import { PoolClient } from 'pg';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { pool, query, queryOne, withTransaction, PG_UNIQUE_VIOLATION } from '../config/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import { paymentReference } from '../lib/tokens';
import { Bank, paystack, PaystackError, TransferData } from '../integrations/paystack/paystackClient';
import * as walletRepo from '../repositories/walletRepository';
import { audit } from './auditService';
import type { BankAccountRow, WithdrawalRow } from '../types/db';
import type { Pagination } from '../lib/http';

// ---------------------------------------------------------------------------
// Banks & bank accounts
// ---------------------------------------------------------------------------

let bankCache: { at: number; banks: Bank[] } | null = null;
const BANK_CACHE_MS = 12 * 60 * 60 * 1000;

export async function listBanks(): Promise<Pick<Bank, 'name' | 'code' | 'slug'>[]> {
  if (!bankCache || Date.now() - bankCache.at > BANK_CACHE_MS) {
    const banks = await paystack.listBanks(env.CURRENCY);
    bankCache = { at: Date.now(), banks: banks.filter((b) => b.active !== false) };
  }
  return bankCache.banks.map((b) => ({ name: b.name, code: b.code, slug: b.slug }));
}

function publicBankAccount(b: BankAccountRow) {
  return {
    id: b.id,
    bankCode: b.bank_code,
    bankName: b.bank_name,
    accountNumber: b.account_number,
    accountName: b.account_name,
    isDefault: b.is_default,
    createdAt: b.created_at,
  };
}

export async function listBankAccounts(userId: number) {
  const rows = await query<BankAccountRow>(
    pool,
    'SELECT * FROM bank_accounts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at DESC',
    [userId]
  );
  return rows.map(publicBankAccount);
}

/**
 * Resolves the account name with Paystack (NUBAN lookup), registers a
 * transfer recipient, and stores it. Users can only withdraw to accounts
 * added this way.
 */
export async function addBankAccount(userId: number, bankCode: string, accountNumber: string, ip?: string | null) {
  const count = await queryOne<{ n: number }>(pool, 'SELECT COUNT(*) AS n FROM bank_accounts WHERE user_id = $1 AND deleted_at IS NULL', [
    userId,
  ]);
  if ((count?.n ?? 0) >= 5) throw badRequest('You can save at most 5 bank accounts', 'TOO_MANY_BANK_ACCOUNTS');

  let resolved;
  try {
    resolved = await paystack.resolveAccount(accountNumber, bankCode);
  } catch (err) {
    if (err instanceof PaystackError && err.definitive) throw badRequest('Could not verify that bank account number', 'ACCOUNT_UNRESOLVED');
    throw err;
  }
  const banks = await listBanks().catch(() => []);
  const bankName = banks.find((b) => b.code === bankCode)?.name ?? bankCode;
  const recipient = await paystack.createTransferRecipient({
    name: resolved.account_name,
    accountNumber,
    bankCode,
    currency: env.CURRENCY,
  });

  try {
    return await withTransaction(async (c) => {
      const hasDefault = await queryOne(c, 'SELECT 1 FROM bank_accounts WHERE user_id = $1 AND is_default AND deleted_at IS NULL', [
        userId,
      ]);
      const row = await queryOne<BankAccountRow>(
        c,
        `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_number, account_name, recipient_code, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, bankCode, bankName, accountNumber, resolved.account_name, recipient.recipient_code, !hasDefault]
      );
      await audit(c, {
        actorId: userId,
        action: 'bank_account.add',
        entityType: 'bank_account',
        entityId: row!.id,
        metadata: { bankCode },
        ip,
      });
      return publicBankAccount(row!);
    });
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION) throw conflict('This bank account is already saved');
    throw err;
  }
}

export async function removeBankAccount(userId: number, id: number) {
  const res = await pool.query(
    `UPDATE bank_accounts SET deleted_at = now(), is_default = false WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  if (!res.rowCount) throw notFound('Bank account');
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

function publicWithdrawal(w: WithdrawalRow & Partial<BankAccountRow>) {
  return {
    id: w.id,
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    reference: w.reference,
    failureReason: w.failure_reason,
    bankAccountId: w.bank_account_id,
    bankName: w.bank_name,
    accountNumber: w.account_number ? `******${w.account_number.slice(-4)}` : undefined,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/**
 * Creates a withdrawal. Funds are debited from the wallet immediately (held)
 * so they can't be bet or withdrawn twice; any failure/rejection refunds
 * them via a `withdrawal_reversal` ledger entry.
 */
export async function requestWithdrawal(
  user: { id: number; kycStatus: string; status: string },
  amount: number,
  bankAccountId: number,
  ip?: string | null
) {
  if (user.status !== 'active') throw forbidden(`Account is ${user.status}`, 'ACCOUNT_RESTRICTED');
  if (env.WITHDRAWAL_REQUIRE_KYC && user.kycStatus !== 'verified') {
    throw forbidden('Please complete identity verification (KYC) before withdrawing', 'KYC_REQUIRED');
  }
  if (amount < env.MIN_WITHDRAWAL) throw badRequest(`Minimum withdrawal is ${env.MIN_WITHDRAWAL} ${env.CURRENCY}`);
  if (amount > env.MAX_WITHDRAWAL) throw badRequest(`Maximum withdrawal is ${env.MAX_WITHDRAWAL} ${env.CURRENCY}`);

  const amountStr = fromMinor(toMinor(amount));
  const needsReview = amount >= env.WITHDRAWAL_REVIEW_THRESHOLD;

  const withdrawal = await withTransaction(async (c) => {
    const account = await queryOne<BankAccountRow>(c, 'SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
      bankAccountId,
      user.id,
    ]);
    if (!account) throw notFound('Bank account');

    // Lock the wallet first so the daily-limit check and the debit are atomic.
    await c.query('SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE', [user.id]);
    const today = await queryOne<{ total: string }>(
      c,
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM withdrawals
       WHERE user_id = $1 AND created_at > now() - interval '1 day' AND status NOT IN ('failed', 'reversed', 'rejected')`,
      [user.id]
    );
    if (toMinor(today!.total) + toMinor(amount) > toMinor(env.WITHDRAWAL_DAILY_LIMIT)) {
      throw new AppError('Daily withdrawal limit reached', 422, 'WITHDRAWAL_LIMIT_EXCEEDED');
    }

    const w = await queryOne<WithdrawalRow>(
      c,
      `INSERT INTO withdrawals (user_id, bank_account_id, amount, currency, status, reference)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, account.id, amountStr, env.CURRENCY, needsReview ? 'pending_review' : 'approved', paymentReference('wd')]
    );
    await walletRepo.adjustBalance(c, {
      userId: user.id,
      amount: `-${amountStr}`,
      type: 'withdrawal',
      referenceType: 'withdrawal',
      referenceId: w!.id,
      note: `Withdrawal to ${account.bank_name} ******${account.account_number.slice(-4)}`,
    });
    await audit(c, {
      actorId: user.id,
      action: 'withdrawal.request',
      entityType: 'withdrawal',
      entityId: w!.id,
      metadata: { amount: amountStr, needsReview },
      ip,
    });
    return w!;
  });

  if (!needsReview) {
    await processWithdrawal(withdrawal.id);
  }
  return getWithdrawal(user.id, withdrawal.id);
}

async function refundWithdrawal(c: PoolClient, w: WithdrawalRow, status: 'failed' | 'reversed' | 'rejected', reason: string) {
  await c.query('UPDATE withdrawals SET status = $2, failure_reason = $3 WHERE id = $1', [w.id, status, reason.slice(0, 500)]);
  await walletRepo.adjustBalance(c, {
    userId: w.user_id,
    amount: w.amount,
    type: 'withdrawal_reversal',
    referenceType: 'withdrawal',
    referenceId: w.id,
    note: `Withdrawal ${status}: ${reason}`.slice(0, 255),
  });
}

/**
 * Sends an `approved` withdrawal to Paystack Transfers. Network errors leave
 * it in `processing` for the reconciliation job (the transfer may have gone
 * through); only a definitive Paystack rejection refunds the user.
 */
export async function processWithdrawal(withdrawalId: number): Promise<void> {
  const claimed = await withTransaction(async (c) => {
    const w = await queryOne<WithdrawalRow & { recipient_code: string }>(
      c,
      `SELECT w.*, b.recipient_code FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
       WHERE w.id = $1 FOR UPDATE OF w`,
      [withdrawalId]
    );
    if (!w || w.status !== 'approved') return null;
    await c.query(`UPDATE withdrawals SET status = 'processing' WHERE id = $1`, [w.id]);
    return w;
  });
  if (!claimed) return;

  try {
    const transfer = await paystack.initiateTransfer({
      amount: toMinor(claimed.amount),
      recipient: claimed.recipient_code,
      reference: claimed.reference,
      reason: `${env.APP_NAME} withdrawal`,
      currency: claimed.currency,
    });
    await withTransaction((c) => applyTransferStatus(c, claimed.reference, transfer));
  } catch (err) {
    if (err instanceof PaystackError && err.definitive) {
      await withTransaction(async (c) => {
        const w = await queryOne<WithdrawalRow>(c, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [claimed.id]);
        if (w && w.status === 'processing') await refundWithdrawal(c, w, 'failed', err.message);
      });
    } else {
      logger.warn({ err, withdrawalId }, 'Transfer outcome unknown; will reconcile');
    }
  }
}

async function applyTransferStatus(c: PoolClient, reference: string, t: Partial<TransferData> & { status?: string }, reason?: string) {
  const w = await queryOne<WithdrawalRow>(c, 'SELECT * FROM withdrawals WHERE reference = $1 FOR UPDATE', [reference]);
  if (!w) return { ignored: true, reason: 'unknown withdrawal reference' };
  if (['success', 'failed', 'reversed', 'rejected'].includes(w.status)) return { alreadyFinal: true, status: w.status };

  await c.query('UPDATE withdrawals SET transfer_code = COALESCE($2, transfer_code), gateway_response = $3 WHERE id = $1', [
    w.id,
    t.transfer_code ?? null,
    JSON.stringify(t),
  ]);

  switch (t.status) {
    case 'success':
      await c.query(`UPDATE withdrawals SET status = 'success' WHERE id = $1`, [w.id]);
      return { status: 'success' };
    case 'failed':
    case 'abandoned':
    case 'blocked':
    case 'rejected':
      await refundWithdrawal(c, w, 'failed', reason || t.reason || `Transfer ${t.status}`);
      return { status: 'failed', refunded: true };
    case 'reversed':
      await refundWithdrawal(c, w, 'reversed', reason || 'Transfer reversed by bank');
      return { status: 'reversed', refunded: true };
    case 'otp':
      logger.error({ reference }, 'Paystack requires OTP for transfers — disable OTP in the Paystack dashboard for API payouts');
      return { status: 'processing' };
    default:
      return { status: 'processing' };
  }
}

/** Called from the webhook handler inside its transaction. */
export async function handleTransferEvent(
  c: PoolClient,
  event: 'transfer.success' | 'transfer.failed' | 'transfer.reversed',
  data: Record<string, any>
) {
  const status = event === 'transfer.success' ? 'success' : event === 'transfer.failed' ? 'failed' : 'reversed';
  return applyTransferStatus(c, data.reference, { ...data, status } as TransferData, data.reason || data.gateway_response);
}

export async function reconcileWithdrawals(): Promise<{ checked: number; retried: number }> {
  const stuck = await query<WithdrawalRow>(
    pool,
    `SELECT * FROM withdrawals WHERE status = 'processing' AND updated_at < now() - interval '10 minutes' ORDER BY updated_at LIMIT 50`
  );
  for (const w of stuck) {
    try {
      const t = await paystack.verifyTransfer(w.reference);
      await withTransaction((c) => applyTransferStatus(c, w.reference, t));
    } catch (err) {
      if (err instanceof PaystackError && err.httpStatus === 404) {
        // Paystack never received it -> safe to retry with the same reference (idempotent at Paystack).
        await pool.query(`UPDATE withdrawals SET status = 'approved' WHERE id = $1 AND status = 'processing'`, [w.id]);
      } else {
        logger.warn({ err, reference: w.reference }, 'Withdrawal reconciliation failed');
      }
    }
  }
  const approved = await query<{ id: number }>(pool, `SELECT id FROM withdrawals WHERE status = 'approved' ORDER BY created_at LIMIT 50`);
  for (const a of approved) await processWithdrawal(a.id);
  return { checked: stuck.length, retried: approved.length };
}

export async function getWithdrawal(userId: number, id: number) {
  const w = await queryOne<WithdrawalRow & BankAccountRow>(
    pool,
    `SELECT w.*, b.bank_name, b.account_number FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
     WHERE w.id = $1 AND w.user_id = $2`,
    [id, userId]
  );
  if (!w) throw notFound('Withdrawal');
  return publicWithdrawal(w);
}

export async function listWithdrawals(userId: number, p: Pagination) {
  const rows = await query<WithdrawalRow & BankAccountRow>(
    pool,
    `SELECT w.*, b.bank_name, b.account_number FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
     WHERE w.user_id = $1 ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, p.limit, p.offset]
  );
  return rows.map(publicWithdrawal);
}

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

export function adminListWithdrawals(p: Pagination & { status?: string }) {
  return query(
    pool,
    `SELECT w.*, u.username, u.email, u.kyc_status, b.bank_name, b.account_number, b.account_name
     FROM withdrawals w JOIN users u ON u.id = w.user_id JOIN bank_accounts b ON b.id = w.bank_account_id
     WHERE ($1::text IS NULL OR w.status = $1)
     ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`,
    [p.status ?? null, p.limit, p.offset]
  );
}

export async function approveWithdrawal(adminId: number, id: number, ip?: string | null) {
  await withTransaction(async (c) => {
    const w = await queryOne<WithdrawalRow>(c, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw notFound('Withdrawal');
    if (w.status !== 'pending_review') throw conflict(`Withdrawal is ${w.status}, not pending review`);
    await c.query(`UPDATE withdrawals SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, adminId]);
    await audit(c, { actorId: adminId, action: 'withdrawal.approve', entityType: 'withdrawal', entityId: id, ip });
  });
  await processWithdrawal(id);
  return queryOne<WithdrawalRow>(pool, 'SELECT * FROM withdrawals WHERE id = $1', [id]);
}

export async function rejectWithdrawal(adminId: number, id: number, reason: string, ip?: string | null) {
  return withTransaction(async (c) => {
    const w = await queryOne<WithdrawalRow>(c, 'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw notFound('Withdrawal');
    if (w.status !== 'pending_review') throw conflict(`Withdrawal is ${w.status}, not pending review`);
    await c.query('UPDATE withdrawals SET reviewed_by = $2, reviewed_at = now() WHERE id = $1', [id, adminId]);
    await refundWithdrawal(c, w, 'rejected', reason);
    await audit(c, { actorId: adminId, action: 'withdrawal.reject', entityType: 'withdrawal', entityId: id, metadata: { reason }, ip });
    return queryOne<WithdrawalRow>(c, 'SELECT * FROM withdrawals WHERE id = $1', [id]);
  });
}
