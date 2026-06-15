import { env } from '../config/env';
import { logger } from '../config/logger';
import { pool, query, queryOne, withTransaction } from '../config/db';
import { badRequest } from '../lib/errors';
import { oddsApi } from '../integrations/oddsApi/oddsApiClient';
import { aggregate, collectQuotes, FeedEvent, normalizeEvent } from '../integrations/oddsApi/normalize';
import { recordResultAndSettle } from './settlementService';
import type { EventRow, LeagueRow } from '../types/db';

const PROVIDER = 'odds-api-io';

export interface LeagueSyncSummary {
  league: string;
  eventsSeen: number;
  eventsCreated: number;
  marketsCreated: number;
  pricesUpdated: number;
  resultsRecorded: number;
  errors: string[];
}

async function upsertEvent(league: LeagueRow, fe: FeedEvent): Promise<{ event: EventRow; created: boolean }> {
  const existing = await queryOne<EventRow>(pool, 'SELECT * FROM events WHERE odds_provider = $1 AND external_ref = $2', [
    PROVIDER,
    fe.externalId,
  ]);
  if (existing) {
    // Never resurrect events we've closed or settled; only move forward.
    if (existing.status === 'scheduled' && !existing.settled_at) {
      await pool.query(
        `UPDATE events SET start_time = $2, status = CASE WHEN $3 IN ('postponed','cancelled','live','finished') THEN $3 ELSE status END WHERE id = $1`,
        [existing.id, fe.startTime, fe.status]
      );
      if (fe.status === 'postponed')
        await pool.query(`UPDATE markets SET status = 'suspended' WHERE event_id = $1 AND status = 'open'`, [existing.id]);
    }
    return { event: (await queryOne<EventRow>(pool, 'SELECT * FROM events WHERE id = $1', [existing.id]))!, created: false };
  }
  const event = await queryOne<EventRow>(
    pool,
    `INSERT INTO events (league_id, home_team, away_team, start_time, status, odds_provider, external_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (odds_provider, external_ref) DO UPDATE SET start_time = EXCLUDED.start_time
     RETURNING *`,
    [league.id, fe.home, fe.away, fe.startTime, fe.status === 'scheduled' ? 'scheduled' : fe.status, PROVIDER, fe.externalId]
  );
  return { event: event!, created: true };
}

async function applyPrices(event: EventRow, rawOdds: unknown, s: LeagueSyncSummary) {
  // Pre-match book only: never price or (re)open markets after kick-off.
  if (event.status !== 'scheduled' || event.start_time <= new Date()) return;
  const markets = collectQuotes(rawOdds, env.ODDS_API_BOOKMAKERS);

  for (const { type, line, quotes } of markets.values()) {
    const prices = aggregate(quotes, env.ODDS_AGGREGATION, env.ODDS_MARGIN_PERCENT);
    if (!Object.keys(prices).length) continue;

    await withTransaction(async (c) => {
      let market = await queryOne<{ id: number; status: string }>(
        c,
        `SELECT id, status FROM markets WHERE event_id = $1 AND market_type = $2 AND COALESCE(line, -9999) = COALESCE($3::numeric, -9999) FOR UPDATE`,
        [event.id, type, line]
      );
      if (!market) {
        market = await queryOne(c, 'INSERT INTO markets (event_id, market_type, line) VALUES ($1, $2, $3) RETURNING id, status', [
          event.id,
          type,
          line,
        ]);
        s.marketsCreated += 1;
      }
      if (market!.status === 'settled' || market!.status === 'void') return;

      for (const [selection, price] of Object.entries(prices)) {
        const r = await c.query(
          `INSERT INTO odds (market_id, selection, price_decimal) VALUES ($1, $2, $3)
           ON CONFLICT (market_id, selection) DO UPDATE SET price_decimal = EXCLUDED.price_decimal
           WHERE odds.result = 'pending' AND odds.price_decimal <> EXCLUDED.price_decimal`,
          [market!.id, selection, price]
        );
        s.pricesUpdated += r.rowCount ?? 0;
      }
    });
  }
}

export async function syncLeague(league: LeagueRow): Promise<LeagueSyncSummary> {
  if (!league.provider_slug) throw badRequest(`League ${league.slug} has no provider_slug configured`);
  const s: LeagueSyncSummary = {
    league: league.slug,
    eventsSeen: 0,
    eventsCreated: 0,
    marketsCreated: 0,
    pricesUpdated: 0,
    resultsRecorded: 0,
    errors: [],
  };
  const sport = (await queryOne<{ slug: string }>(pool, 'SELECT slug FROM sports WHERE id = $1', [league.sport_id]))!.slug;

  const rawEvents = await oddsApi.events(sport, league.provider_slug);
  const feedEvents = (Array.isArray(rawEvents) ? rawEvents : []).map(normalizeEvent).filter((e): e is FeedEvent => !!e);
  s.eventsSeen = feedEvents.length;

  const upcoming: { event: EventRow; fe: FeedEvent }[] = [];
  for (const fe of feedEvents) {
    try {
      const { event, created } = await upsertEvent(league, fe);
      if (created) s.eventsCreated += 1;
      if (event.status === 'scheduled' && fe.startTime > new Date()) upcoming.push({ event, fe });

      // Results from the feed: stored always; auto-settled only if explicitly enabled.
      if (fe.status === 'finished' && fe.score && !event.settled_at && env.AUTO_SETTLE_FROM_FEED) {
        await recordResultAndSettle(null, event.id, fe.score, null, 'feed');
        s.resultsRecorded += 1;
      }
    } catch (err) {
      s.errors.push(`event ${fe.externalId}: ${(err as Error).message}`);
    }
  }

  // Fetch odds 10 events at a time (provider limit for /odds/multi).
  for (let i = 0; i < upcoming.length; i += 10) {
    const batch = upcoming.slice(i, i + 10);
    try {
      const odds = await oddsApi.oddsMulti(
        batch.map((b) => b.fe.externalId),
        env.ODDS_API_BOOKMAKERS
      );
      for (const raw of Array.isArray(odds) ? odds : []) {
        const match = batch.find((b) => b.fe.externalId === String((raw as any)?.id ?? (raw as any)?.eventId));
        if (match) await applyPrices(match.event, raw, s);
      }
    } catch (err) {
      s.errors.push(`odds batch ${i / 10}: ${(err as Error).message}`);
    }
  }
  return s;
}

/** Syncs every league with sync_enabled = true (or the given slugs). */
export async function syncLeagues(slugs?: string[]): Promise<LeagueSyncSummary[]> {
  const leagues = slugs?.length
    ? await query<LeagueRow>(pool, 'SELECT * FROM leagues WHERE slug = ANY($1) AND provider_slug IS NOT NULL', [slugs])
    : await query<LeagueRow>(
        pool,
        'SELECT * FROM leagues WHERE sync_enabled AND is_active AND provider_slug IS NOT NULL ORDER BY sort_order'
      );
  const out: LeagueSyncSummary[] = [];
  for (const l of leagues) {
    try {
      out.push(await syncLeague(l));
    } catch (err) {
      logger.warn({ err, league: l.slug }, 'League sync failed');
      out.push({
        league: l.slug,
        eventsSeen: 0,
        eventsCreated: 0,
        marketsCreated: 0,
        pricesUpdated: 0,
        resultsRecorded: 0,
        errors: [(err as Error).message],
      });
    }
  }
  return out;
}

export async function providerLeagues(sport: string) {
  const raw = await oddsApi.leagues(sport);
  return (Array.isArray(raw) ? raw : []).map((l: any) => ({
    slug: l.slug ?? l.id,
    name: l.name,
    country: l.country ?? l.category ?? null,
  }));
}
