import { PoolClient } from 'pg';
import { env } from '../config/env';
import { pool, query, queryOne, withTransaction, PG_UNIQUE_VIOLATION } from '../config/db';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { combineOdds, fromMinor, payoutMinor, toMinor } from '../lib/money';
import { bookingCode } from '../lib/tokens';
import * as walletRepo from '../repositories/walletRepository';
import { betsPlaced } from '../middleware/metrics';
import type { BetSelectionRow, BetSlipRow } from '../types/db';
import type { Pagination } from '../lib/http';

interface LiveOdds {
  odds_id: number;
  selection: string;
  price_decimal: string;
  odds_active: boolean;
  market_id: number;
  market_type: string;
  line: string | null;
  market_status: string;
  event_id: number;
  event_status: string;
  start_time: Date;
  home_team: string;
  away_team: string;
}

const LIVE_ODDS_SQL = `
  SELECT o.id AS odds_id, o.selection, o.price_decimal, o.is_active AS odds_active,
         m.id AS market_id, m.market_type, m.line, m.status AS market_status,
         e.id AS event_id, e.status AS event_status, e.start_time, e.home_team, e.away_team
  FROM odds o JOIN markets m ON m.id = o.market_id JOIN events e ON e.id = m.event_id`;

function isBettable(o: LiveOdds): boolean {
  return o.odds_active && o.market_status === 'open' && o.event_status === 'scheduled' && o.start_time > new Date();
}

export type OddsChangePolicy = 'none' | 'higher' | 'any';

export interface PlaceBetInput {
  stake: number;
  selections: { oddsId: number; price?: number }[];
  acceptOddsChanges?: OddsChangePolicy;
  idempotencyKey?: string;
  bookingCode?: string;
}

/**
 * Places a single (1 selection) or accumulator (2+) bet.
 *
 *  * Prices are always re-read and row-locked server-side; a client-sent
 *    `price` is only used to detect odds movement, never to price the bet.
 *  * acceptOddsChanges: 'none' rejects any change, 'higher' (default)
 *    accepts improvements only, 'any' accepts whatever the current price is.
 *  * Pre-match only: the event must be scheduled and not yet kicked off.
 *  * One leg per event (prevents correlated same-game accumulators).
 *  * Idempotency-Key makes retries from flaky mobile networks safe.
 */
export async function placeBet(userId: number, input: PlaceBetInput) {
  const { stake, selections } = input;
  const policy = input.acceptOddsChanges ?? 'higher';

  if (stake < env.MIN_STAKE) throw badRequest(`Minimum stake is ${env.MIN_STAKE} ${env.CURRENCY}`, 'STAKE_TOO_LOW');
  if (stake > env.MAX_STAKE) throw badRequest(`Maximum stake is ${env.MAX_STAKE} ${env.CURRENCY}`, 'STAKE_TOO_HIGH');
  if (selections.length === 0) throw badRequest('At least one selection is required');
  if (selections.length > env.MAX_SELECTIONS)
    throw badRequest(`A bet slip can have at most ${env.MAX_SELECTIONS} selections`, 'TOO_MANY_SELECTIONS');
  if (new Set(selections.map((s) => s.oddsId)).size !== selections.length) throw badRequest('Duplicate selections');

  if (input.idempotencyKey) {
    const existing = await queryOne<BetSlipRow>(pool, 'SELECT * FROM bet_slips WHERE user_id = $1 AND idempotency_key = $2', [
      userId,
      input.idempotencyKey,
    ]);
    if (existing) return { ...(await getBet(userId, existing.id)), idempotentReplay: true };
  }

  try {
    const slipId = await withTransaction(async (c) => {
      const ids = selections.map((s) => s.oddsId);
      // Lock the odds rows in a stable order to avoid deadlocks between concurrent slips.
      const rows = await query<LiveOdds>(c, `${LIVE_ODDS_SQL} WHERE o.id = ANY($1::bigint[]) ORDER BY o.id FOR UPDATE OF o`, [ids]);
      const byId = new Map(rows.map((r) => [r.odds_id, r]));

      const changes: { oddsId: number; requested: number; current: string }[] = [];
      const unavailable: number[] = [];
      const events = new Set<number>();

      for (const s of selections) {
        const o = byId.get(s.oddsId);
        if (!o || !isBettable(o)) {
          unavailable.push(s.oddsId);
          continue;
        }
        if (events.has(o.event_id)) throw badRequest('Only one selection per match is allowed on a bet slip', 'SAME_EVENT_SELECTIONS');
        events.add(o.event_id);

        if (s.price !== undefined) {
          const current = Number(o.price_decimal);
          const moved = Math.abs(current - s.price) > 1e-9;
          const ok = !moved || policy === 'any' || (policy === 'higher' && current > s.price);
          if (!ok) changes.push({ oddsId: s.oddsId, requested: s.price, current: o.price_decimal });
        }
      }

      if (unavailable.length) throw conflict('Some selections are no longer available', 'SELECTIONS_UNAVAILABLE', { oddsIds: unavailable });
      if (changes.length) throw conflict('Odds have changed', 'ODDS_CHANGED', { changes });

      const ordered = selections.map((s) => byId.get(s.oddsId)!);
      const totalOdds = combineOdds(ordered.map((o) => o.price_decimal));
      const stakeMinor = toMinor(stake);
      const potentialMinor = payoutMinor(stakeMinor, totalOdds);
      if (potentialMinor > toMinor(env.MAX_PAYOUT)) {
        throw badRequest(
          `Potential payout exceeds the maximum of ${env.MAX_PAYOUT} ${env.CURRENCY}. Reduce your stake or selections.`,
          'MAX_PAYOUT_EXCEEDED'
        );
      }

      const slip = await queryOne<{ id: number }>(
        c,
        `INSERT INTO bet_slips (user_id, stake, bet_type, total_odds, potential_payout, idempotency_key, booking_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          userId,
          fromMinor(stakeMinor),
          ordered.length > 1 ? 'multi' : 'single',
          totalOdds.toFixed(3),
          fromMinor(potentialMinor),
          input.idempotencyKey ?? null,
          input.bookingCode ?? null,
        ]
      );

      await walletRepo.adjustBalance(c, {
        userId,
        amount: `-${fromMinor(stakeMinor)}`,
        type: 'bet_stake',
        referenceType: 'bet_slip',
        referenceId: slip!.id,
      });

      for (const o of ordered) {
        await c.query(
          `INSERT INTO bet_selections (bet_slip_id, odds_id, market_id, event_id, market_type, line, selection, price_decimal_at_placement)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [slip!.id, o.odds_id, o.market_id, o.event_id, o.market_type, o.line, o.selection, o.price_decimal]
        );
      }
      betsPlaced.inc({ bet_type: ordered.length > 1 ? 'multi' : 'single' });
      return slip!.id;
    });
    return getBet(userId, slipId);
  } catch (err: any) {
    // Two concurrent requests with the same Idempotency-Key: return the winner's slip.
    if (err?.code === PG_UNIQUE_VIOLATION && input.idempotencyKey) {
      const existing = await queryOne<BetSlipRow>(pool, 'SELECT * FROM bet_slips WHERE user_id = $1 AND idempotency_key = $2', [
        userId,
        input.idempotencyKey,
      ]);
      if (existing) return { ...(await getBet(userId, existing.id)), idempotentReplay: true };
    }
    throw err;
  }
}

function presentSlip(
  slip: BetSlipRow,
  legs: (BetSelectionRow & { home_team: string; away_team: string; start_time: Date; league_name: string })[]
) {
  return {
    id: slip.id,
    betType: slip.bet_type,
    stake: slip.stake,
    totalOdds: slip.total_odds,
    potentialPayout: slip.potential_payout,
    payout: slip.payout,
    status: slip.status,
    bookingCode: slip.booking_code,
    createdAt: slip.created_at,
    settledAt: slip.settled_at,
    selections: legs.map((l) => ({
      oddsId: l.odds_id,
      eventId: l.event_id,
      match: `${l.home_team} vs ${l.away_team}`,
      league: l.league_name,
      startTime: l.start_time,
      marketType: l.market_type,
      line: l.line,
      selection: l.selection,
      price: l.price_decimal_at_placement,
      result: l.result,
    })),
  };
}

async function loadLegs(db: PoolClient | typeof pool, slipIds: number[]) {
  return query<BetSelectionRow & { home_team: string; away_team: string; start_time: Date; league_name: string }>(
    db,
    `SELECT bs.*, e.home_team, e.away_team, e.start_time, l.name AS league_name
     FROM bet_selections bs JOIN events e ON e.id = bs.event_id JOIN leagues l ON l.id = e.league_id
     WHERE bs.bet_slip_id = ANY($1::bigint[]) ORDER BY bs.id`,
    [slipIds]
  );
}

export async function getBet(userId: number, slipId: number) {
  const slip = await queryOne<BetSlipRow>(pool, 'SELECT * FROM bet_slips WHERE id = $1 AND user_id = $2', [slipId, userId]);
  if (!slip) throw notFound('Bet');
  return presentSlip(slip, await loadLegs(pool, [slip.id]));
}

export async function listBets(userId: number, p: Pagination & { status?: string }) {
  const slips = await query<BetSlipRow>(
    pool,
    `SELECT * FROM bet_slips WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [userId, p.status ?? null, p.limit, p.offset]
  );
  if (!slips.length) return [];
  const legs = await loadLegs(
    pool,
    slips.map((s) => s.id)
  );
  return slips.map((s) =>
    presentSlip(
      s,
      legs.filter((l) => l.bet_slip_id === s.id)
    )
  );
}

// ---------------------------------------------------------------------------
// Cash-out
// ---------------------------------------------------------------------------

/**
 * Fair cash-out value = potential winnings / (product of current prices of
 * still-pending legs), i.e. the stake that would buy the same payout at
 * today's odds, minus an operator margin. Legs already won keep their
 * placement price; void legs count as 1.00. Unavailable if any leg lost or
 * any pending leg is no longer bettable (suspended / kicked off).
 */
async function computeCashout(c: PoolClient | typeof pool, slip: BetSlipRow, lock: boolean) {
  if (!env.CASHOUT_ENABLED) return { available: false as const, reason: 'Cash-out is disabled' };
  if (slip.status !== 'pending') return { available: false as const, reason: `Bet is ${slip.status}` };

  const legs = await query<BetSelectionRow & LiveOdds>(
    c,
    `SELECT bs.*, o.price_decimal, o.is_active AS odds_active, m.status AS market_status, e.status AS event_status, e.start_time
     FROM bet_selections bs JOIN odds o ON o.id = bs.odds_id JOIN markets m ON m.id = bs.market_id JOIN events e ON e.id = bs.event_id
     WHERE bs.bet_slip_id = $1 ORDER BY bs.odds_id ${lock ? 'FOR UPDATE OF o' : ''}`,
    [slip.id]
  );
  if (legs.some((l) => l.result === 'lost')) return { available: false as const, reason: 'A selection has lost' };

  let currentPendingOdds = 1;
  let placedOdds = 1;
  for (const l of legs) {
    if (l.result === 'void') continue;
    placedOdds *= Number(l.price_decimal_at_placement);
    if (l.result === 'pending') {
      if (!isBettable(l)) return { available: false as const, reason: 'One or more selections are suspended or in play' };
      currentPendingOdds *= Number(l.price_decimal);
    }
  }
  const fair = payoutMinor(toMinor(slip.stake), placedOdds / currentPendingOdds);
  const offered = Math.min(Math.floor(fair * (1 - env.CASHOUT_MARGIN_PERCENT / 100)), toMinor(slip.potential_payout));
  if (offered <= 0) return { available: false as const, reason: 'No cash-out value' };
  return { available: true as const, amount: fromMinor(offered) };
}

export async function cashoutQuote(userId: number, slipId: number) {
  const slip = await queryOne<BetSlipRow>(pool, 'SELECT * FROM bet_slips WHERE id = $1 AND user_id = $2', [slipId, userId]);
  if (!slip) throw notFound('Bet');
  return { betId: slipId, ...(await computeCashout(pool, slip, false)) };
}

export async function executeCashout(userId: number, slipId: number, expectedAmount?: number) {
  return withTransaction(async (c) => {
    const slip = await queryOne<BetSlipRow>(c, 'SELECT * FROM bet_slips WHERE id = $1 AND user_id = $2 FOR UPDATE', [slipId, userId]);
    if (!slip) throw notFound('Bet');
    const q = await computeCashout(c, slip, true);
    if (!q.available) throw conflict(`Cash-out unavailable: ${q.reason}`, 'CASHOUT_UNAVAILABLE');
    if (expectedAmount !== undefined && toMinor(q.amount) < toMinor(expectedAmount)) {
      throw conflict('Cash-out value has changed', 'CASHOUT_CHANGED', { amount: q.amount });
    }
    const balance = await walletRepo.adjustBalance(c, {
      userId,
      amount: q.amount,
      type: 'bet_cashout',
      referenceType: 'bet_slip',
      referenceId: slipId,
    });
    await c.query(`UPDATE bet_slips SET status = 'cashed_out', payout = $2, settled_at = now() WHERE id = $1`, [slipId, q.amount]);
    return { betId: slipId, cashedOut: q.amount, balance };
  });
}

// ---------------------------------------------------------------------------
// Booking codes (shareable slips)
// ---------------------------------------------------------------------------

export async function createBookingCode(userId: number | null, oddsIds: number[]) {
  if (!oddsIds.length || oddsIds.length > env.MAX_SELECTIONS) throw badRequest(`Provide 1-${env.MAX_SELECTIONS} selections`);
  const rows = await query<LiveOdds>(pool, `${LIVE_ODDS_SQL} WHERE o.id = ANY($1::bigint[])`, [oddsIds]);
  const bettable = rows.filter(isBettable);
  if (bettable.length !== new Set(oddsIds).size) throw conflict('Some selections are not available for betting', 'SELECTIONS_UNAVAILABLE');
  if (new Set(bettable.map((r) => r.event_id)).size !== bettable.length)
    throw badRequest('Only one selection per match is allowed', 'SAME_EVENT_SELECTIONS');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = bookingCode();
    try {
      await pool.query(
        `INSERT INTO booking_codes (code, odds_ids, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [code, oddsIds, userId, env.BOOKING_CODE_TTL_HOURS]
      );
      return { code, selections: oddsIds.length };
    } catch (err: any) {
      if (err?.code !== PG_UNIQUE_VIOLATION) throw err;
    }
  }
  throw new AppError('Could not allocate a booking code, try again', 503);
}

export async function loadBookingCode(code: string) {
  const row = await queryOne<{ odds_ids: number[]; expires_at: Date }>(
    pool,
    'SELECT odds_ids, expires_at FROM booking_codes WHERE code = $1',
    [code.toUpperCase()]
  );
  if (!row || row.expires_at < new Date()) throw notFound('Booking code');
  const rows = await query<LiveOdds>(pool, `${LIVE_ODDS_SQL} WHERE o.id = ANY($1::bigint[])`, [row.odds_ids.map(Number)]);
  const selections = rows.map((r) => ({
    oddsId: r.odds_id,
    eventId: r.event_id,
    match: `${r.home_team} vs ${r.away_team}`,
    startTime: r.start_time,
    marketType: r.market_type,
    line: r.line,
    selection: r.selection,
    price: r.price_decimal,
    available: isBettable(r),
  }));
  const live = selections.filter((s) => s.available);
  return {
    code: code.toUpperCase(),
    expiresAt: row.expires_at,
    selections,
    totalOdds: live.length ? combineOdds(live.map((s) => s.price)).toFixed(3) : null,
  };
}
