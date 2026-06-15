-- ============================================================================
-- 001 — Initial schema (PostgreSQL 14+)
--
-- Conventions
--   * Money is NUMERIC(18,2) (never float). Odds are NUMERIC(10,3).
--   * Enumerations are TEXT + CHECK constraints (easier to evolve than ENUM).
--   * All timestamps are TIMESTAMPTZ (stored in UTC).
--   * `transactions` is an append-only ledger; wallets.balance is a cached
--     running total that is only ever changed in the same DB transaction as
--     a ledger insert.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keeps updated_at honest without relying on application code. An UPDATE
-- that sets updated_at explicitly (backfills, data fixes) is respected.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Users & auth
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username               TEXT        NOT NULL,
  email                  TEXT        NOT NULL,
  phone                  TEXT        NULL,
  password_hash          TEXT        NOT NULL,
  first_name             TEXT        NULL,
  last_name              TEXT        NULL,
  role                   TEXT        NOT NULL DEFAULT 'user'
                         CHECK (role IN ('user', 'admin')),
  kyc_status             TEXT        NOT NULL DEFAULT 'unverified'
                         CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
  date_of_birth          DATE        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended', 'banned', 'closed')),
  self_exclusion_until   TIMESTAMPTZ NULL,
  failed_login_attempts  INTEGER     NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ NULL,
  last_login_at          TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,32}$')
);
CREATE UNIQUE INDEX uq_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX uq_users_email_lower    ON users (lower(email));
CREATE UNIQUE INDEX uq_users_phone          ON users (phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_users_status               ON users (status);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Opaque refresh tokens (only the SHA-256 hash is stored). `family_id` ties a
-- chain of rotated tokens together so reuse of an old token revokes the chain.
CREATE TABLE refresh_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  family_id    UUID        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ NULL,
  replaced_by  BIGINT      NULL REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent   TEXT        NULL,
  ip           TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE password_reset_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_user ON password_reset_tokens (user_id);

-- ----------------------------------------------------------------------------
-- Wallet & ledger
-- ----------------------------------------------------------------------------
CREATE TABLE wallets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency    CHAR(3)       NOT NULL DEFAULT 'NGN',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_wallets_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transactions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT          NOT NULL CHECK (type IN (
                    'deposit', 'withdrawal', 'withdrawal_reversal',
                    'bet_stake', 'bet_payout', 'bet_void_refund', 'bet_cashout',
                    'game_stake', 'game_payout', 'adjustment')),
  amount          NUMERIC(18,2) NOT NULL,           -- positive = credit, negative = debit
  balance_after   NUMERIC(18,2) NOT NULL,
  reference_type  TEXT          NULL,               -- 'bet_slip', 'game_round', 'payment_intent', 'withdrawal'
  reference_id    BIGINT        NULL,
  note            TEXT          NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_user_created ON transactions (user_id, created_at DESC);
CREATE INDEX idx_transactions_reference    ON transactions (reference_type, reference_id);
-- Last line of defence against double-crediting: a given ledger movement type
-- can only ever be posted once for a given referenced object (one payout per
-- bet slip, one credit per deposit, one refund per withdrawal, ...).
CREATE UNIQUE INDEX uq_transactions_once_per_reference
  ON transactions (type, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Payments (Paystack)
-- ----------------------------------------------------------------------------
CREATE TABLE payment_intents (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT          NOT NULL DEFAULT 'paystack',
  reference         TEXT          NOT NULL UNIQUE,
  amount            NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3)       NOT NULL DEFAULT 'NGN',
  status            TEXT          NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  access_code       TEXT          NULL,
  authorization_url TEXT          NULL,
  channel           TEXT          NULL,
  gateway_response  JSONB         NULL,
  paid_at           TIMESTAMPTZ   NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_intents_user           ON payment_intents (user_id, created_at DESC);
CREATE INDEX idx_payment_intents_status_created ON payment_intents (status, created_at);
CREATE TRIGGER trg_payment_intents_updated_at BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every accepted webhook delivery is recorded first; the unique key makes
-- processing idempotent across gateway retries.
CREATE TABLE webhook_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     TEXT        NOT NULL,
  event_key    TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_event UNIQUE (provider, event_key)
);

CREATE TABLE bank_accounts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_code       TEXT        NOT NULL,
  bank_name       TEXT        NOT NULL,
  account_number  TEXT        NOT NULL,
  account_name    TEXT        NOT NULL,
  recipient_code  TEXT        NOT NULL,
  is_default      BOOLEAN     NOT NULL DEFAULT false,
  deleted_at      TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_bank_accounts_active
  ON bank_accounts (user_id, bank_code, account_number) WHERE deleted_at IS NULL;

CREATE TABLE withdrawals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_account_id  BIGINT        NOT NULL REFERENCES bank_accounts(id),
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency         CHAR(3)       NOT NULL DEFAULT 'NGN',
  status           TEXT          NOT NULL CHECK (status IN (
                     'pending_review', 'approved', 'processing',
                     'success', 'failed', 'reversed', 'rejected')),
  reference        TEXT          NOT NULL UNIQUE,
  transfer_code    TEXT          NULL,
  failure_reason   TEXT          NULL,
  reviewed_by      BIGINT        NULL REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ   NULL,
  gateway_response JSONB         NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_withdrawals_user   ON withdrawals (user_id, created_at DESC);
CREATE INDEX idx_withdrawals_status ON withdrawals (status, created_at);
CREATE TRIGGER trg_withdrawals_updated_at BEFORE UPDATE ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- Responsible gambling
-- ----------------------------------------------------------------------------
-- Decreases take effect immediately; increases are staged in pending_* and
-- only applied after a cooling-off period (industry-standard practice).
CREATE TABLE deposit_limits (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period                TEXT          NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  amount_limit          NUMERIC(18,2) NULL CHECK (amount_limit IS NULL OR amount_limit > 0),
  pending_amount_limit  NUMERIC(18,2) NULL,
  pending_effective_at  TIMESTAMPTZ   NULL,
  pending_removal       BOOLEAN       NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_deposit_limit_user_period UNIQUE (user_id, period)
);

-- ----------------------------------------------------------------------------
-- Casino (provably fair)
-- ----------------------------------------------------------------------------
CREATE TABLE games (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT          NOT NULL UNIQUE,
  name        TEXT          NOT NULL,
  type        TEXT          NOT NULL CHECK (type IN ('dice', 'coinflip', 'slots')),
  rtp_percent NUMERIC(5,2)  NOT NULL DEFAULT 97.00,
  min_bet     NUMERIC(18,2) NOT NULL DEFAULT 50,
  max_bet     NUMERIC(18,2) NOT NULL DEFAULT 500000,
  is_active   BOOLEAN       NOT NULL DEFAULT true,
  config      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE fairness_seeds (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_seed       TEXT        NOT NULL,
  server_seed_hash  TEXT        NOT NULL,
  client_seed       TEXT        NOT NULL,
  nonce             BIGINT      NOT NULL DEFAULT 0,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  revealed_at       TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_fairness_one_active_per_user ON fairness_seeds (user_id) WHERE is_active;

CREATE TABLE game_rounds (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id           INTEGER       NOT NULL REFERENCES games(id),
  fairness_seed_id  BIGINT        NOT NULL REFERENCES fairness_seeds(id),
  nonce             BIGINT        NOT NULL,
  stake             NUMERIC(18,2) NOT NULL,
  multiplier        NUMERIC(12,4) NOT NULL DEFAULT 0,
  payout            NUMERIC(18,2) NOT NULL DEFAULT 0,
  result            JSONB         NOT NULL,
  outcome           TEXT          NOT NULL CHECK (outcome IN ('win', 'loss')),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_game_rounds_user_created ON game_rounds (user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Sportsbook catalogue
-- ----------------------------------------------------------------------------
CREATE TABLE sports (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE leagues (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sport_id       INTEGER NOT NULL REFERENCES sports(id),
  slug           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  short_name     TEXT    NULL,
  country        TEXT    NULL,
  country_code   CHAR(2) NULL,
  provider_slug  TEXT    NULL,               -- league id at the odds provider
  sync_enabled   BOOLEAN NOT NULL DEFAULT false,
  is_featured    BOOLEAN NOT NULL DEFAULT false,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 100,
  CONSTRAINT uq_league_slug UNIQUE (sport_id, slug)
);
CREATE UNIQUE INDEX uq_leagues_provider_slug ON leagues (provider_slug) WHERE provider_slug IS NOT NULL;

CREATE TABLE events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  league_id      INTEGER     NOT NULL REFERENCES leagues(id),
  home_team      TEXT        NOT NULL,
  away_team      TEXT        NOT NULL,
  start_time     TIMESTAMPTZ NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'live', 'finished', 'cancelled', 'postponed')),
  home_score     INTEGER     NULL CHECK (home_score IS NULL OR home_score >= 0),
  away_score     INTEGER     NULL CHECK (away_score IS NULL OR away_score >= 0),
  ht_home_score  INTEGER     NULL CHECK (ht_home_score IS NULL OR ht_home_score >= 0),
  ht_away_score  INTEGER     NULL CHECK (ht_away_score IS NULL OR ht_away_score >= 0),
  is_featured    BOOLEAN     NOT NULL DEFAULT false,
  odds_provider  TEXT        NULL,
  external_ref   TEXT        NULL,
  settled_at     TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_events_provider_ref UNIQUE (odds_provider, external_ref),
  CONSTRAINT chk_teams_differ CHECK (lower(home_team) <> lower(away_team))
);
CREATE INDEX idx_events_league_start ON events (league_id, start_time);
CREATE INDEX idx_events_status_start ON events (status, start_time);
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A market is a bettable question on an event ('1X2', 'OVER_UNDER' @ 2.5, ...)
CREATE TABLE markets (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     BIGINT       NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  market_type  TEXT         NOT NULL,
  line         NUMERIC(6,2) NULL,
  status       TEXT         NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'suspended', 'settled', 'void')),
  settled_at   TIMESTAMPTZ  NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_markets_event_type_line ON markets (event_id, market_type, COALESCE(line, -9999));

CREATE TABLE odds (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id      BIGINT        NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  selection      TEXT          NOT NULL,
  price_decimal  NUMERIC(10,3) NOT NULL CHECK (price_decimal >= 1.01),
  is_active      BOOLEAN       NOT NULL DEFAULT true,
  result         TEXT          NOT NULL DEFAULT 'pending'
                 CHECK (result IN ('pending', 'won', 'lost', 'void')),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_market_selection UNIQUE (market_id, selection)
);
CREATE TRIGGER trg_odds_updated_at BEFORE UPDATE ON odds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- Bets
-- ----------------------------------------------------------------------------
CREATE TABLE bet_slips (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake             NUMERIC(18,2) NOT NULL CHECK (stake > 0),
  bet_type          TEXT          NOT NULL CHECK (bet_type IN ('single', 'multi')),
  total_odds        NUMERIC(16,3) NOT NULL,
  potential_payout  NUMERIC(18,2) NOT NULL,
  payout            NUMERIC(18,2) NULL,
  status            TEXT          NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'won', 'lost', 'void', 'cashed_out')),
  idempotency_key   TEXT          NULL,
  booking_code      TEXT          NULL,
  settled_at        TIMESTAMPTZ   NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_bet_slips_user_status ON bet_slips (user_id, status, created_at DESC);
CREATE INDEX idx_bet_slips_status      ON bet_slips (status);
CREATE UNIQUE INDEX uq_bet_slips_idempotency ON bet_slips (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE bet_selections (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bet_slip_id                 BIGINT        NOT NULL REFERENCES bet_slips(id) ON DELETE CASCADE,
  odds_id                     BIGINT        NOT NULL REFERENCES odds(id),
  market_id                   BIGINT        NOT NULL REFERENCES markets(id),
  event_id                    BIGINT        NOT NULL REFERENCES events(id),
  market_type                 TEXT          NOT NULL,
  line                        NUMERIC(6,2)  NULL,
  selection                   TEXT          NOT NULL,
  price_decimal_at_placement  NUMERIC(10,3) NOT NULL,
  result                      TEXT          NOT NULL DEFAULT 'pending'
                              CHECK (result IN ('pending', 'won', 'lost', 'void'))
);
CREATE INDEX idx_bet_selections_slip   ON bet_selections (bet_slip_id);
CREATE INDEX idx_bet_selections_market ON bet_selections (market_id, result);
CREATE INDEX idx_bet_selections_odds   ON bet_selections (odds_id);

-- Shareable bet slips ("booking codes"), popular with Nigerian punters.
CREATE TABLE booking_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  odds_ids    BIGINT[]    NOT NULL,
  created_by  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Audit trail for privileged actions
-- ----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,
  entity_type  TEXT        NULL,
  entity_id    TEXT        NULL,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip           TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_entity  ON audit_logs (entity_type, entity_id);
