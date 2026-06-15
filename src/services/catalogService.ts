import { PoolClient } from 'pg';
import { pool, query, queryOne, withTransaction, Queryable, PG_UNIQUE_VIOLATION } from '../config/db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { FOOTBALL_MARKETS, validateMarketShape } from './markets/footballMarkets';
import { audit } from './auditService';
import type { EventRow, LeagueRow, MarketRow, MarketStatus, OddsRow, SportRow } from '../types/db';
import type { Pagination } from '../lib/http';

const MARKET_ORDER = Object.keys(FOOTBALL_MARKETS);
const marketRank = (t: string) => {
  const i = MARKET_ORDER.indexOf(t);
  return i === -1 ? 999 : i;
};

// ---------------------------------------------------------------------------
// Public browsing
// ---------------------------------------------------------------------------

export function listSports() {
  return query<SportRow>(pool, 'SELECT id, slug, name FROM sports WHERE is_active ORDER BY sort_order, name');
}

export function listLeagues(f: { sport?: string; featured?: boolean; country?: string }) {
  return query(
    pool,
    `SELECT l.id, l.slug, l.name, l.short_name, l.country, l.country_code, l.is_featured, s.slug AS sport,
            (SELECT COUNT(*) FROM events e WHERE e.league_id = l.id AND e.status = 'scheduled' AND e.start_time > now()) AS upcoming_events
     FROM leagues l JOIN sports s ON s.id = l.sport_id
     WHERE l.is_active AND s.is_active
       AND ($1::text IS NULL OR s.slug = $1)
       AND ($2::boolean IS NULL OR l.is_featured = $2)
       AND ($3::text IS NULL OR lower(l.country) = lower($3))
     ORDER BY l.sort_order, l.name`,
    [f.sport ?? null, f.featured ?? null, f.country ?? null]
  );
}

export async function getLeague(slug: string) {
  const league = await queryOne(
    pool,
    `SELECT l.id, l.slug, l.name, l.short_name, l.country, l.country_code, l.is_featured, s.slug AS sport
     FROM leagues l JOIN sports s ON s.id = l.sport_id WHERE l.slug = $1 AND l.is_active`,
    [slug]
  );
  if (!league) throw notFound('League');
  return league;
}

export interface EventFilters extends Pagination {
  sport?: string;
  league?: string;
  status?: 'upcoming' | 'live' | 'finished' | 'all';
  from?: Date;
  to?: Date;
  featured?: boolean;
  search?: string;
}

/**
 * Event list with the headline 1X2 prices inlined (what every betting UI
 * shows on its coupon) plus a count of other open markets.
 */
export function listEvents(f: EventFilters) {
  const statusClause =
    f.status === 'live'
      ? `e.status = 'live'`
      : f.status === 'finished'
        ? `e.status = 'finished'`
        : f.status === 'all'
          ? 'TRUE'
          : `e.status = 'scheduled' AND e.start_time > now()`;

  return query(
    pool,
    `SELECT e.id, e.home_team, e.away_team, e.start_time, e.status, e.home_score, e.away_score, e.is_featured,
            l.slug AS league_slug, l.name AS league_name, l.country, s.slug AS sport,
            main.odds AS main_odds, main.market_id AS main_market_id,
            (SELECT COUNT(*) FROM markets m2 WHERE m2.event_id = e.id AND m2.status = 'open') AS open_markets
     FROM events e
     JOIN leagues l ON l.id = e.league_id
     JOIN sports s ON s.id = l.sport_id
     LEFT JOIN LATERAL (
       SELECT m.id AS market_id,
              json_agg(json_build_object('oddsId', o.id, 'selection', o.selection, 'price', o.price_decimal::text)
                       ORDER BY array_position(ARRAY['HOME','DRAW','AWAY'], o.selection)) AS odds
       FROM markets m JOIN odds o ON o.market_id = m.id AND o.is_active
       WHERE m.event_id = e.id AND m.market_type = '1X2' AND m.status = 'open'
       GROUP BY m.id
       LIMIT 1
     ) main ON TRUE
     WHERE ${statusClause}
       AND l.is_active
       AND ($1::text IS NULL OR s.slug = $1)
       AND ($2::text IS NULL OR l.slug = $2)
       AND ($3::timestamptz IS NULL OR e.start_time >= $3)
       AND ($4::timestamptz IS NULL OR e.start_time < $4)
       AND ($5::boolean IS NULL OR e.is_featured = $5)
       AND ($6::text IS NULL OR e.home_team ILIKE '%' || $6 || '%' OR e.away_team ILIKE '%' || $6 || '%')
     ORDER BY ${f.status === 'finished' ? 'e.start_time DESC' : 'e.start_time ASC'}, e.id
     LIMIT $7 OFFSET $8`,
    [f.sport ?? null, f.league ?? null, f.from ?? null, f.to ?? null, f.featured ?? null, f.search?.trim() || null, f.limit, f.offset]
  );
}

/** Upcoming fixtures from each featured league (EPL, La Liga, NPFL by default). */
export async function featuredBoard(perLeague = 5) {
  const leagues = await query<LeagueRow>(pool, 'SELECT * FROM leagues WHERE is_featured AND is_active ORDER BY sort_order');
  return Promise.all(
    leagues.map(async (l) => ({
      league: { slug: l.slug, name: l.name, shortName: l.short_name, country: l.country },
      events: await listEvents({ league: l.slug, limit: perLeague, offset: 0 }),
    }))
  );
}

export async function getEventDetail(eventId: number, db: Queryable = pool) {
  const event = await queryOne(
    db,
    `SELECT e.*, l.slug AS league_slug, l.name AS league_name, l.country, s.slug AS sport
     FROM events e JOIN leagues l ON l.id = e.league_id JOIN sports s ON s.id = l.sport_id WHERE e.id = $1`,
    [eventId]
  );
  if (!event) throw notFound('Event');
  const markets = await query<MarketRow>(db, 'SELECT * FROM markets WHERE event_id = $1', [eventId]);
  const odds = await query<OddsRow>(db, 'SELECT o.* FROM odds o JOIN markets m ON m.id = o.market_id WHERE m.event_id = $1 ORDER BY o.id', [
    eventId,
  ]);
  return {
    ...event,
    markets: markets
      .sort((a, b) => marketRank(a.market_type) - marketRank(b.market_type) || Number(a.line ?? 0) - Number(b.line ?? 0))
      .map((m) => ({
        id: m.id,
        type: m.market_type,
        name: FOOTBALL_MARKETS[m.market_type]?.name ?? m.market_type,
        line: m.line,
        status: m.status,
        odds: odds
          .filter((o) => o.market_id === m.id)
          .map((o) => ({ oddsId: o.id, selection: o.selection, price: o.price_decimal, active: o.is_active, result: o.result })),
      })),
  };
}

// ---------------------------------------------------------------------------
// Admin: catalogue management
// ---------------------------------------------------------------------------

export async function upsertSport(slug: string, name: string) {
  return queryOne<SportRow>(
    pool,
    `INSERT INTO sports (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [slug, name]
  );
}

export function adminListLeagues() {
  return query(pool, `SELECT l.*, s.slug AS sport FROM leagues l JOIN sports s ON s.id = l.sport_id ORDER BY l.sort_order, l.name`);
}

export async function createLeague(p: {
  sportId: number;
  slug: string;
  name: string;
  shortName?: string;
  country?: string;
  countryCode?: string;
  providerSlug?: string;
  syncEnabled?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
}) {
  try {
    return await queryOne<LeagueRow>(
      pool,
      `INSERT INTO leagues (sport_id, slug, name, short_name, country, country_code, provider_slug, sync_enabled, is_featured, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        p.sportId,
        p.slug,
        p.name,
        p.shortName ?? null,
        p.country ?? null,
        p.countryCode ?? null,
        p.providerSlug ?? null,
        p.syncEnabled ?? false,
        p.isFeatured ?? false,
        p.sortOrder ?? 100,
      ]
    );
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION) throw conflict('A league with that slug or provider slug already exists');
    throw err;
  }
}

export async function updateLeague(
  id: number,
  p: Partial<{
    name: string;
    shortName: string;
    providerSlug: string | null;
    syncEnabled: boolean;
    isFeatured: boolean;
    isActive: boolean;
    sortOrder: number;
  }>
) {
  const row = await queryOne<LeagueRow>(
    pool,
    `UPDATE leagues SET
       name = COALESCE($2, name),
       short_name = COALESCE($3, short_name),
       provider_slug = CASE WHEN $4::boolean THEN $5 ELSE provider_slug END,
       sync_enabled = COALESCE($6, sync_enabled),
       is_featured = COALESCE($7, is_featured),
       is_active = COALESCE($8, is_active),
       sort_order = COALESCE($9, sort_order)
     WHERE id = $1 RETURNING *`,
    [
      id,
      p.name ?? null,
      p.shortName ?? null,
      p.providerSlug !== undefined,
      p.providerSlug ?? null,
      p.syncEnabled ?? null,
      p.isFeatured ?? null,
      p.isActive ?? null,
      p.sortOrder ?? null,
    ]
  );
  if (!row) throw notFound('League');
  return row;
}

export interface MarketInput {
  type: string;
  line?: number | null;
  odds: { selection: string; price: number }[];
}

async function insertMarket(c: PoolClient, eventId: number, m: MarketInput): Promise<number> {
  const type = m.type.toUpperCase();
  const line = m.line ?? null;
  const selections = m.odds.map((o) => o.selection.toUpperCase());
  const err = validateMarketShape(type, line, selections);
  if (err) throw badRequest(err, 'INVALID_MARKET');
  if (new Set(selections).size !== selections.length) throw badRequest('Duplicate selections in market', 'INVALID_MARKET');

  let market: { id: number } | null;
  try {
    market = await queryOne<{ id: number }>(c, 'INSERT INTO markets (event_id, market_type, line) VALUES ($1, $2, $3) RETURNING id', [
      eventId,
      type,
      line,
    ]);
  } catch (e: any) {
    if (e?.code === PG_UNIQUE_VIOLATION) throw conflict(`Market ${type}${line !== null ? ` ${line}` : ''} already exists for this event`);
    throw e;
  }
  for (const o of m.odds) {
    await c.query('INSERT INTO odds (market_id, selection, price_decimal) VALUES ($1, $2, $3)', [
      market!.id,
      o.selection.toUpperCase(),
      o.price,
    ]);
  }
  return market!.id;
}

export async function createEvent(
  actorId: number,
  p: { leagueId: number; homeTeam: string; awayTeam: string; startTime: Date; isFeatured?: boolean; markets?: MarketInput[] },
  ip?: string | null
) {
  if (p.startTime <= new Date()) throw badRequest('startTime must be in the future');
  return withTransaction(async (c) => {
    const league = await queryOne(c, 'SELECT id FROM leagues WHERE id = $1', [p.leagueId]);
    if (!league) throw notFound('League');
    const ev = await queryOne<EventRow>(
      c,
      `INSERT INTO events (league_id, home_team, away_team, start_time, is_featured) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [p.leagueId, p.homeTeam.trim(), p.awayTeam.trim(), p.startTime, p.isFeatured ?? false]
    );
    for (const m of p.markets ?? []) await insertMarket(c, ev!.id, m);
    await audit(c, {
      actorId,
      action: 'event.create',
      entityType: 'event',
      entityId: ev!.id,
      metadata: { markets: p.markets?.length ?? 0 },
      ip,
    });
    return getEventDetail(ev!.id, c);
  });
}

export async function updateEvent(
  actorId: number,
  id: number,
  p: Partial<{ startTime: Date; isFeatured: boolean; status: 'scheduled' | 'postponed'; homeTeam: string; awayTeam: string }>,
  ip?: string | null
) {
  return withTransaction(async (c) => {
    const ev = await queryOne<EventRow>(c, 'SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (!ev) throw notFound('Event');
    if (['finished', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
    await c.query(
      `UPDATE events SET start_time = COALESCE($2, start_time), is_featured = COALESCE($3, is_featured),
         status = COALESCE($4, status), home_team = COALESCE($5, home_team), away_team = COALESCE($6, away_team)
       WHERE id = $1`,
      [id, p.startTime ?? null, p.isFeatured ?? null, p.status ?? null, p.homeTeam ?? null, p.awayTeam ?? null]
    );
    if (p.status === 'postponed') {
      await c.query(`UPDATE markets SET status = 'suspended' WHERE event_id = $1 AND status = 'open'`, [id]);
    }
    await audit(c, { actorId, action: 'event.update', entityType: 'event', entityId: id, metadata: p as Record<string, unknown>, ip });
    return getEventDetail(id, c);
  });
}

export async function addMarket(actorId: number, eventId: number, m: MarketInput, ip?: string | null) {
  return withTransaction(async (c) => {
    const ev = await queryOne<EventRow>(c, 'SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev) throw notFound('Event');
    if (ev.status !== 'scheduled') throw conflict(`Cannot add markets to a ${ev.status} event`);
    const id = await insertMarket(c, eventId, m);
    await audit(c, {
      actorId,
      action: 'market.create',
      entityType: 'market',
      entityId: id,
      metadata: { eventId, type: m.type, line: m.line },
      ip,
    });
    return { marketId: id };
  });
}

export async function setMarketStatus(
  actorId: number,
  marketId: number,
  status: Extract<MarketStatus, 'open' | 'suspended'>,
  ip?: string | null
) {
  return withTransaction(async (c) => {
    const m = await queryOne<MarketRow & { event_status: string; start_time: Date }>(
      c,
      'SELECT m.*, e.status AS event_status, e.start_time FROM markets m JOIN events e ON e.id = m.event_id WHERE m.id = $1 FOR UPDATE OF m',
      [marketId]
    );
    if (!m) throw notFound('Market');
    if (['settled', 'void'].includes(m.status)) throw conflict(`Market is ${m.status}`);
    if (status === 'open' && (m.event_status !== 'scheduled' || m.start_time <= new Date())) {
      throw conflict('Only markets of upcoming events can be reopened (pre-match book)');
    }
    await c.query('UPDATE markets SET status = $2 WHERE id = $1', [marketId, status]);
    await audit(c, { actorId, action: `market.${status === 'open' ? 'reopen' : 'suspend'}`, entityType: 'market', entityId: marketId, ip });
    return { marketId, status };
  });
}

export async function addOdds(actorId: number, marketId: number, selection: string, price: number, ip?: string | null) {
  return withTransaction(async (c) => {
    const m = await queryOne<MarketRow>(c, 'SELECT * FROM markets WHERE id = $1', [marketId]);
    if (!m) throw notFound('Market');
    const all = await query<{ selection: string }>(c, 'SELECT selection FROM odds WHERE market_id = $1', [marketId]);
    const err = validateMarketShape(m.market_type, m.line === null ? null : Number(m.line), [
      ...all.map((a) => a.selection),
      selection.toUpperCase(),
    ]);
    if (err) throw badRequest(err, 'INVALID_MARKET');
    const row = await queryOne<OddsRow>(c, 'INSERT INTO odds (market_id, selection, price_decimal) VALUES ($1, $2, $3) RETURNING *', [
      marketId,
      selection.toUpperCase(),
      price,
    ]);
    await audit(c, { actorId, action: 'odds.create', entityType: 'odds', entityId: row!.id, metadata: { marketId, selection, price }, ip });
    return row;
  });
}

export async function updateOdds(actorId: number, oddsId: number, p: { price?: number; isActive?: boolean }, ip?: string | null) {
  return withTransaction(async (c) => {
    const before = await queryOne<OddsRow>(c, 'SELECT * FROM odds WHERE id = $1 FOR UPDATE', [oddsId]);
    if (!before) throw notFound('Odds');
    if (before.result !== 'pending') throw conflict('Odds already settled');
    const row = await queryOne<OddsRow>(
      c,
      'UPDATE odds SET price_decimal = COALESCE($2, price_decimal), is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *',
      [oddsId, p.price ?? null, p.isActive ?? null]
    );
    await audit(c, {
      actorId,
      action: 'odds.update',
      entityType: 'odds',
      entityId: oddsId,
      metadata: { from: before.price_decimal, ...p },
      ip,
    });
    return row;
  });
}

export function adminListEvents(f: Pagination & { status?: string; league?: string; needsResult?: boolean }) {
  return query(
    pool,
    `SELECT e.*, l.slug AS league_slug, l.name AS league_name,
            (SELECT COUNT(*) FROM markets m WHERE m.event_id = e.id AND m.status IN ('open','suspended')) AS unsettled_markets,
            (SELECT COUNT(*) FROM bet_selections bs WHERE bs.event_id = e.id AND bs.result = 'pending') AS pending_bet_legs
     FROM events e JOIN leagues l ON l.id = e.league_id
     WHERE ($1::text IS NULL OR e.status = $1)
       AND ($2::text IS NULL OR l.slug = $2)
       AND (NOT $3::boolean OR (e.status IN ('live', 'finished') AND e.settled_at IS NULL))
     ORDER BY e.start_time DESC LIMIT $4 OFFSET $5`,
    [f.status ?? null, f.league ?? null, f.needsResult ?? false, f.limit, f.offset]
  );
}
