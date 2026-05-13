import { Pool, PoolConnection } from 'mysql2/promise';
import { PaymentIntentRow, PaymentIntentStatus, InsertResult } from '../types/db';
import { Queryable } from '../config/db';

export async function createPaymentIntent(
  pool: Pool,
  { userId, provider, reference, amount, currency = 'NGN' }: { userId: number; provider: string; reference: string; amount: number; currency?: string }
): Promise<number> {
  const [result] = await pool.query<InsertResult>(
    `INSERT INTO payment_intents (user_id, provider, reference, amount, currency, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [userId, provider, reference, amount, currency]
  );
  return result.insertId;
}

export async function getByReference(pool: Pool, reference: string): Promise<PaymentIntentRow | null> {
  const [rows] = await pool.query<PaymentIntentRow[]>('SELECT * FROM payment_intents WHERE reference = ?', [reference]);
  return rows[0] || null;
}

export async function getByReferenceForUpdate(conn: PoolConnection, reference: string): Promise<PaymentIntentRow | null> {
  const [rows] = await conn.query<PaymentIntentRow[]>('SELECT * FROM payment_intents WHERE reference = ? FOR UPDATE', [reference]);
  return rows[0] || null;
}

export async function updateStatus(
  queryable: Queryable,
  reference: string,
  status: PaymentIntentStatus,
  gatewayResponse: Record<string, unknown> | null = null
): Promise<void> {
  await queryable.query(
    'UPDATE payment_intents SET status = ?, gateway_response = ? WHERE reference = ?',
    [status, gatewayResponse ? JSON.stringify(gatewayResponse) : null, reference]
  );
}

/**
 * Inserts a webhook_events row inside `conn`'s transaction. Relies on the
 * UNIQUE KEY (provider, reference, event_type) in the schema: a duplicate
 * delivery of the same event throws ER_DUP_ENTRY, which the caller uses as
 * the "already processed, skip" signal — this makes the check-then-act
 * atomic instead of a separate SELECT that a concurrent retry could race.
 */
export async function recordWebhookEventOrThrow(
  conn: PoolConnection,
  { provider, reference, eventType, payload }: { provider: string; reference: string; eventType: string; payload: unknown }
): Promise<void> {
  await conn.query(
    `INSERT INTO webhook_events (provider, reference, event_type, payload_json) VALUES (?, ?, ?, ?)`,
    [provider, reference, eventType, JSON.stringify(payload)]
  );
}
