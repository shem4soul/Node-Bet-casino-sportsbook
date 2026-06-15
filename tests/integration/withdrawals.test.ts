import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/config/db';
import { reconcileWithdrawals } from '../../src/services/withdrawalService';
import { FakePaystack, sign, startFakePaystack } from '../helpers/fakePaystack';
import { api, assertLedgerConsistent, auth, balanceOf, createUser, resetDb, TestUser } from '../helpers/testApp';

let paystack: FakePaystack;
beforeAll(async () => {
  paystack = await startFakePaystack();
});
afterAll(() => paystack.close());
beforeEach(async () => {
  await resetDb();
  paystack.transferOutcome = 'pending';
  paystack.transfers.clear();
});

const webhook = (payload: object) => {
  const body = JSON.stringify(payload);
  return api().post('/api/v1/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);
};

async function withBank(u: TestUser) {
  const res = await api()
    .post('/api/v1/wallet/bank-accounts')
    .set(auth(u))
    .send({ bankCode: '058', accountNumber: '0123456789' })
    .expect(201);
  expect(res.body).toMatchObject({ bankName: 'Guaranty Trust Bank', accountName: 'CHIDI OKAFOR', isDefault: true });
  return res.body.id as number;
}

const withdraw = (u: TestUser, amount: number, bankAccountId: number) =>
  api().post('/api/v1/wallet/withdrawals').set(auth(u)).send({ amount, bankAccountId });

describe('bank accounts', () => {
  it('lists banks and rejects unresolvable account numbers', async () => {
    const u = await createUser();
    const banks = await api().get('/api/v1/wallet/banks').set(auth(u)).expect(200);
    expect(banks.body.map((b: any) => b.code)).toContain('044');
    const bad = await api()
      .post('/api/v1/wallet/bank-accounts')
      .set(auth(u))
      .send({ bankCode: '058', accountNumber: '0000000000' })
      .expect(400);
    expect(bad.body.error.code).toBe('ACCOUNT_UNRESOLVED');
  });
});

describe('withdrawals', () => {
  it('requires KYC', async () => {
    const u = await createUser({ balance: 50_000 });
    const bank = await withBank(u);
    const res = await withdraw(u, 5000, bank).expect(403);
    expect(res.body.error.code).toBe('KYC_REQUIRED');
  });

  it('holds funds, sends a Paystack transfer, and completes on transfer.success', async () => {
    const u = await createUser({ balance: 50_000, kyc: true });
    const bank = await withBank(u);
    const res = await withdraw(u, 20_000, bank).expect(201);
    expect(res.body).toMatchObject({ status: 'processing', amount: '20000.00', accountNumber: '******6789' });
    expect(await balanceOf(u.id)).toBe('30000.00');
    expect(paystack.transfers.get(res.body.reference)).toMatchObject({ amount: 2_000_000, recipient: 'RCP_0123456789' });

    await webhook({ event: 'transfer.success', data: { reference: res.body.reference, status: 'success' } }).expect(200);
    const w = await api().get(`/api/v1/wallet/withdrawals/${res.body.id}`).set(auth(u)).expect(200);
    expect(w.body.status).toBe('success');
    expect(await balanceOf(u.id)).toBe('30000.00');
  });

  it('refunds on transfer.failed / transfer.reversed (exactly once)', async () => {
    const u = await createUser({ balance: 50_000, kyc: true });
    const bank = await withBank(u);
    const a = (await withdraw(u, 10_000, bank).expect(201)).body;
    const b = (await withdraw(u, 15_000, bank).expect(201)).body;
    expect(await balanceOf(u.id)).toBe('25000.00');

    await webhook({ event: 'transfer.failed', data: { reference: a.reference, reason: 'Account dormant' } }).expect(200);
    await webhook({ event: 'transfer.failed', data: { reference: a.reference } }).expect(200); // retry
    await webhook({ event: 'transfer.reversed', data: { reference: b.reference } }).expect(200);
    expect(await balanceOf(u.id)).toBe('50000.00');
    await assertLedgerConsistent();
  });

  it('refunds immediately when Paystack definitively rejects the transfer', async () => {
    const u = await createUser({ balance: 50_000, kyc: true });
    const bank = await withBank(u);
    paystack.transferOutcome = 'reject';
    const res = await withdraw(u, 10_000, bank).expect(201);
    expect(res.body.status).toBe('failed');
    expect(await balanceOf(u.id)).toBe('50000.00');
  });

  it('keeps funds held on a network error and reconciles later (never double-pays)', async () => {
    const u = await createUser({ balance: 50_000, kyc: true });
    const bank = await withBank(u);
    paystack.transferOutcome = 'network';
    const res = await withdraw(u, 10_000, bank).expect(201);
    expect(res.body.status).toBe('processing');
    expect(await balanceOf(u.id)).toBe('40000.00');

    // Paystack never saw it (404 on verify) -> job re-queues and resends with the SAME reference.
    paystack.transferOutcome = 'success';
    await pool.query(`UPDATE withdrawals SET updated_at = now() - interval '15 minutes' WHERE id = $1`, [res.body.id]);
    await reconcileWithdrawals();
    const w = await api().get(`/api/v1/wallet/withdrawals/${res.body.id}`).set(auth(u)).expect(200);
    expect(w.body.status).toBe('success');
    expect(paystack.transfers.size).toBe(1);
    expect(await balanceOf(u.id)).toBe('40000.00');
  });

  it('large withdrawals wait for admin review; rejection refunds', async () => {
    const admin = await createUser({ admin: true });
    const u = await createUser({ balance: 500_000, kyc: true });
    const bank = await withBank(u);
    const big = (await withdraw(u, 250_000, bank).expect(201)).body;
    expect(big.status).toBe('pending_review');
    expect(paystack.transfers.size).toBe(0);

    const queue = await api().get('/api/v1/admin/withdrawals?status=pending_review').set(auth(admin)).expect(200);
    expect(queue.body).toHaveLength(1);
    await api()
      .post(`/api/v1/admin/withdrawals/${big.id}/reject`)
      .set(auth(admin))
      .send({ reason: 'Source of funds check failed' })
      .expect(200);
    expect(await balanceOf(u.id)).toBe('500000.00');

    const big2 = (await withdraw(u, 250_000, bank).expect(201)).body;
    const approved = await api().post(`/api/v1/admin/withdrawals/${big2.id}/approve`).set(auth(admin)).expect(200);
    expect(approved.body.status).toBe('processing');
    await api().post(`/api/v1/admin/withdrawals/${big2.id}/approve`).set(auth(admin)).expect(409);
  });

  it('cannot withdraw more than the balance', async () => {
    const u = await createUser({ balance: 5000, kyc: true });
    const bank = await withBank(u);
    expect((await withdraw(u, 6000, bank).expect(400)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await pool.query('SELECT 1 FROM withdrawals')).toHaveProperty('rowCount', 0);
  });
});
