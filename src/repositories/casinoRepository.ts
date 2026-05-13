import { Pool, PoolConnection } from 'mysql2/promise';
import { GameRow, FairnessSeedRow, GameRoundRow, InsertResult } from '../types/db';

export async function getGameBySlug(pool: Pool, slug: string): Promise<GameRow | null> {
  const [rows] = await pool.query<GameRow[]>('SELECT * FROM games WHERE slug = ? AND is_active = 1', [slug]);
  return rows[0] || null;
}

export async function getActiveSeed(conn: PoolConnection, userId: number): Promise<FairnessSeedRow | null> {
  const [rows] = await conn.query<FairnessSeedRow[]>(
    'SELECT * FROM fairness_seeds WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1 FOR UPDATE',
    [userId]
  );
  return rows[0] || null;
}

export async function createSeed(
  conn: PoolConnection,
  { userId, serverSeed, serverSeedHash, clientSeed }: { userId: number; serverSeed: string; serverSeedHash: string; clientSeed: string }
): Promise<number> {
  const [result] = await conn.query<InsertResult>(
    `INSERT INTO fairness_seeds (user_id, server_seed, server_seed_hash, client_seed, nonce, is_active)
     VALUES (?, ?, ?, ?, 0, 1)`,
    [userId, serverSeed, serverSeedHash, clientSeed]
  );
  return result.insertId;
}

export async function deactivateSeed(conn: PoolConnection, seedId: number): Promise<void> {
  await conn.query('UPDATE fairness_seeds SET is_active = 0, revealed_at = NOW() WHERE id = ?', [seedId]);
}

export async function incrementNonce(conn: PoolConnection, seedId: number): Promise<void> {
  await conn.query('UPDATE fairness_seeds SET nonce = nonce + 1 WHERE id = ?', [seedId]);
}

export interface InsertRoundParams {
  userId: number;
  gameId: number;
  fairnessSeedId: number;
  nonce: number;
  stake: number;
  multiplier: number;
  payout: number;
  resultJson: Record<string, unknown>;
  outcome: 'win' | 'loss';
}

export async function insertRound(conn: PoolConnection, params: InsertRoundParams): Promise<number> {
  const { userId, gameId, fairnessSeedId, nonce, stake, multiplier, payout, resultJson, outcome } = params;
  const [result] = await conn.query<InsertResult>(
    `INSERT INTO game_rounds (user_id, game_id, fairness_seed_id, nonce, stake, multiplier, payout, result_json, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, gameId, fairnessSeedId, nonce, stake, multiplier, payout, JSON.stringify(resultJson), outcome]
  );
  return result.insertId;
}

export async function listRoundsForUser(
  pool: Pool,
  userId: number,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<GameRoundRow[]> {
  const [rows] = await pool.query<GameRoundRow[]>(
    'SELECT * FROM game_rounds WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, Number(limit), Number(offset)]
  );
  return rows;
}
