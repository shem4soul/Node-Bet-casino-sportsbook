import { Pool, PoolConnection } from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';
import {
  EventRow,
  EventStatus,
  MarketRow,
  MarketStatus,
  OddsRow,
  OddsResult,
  BetSlipRow,
  BetSlipStatus,
  BetSelectionRow,
  SportRow,
  LeagueRow,
  InsertResult,
} from '../types/db';

export async function listEvents(
  pool: Pool,
  { status = 'scheduled', limit = 50, offset = 0 }: { status?: EventStatus; limit?: number; offset?: number } = {}
): Promise<EventRow[]> {
  const [rows] = await pool.query<EventRow[]>(
    `SELECT e.*, l.name AS league_name, s.name AS sport_name
     FROM events e
     JOIN leagues l ON l.id = e.league_id
     JOIN sports s ON s.id = l.sport_id
     WHERE e.status = ?
     ORDER BY e.start_time ASC
     LIMIT ? OFFSET ?`,
    [status, Number(limit), Number(offset)]
  );
  return rows;
}

export async function getEventWithMarkets(pool: Pool, eventId: number): Promise<(EventRow & { markets: MarketRow[] }) | null> {
  const [eventRows] = await pool.query<EventRow[]>('SELECT * FROM events WHERE id = ?', [eventId]);
  const event = eventRows[0];
  if (!event) return null;

  const [markets] = await pool.query<MarketRow[]>('SELECT * FROM markets WHERE event_id = ?', [eventId]);
  for (const market of markets) {
    const [odds] = await pool.query<OddsRow[]>('SELECT * FROM odds WHERE market_id = ?', [market.id]);
    market.odds = odds;
  }
  return { ...event, markets };
}

export async function getOddsForUpdate(conn: PoolConnection, oddsId: number): Promise<OddsRow | null> {
  const [rows] = await conn.query<OddsRow[]>(
    `SELECT o.*, m.status AS market_status, m.event_id
     FROM odds o
     JOIN markets m ON m.id = o.market_id
     WHERE o.id = ? FOR UPDATE`,
    [oddsId]
  );
  return rows[0] || null;
}

export async function createBetSlip(
  conn: PoolConnection,
  { userId, stake, betType, totalOdds, potentialPayout }: { userId: number; stake: number; betType: 'single' | 'multi'; totalOdds: string | number; potentialPayout: number }
): Promise<number> {
  const [result] = await conn.query<InsertResult>(
    `INSERT INTO bet_slips (user_id, stake, bet_type, total_odds, potential_payout, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [userId, stake, betType, totalOdds, potentialPayout]
  );
  return result.insertId;
}

export async function addSelection(
  conn: PoolConnection,
  { betSlipId, oddsId, eventId, selection, priceAtPlacement }: { betSlipId: number; oddsId: number; eventId: number; selection: string; priceAtPlacement: string | number }
): Promise<void> {
  await conn.query(
    `INSERT INTO bet_selections (bet_slip_id, odds_id, event_id, selection, price_decimal_at_placement)
     VALUES (?, ?, ?, ?, ?)`,
    [betSlipId, oddsId, eventId, selection, priceAtPlacement]
  );
}

export async function listBetSlipsForUser(
  pool: Pool,
  userId: number,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<BetSlipRow[]> {
  const [slips] = await pool.query<BetSlipRow[]>(
    'SELECT * FROM bet_slips WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, Number(limit), Number(offset)]
  );
  for (const slip of slips) {
    const [selections] = await pool.query<BetSelectionRow[]>(
      `SELECT bs.*, e.home_team, e.away_team FROM bet_selections bs
       JOIN events e ON e.id = bs.event_id
       WHERE bs.bet_slip_id = ?`,
      [slip.id]
    );
    slip.selections = selections;
  }
  return slips;
}

// --- Settlement helpers (admin) ---

export async function setEventResult(
  conn: PoolConnection,
  { eventId, homeScore, awayScore, resultJson = null }: { eventId: number; homeScore: number; awayScore: number; resultJson?: Record<string, unknown> | null }
): Promise<void> {
  await conn.query(
    `UPDATE events SET status = 'finished', home_score = ?, away_score = ?, result_json = ? WHERE id = ?`,
    [homeScore, awayScore, resultJson ? JSON.stringify(resultJson) : null, eventId]
  );
}

export async function getMarketsForEvent(conn: PoolConnection, eventId: number): Promise<MarketRow[]> {
  const [markets] = await conn.query<MarketRow[]>('SELECT * FROM markets WHERE event_id = ? FOR UPDATE', [eventId]);
  for (const market of markets) {
    const [odds] = await conn.query<OddsRow[]>('SELECT * FROM odds WHERE market_id = ? FOR UPDATE', [market.id]);
    market.odds = odds;
  }
  return markets;
}

export async function setOddsResult(conn: PoolConnection, oddsId: number, result: OddsResult): Promise<void> {
  await conn.query('UPDATE odds SET result = ? WHERE id = ?', [result, oddsId]);
}

export async function setMarketSettled(conn: PoolConnection, marketId: number): Promise<void> {
  await conn.query("UPDATE markets SET status = 'settled', settled_at = NOW() WHERE id = ?", [marketId]);
}

export async function getPendingSelectionsForMarket(conn: PoolConnection, marketId: number): Promise<BetSelectionRow[]> {
  const [rows] = await conn.query<BetSelectionRow[]>(
    `SELECT bsel.*, bs.user_id
     FROM bet_selections bsel
     JOIN bet_slips bs ON bs.id = bsel.bet_slip_id
     JOIN odds o ON o.id = bsel.odds_id
     WHERE o.market_id = ? AND bsel.result = 'pending' FOR UPDATE`,
    [marketId]
  );
  return rows;
}

export async function countPendingSelectionsForSlip(conn: PoolConnection, betSlipId: number): Promise<number> {
  interface CountRow extends RowDataPacket {
    cnt: number;
  }
  const [rows] = await conn.query<CountRow[]>(
    "SELECT COUNT(*) AS cnt FROM bet_selections WHERE bet_slip_id = ? AND result = 'pending'",
    [betSlipId]
  );
  return Number(rows[0].cnt);
}

export async function setSelectionResult(conn: PoolConnection, selectionId: number, result: OddsResult): Promise<void> {
  await conn.query('UPDATE bet_selections SET result = ? WHERE id = ?', [result, selectionId]);
}

export async function getBetSlipForUpdate(conn: PoolConnection, betSlipId: number): Promise<BetSlipRow | null> {
  const [rows] = await conn.query<BetSlipRow[]>('SELECT * FROM bet_slips WHERE id = ? FOR UPDATE', [betSlipId]);
  return rows[0] || null;
}

export async function getSelectionsForSlip(conn: PoolConnection, betSlipId: number): Promise<BetSelectionRow[]> {
  const [rows] = await conn.query<BetSelectionRow[]>('SELECT * FROM bet_selections WHERE bet_slip_id = ?', [betSlipId]);
  return rows;
}

export async function settleBetSlip(conn: PoolConnection, betSlipId: number, status: BetSlipStatus): Promise<void> {
  await conn.query("UPDATE bet_slips SET status = ?, settled_at = NOW() WHERE id = ?", [status, betSlipId]);
}

// --- Admin: catalog management ---

export async function upsertSport(pool: Pool, { slug, name }: { slug: string; name: string }): Promise<SportRow> {
  await pool.query(
    'INSERT INTO sports (slug, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
    [slug, name]
  );
  const [rows] = await pool.query<SportRow[]>('SELECT * FROM sports WHERE slug = ?', [slug]);
  return rows[0];
}

export async function upsertLeague(
  pool: Pool,
  { sportId, slug, name, country }: { sportId: number; slug: string; name: string; country?: string | null }
): Promise<LeagueRow> {
  await pool.query(
    `INSERT INTO leagues (sport_id, slug, name, country) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), country = VALUES(country)`,
    [sportId, slug, name, country || null]
  );
  const [rows] = await pool.query<LeagueRow[]>('SELECT * FROM leagues WHERE sport_id = ? AND slug = ?', [sportId, slug]);
  return rows[0];
}

export interface CreateEventParams {
  leagueId: number;
  homeTeam: string;
  awayTeam: string;
  startTime: Date | string;
  oddsProvider?: string | null;
  externalRef?: string | null;
}

export async function createEvent(pool: Pool, params: CreateEventParams): Promise<number> {
  const { leagueId, homeTeam, awayTeam, startTime, oddsProvider = null, externalRef = null } = params;
  const [result] = await pool.query<InsertResult>(
    `INSERT INTO events (league_id, home_team, away_team, start_time, odds_provider, external_ref)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [leagueId, homeTeam, awayTeam, startTime, oddsProvider, externalRef]
  );
  return result.insertId;
}

export async function getEventByExternalRef(pool: Pool, oddsProvider: string, externalRef: string): Promise<EventRow | null> {
  const [rows] = await pool.query<EventRow[]>(
    'SELECT * FROM events WHERE odds_provider = ? AND external_ref = ?',
    [oddsProvider, externalRef]
  );
  return rows[0] || null;
}

export async function updateEventStatus(pool: Pool, eventId: number, status: EventStatus): Promise<void> {
  await pool.query('UPDATE events SET status = ? WHERE id = ?', [status, eventId]);
}

export async function getMarketByEventAndType(
  pool: Pool,
  eventId: number,
  marketType: string,
  line: number | string | null = null
): Promise<MarketRow | null> {
  const [rows] = await pool.query<MarketRow[]>(
    line === null
      ? 'SELECT * FROM markets WHERE event_id = ? AND market_type = ? AND line IS NULL'
      : 'SELECT * FROM markets WHERE event_id = ? AND market_type = ? AND line = ?',
    line === null ? [eventId, marketType] : [eventId, marketType, line]
  );
  return rows[0] || null;
}

export async function getOddsBySelection(pool: Pool, marketId: number, selection: string): Promise<OddsRow | null> {
  const [rows] = await pool.query<OddsRow[]>('SELECT * FROM odds WHERE market_id = ? AND selection = ?', [marketId, selection]);
  return rows[0] || null;
}

export async function createMarket(
  pool: Pool,
  { eventId, marketType, line = null }: { eventId: number; marketType: string; line?: number | string | null }
): Promise<number> {
  const [result] = await pool.query<InsertResult>(
    `INSERT INTO markets (event_id, market_type, line) VALUES (?, ?, ?)`,
    [eventId, marketType, line]
  );
  return result.insertId;
}

export async function createOdds(
  pool: Pool,
  { marketId, selection, priceDecimal }: { marketId: number; selection: string; priceDecimal: number }
): Promise<number> {
  const [result] = await pool.query<InsertResult>(
    `INSERT INTO odds (market_id, selection, price_decimal) VALUES (?, ?, ?)`,
    [marketId, selection, priceDecimal]
  );
  return result.insertId;
}

export async function updateOddsPrice(pool: Pool, oddsId: number, priceDecimal: number): Promise<void> {
  await pool.query('UPDATE odds SET price_decimal = ? WHERE id = ?', [priceDecimal, oddsId]);
}

export async function setMarketStatus(pool: Pool, marketId: number, status: MarketStatus): Promise<void> {
  await pool.query('UPDATE markets SET status = ? WHERE id = ?', [status, marketId]);
}
