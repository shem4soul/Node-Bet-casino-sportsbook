import { pool, withTransaction } from '../config/db';
import * as sportsRepo from '../repositories/sportsRepository';
import * as walletRepo from '../repositories/walletRepository';
import { AppError } from '../middleware/errorHandler';
import { minBetAmount, maxBetAmount } from '../config/env';
import { PoolConnection } from 'mysql2/promise';
import { OddsResult, OddsRow } from '../types/db';

export async function listUpcomingEvents(pagination: { status?: any; limit?: number; offset?: number }) {
  return sportsRepo.listEvents(pool, pagination);
}

export async function getEvent(eventId: number) {
  const event = await sportsRepo.getEventWithMarkets(pool, eventId);
  if (!event) throw new AppError('Event not found', 404);
  return event;
}

export interface PlaceBetParams {
  stake: number;
  selections: { oddsId: number }[];
}

/**
 * selections: [{ oddsId }, ...] — one item for a single bet, several for a multi.
 * Prices are re-read and locked at placement time (never trust client-supplied
 * odds), so the payout reflects the live price, not whatever the UI cached.
 */
export async function placeBet(userId: number, { stake, selections }: PlaceBetParams) {
  if (!(stake > 0)) throw new AppError('Stake must be positive', 400);
  if (stake < minBetAmount) throw new AppError(`Minimum stake is ${minBetAmount}`, 400);
  if (stake > maxBetAmount) throw new AppError(`Maximum stake is ${maxBetAmount}`, 400);
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new AppError('At least one selection is required', 400);
  }

  const seenEvents = new Set<number>();

  return withTransaction(async (conn) => {
    let totalOdds = 1;
    const resolvedSelections: OddsRow[] = [];

    for (const sel of selections) {
      const odds = await sportsRepo.getOddsForUpdate(conn, sel.oddsId);
      if (!odds) throw new AppError(`Odds ${sel.oddsId} not found`, 404);
      if (odds.market_status !== 'open' || !odds.is_active) {
        throw new AppError(`Market for odds ${sel.oddsId} is not open for betting`, 409);
      }
      // A multi cannot contain two selections from the same event (correlated outcomes)
      if (seenEvents.has(odds.event_id!)) {
        throw new AppError('A multi-bet cannot include more than one selection from the same event', 400);
      }
      seenEvents.add(odds.event_id!);

      totalOdds *= Number(odds.price_decimal);
      resolvedSelections.push(odds);
    }

    const betType: 'single' | 'multi' = resolvedSelections.length > 1 ? 'multi' : 'single';
    const potentialPayout = Number((stake * totalOdds).toFixed(2));

    // Create the slip first — its id is known up front (stake/odds/payout
    // are all already computed), so the wallet debit can reference it
    // directly instead of a fragile "find the most recent row" backfill.
    const betSlipId = await sportsRepo.createBetSlip(conn, {
      userId,
      stake,
      betType,
      totalOdds: totalOdds.toFixed(3),
      potentialPayout,
    });

    await walletRepo.adjustBalance(conn, {
      userId,
      amount: -stake,
      type: 'bet_stake',
      referenceType: 'bet_slip',
      referenceId: betSlipId,
    });

    for (const odds of resolvedSelections) {
      await sportsRepo.addSelection(conn, {
        betSlipId,
        oddsId: odds.id,
        eventId: odds.event_id!,
        selection: odds.selection,
        priceAtPlacement: odds.price_decimal,
      });
    }

    return { betSlipId, betType, totalOdds, potentialPayout, stake };
  });
}

export async function listMyBets(userId: number, pagination: { limit?: number; offset?: number }) {
  return sportsRepo.listBetSlipsForUser(pool, userId, pagination);
}

export interface SettleMarketParams {
  marketId: number;
  winningSelection?: string;
  voidMarket?: boolean;
}

/**
 * Admin settlement for one market. `winningSelection` is the selection
 * string that won (e.g. 'HOME'); every other selection in the market is
 * marked lost. Pass `voidMarket: true` instead to void the whole market
 * (e.g. event cancelled) and refund any pending selections tied to it.
 */
export async function settleMarket({ marketId, winningSelection, voidMarket = false }: SettleMarketParams) {
  return withTransaction(async (conn) => {
    const [marketRows] = await conn.query<any[]>('SELECT * FROM markets WHERE id = ? FOR UPDATE', [marketId]);
    const market = marketRows[0];
    if (!market) throw new AppError('Market not found', 404);
    if (market.status === 'settled') throw new AppError('Market already settled', 409);

    const [oddsRows] = await conn.query<any[]>('SELECT * FROM odds WHERE market_id = ? FOR UPDATE', [marketId]);
    if (!voidMarket && !oddsRows.some((o: any) => o.selection === winningSelection)) {
      throw new AppError('winningSelection does not match any odds in this market', 400);
    }

    for (const odds of oddsRows) {
      const result: OddsResult = voidMarket ? 'void' : odds.selection === winningSelection ? 'won' : 'lost';
      await sportsRepo.setOddsResult(conn, odds.id, result);
    }
    await sportsRepo.setMarketSettled(conn, marketId);

    const pendingSelections = await sportsRepo.getPendingSelectionsForMarket(conn, marketId);
    const affectedSlipIds = new Set<number>();

    for (const sel of pendingSelections) {
      const odds = oddsRows.find((o: any) => o.id === sel.odds_id);
      const result: OddsResult = voidMarket ? 'void' : odds.selection === winningSelection ? 'won' : 'lost';
      await sportsRepo.setSelectionResult(conn, sel.id, result);
      affectedSlipIds.add(sel.bet_slip_id);
    }

    for (const slipId of affectedSlipIds) {
      await maybeSettleSlip(conn, slipId);
    }

    return { marketId, settledSelections: pendingSelections.length, affectedSlips: affectedSlipIds.size };
  });
}

/** If a bet slip has no more pending selections, resolve win/loss and pay out. */
async function maybeSettleSlip(conn: PoolConnection, betSlipId: number): Promise<void> {
  const remainingPending = await sportsRepo.countPendingSelectionsForSlip(conn, betSlipId);
  if (remainingPending > 0) return; // other legs still awaiting results

  const slip = await sportsRepo.getBetSlipForUpdate(conn, betSlipId);
  if (!slip || slip.status !== 'pending') return;

  const allSelections = await sportsRepo.getSelectionsForSlip(conn, betSlipId);
  const anyLost = allSelections.some((s) => s.result === 'lost');
  const allVoid = allSelections.every((s) => s.result === 'void');

  if (anyLost) {
    await sportsRepo.settleBetSlip(conn, betSlipId, 'lost');
    return;
  }

  if (allVoid) {
    // Full void — refund the original stake
    await walletRepo.adjustBalance(conn, {
      userId: slip.user_id,
      amount: Number(slip.stake),
      type: 'bet_void_refund',
      referenceType: 'bet_slip',
      referenceId: betSlipId,
    });
    await sportsRepo.settleBetSlip(conn, betSlipId, 'void');
    return;
  }

  // Won: recompute payout using only non-void legs (void legs count as 1.0x)
  const effectiveOdds = allSelections.reduce((acc, s) => {
    if (s.result === 'void') return acc;
    return acc * Number(s.price_decimal_at_placement);
  }, 1);
  const payout = Number((Number(slip.stake) * effectiveOdds).toFixed(2));

  await walletRepo.adjustBalance(conn, {
    userId: slip.user_id,
    amount: payout,
    type: 'bet_payout',
    referenceType: 'bet_slip',
    referenceId: betSlipId,
  });
  await sportsRepo.settleBetSlip(conn, betSlipId, 'won');
}
