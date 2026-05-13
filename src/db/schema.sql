-- ============================================================
-- Casino + Sportsbook platform schema
-- MySQL 8.0+
-- All money columns use DECIMAL(18,2) — never FLOAT for currency.
-- ============================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS casino_sportsbook
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE casino_sportsbook;

-- ------------------------------------------------------------
-- Users & auth
-- ------------------------------------------------------------
CREATE TABLE users (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username          VARCHAR(32)  NOT NULL UNIQUE,
  email             VARCHAR(191) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  role              ENUM('user','admin') NOT NULL DEFAULT 'user',
  kyc_status        ENUM('unverified','pending','verified','rejected') NOT NULL DEFAULT 'unverified',
  date_of_birth     DATE NULL,
  status            ENUM('active','suspended','self_excluded','banned') NOT NULL DEFAULT 'active',
  self_exclusion_until DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_status (status)
) ENGINE=InnoDB;

-- One row per user, updated only through the transactions ledger via app logic
CREATE TABLE wallets (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL UNIQUE,
  balance           DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  currency          CHAR(3) NOT NULL DEFAULT 'USD',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_wallets_balance_nonneg CHECK (balance >= 0)
) ENGINE=InnoDB;

-- Append-only ledger. Every balance change (deposit, withdrawal, bet, payout,
-- adjustment) is a row here. wallets.balance is a cached running total that
-- must only be mutated inside the same DB transaction as the ledger insert.
CREATE TABLE transactions (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  type              ENUM('deposit','withdrawal','bet_stake','bet_payout','bet_void_refund','game_stake','game_payout','adjustment') NOT NULL,
  amount            DECIMAL(18,2) NOT NULL,          -- positive = credit, negative = debit
  balance_after     DECIMAL(18,2) NOT NULL,
  reference_type    VARCHAR(32) NULL,                -- e.g. 'bet_slip', 'game_round'
  reference_id      BIGINT UNSIGNED NULL,
  note              VARCHAR(255) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_transactions_user_created (user_id, created_at),
  INDEX idx_transactions_reference (reference_type, reference_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Casino games
-- ------------------------------------------------------------
CREATE TABLE games (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug              VARCHAR(64) NOT NULL UNIQUE,      -- 'dice', 'coinflip', 'slots-classic'
  name              VARCHAR(128) NOT NULL,
  type              ENUM('dice','coinflip','slots','blackjack','roulette') NOT NULL,
  rtp_percent       DECIMAL(5,2) NOT NULL DEFAULT 97.00, -- return to player, informational
  min_bet           DECIMAL(18,2) NOT NULL DEFAULT 0.50,
  max_bet           DECIMAL(18,2) NOT NULL DEFAULT 1000.00,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  config_json       JSON NULL,                        -- paytables, reel strips, etc.
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Provably-fair seed pairs. A user commits to a client_seed; server_seed is
-- generated server-side and only its hash is shown until rotated/revealed.
CREATE TABLE fairness_seeds (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  server_seed       VARCHAR(128) NOT NULL,
  server_seed_hash  VARCHAR(128) NOT NULL,
  client_seed       VARCHAR(128) NOT NULL,
  nonce             BIGINT UNSIGNED NOT NULL DEFAULT 0,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  revealed_at       DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fairness_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_fairness_user_active (user_id, is_active)
) ENGINE=InnoDB;

CREATE TABLE game_rounds (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  game_id           INT UNSIGNED NOT NULL,
  fairness_seed_id  BIGINT UNSIGNED NOT NULL,
  nonce             BIGINT UNSIGNED NOT NULL,
  stake             DECIMAL(18,2) NOT NULL,
  multiplier        DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  payout            DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  result_json       JSON NOT NULL,                    -- e.g. {"roll": 42.17, "target": 50, "direction": "under"}
  outcome           ENUM('win','loss') NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rounds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rounds_game FOREIGN KEY (game_id) REFERENCES games(id),
  CONSTRAINT fk_rounds_seed FOREIGN KEY (fairness_seed_id) REFERENCES fairness_seeds(id),
  INDEX idx_rounds_user_created (user_id, created_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Sportsbook
-- ------------------------------------------------------------
CREATE TABLE sports (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug              VARCHAR(64) NOT NULL UNIQUE,   -- 'football', 'basketball'
  name              VARCHAR(128) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE leagues (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sport_id          INT UNSIGNED NOT NULL,
  slug              VARCHAR(96) NOT NULL,
  name              VARCHAR(150) NOT NULL,
  country           VARCHAR(80) NULL,
  CONSTRAINT fk_leagues_sport FOREIGN KEY (sport_id) REFERENCES sports(id),
  UNIQUE KEY uq_league_slug (sport_id, slug)
) ENGINE=InnoDB;

CREATE TABLE events (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  league_id         INT UNSIGNED NOT NULL,
  home_team         VARCHAR(150) NOT NULL,
  away_team         VARCHAR(150) NOT NULL,
  start_time        DATETIME NOT NULL,
  status            ENUM('scheduled','live','finished','cancelled','postponed') NOT NULL DEFAULT 'scheduled',
  home_score        INT NULL,
  away_score        INT NULL,
  result_json       JSON NULL,                     -- richer results (sets, periods, etc.)
  odds_provider     VARCHAR(32) NULL,               -- e.g. 'odds-api-io', NULL for manually created events
  external_ref      VARCHAR(64) NULL,               -- the provider's event id, for re-sync upserts
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_league FOREIGN KEY (league_id) REFERENCES leagues(id),
  INDEX idx_events_start (start_time),
  INDEX idx_events_status (status),
  UNIQUE KEY uq_events_provider_ref (odds_provider, external_ref)
) ENGINE=InnoDB;

-- A market is a bettable question on an event: '1X2', 'OVER_UNDER_2_5', 'BTTS', etc.
CREATE TABLE markets (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id          BIGINT UNSIGNED NOT NULL,
  market_type       VARCHAR(64) NOT NULL,
  line              DECIMAL(6,2) NULL,              -- e.g. 2.5 for over/under
  status            ENUM('open','suspended','settled','void') NOT NULL DEFAULT 'open',
  settled_at        DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_markets_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  INDEX idx_markets_event (event_id)
) ENGINE=InnoDB;

-- A single selection within a market with its current price, e.g. 'HOME' @ 1.85
CREATE TABLE odds (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  market_id         BIGINT UNSIGNED NOT NULL,
  selection         VARCHAR(64) NOT NULL,           -- 'HOME','DRAW','AWAY','OVER','UNDER',...
  price_decimal     DECIMAL(8,3) NOT NULL,          -- decimal odds, e.g. 1.850
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  result            ENUM('pending','won','lost','void') NOT NULL DEFAULT 'pending',
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_odds_market FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  UNIQUE KEY uq_market_selection (market_id, selection),
  CONSTRAINT chk_odds_price_valid CHECK (price_decimal >= 1.001)
) ENGINE=InnoDB;

-- A bet slip is what the user places: one selection (single) or several (multi/accumulator)
CREATE TABLE bet_slips (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  stake             DECIMAL(18,2) NOT NULL,
  bet_type          ENUM('single','multi') NOT NULL DEFAULT 'single',
  total_odds        DECIMAL(10,3) NOT NULL,
  potential_payout  DECIMAL(18,2) NOT NULL,
  status            ENUM('pending','won','lost','void','cashed_out') NOT NULL DEFAULT 'pending',
  settled_at        DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_betslips_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_betslips_user_status (user_id, status)
) ENGINE=InnoDB;

CREATE TABLE bet_selections (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bet_slip_id       BIGINT UNSIGNED NOT NULL,
  odds_id           BIGINT UNSIGNED NOT NULL,
  event_id          BIGINT UNSIGNED NOT NULL,
  selection         VARCHAR(64) NOT NULL,
  price_decimal_at_placement DECIMAL(8,3) NOT NULL,  -- snapshot: price can move after bet is placed
  result            ENUM('pending','won','lost','void') NOT NULL DEFAULT 'pending',
  CONSTRAINT fk_selections_slip FOREIGN KEY (bet_slip_id) REFERENCES bet_slips(id) ON DELETE CASCADE,
  CONSTRAINT fk_selections_odds FOREIGN KEY (odds_id) REFERENCES odds(id),
  CONSTRAINT fk_selections_event FOREIGN KEY (event_id) REFERENCES events(id),
  INDEX idx_selections_slip (bet_slip_id),
  INDEX idx_selections_event (event_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Payments (mock gateway — see src/mockGateway)
-- ------------------------------------------------------------

-- One row per deposit attempt, created when the checkout is initialized.
-- The wallet is only ever credited after a verified webhook flips this to
-- 'success' — never at initialization time.
CREATE TABLE payment_intents (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  provider          VARCHAR(32) NOT NULL DEFAULT 'mock_paystack',
  reference         VARCHAR(64) NOT NULL UNIQUE,
  amount            DECIMAL(18,2) NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'NGN',
  status            ENUM('pending','success','failed','abandoned') NOT NULL DEFAULT 'pending',
  gateway_response  JSON NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_intents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_payment_intents_user (user_id)
) ENGINE=InnoDB;

-- Every accepted webhook call is recorded here first. The unique key is
-- what makes webhook processing idempotent: a retried/duplicated webhook
-- for the same (provider, reference, event_type) is detected and skipped
-- instead of crediting the wallet twice.
CREATE TABLE webhook_events (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider          VARCHAR(32) NOT NULL,
  reference         VARCHAR(64) NOT NULL,
  event_type        VARCHAR(64) NOT NULL,
  payload_json      JSON NOT NULL,
  received_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_webhook_event (provider, reference, event_type)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Responsible gambling
-- ------------------------------------------------------------
CREATE TABLE deposit_limits (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT UNSIGNED NOT NULL,
  period            ENUM('daily','weekly','monthly') NOT NULL,
  amount_limit      DECIMAL(18,2) NOT NULL,
  effective_from    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_deposit_limits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_period (user_id, period)
) ENGINE=InnoDB;
