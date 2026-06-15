import request from 'supertest';
import { createApp } from '../../src/app';
import { pool } from '../../src/config/db';
import { runSeed } from '../../src/db/seed';

export const app = createApp();
export const api = () => request(app);

const TABLES = [
  'audit_logs',
  'booking_codes',
  'bet_selections',
  'bet_slips',
  'odds',
  'markets',
  'events',
  'leagues',
  'sports',
  'game_rounds',
  'fairness_seeds',
  'games',
  'deposit_limits',
  'withdrawals',
  'bank_accounts',
  'webhook_events',
  'payment_intents',
  'transactions',
  'wallets',
  'password_reset_tokens',
  'refresh_tokens',
  'users',
];

/** Wipes all data and re-seeds reference data (sports, leagues, games). */
export async function resetDb(): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const log = console.log;
  console.log = () => undefined;
  try {
    await runSeed({ demo: false });
  } finally {
    console.log = log;
  }
}

let n = 0;

export interface TestUser {
  id: number;
  token: string;
  refreshToken: string;
  username: string;
  email: string;
}

/** Registers a user and optionally gives them a balance via a ledger adjustment. */
export async function createUser(opts: { balance?: number; admin?: boolean; kyc?: boolean } = {}): Promise<TestUser> {
  n += 1;
  const username = `user_${Date.now().toString(36)}_${n}`;
  const email = `${username}@example.com`;
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ username, email, password: 'Passw0rd!', dateOfBirth: '1990-05-17' })
    .expect(201);
  const id = res.body.user.id as number;

  if (opts.admin) await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  if (opts.kyc) await pool.query(`UPDATE users SET kyc_status = 'verified' WHERE id = $1`, [id]);
  if (opts.balance) {
    await pool.query(`UPDATE wallets SET balance = balance + $2 WHERE user_id = $1`, [id, opts.balance]);
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, note)
       SELECT $1, 'adjustment', $2, balance, 'test funding' FROM wallets WHERE user_id = $1`,
      [id, opts.balance]
    );
  }
  return { id, token: res.body.accessToken, refreshToken: res.body.refreshToken, username, email };
}

export const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

export async function balanceOf(userId: number): Promise<string> {
  const r = await pool.query<{ balance: string }>('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
  return r.rows[0].balance;
}

/** Ledger integrity: cached balance must equal the sum of the ledger for every wallet. */
export async function assertLedgerConsistent(): Promise<void> {
  const r = await pool.query(
    `SELECT w.user_id, w.balance, COALESCE(SUM(t.amount), 0) AS ledger
     FROM wallets w LEFT JOIN transactions t ON t.user_id = w.user_id
     GROUP BY w.user_id, w.balance HAVING w.balance <> COALESCE(SUM(t.amount), 0)`
  );
  if (r.rowCount) throw new Error(`Ledger mismatch: ${JSON.stringify(r.rows)}`);
}

export interface Fixture {
  eventId: number;
  odds: Record<string, number>; // e.g. "1X2:HOME" -> oddsId, "OVER_UNDER:2.5:OVER" -> oddsId
}

/** Creates an upcoming EPL fixture with a full set of markets via the admin API. */
export async function createFixture(admin: TestUser, home = 'Arsenal', away = 'Chelsea', league = 'premier-league'): Promise<Fixture> {
  const l = await pool.query<{ id: number }>('SELECT id FROM leagues WHERE slug = $1', [league]);
  const res = await api()
    .post('/api/v1/admin/events')
    .set(auth(admin))
    .send({
      leagueId: l.rows[0].id,
      homeTeam: home,
      awayTeam: away,
      startTime: new Date(Date.now() + 3600_000).toISOString(),
      markets: [
        {
          type: '1X2',
          odds: [
            { selection: 'HOME', price: 2.0 },
            { selection: 'DRAW', price: 3.4 },
            { selection: 'AWAY', price: 3.8 },
          ],
        },
        {
          type: 'OVER_UNDER',
          line: 2.5,
          odds: [
            { selection: 'OVER', price: 1.9 },
            { selection: 'UNDER', price: 1.9 },
          ],
        },
        {
          type: 'BTTS',
          odds: [
            { selection: 'YES', price: 1.8 },
            { selection: 'NO', price: 2.0 },
          ],
        },
        {
          type: 'DRAW_NO_BET',
          odds: [
            { selection: 'HOME', price: 1.5 },
            { selection: 'AWAY', price: 2.6 },
          ],
        },
        {
          type: 'HT_1X2',
          odds: [
            { selection: 'HOME', price: 2.8 },
            { selection: 'DRAW', price: 2.1 },
            { selection: 'AWAY', price: 4.5 },
          ],
        },
        {
          type: 'CORRECT_SCORE',
          odds: [
            { selection: '1-0', price: 7.5 },
            { selection: '2-1', price: 9 },
            { selection: 'OTHER', price: 3 },
          ],
        },
      ],
    })
    .expect(201);

  const odds: Record<string, number> = {};
  for (const m of res.body.markets) {
    for (const o of m.odds)
      odds[[m.type, m.line !== null ? Number(m.line) : null, o.selection].filter((x) => x !== null).join(':')] = o.oddsId;
  }
  return { eventId: res.body.id, odds };
}

/** Moves an event's kick-off into the past so a result can be recorded. */
export async function kickOff(eventId: number): Promise<void> {
  await pool.query(`UPDATE events SET start_time = now() - interval '2 hours', status = 'live' WHERE id = $1`, [eventId]);
}
