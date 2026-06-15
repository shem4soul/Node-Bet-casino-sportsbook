import { PoolClient } from 'pg';
import { createLogger } from '../config/logger';
import { query, queryOne, withTransaction } from '../config/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { combineOdds, fromMinor, payoutMinor, toMinor } from '../lib/money';
import * as walletRepo from '../repositories/walletRepository';
import { LegResult, Score, settleMarketFromScore } from './markets/footballMarkets';
import { audit } from './auditService';
import type { BetSelectionRow, BetSlipRow, EventRow, MarketRow, OddsRow } from '../types/db';

const log = createLogger('settlement');

/**
 * Settles one market given a result per selection, then resolves every bet
 * slip that no longer has pending legs. Runs inside the caller's transaction.
 */
async function settleMarketWithResults(c: PoolClient, market: MarketRow, results: Record<string, LegResult>) {
  const odds = await query<OddsRow>(c, 'SELECT * FROM odds WHERE market_id = $1 FOR UPDATE', [market.id]);
  for (const o of odds) {
    const r = results[o.selection];
    if (!r) throw badRequest(`Missing result for selection ${o.selection}`);
    await c.query('UPDATE odds SET result = $2 WHERE id = $1', [o.id, r]);
  }
  const allVoid = odds.every((o) => results[o.selection] === 'void');
  await c.query('UPDATE markets SET status = $2, settled_at = now() WHERE id = $1', [market.id, allVoid ? 'void' : 'settled']);

  const legs = await query<BetSelectionRow>(c, `SELECT * FROM bet_selections WHERE market_id = $1 AND result = 'pending' FOR UPDATE`, [
    market.id,
  ]);
  const slipIds = new Set<number>();
  for (const leg of legs) {
    await c.query('UPDATE bet_selections SET result = $2 WHERE id = $1', [leg.id, results[leg.selection]]);
    slipIds.add(leg.bet_slip_id);
  }
  let paid = 0;
  for (const id of slipIds) if (await maybeSettleSlip(c, id)) paid += 1;
  log.info(
    {
      event: 'market.settled',
      marketId: market.id,
      eventId: market.event_id,
      marketType: market.market_type,
      line: market.line,
      results,
      legsSettled: legs.length,
      slipsResolved: slipIds.size,
      slipsPaid: paid,
    },
    `Market ${market.market_type}${market.line !== null ? ` ${market.line}` : ''} settled`
  );
  return { marketId: market.id, legsSettled: legs.length, slipsResolved: slipIds.size, slipsPaid: paid };
}

/**
 * If a slip has no pending legs left: any lost leg -> lost; all void ->
 * stake refunded; otherwise won, paying stake x product of non-void prices
 * (void legs count as 1.00). Cashed-out slips are left alone.
 * Returns true if money was credited.
 */
export async function maybeSettleSlip(c: PoolClient, slipId: number): Promise<boolean> {
  const slip = await queryOne<BetSlipRow>(c, 'SELECT * FROM bet_slips WHERE id = $1 FOR UPDATE', [slipId]);
  if (!slip || slip.status !== 'pending') return false;

  const legs = await query<BetSelectionRow>(c, 'SELECT * FROM bet_selections WHERE bet_slip_id = $1', [slipId]);
  if (legs.some((l) => l.result === 'lost')) {
    await c.query(`UPDATE bet_slips SET status = 'lost', payout = 0, settled_at = now() WHERE id = $1`, [slipId]);
    log.debug({ event: 'bet.settled', betId: slipId, ownerId: slip.user_id, outcome: 'lost', stake: slip.stake }, 'Bet lost');
    return false;
  }
  if (legs.some((l) => l.result === 'pending')) return false;

  if (legs.every((l) => l.result === 'void')) {
    await walletRepo.adjustBalance(c, {
      userId: slip.user_id,
      amount: slip.stake,
      type: 'bet_void_refund',
      referenceType: 'bet_slip',
      referenceId: slipId,
      note: 'All selections void',
    });
    await c.query(`UPDATE bet_slips SET status = 'void', payout = $2, settled_at = now() WHERE id = $1`, [slipId, slip.stake]);
    log.info(
      { event: 'bet.settled', betId: slipId, ownerId: slip.user_id, outcome: 'void', refund: slip.stake },
      'Bet void — stake refunded'
    );
    return true;
  }

  const odds = combineOdds(legs.filter((l) => l.result !== 'void').map((l) => l.price_decimal_at_placement));
  const payout = fromMinor(Math.min(payoutMinor(toMinor(slip.stake), odds), toMinor(slip.potential_payout)));
  await walletRepo.adjustBalance(c, {
    userId: slip.user_id,
    amount: payout,
    type: 'bet_payout',
    referenceType: 'bet_slip',
    referenceId: slipId,
  });
  await c.query(`UPDATE bet_slips SET status = 'won', payout = $2, settled_at = now() WHERE id = $1`, [slipId, payout]);
  log.info(
    { event: 'bet.settled', betId: slipId, ownerId: slip.user_id, outcome: 'won', stake: slip.stake, payout },
    `Bet won — paid ${payout}`
  );
  return true;
}

/** Manual settlement of one market by an admin. */
export async function settleMarketManually(
  actorId: number,
  marketId: number,
  input: { winningSelection?: string; results?: Record<string, LegResult>; voidMarket?: boolean },
  ip?: string | null
) {
  return withTransaction(async (c) => {
    const market = await queryOne<MarketRow>(c, 'SELECT * FROM markets WHERE id = $1 FOR UPDATE', [marketId]);
    if (!market) throw notFound('Market');
    if (['settled', 'void'].includes(market.status)) throw conflict(`Market already ${market.status}`);

    const selections = (await query<{ selection: string }>(c, 'SELECT selection FROM odds WHERE market_id = $1', [marketId])).map(
      (r) => r.selection
    );
    let results: Record<string, LegResult>;
    if (input.voidMarket) {
      results = Object.fromEntries(selections.map((s) => [s, 'void' as const]));
    } else if (input.results) {
      results = Object.fromEntries(Object.entries(input.results).map(([k, v]) => [k.toUpperCase(), v]));
      const missing = selections.filter((s) => !results[s]);
      if (missing.length) throw badRequest(`Provide a result for every selection; missing: ${missing.join(', ')}`);
    } else if (input.winningSelection) {
      const win = input.winningSelection.toUpperCase();
      if (!selections.includes(win)) throw badRequest('winningSelection does not match any selection in this market');
      results = Object.fromEntries(selections.map((s) => [s, s === win ? ('won' as const) : ('lost' as const)]));
    } else {
      throw badRequest('Provide winningSelection, results, or voidMarket');
    }

    const summary = await settleMarketWithResults(c, market, results);
    await audit(c, { actorId, action: 'market.settle', entityType: 'market', entityId: marketId, metadata: { results }, ip });
    log.info({ event: 'market.settled_manually', marketId, results }, 'Market settled manually by admin');
    return summary;
  });
}

/**
 * Records the final score of an event and auto-settles every supported
 * market from it (1X2, double chance, O/U, BTTS, HT/FT, correct score,
 * handicap, ...). Markets the engine can't settle (custom types, HT markets
 * without a HT score) are reported back for manual settlement.
 */
export async function recordResultAndSettle(
  actorId: number | null,
  eventId: number,
  score: Score,
  ip?: string | null,
  source: 'admin' | 'feed' = 'admin'
) {
  return withTransaction(async (c) => {
    const ev = await queryOne<EventRow>(c, 'SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!ev) throw notFound('Event');
    if (ev.status === 'cancelled') throw conflict('Event is cancelled');
    if (ev.settled_at) throw conflict('Event result has already been settled');
    if (ev.start_time > new Date()) throw conflict('Event has not started yet');
    if ((score.htHome == null) !== (score.htAway == null)) throw badRequest('Provide both half-time scores or neither');
    if (score.htHome != null && (score.htHome > score.home || score.htAway! > score.away)) {
      throw badRequest('Half-time score cannot exceed the full-time score');
    }

    await c.query(
      `UPDATE events SET status = 'finished', home_score = $2, away_score = $3, ht_home_score = $4, ht_away_score = $5 WHERE id = $1`,
      [eventId, score.home, score.away, score.htHome ?? null, score.htAway ?? null]
    );

    const markets = await query<MarketRow>(c, `SELECT * FROM markets WHERE event_id = $1 AND status IN ('open', 'suspended') FOR UPDATE`, [
      eventId,
    ]);
    const settled: unknown[] = [];
    const manual: { marketId: number; type: string; reason: string }[] = [];

    for (const m of markets) {
      const selections = (await query<{ selection: string }>(c, 'SELECT selection FROM odds WHERE market_id = $1', [m.id])).map(
        (r) => r.selection
      );
      const outcome = settleMarketFromScore(m.market_type, m.line === null ? null : Number(m.line), selections, score);
      if (!outcome.ok) {
        // Stop further betting on it, but leave it for a human.
        await c.query(`UPDATE markets SET status = 'suspended' WHERE id = $1`, [m.id]);
        manual.push({ marketId: m.id, type: m.market_type, reason: outcome.reason });
        continue;
      }
      settled.push({ type: m.market_type, line: m.line, ...(await settleMarketWithResults(c, m, outcome.results)) });
    }

    if (manual.length === 0) await c.query('UPDATE events SET settled_at = now() WHERE id = $1', [eventId]);
    await audit(c, {
      actorId,
      action: 'event.result',
      entityType: 'event',
      entityId: eventId,
      metadata: { score, source, manual: manual.length },
      ip,
    });
    log.info(
      {
        event: 'event.result_recorded',
        eventId,
        match: `${ev.home_team} vs ${ev.away_team}`,
        score,
        source,
        marketsSettled: settled.length,
        needsManual: manual,
      },
      `Result ${ev.home_team} ${score.home}-${score.away} ${ev.away_team} recorded (${source})`
    );
    if (manual.length)
      log.warn({ event: 'event.manual_settlement_needed', eventId, markets: manual }, `${manual.length} market(s) need manual settlement`);
    return { eventId, score, settledMarkets: settled, needsManualSettlement: manual };
  });
}

/** Cancels an event: voids every unsettled market, refunding/recomputing affected slips. */
export async function cancelEvent(actorId: number, eventId: number, reason: string, ip?: string | null) {
  return withTransaction(async (c) => {
    const ev = await queryOne<EventRow>(c, 'SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!ev) throw notFound('Event');
    if (ev.status === 'cancelled') throw conflict('Event already cancelled');
    if (ev.settled_at) throw conflict('Event already settled');

    await c.query(`UPDATE events SET status = 'cancelled', settled_at = now() WHERE id = $1`, [eventId]);
    const markets = await query<MarketRow>(c, `SELECT * FROM markets WHERE event_id = $1 AND status IN ('open', 'suspended') FOR UPDATE`, [
      eventId,
    ]);
    let legs = 0;
    for (const m of markets) {
      const sels = (await query<{ selection: string }>(c, 'SELECT selection FROM odds WHERE market_id = $1', [m.id])).map(
        (r) => r.selection
      );
      const r = await settleMarketWithResults(c, m, Object.fromEntries(sels.map((s) => [s, 'void' as const])));
      legs += r.legsSettled;
    }
    await audit(c, { actorId, action: 'event.cancel', entityType: 'event', entityId: eventId, metadata: { reason }, ip });
    log.warn(
      {
        event: 'event.cancelled',
        eventId,
        match: `${ev.home_team} vs ${ev.away_team}`,
        reason,
        voidedMarkets: markets.length,
        voidedLegs: legs,
      },
      'Event cancelled — all markets void'
    );
    return { eventId, voidedMarkets: markets.length, voidedLegs: legs };
  });
}
