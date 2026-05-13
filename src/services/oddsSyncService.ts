import { pool } from '../config/db';
import * as sportsRepo from '../repositories/sportsRepository';
import { getOddsApiClient } from '../integrations/oddsApiClient';
import { AppError } from '../middleware/errorHandler';
import { oddsSyncBookmakers, oddsSyncMarket } from '../config/env';
import type { Event as ApiEvent, MarketOdds } from 'odds-api-io';

const PROVIDER = 'odds-api-io';

const EVENT_STATUS_MAP: Record<string, 'scheduled' | 'live' | 'finished'> = {
  upcoming: 'scheduled',
  live: 'live',
  finished: 'finished',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The SDK's outcome.name is provider-defined text (often a team name or
 * 'Draw'). We normalize it against the event's own participant names so
 * our markets read as HOME/AWAY/DRAW like the rest of the app, but fall
 * back to a slugified version of whatever the provider sent so sports
 * without a home/away/draw shape (e.g. tennis) still sync sensibly.
 */
function normalizeSelection(outcomeName: string, homeTeamName: string, awayTeamName: string): string {
  const n = String(outcomeName).trim().toLowerCase();
  if (n === homeTeamName.trim().toLowerCase()) return 'HOME';
  if (n === awayTeamName.trim().toLowerCase()) return 'AWAY';
  if (n === 'draw' || n === 'tie') return 'DRAW';
  return String(outcomeName).trim().toUpperCase().replace(/\s+/g, '_');
}

type Outcome = MarketOdds['outcomes'][number];

/** Best (highest) decimal price per selection among the returned outcomes. */
function pickBestPricePerSelection(outcomes: Outcome[], homeTeamName: string, awayTeamName: string): Map<string, Outcome> {
  const bestBySelection = new Map<string, Outcome>();
  for (const outcome of outcomes) {
    const selection = normalizeSelection(outcome.name, homeTeamName, awayTeamName);
    const existing = bestBySelection.get(selection);
    if (!existing || outcome.odds > existing.odds) {
      bestBySelection.set(selection, outcome);
    }
  }
  return bestBySelection;
}

async function upsertEventFromApi(apiEvent: ApiEvent): Promise<{ eventId: number; created: boolean }> {
  const sport = await sportsRepo.upsertSport(pool, {
    slug: apiEvent.sport,
    name: capitalize(apiEvent.sport),
  });

  const league = await sportsRepo.upsertLeague(pool, {
    sportId: sport.id,
    slug: apiEvent.leagueId,
    name: apiEvent.league,
  });

  const existing = await sportsRepo.getEventByExternalRef(pool, PROVIDER, apiEvent.id);
  const status = EVENT_STATUS_MAP[apiEvent.status || 'upcoming'] || 'scheduled';

  if (existing) {
    if (existing.status !== status) {
      await sportsRepo.updateEventStatus(pool, existing.id, status);
    }
    return { eventId: existing.id, created: false };
  }

  const eventId = await sportsRepo.createEvent(pool, {
    leagueId: league.id,
    homeTeam: apiEvent.homeParticipant.name,
    awayTeam: apiEvent.awayParticipant.name,
    startTime: new Date(apiEvent.startTime),
    oddsProvider: PROVIDER,
    externalRef: apiEvent.id,
  });

  return { eventId, created: true };
}

async function upsertOddsForEvent({
  ourEventId,
  apiEvent,
  marketOdds,
}: {
  ourEventId: number;
  apiEvent: ApiEvent;
  marketOdds: MarketOdds;
}): Promise<{ marketId: number; oddsCreated: number; oddsUpdated: number }> {
  const marketType = marketOdds.market.toUpperCase();
  const line = marketOdds.marketLine ?? null;

  const existingMarket = await sportsRepo.getMarketByEventAndType(pool, ourEventId, marketType, line);
  const marketId = existingMarket
    ? existingMarket.id
    : await sportsRepo.createMarket(pool, { eventId: ourEventId, marketType, line });

  const bestPerSelection = pickBestPricePerSelection(
    marketOdds.outcomes,
    apiEvent.homeParticipant.name,
    apiEvent.awayParticipant.name
  );

  let created = 0;
  let updated = 0;

  for (const [selection, outcome] of bestPerSelection) {
    const existingOdds = await sportsRepo.getOddsBySelection(pool, marketId, selection);
    if (existingOdds) {
      await sportsRepo.updateOddsPrice(pool, existingOdds.id, outcome.odds);
      updated += 1;
    } else {
      await sportsRepo.createOdds(pool, { marketId, selection, priceDecimal: outcome.odds });
      created += 1;
    }
  }

  return { marketId, oddsCreated: created, oddsUpdated: updated };
}

export interface SyncSportLeagueParams {
  sport: string;
  league?: string;
  bookmakers?: string[];
  market?: string;
}

export interface SyncSummary {
  eventsSeen: number;
  eventsCreated: number;
  marketsTouched: number;
  oddsCreated: number;
  oddsUpdated: number;
  skipped: { eventId: string; reason: string }[];
}

/**
 * Pulls upcoming events for a sport/league from Odds-API.io, upserts them
 * as our events/markets/odds, and returns a summary. Safe to call
 * repeatedly — matching is done via (odds_provider, external_ref), so
 * re-running just refreshes prices instead of duplicating rows.
 *
 * Note: this only syncs prices, never settles bets. Settlement stays a
 * manual admin action (POST /api/admin/markets/:marketId/settle) —
 * auto-deriving a winning selection from a provider's score is easy to
 * get wrong for edge cases (voids, postponements, non-1X2 markets), and
 * an incorrect auto-settlement pays out real balances.
 */
export async function syncSportLeague({ sport, league, bookmakers, market }: SyncSportLeagueParams): Promise<SyncSummary> {
  if (!sport) throw new AppError('sport is required', 400);

  const useBookmakers = (bookmakers && bookmakers.length ? bookmakers : oddsSyncBookmakers).join(',');
  if (!useBookmakers) {
    throw new AppError('No bookmakers configured — pass bookmakers or set ODDS_SYNC_BOOKMAKERS', 400);
  }
  const targetMarket = (market || oddsSyncMarket).toLowerCase();

  const client = getOddsApiClient();
  const apiEvents = await client.getEvents({ sport, league });

  const summary: SyncSummary = {
    eventsSeen: apiEvents.length,
    eventsCreated: 0,
    marketsTouched: 0,
    oddsCreated: 0,
    oddsUpdated: 0,
    skipped: [],
  };

  for (const apiEvent of apiEvents) {
    const { eventId, created } = await upsertEventFromApi(apiEvent);
    if (created) summary.eventsCreated += 1;

    let eventOdds;
    try {
      eventOdds = await client.getEventOdds({ eventId: apiEvent.id, bookmakers: useBookmakers });
    } catch (err: any) {
      summary.skipped.push({ eventId: apiEvent.id, reason: `odds fetch failed: ${err.message}` });
      continue;
    }

    const marketOdds = eventOdds.markets.find((m) => m.market.toLowerCase() === targetMarket);
    if (!marketOdds || marketOdds.outcomes.length === 0) {
      summary.skipped.push({ eventId: apiEvent.id, reason: `no '${targetMarket}' odds available` });
      continue;
    }

    const result = await upsertOddsForEvent({ ourEventId: eventId, apiEvent, marketOdds });
    summary.marketsTouched += 1;
    summary.oddsCreated += result.oddsCreated;
    summary.oddsUpdated += result.oddsUpdated;
  }

  return summary;
}
