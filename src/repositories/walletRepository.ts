import { Pool, PoolConnection } from 'mysql2/promise';
import { WalletRow, TransactionRow, TransactionType, InsertResult } from '../types/db';
import { AppError } from '../middleware/errorHandler';

/**
 * All balance mutations go through `adjustBalance`, which must be called
 * with a connection that is inside an active transaction (see
 * config/db.ts#withTransaction). It locks the wallet row with
 * SELECT ... FOR UPDATE so concurrent bets/games on the same user
 * serialize instead of racing on the balance.
 */

async function getWalletForUpdate(conn: PoolConnection, userId: number): Promise<WalletRow | null> {
  const [rows] = await conn.query<WalletRow[]>('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
  return rows[0] || null;
}

export async function getWallet(pool: Pool | PoolConnection, userId: number): Promise<WalletRow | null> {
  const [rows] = await pool.query<WalletRow[]>('SELECT * FROM wallets WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

export interface AdjustBalanceParams {
  userId: number;
  amount: number;
  type: TransactionType;
  referenceType?: string | null;
  referenceId?: number | null;
  note?: string | null;
}

/**
 * amount: positive to credit, negative to debit.
 * Throws if the debit would push balance below zero.
 */
export async function adjustBalance(
  conn: PoolConnection,
  { userId, amount, type, referenceType = null, referenceId = null, note = null }: AdjustBalanceParams
): Promise<number> {
  const wallet = await getWalletForUpdate(conn, userId);
  if (!wallet) {
    throw new AppError('Wallet not found', 404);
  }

  const newBalance = Number(wallet.balance) + Number(amount);
  if (newBalance < 0) {
    throw new AppError('Insufficient balance', 400);
  }

  await conn.query('UPDATE wallets SET balance = ? WHERE user_id = ?', [newBalance.toFixed(2), userId]);

  await conn.query(
    `INSERT INTO transactions (user_id, type, amount, balance_after, reference_type, reference_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, Number(amount).toFixed(2), newBalance.toFixed(2), referenceType, referenceId, note]
  );

  return newBalance;
}

export async function listTransactions(
  pool: Pool,
  userId: number,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<TransactionRow[]> {
  const [rows] = await pool.query<TransactionRow[]>(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, Number(limit), Number(offset)]
  );
  return rows;
}

// Re-exported for services that need the InsertResult type alongside these functions
export type { InsertResult };
