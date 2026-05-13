import { Pool, PoolConnection } from 'mysql2/promise';
import { UserRow, InsertResult } from '../types/db';

export async function findByEmailOrUsername(pool: Pool, identifier: string): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1',
    [identifier, identifier]
  );
  return rows[0] || null;
}

export async function findById(pool: Pool, id: number): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

export async function createUser(
  conn: PoolConnection,
  { username, email, passwordHash, dateOfBirth }: { username: string; email: string; passwordHash: string; dateOfBirth: string }
): Promise<number> {
  const [result] = await conn.query<InsertResult>(
    `INSERT INTO users (username, email, password_hash, date_of_birth)
     VALUES (?, ?, ?, ?)`,
    [username, email, passwordHash, dateOfBirth]
  );
  return result.insertId;
}

export async function createWallet(conn: PoolConnection, userId: number, startingBalance = 0): Promise<void> {
  await conn.query('INSERT INTO wallets (user_id, balance) VALUES (?, ?)', [userId, startingBalance]);
}
