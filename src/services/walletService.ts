import { pool, withTransaction } from '../config/db';
import * as walletRepo from '../repositories/walletRepository';
import { AppError } from '../middleware/errorHandler';

export async function getBalance(userId: number) {
  const wallet = await walletRepo.getWallet(pool, userId);
  if (!wallet) throw new AppError('Wallet not found', 404);
  return wallet;
}

// Deposits now go through the gateway flow — see paymentService.initializeDeposit
// and the webhook handler. The wallet is credited only on a verified,
// idempotent webhook confirmation, never directly from a client request.

/**
 * Mock withdrawal — in production this should trigger KYC checks and an
 * actual payout via the payment processor, likely with a manual review
 * step above a threshold.
 */
export async function withdraw(userId: number, amount: number): Promise<number> {
  if (!(amount > 0)) throw new AppError('Withdrawal amount must be positive', 400);

  return withTransaction((conn) =>
    walletRepo.adjustBalance(conn, {
      userId,
      amount: -amount,
      type: 'withdrawal',
      note: 'Mock withdrawal — wire up a real payout flow before going live',
    })
  );
}

export async function getTransactions(userId: number, pagination: { limit?: number; offset?: number }) {
  return walletRepo.listTransactions(pool, userId, pagination);
}
