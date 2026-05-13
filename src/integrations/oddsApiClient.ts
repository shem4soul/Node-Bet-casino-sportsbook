import { OddsAPIClient } from 'odds-api-io';
import { oddsApiKey, oddsApiBaseUrl } from '../config/env';
import { AppError } from '../middleware/errorHandler';

let cachedClient: OddsAPIClient | null = null;

/**
 * Lazily constructs the SDK client so a missing ODDS_API_KEY only breaks
 * the odds-sync feature, not the whole app on boot.
 */
export function getOddsApiClient(): OddsAPIClient {
  if (!oddsApiKey) {
    throw new AppError('ODDS_API_KEY is not configured', 500);
  }
  if (!cachedClient) {
    cachedClient = new OddsAPIClient({
      apiKey: oddsApiKey,
      ...(oddsApiBaseUrl ? { baseUrl: oddsApiBaseUrl } : {}),
    });
  }
  return cachedClient;
}
