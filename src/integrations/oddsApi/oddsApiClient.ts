import { env } from '../../config/env';
import { AppError } from '../../lib/errors';

/**
 * Minimal client for odds-api.io v3 (https://docs.odds-api.io). The API key
 * travels as the `apiKey` query parameter. Responses are normalised by
 * ./normalize.ts, which tolerates the documented shape and older variants.
 */

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  if (!env.ODDS_API_KEY) throw new AppError('ODDS_API_KEY is not configured', 503, 'ODDS_FEED_DISABLED');
  const qs = new URLSearchParams({ apiKey: env.ODDS_API_KEY });
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);

  let res: Response;
  try {
    res = await fetch(`${env.ODDS_API_BASE_URL}/${path}?${qs.toString()}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new AppError('Odds provider unreachable', 502, 'ODDS_FEED_ERROR');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(`Odds provider HTTP ${res.status}: ${body.slice(0, 200)}`, 502, 'ODDS_FEED_ERROR');
  }
  return (await res.json()) as T;
}

export const oddsApi = {
  leagues: (sport: string) => get<unknown[]>('leagues', { sport }),
  events: (sport: string, league?: string, status?: string) => get<unknown[]>('events', { sport, league, status }),
  oddsMulti: (eventIds: string[], bookmakers: string[]) =>
    get<unknown[]>('odds/multi', { eventIds: eventIds.join(','), bookmakers: bookmakers.join(',') }),
};

export type OddsApi = typeof oddsApi;
