import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { env } from './env';
import { logger } from './logger';

// BIGINT (int8, OID 20) -> JS number. Safe for ids/counts up to 2^53.
types.setTypeParser(20, (v) => Number(v));
// NUMERIC (OID 1700) is deliberately left as a STRING so money never passes
// through a float on its way out of the database. Use lib/money.ts to do math.

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: env.APP_NAME,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pool | PoolClient;

export async function query<T extends QueryResultRow = any>(db: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = any>(db: Queryable, text: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(text, params);
  return res.rows[0] ?? null;
}

/**
 * Runs `work(client)` inside a READ COMMITTED transaction. Commits on
 * success, rolls back on any thrown error. Row-level locking (SELECT ...
 * FOR UPDATE) inside `work` serializes concurrent balance changes.
 */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cluster-wide mutual exclusion for background jobs: when several API or
 * worker replicas run the same cron, only the one that wins the advisory
 * lock executes; the others skip that tick.
 */
export async function withAdvisoryLock<T>(lockKey: number, work: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!rows[0]?.locked) return { ran: false };
    try {
      return { ran: true, result: await work() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
