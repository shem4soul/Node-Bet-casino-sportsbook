# Casino + Sportsbook API (Node.js + TypeScript + MySQL)

Backend-only API for a casino (dice, coinflip, slots) and sports betting
platform. No frontend — this is meant to sit behind whatever client you
build next.

> ⚠️ **Before operating this for real money**: online gambling is a
> regulated industry almost everywhere. You will need a gambling license
> for each jurisdiction you operate in, a licensed payment processor
> (the deposit/withdraw endpoints here are mocked), real KYC/AML checks,
> and legal review of your terms and responsible-gambling controls. This
> project gives you the technical scaffolding, not a compliance program.

## Stack

- Node.js + Express, written in TypeScript (source in `src/`, compiles to `dist/`)
- MySQL (via `mysql2`, raw SQL — no ORM, so the schema is exactly what you see in `src/db/schema.sql`; row shapes are typed in `src/types/db.ts`)
- JWT auth, bcrypt password hashing
- Provably-fair casino RNG (HMAC-SHA256 commit/reveal)

## Setup

```bash
npm install
cp .env.example .env   # then edit DB credentials, JWT_SECRET, etc.

# create the database, tables, and seed data (games, a demo admin, a sample event)
npm run db:init

npm run dev             # runs src/server.ts directly via tsx, with hot reload
# — or, for a compiled/production run —
npm run build && npm start   # tsc -> dist/, then node dist/server.js
```

`npm run typecheck` runs `tsc --noEmit` on its own, useful in CI without producing build output.

Server listens on `PORT` (default `4000`), all routes under `/api`.

## Architecture notes

- **Money is DECIMAL everywhere**, never float. `mysql2` is configured with
  `decimalNumbers: false` so DECIMAL columns come back as strings and get
  parsed explicitly — avoids silent float rounding on balances. This is
  reflected in the types too: every `*_Row` interface in `src/types/db.ts`
  types DECIMAL columns as `string`, not `number`.
- **`transactions` is an append-only ledger.** `wallets.balance` is a cached
  total; it's only ever mutated inside the same DB transaction as a ledger
  insert (see `walletRepository.adjustBalance`), with `SELECT ... FOR UPDATE`
  row locking so concurrent bets/games on one user can't race the balance.
- **Casino games are provably fair.** Each user has an active
  (serverSeed, clientSeed, nonce) triple. Only the SHA-256 hash of the
  server seed is exposed up front; rotating seeds reveals the previous
  server seed so every past round can be independently recomputed and
  verified against its stored hash.
- **Sportsbook settlement is selection-based, not score-parsing.** An admin
  resolves a market by naming the winning `selection` string (e.g. `HOME`)
  rather than the system trying to infer winners from scores across
  arbitrary market types. Multi-bets recompute payout from surviving legs
  when a leg is voided (event cancelled, market voided).

## Key endpoints

All authenticated routes take `Authorization: Bearer <token>`.

### Auth

- `POST /api/auth/register` — `{ username, email, password, dateOfBirth }` (18+ enforced)
- `POST /api/auth/login` — `{ identifier, password }`

### Wallet

- `GET /api/wallet/balance`
- `POST /api/wallet/deposit/initialize` — `{ amount }` → starts a deposit through the mock gateway, returns `{ reference, authorizationUrl }`. Open `authorizationUrl` in a browser to complete the test checkout.
- `GET /api/wallet/deposit/:reference/status` — check a deposit's current status
- `POST /api/wallet/withdraw` — `{ amount }` (still directly mocked — no payout gateway wired up)
- `GET /api/wallet/transactions?limit=&offset=`

## Mock payment gateway (test-only — see "payments" section below)

`src/mockGateway/` is a small stand-in for a hosted gateway shaped like
Paystack's API/webhook contract, so you can build and test the whole
deposit flow — including real HMAC signature verification and webhook
idempotency — without touching a real processor or moving real money.

**Flow:**

1. `POST /api/wallet/deposit/initialize` creates a `pending` row in
   `payment_intents` and asks the mock gateway for a checkout URL.
2. Open the returned `authorizationUrl` in a browser — it's a plain HTML
   page with "Simulate successful payment" / "Simulate failed payment"
   buttons.
3. Clicking a button makes the mock gateway sign a payload with
   `HMAC-SHA512(MOCK_GATEWAY_SECRET_KEY, rawBody)` and POST it to
   `POST /api/webhooks/paystack` with the signature in the
   `x-mock-paystack-signature` header — exactly the shape a real gateway's
   webhook would take.
4. The webhook handler (`paymentService.handleWebhook`) verifies the
   signature against the **raw request bytes** (captured via the
   `verify` hook on `express.json()` in `app.js` — never against a
   re-serialized JSON object, which can silently break the signature),
   checks `webhook_events` for a duplicate `(provider, reference,
event_type)` delivery, and **only then** credits the wallet inside a
   DB transaction.
5. `GET /mock-paystack/transaction/verify/:reference` mimics the polling
   fallback a real gateway offers, in case a webhook is ever missed.

**Idempotency in practice:** replay the exact same webhook call (same
signature, same body) twice — the second delivery hits the
`webhook_events` UNIQUE KEY, the insert fails with `ER_DUP_ENTRY`, and
`handleWebhook` treats that as "already processed" and returns success
without crediting the wallet a second time.

**Swapping in a real gateway later:** delete `src/mockGateway/`, point
`initializeDeposit` at the real provider's initialize/charge API instead
of `POST /mock-paystack/transaction/initialize`, and swap the secret key
and signature header name to match that provider's docs — the rest of
the flow (raw-body capture, idempotent webhook_events insert, transactional
wallet credit) carries over unchanged.

### Casino

- `GET /api/casino/fairness` — current server-seed hash, client seed, nonce
- `POST /api/casino/fairness/rotate` — `{ clientSeed? }` rotates seed, reveals previous server seed
- `POST /api/casino/dice/play` — `{ stake, target, direction: 'under'|'over', clientSeed? }`
- `POST /api/casino/coinflip/play` — `{ stake, call: 'heads'|'tails', clientSeed? }`
- `POST /api/casino/slots/play` — `{ stake, clientSeed? }`
- `GET /api/casino/history?limit=&offset=`

### Sports (browsing is public, betting requires auth)

- `GET /api/sports/events?status=scheduled`
- `GET /api/sports/events/:eventId` — event with markets + odds
- `POST /api/sports/bets` — `{ stake, selections: [{ oddsId }, ...] }` (1 selection = single, 2+ = multi)
- `GET /api/sports/bets/mine?limit=&offset=`

### Admin (requires `role: 'admin'` on the JWT)

- `POST /api/admin/sports` — `{ slug, name }`
- `POST /api/admin/leagues` — `{ sportId, slug, name, country? }`
- `POST /api/admin/events` — `{ leagueId, homeTeam, awayTeam, startTime }`
- `POST /api/admin/markets` — `{ eventId, marketType, line? }`
- `POST /api/admin/odds` — `{ marketId, selection, priceDecimal }`
- `PATCH /api/admin/odds/:oddsId` — `{ priceDecimal }`
- `POST /api/admin/markets/:marketId/suspend`
- `POST /api/admin/markets/:marketId/reopen`
- `POST /api/admin/markets/:marketId/settle` — `{ winningSelection }` or `{ voidMarket: true }`
- `POST /api/admin/odds-sync` — `{ sport, league?, bookmakers?, market? }` (see "Odds-API.io integration" below)

The seeded demo admin is `admin@example.com`. **Its seed password hash is a
placeholder — generate a real one and update the seed before using it**:

```js
node -e "console.log(require('bcryptjs').hashSync('YourNewPassword!', 12))"
```

## Odds-API.io integration

`src/services/oddsSyncService.js` pulls live events + odds from
[Odds-API.io](https://odds-api.io) (via the [`odds-api-io`](https://github.com/shem4soul/Bet-Odds-API)
npm SDK) and upserts them into `events`/`markets`/`odds`, replacing manual
`POST /api/admin/events` + `.../markets` + `.../odds` calls for real
sports data.

**Setup:**

```bash
# .env
ODDS_API_KEY=your-odds-api-io-key
ODDS_SYNC_BOOKMAKERS=singbet,bet365   # comma-separated bookmaker ids
ODDS_SYNC_MARKET=moneyline            # which market to sync per event
```

**Trigger a sync manually (admin only):**

```bash
POST /api/admin/odds-sync
{ "sport": "basketball", "league": "usa-nba" }
```

**Or run it continuously in the background** by setting, in `.env`:

```
ODDS_SYNC_INTERVAL_MINUTES=15
ODDS_SYNC_SPORT=basketball
ODDS_SYNC_LEAGUE=usa-nba
```

`src/jobs/oddsSyncScheduler.js` then calls the sync once on boot and every
`N` minutes after — a plain `setInterval`, not a cron library, since this
project only needed one schedule. Swap in `node-cron` or a real job queue
if you need to sync several sport/league combinations on independent
schedules.

**How the mapping works:**

- Events are matched by `(odds_provider, external_ref)` — the SDK's
  `Event.id` — so re-running a sync updates prices instead of creating
  duplicate events every time.
- Each `outcome.name` the SDK returns is normalized against the event's
  own home/away team names into `HOME`/`AWAY`/`DRAW`; anything that
  doesn't match those (e.g. a tennis player's name) falls back to a
  slugified version of whatever the provider sent, so non-1X2 sports
  still sync sensibly.
- When multiple bookmakers are configured, the **best (highest) decimal
  price** per selection is stored — standard "best odds" aggregation.
- **Settlement is never automatic.** The sync only ever writes prices; an
  admin still resolves a market via `POST /api/admin/markets/:marketId/settle`.
  Deriving a winning selection from a provider's score automatically is
  easy to get wrong (voids, postponements, non-1X2 markets), and an
  incorrect auto-settlement pays out real balances — so that step stays
  a deliberate, human action.
