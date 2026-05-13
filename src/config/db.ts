import mysql, { Pool, PoolConnection } from 'mysql2/promise';

export const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  decimalNumbers: false, // keep DECIMAL columns as strings to avoid float rounding
});

/**
 * Run `work(connection)` inside a transaction with row locking friendly
 * isolation. Commits on success, rolls back on any thrown error.
 */
export async function withTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Repositories accept either a Pool (for plain reads) or a PoolConnection
// (when the caller is inside withTransaction) — both expose the same
// .query() signature, so this alias keeps repository signatures simple.
export type Queryable = Pool | PoolConnection;
