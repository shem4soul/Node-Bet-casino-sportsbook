import { PoolClient } from 'pg';
import { env } from '../config/env';
import { createLogger, maskEmail } from '../config/logger';
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
const log = createLogger('payments');

type DepositOutcome = Awaited<ReturnType<typeof finalizeDeposit>>;

/** Logged only AFTER the transaction commits, so a log line never claims a credit that was rolled back. */
function logDepositOutcome(source: 'webhook' | 'verify' | 'reconcile', reference: string, r: DepositOutcome) {
  if (r.credited) {
    log.info(
      { event: 'deposit.credited', source, reference, depositUserId: r.userId, amount: r.amount, channel: r.channel, balance: r.balance },
      `Deposit credited via ${source}`
    );
  } else if (r.status === 'failed' && !('alreadyFinal' in r)) {
    log.warn({ event: 'deposit.failed', source, reference }, 'Deposit marked failed');
  } else {
    log.debug({ event: 'deposit.unchanged', source, reference, status: r.status }, 'Deposit already final or still pending');
  }
}

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
    log.info(
      { event: 'deposit.initialized', reference, amount: amountStr, currency: env.CURRENCY, email: maskEmail(user.email) },
      'Deposit checkout created'
    );
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
    log.error({ event: 'deposit.init_failed', reference, amount: amountStr, err }, 'Paystack transaction initialize failed');
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
      log.error(
        {
          event: 'deposit.amount_mismatch',
          reference: tx.reference,
          expected: intent.amount,
          paidKobo: tx.amount,
          currency: tx.currency,
          depositUserId: intent.user_id,
        },
        'Deposit amount/currency mismatch — NOT credited, needs investigation'
      );
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
    return { status: 'success' as const, credited: true, balance, userId: intent.user_id, amount: intent.amount, channel: tx.channel };
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
    logDepositOutcome('verify', reference, await withTransaction((c) => finalizeDeposit(c, tx)));
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
  if (!isValidSignature(rawBody, signature)) {
    log.warn(
      { event: 'webhook.invalid_signature', provider: PROVIDER, bytes: rawBody?.length ?? 0 },
      'Rejected webhook with invalid signature'
    );
    throw unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  let evt: PaystackWebhook;
  try {
    evt = JSON.parse(rawBody!.toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON payload');
  }
  const reference = evt?.data?.reference;
  if (!evt?.event || !reference) throw badRequest('Malformed webhook payload');

  const supported = ['charge.success', 'transfer.success', 'transfer.failed', 'transfer.reversed'];
  log.info({ event: 'webhook.received', provider: PROVIDER, type: evt.event, reference }, `Paystack webhook ${evt.event}`);
  if (!supported.includes(evt.event)) {
    log.debug({ event: 'webhook.ignored', type: evt.event, reason: 'unsupported' }, 'Ignoring unsupported webhook type');
    return { ignored: true, event: evt.event };
  }

  // Charges/transfers we didn't create (other products on the same Paystack
  // account) are acknowledged and ignored, so Paystack doesn't retry them forever.
  const known = evt.event.startsWith('charge.')
    ? await queryOne(pool, 'SELECT 1 FROM payment_intents WHERE reference = $1', [reference])
    : await queryOne(pool, 'SELECT 1 FROM withdrawals WHERE reference = $1', [reference]);
  if (!known) {
    log.info(
      { event: 'webhook.ignored', type: evt.event, reference, reason: 'unknown_reference' },
      'Ignoring webhook for a reference we did not create'
    );
    return { ignored: true, reason: 'unknown reference' };
  }

  // For charges, confirm with Paystack *before* opening the DB transaction (no network I/O while holding locks).
  let verified: VerifiedTransaction | null = null;
  if (evt.event === 'charge.success') {
    verified = env.PAYSTACK_VERIFY_ON_WEBHOOK ? await paystack.verifyTransaction(reference) : (evt.data as unknown as VerifiedTransaction);
  }

  try {
    const result = await withTransaction(async (c) => {
      await c.query('INSERT INTO webhook_events (provider, event_key, event_type, payload) VALUES ($1, $2, $3, $4)', [
        PROVIDER,
        `${evt.event}:${reference}`,
        evt.event,
        JSON.stringify(evt),
      ]);

      if (evt.event === 'charge.success') return finalizeDeposit(c, verified!);
      return handleTransferEvent(c, evt.event as 'transfer.success' | 'transfer.failed' | 'transfer.reversed', evt.data);
    });
    if (evt.event === 'charge.success') logDepositOutcome('webhook', reference, result as DepositOutcome);
    return result;
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION && err?.constraint === 'uq_webhook_event') {
      log.info({ event: 'webhook.duplicate', type: evt.event, reference }, 'Duplicate webhook delivery ignored (idempotent)');
      return { duplicate: true };
    }
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
      logDepositOutcome('reconcile', intent.reference, r);
      if (r.credited) credited += 1;
    } catch (err) {
      if (err instanceof PaystackError) log.debug({ reference: intent.reference, err: err.message }, 'Reconcile: Paystack verify failed');
      else log.error({ event: 'deposit.reconcile_error', err, reference: intent.reference }, 'Deposit reconciliation failed');
    }
  }
  const expired = await pool.query(
    `UPDATE payment_intents SET status = 'abandoned'
     WHERE status = 'pending' AND created_at < now() - interval '24 hours'`
  );
  return { checked: stale.length, credited, expired: expired.rowCount ?? 0 };
}
