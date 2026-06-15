import express from 'express';
import http from 'http';
import crypto from 'crypto';

/**
 * In-process stand-in for api.paystack.co used by integration tests. It
 * implements just the endpoints our client calls, with the same envelope
 * ({ status, message, data }) and amounts in kobo, and lets tests drive
 * outcomes (mark a charge paid, make transfers fail, ...).
 */
export interface FakePaystack {
  url: string;
  charges: Map<string, { amount: number; email: string; status: string; currency: string }>;
  transfers: Map<string, { amount: number; recipient: string; status: string }>;
  pay(reference: string, overrides?: Partial<{ amount: number; status: string }>): void;
  transferOutcome: 'pending' | 'success' | 'reject' | 'network';
  close(): Promise<void>;
}

export const SECRET = 'sk_test_fake_secret_for_tests';

export function sign(body: string): string {
  return crypto.createHmac('sha512', SECRET).update(body).digest('hex');
}

export async function startFakePaystack(port = 45999): Promise<FakePaystack> {
  const app = express();
  app.use(express.json());
  const ok = (data: unknown) => ({ status: true, message: 'ok', data });

  const state: FakePaystack = {
    url: `http://127.0.0.1:${port}`,
    charges: new Map(),
    transfers: new Map(),
    transferOutcome: 'pending',
    pay(reference, overrides = {}) {
      const c = state.charges.get(reference);
      if (!c) throw new Error(`no charge ${reference}`);
      Object.assign(c, { status: 'success' }, overrides);
    },
    close: async () => undefined,
  };

  app.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) return res.status(401).json({ status: false, message: 'Invalid key' });
    next();
  });

  app.post('/transaction/initialize', (req, res) => {
    const { reference, amount, email, currency } = req.body;
    state.charges.set(reference, { amount, email, status: 'abandoned', currency: currency || 'NGN' });
    res.json(ok({ authorization_url: `https://checkout.paystack.test/${reference}`, access_code: `ac_${reference}`, reference }));
  });

  app.get('/transaction/verify/:ref', (req, res) => {
    const c = state.charges.get(req.params.ref);
    if (!c) return res.status(404).json({ status: false, message: 'Transaction reference not found' });
    res.json(
      ok({
        id: 1,
        reference: req.params.ref,
        status: c.status,
        amount: c.amount,
        currency: c.currency,
        channel: 'card',
        paid_at: new Date().toISOString(),
      })
    );
  });

  app.get('/bank', (_req, res) => {
    res.json(
      ok([
        { id: 1, name: 'Access Bank', slug: 'access-bank', code: '044', currency: 'NGN', active: true },
        { id: 2, name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', code: '058', currency: 'NGN', active: true },
      ])
    );
  });

  app.get('/bank/resolve', (req, res) => {
    if (req.query.account_number === '0000000000')
      return res.status(422).json({ status: false, message: 'Could not resolve account name' });
    res.json(ok({ account_number: req.query.account_number, account_name: 'CHIDI OKAFOR' }));
  });

  app.post('/transferrecipient', (req, res) => {
    res.json(ok({ recipient_code: `RCP_${req.body.account_number}` }));
  });

  app.post('/transfer', (req, res) => {
    const { reference, amount, recipient } = req.body;
    if (state.transferOutcome === 'reject')
      return res.status(400).json({ status: false, message: 'Your balance is not enough to fulfil this request' });
    if (state.transferOutcome === 'network') {
      req.socket.destroy();
      return;
    }
    const status = state.transferOutcome === 'success' ? 'success' : 'pending';
    state.transfers.set(reference, { amount, recipient, status });
    res.json(ok({ reference, transfer_code: `TRF_${reference.slice(-8)}`, status, amount, currency: 'NGN' }));
  });

  app.get('/transfer/verify/:ref', (req, res) => {
    const t = state.transfers.get(req.params.ref);
    if (!t) return res.status(404).json({ status: false, message: 'Transfer not found' });
    res.json(ok({ reference: req.params.ref, transfer_code: 'TRF_x', status: t.status, amount: t.amount, currency: 'NGN' }));
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
