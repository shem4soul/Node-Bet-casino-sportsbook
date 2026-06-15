# Naija Sportsbook API

Production-ready sportsbook + casino backend in **Node.js + TypeScript + PostgreSQL**, with **Paystack** deposits and payouts and football betting on the **English Premier League, LaLiga and the Nigeria Premier Football League (NPFL)**, plus Serie A, Bundesliga, Ligue 1, the Champions League and the EFL Championship.

> ⚠️ **Regulatory notice.** Real-money betting is licensed activity. In Nigeria, you need a licence from the National Lottery Regulatory Commission and/or the relevant state gaming board (e.g. the Lagos State Lotteries and Gaming Authority) before taking bets, plus KYC/AML processes and responsible-gambling controls that satisfy them. Paystack also requires approval for gaming businesses. This repository gives you the technical platform, not a compliance programme. Get legal advice before launching.

---

## Contents

- [Features](#features)
- [Quick start (Docker)](#quick-start-docker)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Paystack integration](#paystack-integration)
- [Leagues, markets & odds](#leagues-markets--odds)
- [Settlement](#settlement)
- [API overview](#api-overview)
- [API documentation (Swagger)](#api-documentation-swagger)
- [Logging](#logging)
- [Architecture](#architecture)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Production checklist](#production-checklist)
- [Upgrading from v1 (MySQL)](#upgrading-from-v1-mysql)

---

## Features

**Sportsbook**
- Football leagues seeded and featured: EPL, LaLiga, NPFL (+ 5 more). Add any league via the admin API.
- 12 market types settled automatically from the final score: 1X2, Double Chance, Draw No Bet, Over/Under (any half/whole line), BTTS, Odd/Even, Half-Time 1X2, HT/FT, Correct Score (with "OTHER"), Asian Handicap (half/whole lines), and home/away team totals.
- Singles and accumulators (up to 40 legs), one leg per match, pre-match only. Kick-off automatically closes markets.
- Odds-change protection (`acceptOddsChanges: none | higher | any`), `Idempotency-Key` support for safe retries, max-payout cap.
- **Cash-out** at fair value minus a configurable margin.
- **Booking codes**: shareable bet slips (e.g. `NB7K2QX`).
- Odds feed sync from [odds-api.io](https://odds-api.io) for every league, with best/average aggregation and an operator margin. Prices are never touched after kick-off.

**Payments (Paystack, NGN)**
- Deposits through Paystack Checkout (redirect or Inline/Popup).
- Every charge is re-verified with the Paystack API before crediting. Webhooks are HMAC-SHA512 verified and idempotent.
- Three credit paths that can safely race: webhook, client verify after redirect, and a reconciliation job. Exactly one credits.
- **Withdrawals via Paystack Transfers** to NUBAN accounts (names resolved through Paystack). Funds are held on request, admin review applies above a threshold, and failed or reversed transfers are refunded automatically. Network timeouts are reconciled, never double-paid.

**Accounts & safety**
- 18+ enforcement, login by email/username/phone, lockout after repeated failures.
- Short-lived JWT access tokens + rotating refresh tokens with reuse detection.
- Password reset by email (SMTP or logged in dev), change password, logout everywhere.
- Responsible gambling: daily/weekly/monthly deposit limits (raising a limit has a 24-hour cooling-off period), and self-exclusion that cannot be shortened.
- KYC status gate on withdrawals. Bans and suspensions take effect immediately.

**Back office**
- User management (status, KYC, balance adjustments), fixture/market/odds management, manual settlement, event cancellation.
- Withdrawal review queue.
- Reports: GGR (sportsbook + casino), deposits/withdrawals, active/new users, open-bet liability per selection.
- Full **audit log** of privileged actions.

**Casino** (kept from v1): provably-fair dice, coin flip and slots (HMAC-SHA256 commit/reveal).

**Operations**
- PostgreSQL with an append-only ledger. A unique index prevents double payouts.
- Versioned SQL migrations with checksums and an advisory lock.
- Background worker with cluster-safe cron jobs (Postgres advisory locks).
- **Structured logging:** JSON logs (pino) with request IDs and user IDs on every line, named business events (`bet.placed`, `deposit.credited`, `withdrawal.refunded`, ...), PII masking, secret redaction, and an optional log file.
- **Swagger / OpenAPI 3 docs** at `/docs`: all 81 operations with full request/response schemas, examples and error codes. Contract tests keep the docs in sync with the code.
- zod-validated config and requests, Prometheus `/metrics`, `/health` and `/ready`, graceful shutdown.
- Multi-stage Docker image (non-root, tini, healthcheck), docker-compose stack, GitHub Actions CI/CD to GHCR with SSH deploys.
- 109 unit, integration and contract tests against real PostgreSQL.

---

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set JWT_ACCESS_SECRET, PAYSTACK_SECRET_KEY / PUBLIC_KEY, ADMIN_EMAIL / ADMIN_PASSWORD
docker compose up --build
```

This starts PostgreSQL, runs migrations and the seed (a one-shot `migrate` service), then starts the API and the background worker.

- API: <http://localhost:4000/api/v1>
- Docs: <http://localhost:4000/docs>
- Health: `/health` (liveness), `/ready` (checks the DB)

Want sample EPL/LaLiga/NPFL fixtures with odds? Add `SEED_DEMO_DATA=true` to `.env` before the first `up`.

## Local development

Requirements: Node 20+ (22 recommended) and PostgreSQL 14+.

```bash
npm install
cp .env.example .env                 # point DATABASE_URL at your local Postgres
npm run db:migrate
SEED_DEMO_DATA=true npm run db:seed  # leagues, games, admin (if ADMIN_* set), demo fixtures
npm run dev                          # API with hot reload
npm run dev:worker                   # background jobs (separate terminal), or set RUN_JOBS_IN_API=true
```

| Script | What it does |
| --- | --- |
| `npm run dev` / `dev:worker` | Run API / worker from TypeScript with reload |
| `npm run build` | Compile to `dist/` and copy the OpenAPI spec |
| `npm start` / `start:worker` | Run compiled API / worker |
| `npm run db:migrate` / `db:seed` | Apply migrations / idempotent seed (`:prod` variants run from `dist/`) |
| `npm test` | All tests (needs Postgres, see [Testing](#testing)) |
| `npm run lint` / `format` / `typecheck` | Code quality |

To test Paystack webhooks locally, expose the API with a tunnel (e.g. `ngrok http 4000`) and set the webhook URL in your Paystack test dashboard.

## Configuration

Every variable is documented in [`.env.example`](.env.example) and validated at boot by [`src/config/env.ts`](src/config/env.ts). In production the API refuses to start without a Paystack key or with a demo balance. The settings that matter most:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DATABASE_SSL` | PostgreSQL connection (set `DATABASE_SSL=true` for most managed DBs) |
| `JWT_ACCESS_SECRET` | ≥32 random characters |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` | From your Paystack dashboard |
| `FRONTEND_URL` / `PAYSTACK_CALLBACK_URL` | Where Paystack returns customers after checkout |
| `TRUST_PROXY` | Set correctly behind a load balancer (e.g. `1`) so rate limits and IP checks see real client IPs |
| `CORS_ORIGINS` | Your web/mobile origins |
| `MIN_STAKE`, `MAX_STAKE`, `MAX_PAYOUT`, `MAX_SELECTIONS` | Sportsbook risk limits (NGN) |
| `WITHDRAWAL_REVIEW_THRESHOLD`, `WITHDRAWAL_REQUIRE_KYC` | Payout controls |
| `ODDS_API_KEY`, `ODDS_API_BOOKMAKERS`, `ODDS_AGGREGATION`, `ODDS_MARGIN_PERCENT` | Odds feed |

## Paystack integration

### Deposits

```
Client                     API                               Paystack
  | POST /wallet/deposits    |                                    |
  |------------------------->| create pending payment_intent      |
  |                          |--- POST /transaction/initialize -->|
  |<-- authorizationUrl -----|                                    |
  |====== customer pays on Paystack checkout =====================>|
  |                          |<-- webhook charge.success ---------| (x-paystack-signature)
  |                          |--- GET /transaction/verify/:ref -->| (re-confirm amount & status)
  |                          | credit wallet (once, in a DB tx)   |
  | redirect back to app     |                                    |
  | POST /deposits/:ref/verify (fallback if the webhook is late)  |
```

1. **Start**: `POST /api/v1/wallet/deposits { "amount": 5000 }` returns `authorizationUrl` (redirect the user) and `accessCode`/`publicKey` (for Paystack Inline).
2. **Webhook**: in the Paystack dashboard, under *Settings → API Keys & Webhooks*, set the webhook URL to `https://<your-api>/api/v1/webhooks/paystack`.
3. **Callback**: Paystack redirects to `PAYSTACK_CALLBACK_URL?reference=...`. Your frontend calls `POST /api/v1/wallet/deposits/:reference/verify` and shows the result.
4. A **reconciliation job** (every 5 min) re-verifies pending deposits, so a missed webhook never leaves a paying customer uncredited.

Safety properties, all covered by tests:
- The signature is checked over the raw request bytes.
- `webhook_events (provider, event_key)` is unique, so duplicate deliveries are no-ops.
- The charge is re-verified with Paystack and the amount and currency must match the intent. A forged or replayed `charge.success` credits nothing.
- The intent row is locked, so webhook, verify and job can race and only one credits.
- The ledger's unique `(type, reference)` index is a final guard against double credits.

### Withdrawals (Paystack Transfers)

1. `GET /wallet/banks` returns Nigerian banks with their codes.
2. `POST /wallet/bank-accounts { bankCode, accountNumber }` resolves the account name with Paystack and creates a transfer recipient.
3. `POST /wallet/withdrawals { amount, bankAccountId }` holds the funds immediately. Below `WITHDRAWAL_REVIEW_THRESHOLD` the transfer is sent straight away. At or above it, the withdrawal waits in `pending_review` for `POST /admin/withdrawals/:id/approve` (or `/reject`, which refunds).
4. `transfer.success` completes the withdrawal. `transfer.failed` and `transfer.reversed` refund the user automatically. If Paystack times out, the withdrawal stays `processing` until the reconciliation job verifies it. It is never double-sent: the same reference is reused.

**Paystack setup for payouts:** fund your Paystack balance, and **disable OTP for transfers** (*Settings → Preferences*), otherwise API transfers stall at `otp`. Optionally set `PAYSTACK_ENFORCE_IP_WHITELIST=true` to accept webhooks only from Paystack's published IPs (needs a correct `TRUST_PROXY`).

## Leagues, markets & odds

Seeded leagues (`GET /api/v1/sports/leagues`):

| Slug | League | Featured |
| --- | --- | --- |
| `premier-league` | English Premier League | ✅ |
| `la-liga` | LaLiga | ✅ |
| `npfl` | Nigeria Premier Football League | ✅ |
| `serie-a`, `bundesliga`, `ligue-1`, `champions-league`, `championship` | Other top competitions | |

`GET /api/v1/sports/featured` returns the next fixtures for each featured league, with 1X2 prices inline. `GET /api/v1/sports/markets` lists every market type and its valid selections.

### Two ways to get fixtures and odds

**1. Odds feed (automatic).** Set `ODDS_API_KEY`, then for each league:

```bash
# discover the provider's league ids
GET  /api/v1/admin/odds-provider/leagues?sport=football
# set the id and enable sync
PATCH /api/v1/admin/leagues/:id   { "providerSlug": "england-premier-league", "syncEnabled": true }
# sync now (or wait for ODDS_SYNC_CRON)
POST /api/v1/admin/odds-sync      { "leagues": ["premier-league", "la-liga", "npfl"] }
```

The seed ships *best-guess* provider slugs. Verify them with the discovery endpoint, because providers rename leagues and NPFL coverage varies by plan. Supported feed markets: 1X2, totals, BTTS, double chance, draw no bet and Asian handicap (half/whole lines). Use `ODDS_AGGREGATION=average` (not `best`) plus `ODDS_MARGIN_PERCENT`: taking the best price across bookmakers gives sharp bettors arbitrage against you.

**2. Trading team (manual).** Create a fixture with its markets in one call:

```http
POST /api/v1/admin/events
{
  "leagueId": 3, "homeTeam": "Enyimba", "awayTeam": "Kano Pillars",
  "startTime": "2026-11-01T16:00:00Z",
  "markets": [
    { "type": "1X2", "odds": [{"selection":"HOME","price":1.75},{"selection":"DRAW","price":3.2},{"selection":"AWAY","price":4.8}] },
    { "type": "OVER_UNDER", "line": 2.5, "odds": [{"selection":"OVER","price":1.9},{"selection":"UNDER","price":1.9}] },
    { "type": "BTTS", "odds": [{"selection":"YES","price":1.8},{"selection":"NO","price":1.95}] }
  ]
}
```

Then adjust prices with `PATCH /admin/odds/:id`, and use `POST /admin/markets/:id/suspend` or `/reopen`.

## Settlement

```http
POST /api/v1/admin/events/:id/result
{ "homeScore": 2, "awayScore": 1, "htHomeScore": 0, "htAwayScore": 1 }
```

This records the score and settles every supported market in one transaction, using the pure, exhaustively tested engine in [`src/services/markets/footballMarkets.ts`](src/services/markets/footballMarkets.ts). It handles pushes (whole-line totals and handicaps) and Draw No Bet voids. Accumulators are recomputed with void legs at 1.00, and a multi is settled as lost as soon as any leg loses. Markets the engine can't settle (custom types, or half-time markets when no HT score was given) are suspended and returned in `needsManualSettlement` for `POST /admin/markets/:id/settle`.

- **Abandoned/cancelled match:** `POST /admin/events/:id/cancel` voids everything and refunds or recomputes slips.
- **Postponed:** `PATCH /admin/events/:id { "status": "postponed" }` suspends markets.
- **Feed auto-settlement** (`AUTO_SETTLE_FROM_FEED=true`) is off by default. Wrong results pay out real money, so a human confirms by default.

## API overview

All routes are under `/api/v1`. The full interactive reference is at **`/docs`** (OpenAPI JSON: `/docs/openapi.json`).

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register` `login` `refresh` `logout` `logout-all` `forgot-password` `reset-password` |
| Account | `GET/PATCH /account/me`, `POST /account/change-password`, `GET /account/limits`, `PUT /account/limits/deposit`, `POST /account/self-exclusion` |
| Wallet | `GET /wallet`, `GET /wallet/transactions`, `POST/GET /wallet/deposits`, `POST /wallet/deposits/:ref/verify`, `GET /wallet/banks`, `GET/POST/DELETE /wallet/bank-accounts`, `POST/GET /wallet/withdrawals` |
| Sports | `GET /sports`, `/sports/markets`, `/sports/leagues`, `/sports/leagues/:slug/events`, `/sports/featured`, `/sports/events`, `/sports/events/:id` |
| Bets | `POST/GET /sports/bets`, `GET /sports/bets/:id`, `GET/POST /sports/bets/:id/cashout`, `POST/GET /sports/booking-codes` |
| Casino | `GET /casino/games`, `/casino/fairness`, `POST /casino/{dice,coinflip,slots}/play`, `GET /casino/history` |
| Admin | users, leagues, events, results, markets, odds, odds-sync, bets, withdrawals, reports, audit-logs |
| Webhooks | `POST /webhooks/paystack` |

Example: place an accumulator.

```bash
curl -X POST $API/api/v1/sports/bets \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6f1c2e1a-slip-42" \
  -d '{"stake": 1000, "selections": [{"oddsId": 146, "price": 1.75}, {"oddsId": 212, "price": 1.9}], "acceptOddsChanges": "higher"}'
```

Errors share one shape: `{ "error": { "code": "ODDS_CHANGED", "message": "...", "details": {...}, "requestId": "..." } }`.

## API documentation (Swagger)

Interactive docs are served by the API itself:

| URL | What |
| --- | --- |
| `/docs` | Swagger UI: browse, **Authorize** with your access token, and **Try it out** against the running server |
| `/docs/openapi.json` | OpenAPI 3.0 spec (JSON), for Postman/Insomnia import or client generation |
| `/docs/openapi.yaml` | Same spec, YAML |

The source of truth is [`src/docs/openapi.yaml`](src/docs/openapi.yaml): 81 operations, each with an `operationId`, request and response schemas, examples, and its possible error codes. All errors share the documented `Error` schema; branch on `error.code`.

Using it from Swagger UI:
1. `POST /auth/login` (or `/auth/register`) → **Try it out** → copy `accessToken` from the response.
2. Click **Authorize** (top right), paste the token. Swagger UI remembers it across reloads.
3. Try `GET /sports/featured`, then `POST /sports/bets`.

Generate a typed client for your frontend or mobile app:

```bash
npx @openapitools/openapi-generator-cli generate -i http://localhost:4000/docs/openapi.json -g typescript-fetch -o ./sdk
# or: -g kotlin / -g swift5 / -g dart for mobile apps
```

**Keeping docs honest.** When you add or change an endpoint, update `openapi.yaml` in the same PR. CI runs `npm run docs:validate`, the route-coverage unit test and the contract test, so drift fails the build.

**Production:** set `DOCS_USERNAME` and `DOCS_PASSWORD` to put the docs behind HTTP Basic auth, or `DOCS_ENABLED=false` to turn them off.

## Logging

Logs are structured JSON ([pino](https://getpino.io)), one object per line, written to stdout (and optionally `LOG_FILE`). Locally they're pretty-printed. Every line carries:

| Field | Meaning |
| --- | --- |
| `time`, `level` | ISO timestamp, `debug`/`info`/`warn`/`error`/`fatal` |
| `service`, `env`, `version` | Which deployment wrote it |
| `module` | `http`, `auth`, `bets`, `payments`, `withdrawals`, `settlement`, `ledger`, `audit`, `jobs`, `odds-sync`, ... |
| `requestId` | From the client's `X-Request-Id` header or generated. Echoed in the response header and in error bodies, so a support ticket can be traced end to end |
| `userId` | The authenticated user, attached automatically to every line written during their request (even deep in services) |
| `job` | Background job name, for lines written by the worker |
| `event` | Stable name for business events (below) |

Each HTTP request produces one access line: `POST /api/v1/sports/bets 201 13ms`, with `durationMs`, `userId` and, on failure, the API `errorCode`.

Key business events (`event` field):

| Area | Events |
| --- | --- |
| Auth | `auth.register`, `auth.login`, `auth.login.failed` ⚠️, `auth.account.locked` ⚠️, `auth.refresh.reuse_detected` ⚠️ (possible token theft), `auth.password.changed`, `auth.password_reset.*` |
| Deposits | `deposit.initialized`, `deposit.credited` (with `source`: webhook / verify / reconcile), `deposit.failed`, `deposit.amount_mismatch` 🚨, `webhook.received`, `webhook.duplicate`, `webhook.invalid_signature` ⚠️ |
| Withdrawals | `withdrawal.requested`, `withdrawal.transfer_sent`, `withdrawal.succeeded`, `withdrawal.refunded` ⚠️, `withdrawal.outcome_unknown` ⚠️, `withdrawal.otp_required` 🚨 |
| Betting | `bet.placed`, `bet.rejected` (`reason`: odds_changed, selections_unavailable, max_payout), `bet.cashed_out`, `bet.settled`, `booking_code.created` |
| Settlement | `market.settled`, `event.result_recorded`, `event.manual_settlement_needed` ⚠️, `event.cancelled` |
| Back office | `audit.*`: every admin and responsible-gambling action (mirrors the `audit_logs` table) |
| System | `server.started`, `scheduler.started`, `job.finished`, `job.failed` 🚨, `odds_sync.league`, `ledger.entry` (debug) |

⚠️ = worth a dashboard; 🚨 = alert on it.

**Privacy & secrets.** Passwords, tokens, `Authorization` headers, Paystack signatures and transfer recipient codes are redacted. Emails and account numbers are masked (`ch***@example.com`, `******6789`). Query strings are never logged.

**Configuration:** `LOG_LEVEL` (`debug` adds ledger and per-bet settlement detail), `LOG_PRETTY`, `LOG_FILE`, `LOG_PROBES`. Under Docker, logs go to stdout with rotation (20 MB × 10 files per container, set in `docker-compose.yml`). Point Loki/Promtail, Vector, Fluent Bit, the Datadog agent or CloudWatch at the container logs.

Example queries:

```bash
# everything that happened in one request
docker compose logs api | grep '"requestId":"3f2c9a1e-...'
# all money movements for user 42 (needs LOG_LEVEL=debug for ledger lines)
docker compose logs api worker | grep '"userId":42' | grep -E 'deposit|withdrawal|bet|ledger'
# security signals
docker compose logs api | grep -E 'reuse_detected|account.locked|invalid_signature'
```

## Architecture

```
src/
  app.ts, server.ts, worker.ts    HTTP app, API entrypoint, background worker
  config/                         env (zod), pg pool + transactions + advisory locks, logger
  routes/                         HTTP layer: zod validation -> service call
  services/                       business logic (auth, payments, withdrawals, bets, settlement, ...)
    markets/footballMarkets.ts    pure market catalogue + settlement engine
  integrations/paystack           typed Paystack client + webhook signatures
  integrations/oddsApi            odds-api.io client + pure normaliser
  repositories/walletRepository   the ONLY code that changes balances
  jobs/scheduler.ts               cron jobs (kick-off closer, reconciliation, odds sync, cleanup)
  db/migrate.ts, db/seed.ts       migration runner, idempotent seed
migrations/                       versioned SQL (NNN_name.sql)
tests/unit, tests/integration     vitest + supertest against real Postgres and a fake Paystack
```

Design rules:
- **Money never touches a float.** NUMERIC columns arrive as strings, and arithmetic happens in integer kobo (`src/lib/money.ts`). Payouts round down to the kobo.
- **`transactions` is an append-only ledger.** `wallets.balance` changes only through `adjustBalance()`, in the same DB transaction as its ledger row, under `SELECT ... FOR UPDATE`. The tests assert `balance == SUM(ledger)` after every money flow, including concurrent bets.
- **Server-side pricing.** Bets are always priced from locked DB rows. Client prices are only used to detect odds movement.
- **Network I/O never happens while DB locks are held.** Payment-provider calls run before or after transactions, and uncertain outcomes are reconciled.
- **Horizontal scaling.** The API is stateless. Jobs use `pg_try_advisory_lock`, so any number of workers or API replicas run each tick once. Rate limiting is in-memory per instance; plug in a Redis store (`rate-limit-redis`) if you need global limits.

### Adding a migration

Create `migrations/002_what_it_does.sql` and run `npm run db:migrate`. Never edit an applied migration: the runner stores a checksum and refuses modified files.

## Testing

```bash
# needs a Postgres database whose name contains "test" (it is wiped on each run)
export TEST_DATABASE_URL=postgres://betting:betting@localhost:5432/betting_test
npm test                 # unit + integration
npm run test:unit        # no database needed
```

A **contract test** (`tests/integration/openapi.contract.test.ts`) calls every documented operation and validates each real response against `openapi.yaml`. It fails if a response has the wrong types, misses required fields, returns fields the docs don't mention, or if an endpoint is never exercised. A unit test checks that every Express route is documented and every documented route exists.

Integration tests run the real Express app against real PostgreSQL. In-process fake Paystack and odds-api.io servers mean the real HTTP clients get exercised. Coverage includes registration and auth flows, token reuse detection, webhook idempotency under concurrent delivery, forged webhooks, amount mismatches, deposit limits, self-exclusion, concurrent bets against one wallet, odds movement, idempotent bet placement, settlement across every market type, cancellations, cash-out, booking codes, transfers (success, failure, reversal, timeout), admin review, reports, provably-fair verification, and feed sync.

## CI/CD

**CI** (`.github/workflows/ci.yml`, on every PR and push to `main`):
1. ESLint (zero warnings), Prettier check, `tsc`.
2. Unit + integration tests on PostgreSQL 15 and 16.
3. Docker image build, container smoke test (migrate → seed → boot → hit `/ready` and the leagues endpoint), Trivy vulnerability scan.

**CD** (`.github/workflows/cd.yml`):
- Push to `main` → image `ghcr.io/<owner>/<repo>:main` + `:sha-xxxxxxx` → deploys to **staging** (if `STAGING_HOST` is set).
- Tag `v1.2.3` → `:1.2.3`, `:1.2`, `:latest` → deploys to **production** (protect the `production` environment with required reviewers for a manual approval gate).
- Deploys copy the compose files to the host over SSH, `docker compose pull && up -d` (migrations run first as the `migrate` service), then poll `/ready`.

Repository settings for CD:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | Private key for the deploy user |
| Secret | `DEPLOY_USER` | SSH user on the host |
| Variable | `STAGING_HOST` / `PRODUCTION_HOST` | Hostname/IP (leave unset to skip that environment) |
| Variable | `STAGING_URL` / `PRODUCTION_URL` | Public base URL, used for the post-deploy `/ready` check |
| Variable | `DEPLOY_PATH` | Directory on the host (default `/opt/sportsbook`) |

On the host: install Docker (Compose ≥ 2.24), create `DEPLOY_PATH/.env` from `.env.example` with production values and `DOMAIN=api.yourdomain.com`. The prod override adds Caddy for automatic HTTPS, runs two API replicas, and keeps Postgres private. For real traffic, prefer a managed PostgreSQL with backups and point `DATABASE_URL` at it.

## Production checklist

- [ ] Licence(s) in place; Paystack approved for gaming; terms & privacy published.
- [ ] Live Paystack keys; webhook URL configured; OTP for transfers disabled; Paystack balance funded.
- [ ] `NODE_ENV=production`, strong `JWT_ACCESS_SECRET`, `DEMO_STARTING_BALANCE=0`, `METRICS_TOKEN` set.
- [ ] `/docs` protected with `DOCS_USERNAME`/`DOCS_PASSWORD` (or `DOCS_ENABLED=false`).
- [ ] Container logs shipped to your log platform, with alerts on `level=error` and on the events listed under [Logging](#logging).
- [ ] `TRUST_PROXY` matches your proxy chain; `CORS_ORIGINS` restricted.
- [ ] Managed PostgreSQL with PITR backups, `DATABASE_SSL=true`.
- [ ] `SMTP_URL` configured (password reset emails).
- [ ] KYC provider wired to `PATCH /admin/users/:id/kyc` (e.g. via Smile ID, Dojah, or Prembly webhooks).
- [ ] Risk limits reviewed (`MAX_STAKE`, `MAX_PAYOUT`, `WITHDRAWAL_REVIEW_THRESHOLD`, `ODDS_MARGIN_PERCENT`).
- [ ] League provider slugs verified; at least one person on result-entry duty for match days.
- [ ] Prometheus scraping `/metrics`, alerting on 5xx rate, job failures (`sportsbook_job_runs_total{outcome="error"}`) and `/ready`.
- [ ] Admin account created via `ADMIN_EMAIL`/`ADMIN_PASSWORD`, then remove those vars from the environment.

## Upgrading from v1 (MySQL)

v2 is a rewrite of the data layer: MySQL → PostgreSQL, a new schema (`migrations/001_initial_schema.sql`), versioned routes (`/api/*` → `/api/v1/*`), a real Paystack integration (the mock gateway is gone), and refresh tokens. Endpoint names changed in places (for example `POST /wallet/deposit/initialize` → `POST /wallet/deposits`, `POST /admin/markets/:id/settle` is unchanged). There is no automatic data migration. To carry over existing users and balances, export them from MySQL and import them into the new tables, posting each opening balance as an `adjustment` ledger row so `balance == SUM(ledger)` holds.

## License

The upstream archive did not include a LICENSE file. Confirm the original project's licence terms and add a `LICENSE` file before redistributing.
