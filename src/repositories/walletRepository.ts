import { PoolClient } from 'pg';
import { Queryable, query, queryOne } from '../config/db';
import { AppError } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import type { TransactionRow, TransactionType, WalletRow } from '../types/db';
import type { Pagination } from '../lib/http';

export async function createWallet(db: Queryable, userId: number, currency: string, startingBalance = 0): Promise<void> {
  await db.query('INSERT INTO wallets (user_id, balance, currency) VALUES ($1, $2, $3)', [
    userId,
    fromMinor(toMinor(startingBalance)),
    currency,
  ]);
  if (startingBalance > 0) {
    await db.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, note)
       VALUES ($1, 'adjustment', $2, $2, 'Demo starting balance')`,
      [userId, fromMinor(toMinor(startingBalance))]
    );
  }
}

export function getWallet(db: Queryable, userId: number): Promise<WalletRow | null> {
  return queryOne<WalletRow>(db, 'SELECT * FROM wallets WHERE user_id = $1', [userId]);
}

export interface AdjustBalanceParams {
  userId: number;
  /** Major units, positive = credit, negative = debit. */
  amount: string | number;
  type: TransactionType;
  referenceType?: string | null;
  referenceId?: number | null;
  note?: string | null;
}

/**
 * THE only way a balance changes. Must be called with a client inside an
 * open transaction (config/db.ts#withTransaction). Locks the wallet row
 * (SELECT ... FOR UPDATE) so concurrent operations on one user serialize,
 * refuses to go negative, and writes the matching ledger row.
 *
 * Returns the new balance as a 2dp string.
 */
export async function adjustBalance(client: PoolClient, p: AdjustBalanceParams): Promise<string> {
  const wallet = await queryOne<WalletRow>(client, 'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [p.userId]);
  if (!wallet) throw new AppError('Wallet not found', 404);

  const deltaMinor = toMinor(p.amount);
  if (deltaMinor === 0) throw new AppError('Ledger amount cannot be zero', 500);
  const newMinor = toMinor(wallet.balance) + deltaMinor;
  if (newMinor < 0) throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');

  const newBalance = fromMinor(newMinor);
  await client.query('UPDATE wallets SET balance = $1 WHERE user_id = $2', [newBalance, p.userId]);
  await client.query(
    `INSERT INTO transactions (user_id, type, amount, balance_after, reference_type, reference_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.userId, p.type, fromMinor(deltaMinor), newBalance, p.referenceType ?? null, p.referenceId ?? null, p.note ?? null]
  );
  return newBalance;
}

export function listTransactions(
  db: Queryable,
  userId: number,
  { limit, offset, type }: Pagination & { type?: TransactionType }
): Promise<TransactionRow[]> {
  return query<TransactionRow>(
    db,
    `SELECT * FROM transactions
     WHERE user_id = $1 AND ($2::text IS NULL OR type = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [userId, type ?? null, limit, offset]
  );
}
