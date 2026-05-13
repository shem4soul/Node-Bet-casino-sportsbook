import crypto from 'crypto';
import { pool, withTransaction } from '../config/db';
import { PoolConnection } from 'mysql2/promise';
import * as casinoRepo from '../repositories/casinoRepository';
import * as walletRepo from '../repositories/walletRepository';
import { AppError } from '../middleware/errorHandler';
import * as pf from '../utils/provablyFair';
import { minBetAmount, maxBetAmount } from '../config/env';
import { GameRow } from '../types/db';

interface SeedState {
  id: number;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
}

async function ensureSeed(conn: PoolConnection, userId: number, clientSeed?: string): Promise<SeedState> {
  const existing = await casinoRepo.getActiveSeed(conn, userId);
  if (existing) return existing;

  const serverSeed = pf.generateServerSeed();
  const serverSeedHash = pf.hashServerSeed(serverSeed);
  const finalClientSeed = clientSeed || crypto.randomBytes(8).toString('hex');
  const id = await casinoRepo.createSeed(conn, {
    userId,
    serverSeed,
    serverSeedHash,
    clientSeed: finalClientSeed,
  });
  return { id, server_seed: serverSeed, server_seed_hash: serverSeedHash, client_seed: finalClientSeed, nonce: 0 };
}

/** Returns the current seed hash (not the raw seed) plus client seed/nonce. */
export async function getFairnessState(userId: number) {
  return withTransaction(async (conn) => {
    const seed = await ensureSeed(conn, userId);
    return {
      serverSeedHash: seed.server_seed_hash,
      clientSeed: seed.client_seed,
      nonce: seed.nonce,
    };
  });
}

/** Rotates the seed pair, revealing the previous server seed for verification. */
export async function rotateSeed(userId: number, newClientSeed?: string) {
  return withTransaction(async (conn) => {
    const current = await casinoRepo.getActiveSeed(conn, userId);
    if (current) {
      await casinoRepo.deactivateSeed(conn, current.id);
    }
    const serverSeed = pf.generateServerSeed();
    const serverSeedHash = pf.hashServerSeed(serverSeed);
    const clientSeed = newClientSeed || crypto.randomBytes(8).toString('hex');
    await casinoRepo.createSeed(conn, { userId, serverSeed, serverSeedHash, clientSeed });

    return {
      revealedPreviousServerSeed: current ? current.server_seed : null,
      newServerSeedHash: serverSeedHash,
      clientSeed,
    };
  });
}

function validateStake(stake: number, game?: GameRow | null): void {
  const min = game ? Number(game.min_bet) : minBetAmount;
  const max = game ? Number(game.max_bet) : maxBetAmount;
  if (!(stake > 0)) throw new AppError('Stake must be positive', 400);
  if (stake < min) throw new AppError(`Minimum stake is ${min}`, 400);
  if (stake > max) throw new AppError(`Maximum stake is ${max}`, 400);
}

export interface PlayDiceParams {
  stake: number;
  target: number;
  direction: 'under' | 'over';
  clientSeed?: string;
}

/**
 * Dice: player picks a target (0-99.99) and direction ('under' | 'over').
 * Payout multiplier is derived from the win probability so the house
 * keeps `houseEdgePercent` on average — same shape real dice games use.
 */
export async function playDice(userId: number, { stake, target, direction, clientSeed }: PlayDiceParams) {
  const game = await casinoRepo.getGameBySlug(pool, 'dice');
  if (!game) throw new AppError('Game not available', 404);
  validateStake(stake, game);
  if (!(target > 0 && target < 100)) throw new AppError('target must be between 0 and 100', 400);
  if (!['under', 'over'].includes(direction)) throw new AppError("direction must be 'under' or 'over'", 400);

  const houseEdge = Number(game.config_json.houseEdgePercent || 2) / 100;

  return withTransaction(async (conn) => {
    const seed = await ensureSeed(conn, userId, clientSeed);
    const nonce = seed.nonce;

    // Debit stake first
    await walletRepo.adjustBalance(conn, { userId, amount: -stake, type: 'game_stake', referenceType: 'game_round' });

    const roll = pf.rollDice(seed.server_seed, seed.client_seed, nonce);
    const winProbability = direction === 'under' ? target / 100 : (100 - target) / 100;
    const fairMultiplier = 1 / winProbability;
    const multiplier = fairMultiplier * (1 - houseEdge);

    const won = direction === 'under' ? roll < target : roll > target;
    const payout = won ? Number((stake * multiplier).toFixed(2)) : 0;

    if (payout > 0) {
      await walletRepo.adjustBalance(conn, {
        userId,
        amount: payout,
        type: 'game_payout',
        referenceType: 'game_round',
      });
    }

    await casinoRepo.incrementNonce(conn, seed.id);

    const roundId = await casinoRepo.insertRound(conn, {
      userId,
      gameId: game.id,
      fairnessSeedId: seed.id,
      nonce,
      stake,
      multiplier: won ? multiplier : 0,
      payout,
      resultJson: { roll, target, direction },
      outcome: won ? 'win' : 'loss',
    });

    const wallet = await walletRepo.getWallet(conn, userId);

    return { roundId, roll, target, direction, won, payout, multiplier: won ? multiplier : 0, balance: wallet!.balance };
  });
}

export interface PlayCoinflipParams {
  stake: number;
  call: 'heads' | 'tails';
  clientSeed?: string;
}

export async function playCoinflip(userId: number, { stake, call, clientSeed }: PlayCoinflipParams) {
  const game = await casinoRepo.getGameBySlug(pool, 'coinflip');
  if (!game) throw new AppError('Game not available', 404);
  validateStake(stake, game);
  if (!['heads', 'tails'].includes(call)) throw new AppError("call must be 'heads' or 'tails'", 400);

  const houseEdge = Number(game.config_json.houseEdgePercent || 2) / 100;
  const multiplier = 2 * (1 - houseEdge);

  return withTransaction(async (conn) => {
    const seed = await ensureSeed(conn, userId, clientSeed);
    const nonce = seed.nonce;

    await walletRepo.adjustBalance(conn, { userId, amount: -stake, type: 'game_stake', referenceType: 'game_round' });

    const isHeads = pf.flipCoin(seed.server_seed, seed.client_seed, nonce);
    const result = isHeads ? 'heads' : 'tails';
    const won = result === call;
    const payout = won ? Number((stake * multiplier).toFixed(2)) : 0;

    if (payout > 0) {
      await walletRepo.adjustBalance(conn, { userId, amount: payout, type: 'game_payout', referenceType: 'game_round' });
    }

    await casinoRepo.incrementNonce(conn, seed.id);

    const roundId = await casinoRepo.insertRound(conn, {
      userId,
      gameId: game.id,
      fairnessSeedId: seed.id,
      nonce,
      stake,
      multiplier: won ? multiplier : 0,
      payout,
      resultJson: { result, call },
      outcome: won ? 'win' : 'loss',
    });

    const wallet = await walletRepo.getWallet(conn, userId);

    return { roundId, result, call, won, payout, multiplier: won ? multiplier : 0, balance: wallet!.balance };
  });
}

export interface PlaySlotsParams {
  stake: number;
  clientSeed?: string;
}

export async function playSlots(userId: number, { stake, clientSeed }: PlaySlotsParams) {
  const game = await casinoRepo.getGameBySlug(pool, 'slots-classic');
  if (!game) throw new AppError('Game not available', 404);
  validateStake(stake, game);

  const { symbols = [], weights = [], payouts = {} } = game.config_json;
  const REELS = 3;

  return withTransaction(async (conn) => {
    const seed = await ensureSeed(conn, userId, clientSeed);
    const nonce = seed.nonce;

    await walletRepo.adjustBalance(conn, { userId, amount: -stake, type: 'game_stake', referenceType: 'game_round' });

    const reels: string[] = [];
    for (let i = 0; i < REELS; i += 1) {
      reels.push(pf.pickWeightedSymbol(seed.server_seed, seed.client_seed, nonce, i, symbols, weights));
    }

    let multiplier = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      multiplier = Number(payouts[reels[0]] || 0);
    }
    const won = multiplier > 0;
    const payout = won ? Number((stake * multiplier).toFixed(2)) : 0;

    if (payout > 0) {
      await walletRepo.adjustBalance(conn, { userId, amount: payout, type: 'game_payout', referenceType: 'game_round' });
    }

    await casinoRepo.incrementNonce(conn, seed.id);

    const roundId = await casinoRepo.insertRound(conn, {
      userId,
      gameId: game.id,
      fairnessSeedId: seed.id,
      nonce,
      stake,
      multiplier,
      payout,
      resultJson: { reels },
      outcome: won ? 'win' : 'loss',
    });

    const wallet = await walletRepo.getWallet(conn, userId);

    return { roundId, reels, won, payout, multiplier, balance: wallet!.balance };
  });
}

export async function getHistory(userId: number, pagination: { limit?: number; offset?: number }) {
  return casinoRepo.listRoundsForUser(pool, userId, pagination);
}
