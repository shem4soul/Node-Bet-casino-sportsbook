import { PoolClient } from 'pg';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { pool, query, queryOne, withTransaction, PG_UNIQUE_VIOLATION } from '../config/db';
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import { paymentReference } from '../lib/tokens';
import { isValidSignature, paystack, PaystackError, VerifiedTransaction } from '../integrations/paystack/paystackClient';
import * as walletRepo from '../repositories/walletRepository';
import { assertDepositAllowed } from './responsibleGamblingService';
import { handleTransferEvent } from './withdrawalService';
import { depositsCredited } from '../middleware/metrics';
import type { PaymentIntentRow } from '../types/db';
import type { Pagination } from '../lib/http';

const PROVIDER = 'paystack';

function publicIntent(i: PaymentIntentRow) {
  return {
    reference: i.reference,
    amount: i.amount,
    currency: i.currency,
    status: i.status,
    channel: i.channel,
    authorizationUrl: i.status === 'pending' ? i.authorization_url : null,
    paidAt: i.paid_at,
    createdAt: i.created_at,
  };
}

/**
 * Step 1: create a `pending` payment intent and a Paystack checkout session.
 * The wallet is NOT touched here — only a verified success credits it.
 */
export async function initializeDeposit(user: { id: number; email: string }, amount: number) {
  if (amount < env.MIN_DEPOSIT) throw badRequest(`Minimum deposit is ${env.MIN_DEPOSIT} ${env.CURRENCY}`, 'DEPOSIT_TOO_SMALL');
  if (amount > env.MAX_DEPOSIT) throw badRequest(`Maximum deposit is ${env.MAX_DEPOSIT} ${env.CURRENCY}`, 'DEPOSIT_TOO_LARGE');

  const reference = paymentReference('dep');
  const amountStr = fromMinor(toMinor(amount));

  await withTransaction(async (c) => {
    // Serialise per-user so two parallel requests can't both squeeze under a limit.
    await c.query('SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE', [user.id]);
    await assertDepositAllowed(c, user.id, amount);
    await c.query(
      `INSERT INTO payment_intents (user_id, provider, reference, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [user.id, PROVIDER, reference, amountStr, env.CURRENCY]
    );
  });

  try {
    const data = await paystack.initializeTransaction({
      email: user.email,
      amount: toMinor(amount),
      reference,
      currency: env.CURRENCY,
      callback_url: env.paystackCallbackUrl,
      metadata: { user_id: user.id, purpose: 'wallet_deposit' },
    });
    await pool.query('UPDATE payment_intents SET access_code = $2, authorization_url = $3 WHERE reference = $1', [
      reference,
      data.access_code,
      data.authorization_url,
    ]);
    return {
      reference,
      amount: amountStr,
      currency: env.CURRENCY,
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      publicKey: env.PAYSTACK_PUBLIC_KEY || undefined,
    };
  } catch (err) {
    await pool.query(`UPDATE payment_intents SET status = 'abandoned', gateway_response = $2 WHERE reference = $1 AND status = 'pending'`, [
      reference,
      JSON.stringify({ error: (err as Error).message }),
    ]);
    if (err instanceof AppError) throw err;
    throw new AppError('Could not start payment with Paystack', 502, 'PAYMENT_PROVIDER_ERROR');
  }
}

/**
 * Finalises a deposit from a Paystack-verified transaction. Idempotent: the
 * intent row is locked and only a `pending` intent can transition, so the
 * webhook, the client-side verify call and the reconciliation job can all
 * race safely — exactly one of them credits the wallet.
 */
export async function finalizeDeposit(c: PoolClient, tx: VerifiedTransaction) {
  const intent = await queryOne<PaymentIntentRow>(c, 'SELECT * FROM payment_intents WHERE reference = $1 FOR UPDATE', [tx.reference]);
  if (!intent) throw notFound('Payment reference');
  if (intent.status !== 'pending' && intent.status !== 'abandoned') return { status: intent.status, credited: false, alreadyFinal: true };

  if (tx.status === 'success') {
    if (Number(tx.amount) !== toMinor(intent.amount) || (tx.currency && tx.currency !== intent.currency)) {
      await c.query(`UPDATE payment_intents SET status = 'failed', gateway_response = $2 WHERE id = $1`, [
        intent.id,
        JSON.stringify({ ...tx, mismatch: true }),
      ]);
      logger.error({ reference: tx.reference, expected: intent.amount, got: tx.amount }, 'Deposit amount/currency mismatch');
      return { status: 'failed' as const, credited: false };
    }
    await c.query(
      `UPDATE payment_intents SET status = 'success', channel = $2, paid_at = COALESCE($3::timestamptz, now()), gateway_response = $4 WHERE id = $1`,
      [intent.id, tx.channel ?? null, tx.paid_at ?? null, JSON.stringify(tx)]
    );
    const balance = await walletRepo.adjustBalance(c, {
      userId: intent.user_id,
      amount: intent.amount,
      type: 'deposit',
      referenceType: 'payment_intent',
      referenceId: intent.id,
      note: `Paystack deposit ${intent.reference}${tx.channel ? ` (${tx.channel})` : ''}`,
    });
    depositsCredited.inc();
    return { status: 'success' as const, credited: true, balance, userId: intent.user_id };
  }

  if (['failed', 'reversed'].includes(tx.status)) {
    await c.query(`UPDATE payment_intents SET status = 'failed', gateway_response = $2 WHERE id = $1`, [intent.id, JSON.stringify(tx)]);
    return { status: 'failed' as const, credited: false };
  }
  if (tx.status === 'abandoned' && intent.status === 'pending') {
    // Paystack marks unpaid checkouts "abandoned" but the customer can still pay later.
    return { status: 'pending' as const, credited: false };
  }
  return { status: intent.status, credited: false };
}

/** Client-side "verify" (after redirect) — the polling fallback to webhooks. */
export async function verifyDeposit(userId: number, reference: string) {
  const intent = await queryOne<PaymentIntentRow>(pool, 'SELECT * FROM payment_intents WHERE reference = $1', [reference]);
  if (!intent || intent.user_id !== userId) throw notFound('Deposit');
  if (intent.status === 'pending' || intent.status === 'abandoned') {
    const tx = await paystack.verifyTransaction(reference);
    await withTransaction((c) => finalizeDeposit(c, tx));
  }
  const fresh = await queryOne<PaymentIntentRow>(pool, 'SELECT * FROM payment_intents WHERE reference = $1', [reference]);
  return publicIntent(fresh!);
}

export async function getDeposit(userId: number, reference: string) {
  const intent = await queryOne<PaymentIntentRow>(pool, 'SELECT * FROM payment_intents WHERE reference = $1', [reference]);
  if (!intent || intent.user_id !== userId) throw notFound('Deposit');
  return publicIntent(intent);
}

export async function listDeposits(userId: number, p: Pagination) {
  const rows = await query<PaymentIntentRow>(
    pool,
    'SELECT * FROM payment_intents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [userId, p.limit, p.offset]
  );
  return rows.map(publicIntent);
}

interface PaystackWebhook {
  event: string;
  data: Record<string, any> & { reference?: string; id?: number };
}

/**
 * Inbound Paystack webhook.
 *  1. Signature over the RAW body (x-paystack-signature, HMAC-SHA512).
 *  2. Record (provider, event_key) in webhook_events inside the same DB
 *     transaction as the business effect -> duplicate deliveries are no-ops,
 *     and a failure rolls the record back so Paystack's retry can succeed.
 *  3. For charges, re-verify with the Paystack API before crediting
 *     (defence in depth against a leaked secret / replayed payload).
 */
export async function handlePaystackWebhook(rawBody: Buffer | undefined, signature: string | string[] | undefined) {
  if (!isValidSignature(rawBody, signature)) throw unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');

  let evt: PaystackWebhook;
  try {
    evt = JSON.parse(rawBody!.toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON payload');
  }
  const reference = evt?.data?.reference;
  if (!evt?.event || !reference) throw badRequest('Malformed webhook payload');

  const supported = ['charge.success', 'transfer.success', 'transfer.failed', 'transfer.reversed'];
  if (!supported.includes(evt.event)) return { ignored: true, event: evt.event };

  // Charges/transfers we didn't create (other products on the same Paystack
  // account) are acknowledged and ignored, so Paystack doesn't retry them forever.
  const known = evt.event.startsWith('charge.')
    ? await queryOne(pool, 'SELECT 1 FROM payment_intents WHERE reference = $1', [reference])
    : await queryOne(pool, 'SELECT 1 FROM withdrawals WHERE reference = $1', [reference]);
  if (!known) return { ignored: true, reason: 'unknown reference' };

  // For charges, confirm with Paystack *before* opening the DB transaction (no network I/O while holding locks).
  let verified: VerifiedTransaction | null = null;
  if (evt.event === 'charge.success') {
    verified = env.PAYSTACK_VERIFY_ON_WEBHOOK ? await paystack.verifyTransaction(reference) : (evt.data as unknown as VerifiedTransaction);
  }

  try {
    return await withTransaction(async (c) => {
      await c.query('INSERT INTO webhook_events (provider, event_key, event_type, payload) VALUES ($1, $2, $3, $4)', [
        PROVIDER,
        `${evt.event}:${reference}`,
        evt.event,
        JSON.stringify(evt),
      ]);

      if (evt.event === 'charge.success') return finalizeDeposit(c, verified!);
      return handleTransferEvent(c, evt.event as 'transfer.success' | 'transfer.failed' | 'transfer.reversed', evt.data);
    });
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION && err?.constraint === 'uq_webhook_event') return { duplicate: true };
    throw err;
  }
}

/**
 * Reconciliation job: re-verifies stale pending deposits with Paystack so a
 * missed webhook never leaves a paid customer uncredited.
 */
export async function reconcilePendingDeposits(): Promise<{ checked: number; credited: number; expired: number }> {
  const stale = await query<PaymentIntentRow>(
    pool,
    `SELECT * FROM payment_intents
     WHERE status IN ('pending', 'abandoned') AND access_code IS NOT NULL
       AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '48 hours'
     ORDER BY created_at LIMIT 100`
  );
  let credited = 0;
  for (const intent of stale) {
    try {
      const tx = await paystack.verifyTransaction(intent.reference);
      const r = await withTransaction((c) => finalizeDeposit(c, tx));
      if (r.credited) credited += 1;
    } catch (err) {
      if (!(err instanceof PaystackError)) logger.error({ err, reference: intent.reference }, 'Deposit reconciliation failed');
    }
  }
  const expired = await pool.query(
    `UPDATE payment_intents SET status = 'abandoned'
     WHERE status = 'pending' AND created_at < now() - interval '24 hours'`
  );
  return { checked: stale.length, credited, expired: expired.rowCount ?? 0 };
}
