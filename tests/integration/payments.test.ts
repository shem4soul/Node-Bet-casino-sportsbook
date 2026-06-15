import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { reconcilePendingDeposits } from '../../src/services/paymentService';
import { FakePaystack, sign, startFakePaystack } from '../helpers/fakePaystack';
import { api, assertLedgerConsistent, auth, balanceOf, createUser, resetDb } from '../helpers/testApp';

let paystack: FakePaystack;
beforeAll(async () => {
  paystack = await startFakePaystack();
});
afterAll(() => paystack.close());
beforeEach(resetDb);

function webhook(payload: object, signature?: string) {
  const body = JSON.stringify(payload);
  return api()
    .post('/api/v1/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature ?? sign(body))
    .send(body);
}

async function startDeposit(user: Awaited<ReturnType<typeof createUser>>, amount: number) {
  const res = await api().post('/api/v1/wallet/deposits').set(auth(user)).send({ amount }).expect(201);
  expect(res.body.authorizationUrl).toContain('checkout.paystack.test');
  return res.body.reference as string;
}

describe('Paystack deposits', () => {
  it('credits the wallet exactly once on a verified charge.success webhook', async () => {
    const u = await createUser();
    const ref = await startDeposit(u, 5000);
    expect(paystack.charges.get(ref)!.amount).toBe(500_000); // kobo
    paystack.pay(ref);

    const evt = { event: 'charge.success', data: { reference: ref, amount: 500_000, currency: 'NGN', status: 'success' } };
    await webhook(evt).expect(200);
    await webhook(evt).expect(200); // Paystack retry -> idempotent
    await Promise.all([webhook(evt), webhook(evt), webhook(evt)]);

    expect(await balanceOf(u.id)).toBe('5000.00');
    const dep = await api().get(`/api/v1/wallet/deposits/${ref}`).set(auth(u)).expect(200);
    expect(dep.body).toMatchObject({ status: 'success', channel: 'card', amount: '5000.00' });
    await assertLedgerConsistent();
  });

  it('acknowledges (200) and ignores events for references it did not create', async () => {
    const res = await webhook({ event: 'charge.success', data: { reference: 'someone_elses_ref_123', amount: 100 } }).expect(200);
    expect(res.body).toEqual({ received: true });
    await webhook({ event: 'transfer.success', data: { reference: 'not_ours_456' } }).expect(200);
  });

  it('rejects webhooks with a bad signature', async () => {
    const res = await webhook({ event: 'charge.success', data: { reference: 'x' } }, 'deadbeef').expect(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('does not credit when Paystack verification disagrees with the webhook (forged/replayed payload)', async () => {
    const u = await createUser();
    const ref = await startDeposit(u, 5000);
    // Webhook claims success, but Paystack says the charge was never paid.
    await webhook({ event: 'charge.success', data: { reference: ref, amount: 500_000, status: 'success' } }).expect(200);
    expect(await balanceOf(u.id)).toBe('0.00');
  });

  it('fails the intent if the paid amount does not match', async () => {
    const u = await createUser();
    const ref = await startDeposit(u, 5000);
    paystack.pay(ref, { amount: 100 }); // paid ₦1 instead of ₦5,000
    await webhook({ event: 'charge.success', data: { reference: ref } }).expect(200);
    expect(await balanceOf(u.id)).toBe('0.00');
    const dep = await api().get(`/api/v1/wallet/deposits/${ref}`).set(auth(u)).expect(200);
    expect(dep.body.status).toBe('failed');
  });

  it('client-side verify credits when the webhook was missed, and only once', async () => {
    const u = await createUser();
    const ref = await startDeposit(u, 2500);
    paystack.pay(ref);
    const [a, b] = await Promise.all([
      api().post(`/api/v1/wallet/deposits/${ref}/verify`).set(auth(u)),
      api().post(`/api/v1/wallet/deposits/${ref}/verify`).set(auth(u)),
    ]);
    expect(a.body.status).toBe('success');
    expect(b.body.status).toBe('success');
    expect(await balanceOf(u.id)).toBe('2500.00');
  });

  it('reconciliation job picks up paid deposits with no webhook', async () => {
    const u = await createUser();
    const ref = await startDeposit(u, 1000);
    paystack.pay(ref);
    await pool.query(`UPDATE payment_intents SET created_at = now() - interval '10 minutes' WHERE reference = $1`, [ref]);
    const r = await reconcilePendingDeposits();
    expect(r.credited).toBe(1);
    expect(await balanceOf(u.id)).toBe('1000.00');
  });

  it("users can't see other users' deposits", async () => {
    const a = await createUser();
    const b = await createUser();
    const ref = await startDeposit(a, 1000);
    await api().get(`/api/v1/wallet/deposits/${ref}`).set(auth(b)).expect(404);
  });

  it('enforces minimum deposit', async () => {
    const u = await createUser();
    const res = await api().post('/api/v1/wallet/deposits').set(auth(u)).send({ amount: 50 }).expect(400);
    expect(res.body.error.code).toBe('DEPOSIT_TOO_SMALL');
  });
});

describe('responsible gambling', () => {
  it('blocks deposits over a daily limit, and stages limit increases', async () => {
    const u = await createUser();
    await api().put('/api/v1/account/limits/deposit').set(auth(u)).send({ period: 'daily', amount: 3000 }).expect(200);
    await startDeposit(u, 2000);
    const res = await api().post('/api/v1/wallet/deposits').set(auth(u)).send({ amount: 1500 }).expect(422);
    expect(res.body.error.code).toBe('DEPOSIT_LIMIT_EXCEEDED');

    const raise = await api().put('/api/v1/account/limits/deposit').set(auth(u)).send({ period: 'daily', amount: 50000 }).expect(200);
    expect(raise.body.effect).toBe('scheduled'); // cooling-off before it applies
    await api().post('/api/v1/wallet/deposits').set(auth(u)).send({ amount: 1500 }).expect(422);

    const lower = await api().put('/api/v1/account/limits/deposit').set(auth(u)).send({ period: 'daily', amount: 2500 }).expect(200);
    expect(lower.body.effect).toBe('immediate');
  });

  it('self-excluded users cannot deposit or bet, but can still log in', async () => {
    const u = await createUser({ balance: 5000 });
    await api().post('/api/v1/account/self-exclusion').set(auth(u)).send({ days: 30, confirm: true }).expect(200);
    const res = await api().post('/api/v1/wallet/deposits').set(auth(u)).send({ amount: 1000 }).expect(403);
    expect(res.body.error.code).toBe('SELF_EXCLUDED');
    await api()
      .post('/api/v1/sports/bets')
      .set(auth(u))
      .send({ stake: 100, selections: [{ oddsId: 1 }] })
      .expect(403);
    await api().get('/api/v1/wallet').set(auth(u)).expect(200);
  });
});
