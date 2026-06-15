import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { FakePaystack, sign, startFakePaystack } from '../helpers/fakePaystack';
import { allOperations, checkAgainstSpec, contractErrors, coverage, loadSpec } from '../helpers/openapi';
import { api, createFixture, createUser, kickOff, resetDb, TestUser } from '../helpers/testApp';

/**
 * Drives every documented operation against the real app and validates each
 * response against src/docs/openapi.yaml. If the code changes a response
 * shape (or adds an endpoint) without updating the docs, this test fails.
 */

let paystack: FakePaystack;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface CallOpts {
  as?: TestUser;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
  expect?: number;
}

async function call(method: Method, url: string, opts: CallOpts = {}) {
  let req = api()[method](url);
  if (opts.as) req = req.set('Authorization', `Bearer ${opts.as.token}`);
  for (const [k, v] of Object.entries(opts.headers ?? {})) req = req.set(k, v);
  const res =
    opts.raw !== undefined
      ? await req.set('Content-Type', 'application/json').send(opts.raw)
      : await (opts.body !== undefined ? req.send(opts.body as object) : req);
  if (opts.expect !== undefined && res.status !== opts.expect) {
    throw new Error(`${method.toUpperCase()} ${url}: expected ${opts.expect}, got ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  }
  checkAgainstSpec(method, url, res as any);
  return res;
}

beforeAll(async () => {
  await loadSpec();
  paystack = await startFakePaystack();
  await resetDb();
});
afterAll(() => paystack.close());

describe('OpenAPI contract', () => {
  it('every documented operation returns responses that match the docs', async () => {
    // ---------------- Operations
    await call('get', '/health', { expect: 200 });
    await call('get', '/ready', { expect: 200 });
    await call('get', '/metrics', { expect: 200 });

    // ---------------- Auth
    const reg = await call('post', '/api/v1/auth/register', {
      body: {
        username: 'contract_user',
        email: 'contract@example.com',
        password: 'Passw0rd!',
        dateOfBirth: '1991-07-07',
        phone: '+2348030000001',
        firstName: 'Ada',
      },
      expect: 201,
    });
    await call('post', '/api/v1/auth/register', {
      body: { username: 'contract_user', email: 'contract@example.com', password: 'Passw0rd!', dateOfBirth: '1991-07-07' },
      expect: 409,
    });
    await call('post', '/api/v1/auth/register', {
      body: { username: 'kid_user', email: 'kid@example.com', password: 'Passw0rd!', dateOfBirth: '2015-01-01' },
      expect: 403,
    });
    await call('post', '/api/v1/auth/register', { body: { username: 'x' }, expect: 400 });
    const user: TestUser = {
      id: reg.body.user.id,
      token: reg.body.accessToken,
      refreshToken: reg.body.refreshToken,
      username: 'contract_user',
      email: 'contract@example.com',
    };

    await call('post', '/api/v1/auth/login', { body: { identifier: 'contract_user', password: 'nope' }, expect: 401 });
    const login = await call('post', '/api/v1/auth/login', {
      body: { identifier: 'contract@example.com', password: 'Passw0rd!' },
      expect: 200,
    });
    const refreshed = await call('post', '/api/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken }, expect: 200 });
    await call('post', '/api/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken }, expect: 401 });
    await call('post', '/api/v1/auth/logout', { body: { refreshToken: refreshed.body.refreshToken }, expect: 204 });
    await call('post', '/api/v1/auth/forgot-password', { body: { email: 'contract@example.com' }, expect: 202 });
    await call('post', '/api/v1/auth/reset-password', {
      body: { token: 'definitely-not-a-valid-token-0000', newPassword: 'N3wPassw0rd' },
      expect: 400,
    });

    // ---------------- Account
    await call('get', '/api/v1/account/me', { expect: 401 });
    await call('get', '/api/v1/account/me', { as: user, expect: 200 });
    await call('patch', '/api/v1/account/me', { as: user, body: { lastName: 'Obi' }, expect: 200 });
    await call('post', '/api/v1/account/change-password', {
      as: user,
      body: { currentPassword: 'wrong', newPassword: 'N3wPassw0rd' },
      expect: 401,
    });
    await call('put', '/api/v1/account/limits/deposit', { as: user, body: { period: 'weekly', amount: 500000 }, expect: 200 });
    await call('get', '/api/v1/account/limits', { as: user, expect: 200 });

    // ---------------- Admin + fixtures
    const admin = await createUser({ admin: true });
    await call('get', '/api/v1/admin/users', { as: user, expect: 403 });
    const fx = await createFixture(admin, 'Arsenal', 'Chelsea');
    const fx2 = await createFixture(admin, 'Enyimba', 'Kano Pillars', 'npfl');
    const fx3 = await createFixture(admin, 'Real Madrid', 'Barcelona', 'la-liga');
    const leagueId = (await pool.query(`SELECT id FROM leagues WHERE slug = 'serie-a'`)).rows[0].id;
    await call('post', '/api/v1/admin/events', {
      as: admin,
      body: {
        leagueId,
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        startTime: new Date(Date.now() + 86400_000).toISOString(),
        markets: [
          {
            type: '1X2',
            odds: [
              { selection: 'HOME', price: 2.1 },
              { selection: 'DRAW', price: 3.3 },
              { selection: 'AWAY', price: 3.4 },
            ],
          },
        ],
      },
      expect: 201,
    });

    // ---------------- Sports (public)
    await call('get', '/api/v1/sports', { expect: 200 });
    await call('get', '/api/v1/sports/markets', { expect: 200 });
    await call('get', '/api/v1/sports/leagues?featured=true', { expect: 200 });
    await call('get', '/api/v1/sports/leagues/premier-league', { expect: 200 });
    await call('get', '/api/v1/sports/leagues/nope', { expect: 404 });
    await call('get', '/api/v1/sports/leagues/npfl/events', { expect: 200 });
    await call('get', '/api/v1/sports/featured?perLeague=2', { expect: 200 });
    await call('get', '/api/v1/sports/events?search=Arsenal', { expect: 200 });
    await call('get', '/api/v1/sports/events?status=bogus', { expect: 400 });
    await call('get', `/api/v1/sports/events/${fx.eventId}`, { expect: 200 });
    await call('get', '/api/v1/sports/events/999999', { expect: 404 });

    // ---------------- Wallet: deposits via fake Paystack
    await call('get', '/api/v1/wallet', { as: user, expect: 200 });
    const dep = await call('post', '/api/v1/wallet/deposits', { as: user, body: { amount: 50000 }, expect: 201 });
    await call('post', '/api/v1/wallet/deposits', { as: user, body: { amount: 10 }, expect: 400 });
    paystack.pay(dep.body.reference);
    const webhookBody = JSON.stringify({
      event: 'charge.success',
      data: { reference: dep.body.reference, amount: 5_000_000, status: 'success' },
    });
    await call('post', '/api/v1/webhooks/paystack', {
      raw: webhookBody,
      headers: { 'x-paystack-signature': sign(webhookBody) },
      expect: 200,
    });
    await call('post', '/api/v1/webhooks/paystack', { raw: webhookBody, headers: { 'x-paystack-signature': 'bad' }, expect: 401 });
    await call('post', `/api/v1/wallet/deposits/${dep.body.reference}/verify`, { as: user, expect: 200 });
    await call('get', `/api/v1/wallet/deposits/${dep.body.reference}`, { as: user, expect: 200 });
    await call('get', '/api/v1/wallet/deposits/dep_unknown_reference_0000', { as: user, expect: 404 });
    await call('get', '/api/v1/wallet/deposits', { as: user, expect: 200 });
    await call('get', '/api/v1/wallet/transactions?limit=5', { as: user, expect: 200 });

    // ---------------- Bets
    const single = await call('post', '/api/v1/sports/bets', {
      as: user,
      headers: { 'Idempotency-Key': 'contract-1' },
      body: { stake: 1000, selections: [{ oddsId: fx.odds['1X2:HOME'], price: 2.0 }] },
      expect: 201,
    });
    await call('post', '/api/v1/sports/bets', {
      as: user,
      headers: { 'Idempotency-Key': 'contract-1' },
      body: { stake: 1000, selections: [{ oddsId: fx.odds['1X2:HOME'] }] },
      expect: 200,
    });
    await call('post', '/api/v1/sports/bets', {
      as: user,
      body: { stake: 1000, selections: [{ oddsId: fx.odds['1X2:AWAY'], price: 9.99 }], acceptOddsChanges: 'none' },
      expect: 409,
    });
    await call('post', '/api/v1/sports/bets', { as: user, body: { stake: 5, selections: [{ oddsId: fx.odds['1X2:AWAY'] }] }, expect: 400 });
    await call('post', '/api/v1/sports/bets', { body: { stake: 100, selections: [{ oddsId: 1 }] }, expect: 401 });
    const multi = await call('post', '/api/v1/sports/bets', {
      as: user,
      body: { stake: 500, selections: [{ oddsId: fx2.odds['BTTS:YES'] }, { oddsId: fx3.odds['OVER_UNDER:2.5:OVER'] }] },
      expect: 201,
    });
    await call('get', '/api/v1/sports/bets?status=pending', { as: user, expect: 200 });
    await call('get', `/api/v1/sports/bets/${single.body.id}`, { as: user, expect: 200 });
    await call('get', '/api/v1/sports/bets/999999', { as: user, expect: 404 });
    await call('get', `/api/v1/sports/bets/${multi.body.id}/cashout`, { as: user, expect: 200 });
    await call('post', `/api/v1/sports/bets/${multi.body.id}/cashout`, { as: user, body: { expectedAmount: 999999 }, expect: 409 });
    await call('post', `/api/v1/sports/bets/${multi.body.id}/cashout`, { as: user, body: {}, expect: 200 });
    const code = await call('post', '/api/v1/sports/booking-codes', {
      body: { oddsIds: [fx.odds['1X2:DRAW'], fx2.odds['1X2:HOME']] },
      expect: 201,
    });
    await call('get', `/api/v1/sports/booking-codes/${code.body.code}`, { expect: 200 });
    await call('get', '/api/v1/sports/booking-codes/ZZZZZZZ', { expect: 404 });

    // ---------------- Casino
    await call('get', '/api/v1/casino/games', { expect: 200 });
    await call('get', '/api/v1/casino/fairness', { as: user, expect: 200 });
    await call('post', '/api/v1/casino/dice/play', { as: user, body: { stake: 100, target: 50, direction: 'over' }, expect: 200 });
    await call('post', '/api/v1/casino/coinflip/play', { as: user, body: { stake: 100, call: 'tails' }, expect: 200 });
    await call('post', '/api/v1/casino/slots/play', { as: user, body: { stake: 50 }, expect: 200 });
    await call('post', '/api/v1/casino/dice/play', { as: user, body: { stake: 100, target: 99, direction: 'over' }, expect: 400 });
    await call('post', '/api/v1/casino/fairness/rotate', { as: user, body: {}, expect: 200 });
    await call('get', '/api/v1/casino/history', { as: user, expect: 200 });

    // ---------------- Bank accounts & withdrawals
    await call('get', '/api/v1/wallet/banks', { as: user, expect: 200 });
    const bank = await call('post', '/api/v1/wallet/bank-accounts', {
      as: user,
      body: { bankCode: '058', accountNumber: '0123456789' },
      expect: 201,
    });
    await call('post', '/api/v1/wallet/bank-accounts', { as: user, body: { bankCode: '058', accountNumber: '0000000000' }, expect: 400 });
    const bank2 = await call('post', '/api/v1/wallet/bank-accounts', {
      as: user,
      body: { bankCode: '044', accountNumber: '1234567890' },
      expect: 201,
    });
    await call('get', '/api/v1/wallet/bank-accounts', { as: user, expect: 200 });
    await call('delete', `/api/v1/wallet/bank-accounts/${bank2.body.id}`, { as: user, expect: 204 });
    await call('post', '/api/v1/wallet/withdrawals', { as: user, body: { amount: 2000, bankAccountId: bank.body.id }, expect: 403 }); // KYC
    await pool.query(`UPDATE users SET kyc_status = 'verified' WHERE id = $1`, [user.id]);
    const wd = await call('post', '/api/v1/wallet/withdrawals', {
      as: user,
      body: { amount: 2000, bankAccountId: bank.body.id },
      expect: 201,
    });
    await call('get', '/api/v1/wallet/withdrawals', { as: user, expect: 200 });
    await call('get', `/api/v1/wallet/withdrawals/${wd.body.id}`, { as: user, expect: 200 });
    await call('get', '/api/v1/wallet/withdrawals/999999', { as: user, expect: 404 });

    // ---------------- Admin
    await call('get', '/api/v1/admin/users?search=contract', { as: admin, expect: 200 });
    await call('get', `/api/v1/admin/users/${user.id}`, { as: admin, expect: 200 });
    await call('patch', `/api/v1/admin/users/${user.id}/kyc`, {
      as: admin,
      body: { kycStatus: 'verified', note: 'BVN matched' },
      expect: 200,
    });
    await call('post', `/api/v1/admin/users/${user.id}/adjust-balance`, {
      as: admin,
      body: { amount: 250000, note: 'Promo credit for contract test' },
      expect: 200,
    });
    await call('post', `/api/v1/admin/users/${user.id}/adjust-balance`, {
      as: admin,
      body: { amount: -99999999, note: 'Too large debit' },
      expect: 400,
    });

    // big withdrawal -> review queue -> approve / reject
    const big1 = await call('post', '/api/v1/wallet/withdrawals', {
      as: user,
      body: { amount: 200000, bankAccountId: bank.body.id },
      expect: 201,
    });
    await call('get', '/api/v1/admin/withdrawals?status=pending_review', { as: admin, expect: 200 });
    await call('post', `/api/v1/admin/withdrawals/${big1.body.id}/reject`, {
      as: admin,
      body: { reason: 'Needs source-of-funds check' },
      expect: 200,
    });
    await call('post', `/api/v1/admin/withdrawals/${big1.body.id}/approve`, { as: admin, expect: 409 });
    const big2 = await call('post', '/api/v1/wallet/withdrawals', {
      as: user,
      body: { amount: 200000, bankAccountId: bank.body.id },
      expect: 201,
    });
    await call('post', `/api/v1/admin/withdrawals/${big2.body.id}/approve`, { as: admin, expect: 200 });

    await call('post', '/api/v1/admin/sports', { as: admin, body: { slug: 'basketball', name: 'Basketball' }, expect: 201 });
    await call('get', '/api/v1/admin/leagues', { as: admin, expect: 200 });
    const sportId = (await pool.query(`SELECT id FROM sports WHERE slug = 'football'`)).rows[0].id;
    const league = await call('post', '/api/v1/admin/leagues', {
      as: admin,
      body: { sportId, slug: 'caf-champions-league', name: 'CAF Champions League', country: 'Africa' },
      expect: 201,
    });
    await call('post', '/api/v1/admin/leagues', { as: admin, body: { sportId, slug: 'caf-champions-league', name: 'Dup' }, expect: 409 });
    await call('patch', `/api/v1/admin/leagues/${league.body.id}`, {
      as: admin,
      body: { isFeatured: true, providerSlug: 'africa-caf-champions-league' },
      expect: 200,
    });

    await call('get', '/api/v1/admin/events?needsResult=false', { as: admin, expect: 200 });
    await call('patch', `/api/v1/admin/events/${fx3.eventId}`, { as: admin, body: { isFeatured: true }, expect: 200 });
    const mk = await call('post', `/api/v1/admin/events/${fx3.eventId}/markets`, {
      as: admin,
      body: {
        type: 'ODD_EVEN',
        odds: [
          { selection: 'ODD', price: 1.9 },
          { selection: 'EVEN', price: 1.9 },
        ],
      },
      expect: 201,
    });
    await call('post', `/api/v1/admin/events/${fx3.eventId}/markets`, {
      as: admin,
      body: {
        type: 'ODD_EVEN',
        odds: [
          { selection: 'ODD', price: 1.9 },
          { selection: 'EVEN', price: 1.9 },
        ],
      },
      expect: 409,
    });
    await call('post', `/api/v1/admin/markets/${mk.body.marketId}/suspend`, { as: admin, expect: 200 });
    await call('post', `/api/v1/admin/markets/${mk.body.marketId}/reopen`, { as: admin, expect: 200 });
    const csMarket = (await pool.query(`SELECT market_id FROM odds WHERE id = $1`, [fx3.odds['CORRECT_SCORE:1-0']])).rows[0].market_id;
    await call('post', `/api/v1/admin/markets/${csMarket}/odds`, { as: admin, body: { selection: '3-1', price: 15 }, expect: 201 });
    await call('post', `/api/v1/admin/markets/${csMarket}/odds`, { as: admin, body: { selection: 'three-one', price: 15 }, expect: 400 });
    await call('patch', `/api/v1/admin/odds/${fx3.odds['1X2:HOME']}`, { as: admin, body: { price: 2.05 }, expect: 200 });
    await call('post', `/api/v1/admin/markets/${mk.body.marketId}/settle`, { as: admin, body: { winningSelection: 'ODD' }, expect: 200 });
    await call('post', `/api/v1/admin/markets/${mk.body.marketId}/settle`, { as: admin, body: { winningSelection: 'ODD' }, expect: 409 });

    await call('post', `/api/v1/admin/events/${fx.eventId}/result`, { as: admin, body: { homeScore: 2, awayScore: 1 }, expect: 409 }); // not started
    await kickOff(fx.eventId);
    await call('post', `/api/v1/admin/events/${fx.eventId}/result`, {
      as: admin,
      body: { homeScore: 2, awayScore: 1, htHomeScore: 1, htAwayScore: 1 },
      expect: 200,
    });
    await call('post', `/api/v1/admin/events/${fx2.eventId}/cancel`, { as: admin, body: { reason: 'Waterlogged pitch' }, expect: 200 });
    await call('post', `/api/v1/admin/events/${fx2.eventId}/cancel`, { as: admin, body: { reason: 'Again' }, expect: 409 });

    await call('post', '/api/v1/admin/odds-sync', { as: admin, body: { leagues: ['npfl'] }, expect: 200 }); // feed unreachable -> summary with errors
    await call('get', '/api/v1/admin/odds-provider/leagues?sport=football', { as: admin, expect: 502 });
    await call('get', '/api/v1/admin/bets?status=won', { as: admin, expect: 200 });
    await call('get', '/api/v1/admin/reports/summary', { as: admin, expect: 200 });
    await call('get', `/api/v1/admin/reports/liability?eventId=${fx3.eventId}`, { as: admin, expect: 200 });
    await call('get', '/api/v1/admin/audit-logs?limit=10', { as: admin, expect: 200 });
    await call('patch', `/api/v1/admin/users/${user.id}/status`, {
      as: admin,
      body: { status: 'suspended', reason: 'Contract test suspension' },
      expect: 200,
    });

    // ---------------- Responsible gambling + session endpoints (last: they lock the user out)
    await call('post', '/api/v1/account/change-password', {
      as: user,
      body: { currentPassword: 'Passw0rd!', newPassword: 'N3wPassw0rd' },
      expect: 200,
    });
    await call('post', '/api/v1/account/self-exclusion', { as: user, body: { days: 7, confirm: true }, expect: 200 });
    await call('post', '/api/v1/auth/logout-all', { as: user, expect: 204 });

    expect(contractErrors, `Responses that don't match the docs:\n\n${contractErrors.join('\n\n')}`).toEqual([]);

    // ---------------- Coverage: every documented operation was exercised
    const missing = allOperations().filter((op) => !coverage.has(op));
    expect(missing, `Operations never exercised by the contract test:\n${missing.join('\n')}`).toEqual([]);
  });
});
