import crypto from 'crypto';
import { PoolClient } from 'pg';
import { pool, query, queryOne, withTransaction } from '../config/db';
import { badRequest, notFound } from '../lib/errors';
import { fromMinor, payoutMinor, toMinor } from '../lib/money';
import * as pf from '../lib/provablyFair';
import * as walletRepo from '../repositories/walletRepository';
import type { FairnessSeedRow, GameRow } from '../types/db';
import type { Pagination } from '../lib/http';
import { createLogger } from '../config/logger';

const log = createLogger('casino');

async function getGame(slug: string): Promise<GameRow> {
  const g = await queryOne<GameRow>(pool, 'SELECT * FROM games WHERE slug = $1 AND is_active', [slug]);
  if (!g) throw notFound('Game');
  return g;
}

export function listGames() {
  return query(pool, 'SELECT slug, name, type, rtp_percent, min_bet, max_bet FROM games WHERE is_active ORDER BY id');
}

async function activeSeed(c: PoolClient, userId: number, clientSeed?: string): Promise<FairnessSeedRow> {
  const existing = await queryOne<FairnessSeedRow>(c, 'SELECT * FROM fairness_seeds WHERE user_id = $1 AND is_active FOR UPDATE', [userId]);
  if (existing) return existing;
  const serverSeed = pf.generateServerSeed();
  return (await queryOne<FairnessSeedRow>(
    c,
    `INSERT INTO fairness_seeds (user_id, server_seed, server_seed_hash, client_seed) VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, serverSeed, pf.hashServerSeed(serverSeed), clientSeed || crypto.randomBytes(8).toString('hex')]
  ))!;
}

export async function getFairness(userId: number) {
  return withTransaction(async (c) => {
    const s = await activeSeed(c, userId);
    return { serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, nonce: s.nonce };
  });
}

export async function rotateSeed(userId: number, clientSeed?: string) {
  return withTransaction(async (c) => {
    const current = await queryOne<FairnessSeedRow>(c, 'SELECT * FROM fairness_seeds WHERE user_id = $1 AND is_active FOR UPDATE', [
      userId,
    ]);
    if (current) await c.query('UPDATE fairness_seeds SET is_active = false, revealed_at = now() WHERE id = $1', [current.id]);
    const serverSeed = pf.generateServerSeed();
    const hash = pf.hashServerSeed(serverSeed);
    const cs = clientSeed || crypto.randomBytes(8).toString('hex');
    await c.query('INSERT INTO fairness_seeds (user_id, server_seed, server_seed_hash, client_seed) VALUES ($1,$2,$3,$4)', [
      userId,
      serverSeed,
      hash,
      cs,
    ]);
    return {
      previous: current
        ? {
            serverSeed: current.server_seed,
            serverSeedHash: current.server_seed_hash,
            clientSeed: current.client_seed,
            finalNonce: current.nonce,
          }
        : null,
      newServerSeedHash: hash,
      clientSeed: cs,
    };
  });
}

function checkStake(stake: number, g: GameRow) {
  if (stake < Number(g.min_bet)) throw badRequest(`Minimum stake is ${g.min_bet}`, 'STAKE_TOO_LOW');
  if (stake > Number(g.max_bet)) throw badRequest(`Maximum stake is ${g.max_bet}`, 'STAKE_TOO_HIGH');
}

/**
 * Shared round runner: draws the outcome from the active seed, records the
 * round, then posts stake and payout ledger entries that reference it.
 */
async function playRound<R extends Record<string, unknown>>(
  userId: number,
  game: GameRow,
  stake: number,
  clientSeed: string | undefined,
  draw: (seed: FairnessSeedRow) => { multiplier: number; result: R }
) {
  return withTransaction(async (c) => {
    const seed = await activeSeed(c, userId, clientSeed);
    const { multiplier, result } = draw(seed);
    const stakeMinor = toMinor(stake);
    const payout = multiplier > 0 ? payoutMinor(stakeMinor, multiplier) : 0;

    const round = await queryOne<{ id: number }>(
      c,
      `INSERT INTO game_rounds (user_id, game_id, fairness_seed_id, nonce, stake, multiplier, payout, result, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        userId,
        game.id,
        seed.id,
        seed.nonce,
        fromMinor(stakeMinor),
        multiplier.toFixed(4),
        fromMinor(payout),
        JSON.stringify(result),
        payout > 0 ? 'win' : 'loss',
      ]
    );
    let balance = await walletRepo.adjustBalance(c, {
      userId,
      amount: `-${fromMinor(stakeMinor)}`,
      type: 'game_stake',
      referenceType: 'game_round',
      referenceId: round!.id,
    });
    if (payout > 0) {
      balance = await walletRepo.adjustBalance(c, {
        userId,
        amount: fromMinor(payout),
        type: 'game_payout',
        referenceType: 'game_round',
        referenceId: round!.id,
      });
    }
    await c.query('UPDATE fairness_seeds SET nonce = nonce + 1 WHERE id = $1', [seed.id]);
    log.debug(
      {
        event: 'casino.round',
        game: game.slug,
        roundId: round!.id,
        stake: fromMinor(stakeMinor),
        payout: fromMinor(payout),
        multiplier,
        nonce: seed.nonce,
      },
      `${game.slug} round ${payout > 0 ? 'won' : 'lost'}`
    );

    return {
      roundId: round!.id,
      game: game.slug,
      nonce: seed.nonce,
      serverSeedHash: seed.server_seed_hash,
      ...result,
      won: payout > 0,
      multiplier,
      payout: fromMinor(payout),
      balance,
    };
  });
}

export async function playDice(userId: number, p: { stake: number; target: number; direction: 'under' | 'over'; clientSeed?: string }) {
  const game = await getGame('dice');
  checkStake(p.stake, game);
  if (!(p.target >= 2 && p.target <= 98)) throw badRequest('target must be between 2 and 98');
  const edge = Number(game.config.houseEdgePercent ?? 2) / 100;
  return playRound(userId, game, p.stake, p.clientSeed, (seed) => {
    const roll = pf.rollDice(seed.server_seed, seed.client_seed, seed.nonce);
    const winChance = p.direction === 'under' ? p.target / 100 : (100 - p.target) / 100;
    const won = p.direction === 'under' ? roll < p.target : roll > p.target;
    const multiplier = Number(((1 / winChance) * (1 - edge)).toFixed(4));
    return { multiplier: won ? multiplier : 0, result: { roll, target: p.target, direction: p.direction } };
  });
}

export async function playCoinflip(userId: number, p: { stake: number; call: 'heads' | 'tails'; clientSeed?: string }) {
  const game = await getGame('coinflip');
  checkStake(p.stake, game);
  const edge = Number(game.config.houseEdgePercent ?? 2) / 100;
  return playRound(userId, game, p.stake, p.clientSeed, (seed) => {
    const side = pf.flipCoin(seed.server_seed, seed.client_seed, seed.nonce) ? 'heads' : 'tails';
    return { multiplier: side === p.call ? 2 * (1 - edge) : 0, result: { result: side, call: p.call } };
  });
}

export async function playSlots(userId: number, p: { stake: number; clientSeed?: string }) {
  const game = await getGame('slots-classic');
  checkStake(p.stake, game);
  const { symbols = [], weights = [], payouts = {} } = game.config;
  return playRound(userId, game, p.stake, p.clientSeed, (seed) => {
    const reels = [0, 1, 2].map((i) => pf.pickWeightedSymbol(seed.server_seed, seed.client_seed, seed.nonce, i, symbols, weights));
    const multiplier = reels.every((r) => r === reels[0]) ? Number(payouts[reels[0]] ?? 0) : 0;
    return { multiplier, result: { reels } };
  });
}

export function history(userId: number, p: Pagination) {
  return query(
    pool,
    `SELECT r.id, g.slug AS game, r.stake, r.multiplier, r.payout, r.result, r.outcome, r.nonce, r.created_at,
            s.server_seed_hash, s.client_seed, CASE WHEN s.is_active THEN NULL ELSE s.server_seed END AS revealed_server_seed
     FROM game_rounds r JOIN games g ON g.id = r.game_id JOIN fairness_seeds s ON s.id = r.fairness_seed_id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
    [userId, p.limit, p.offset]
  );
}
