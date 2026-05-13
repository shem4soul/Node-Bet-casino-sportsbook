import 'dotenv/config';

export const port = Number(process.env.PORT || 4000);
export const nodeEnv = process.env.NODE_ENV || 'development';
export const jwtSecret = process.env.JWT_SECRET as string;
export const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';
export const houseEdgePercent = Number(process.env.HOUSE_EDGE_PERCENT || 2);
export const maxBetAmount = Number(process.env.MAX_BET_AMOUNT || 5000);
export const minBetAmount = Number(process.env.MIN_BET_AMOUNT || 0.5);
export const startingDemoBalance = Number(process.env.STARTING_DEMO_BALANCE || 1000);

// Mock payment gateway (Paystack-shaped, for testing only — see src/mockGateway)
export const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
export const mockGatewaySecretKey = process.env.MOCK_GATEWAY_SECRET_KEY || 'sk_test_replace_me';

// Odds-API.io (github.com/shem4soul/Bet-Odds-API — the odds-api-io npm package)
export const oddsApiKey = process.env.ODDS_API_KEY || null;
export const oddsApiBaseUrl = process.env.ODDS_API_BASE_URL || undefined;
export const oddsSyncBookmakers = (process.env.ODDS_SYNC_BOOKMAKERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const oddsSyncMarket = process.env.ODDS_SYNC_MARKET || 'moneyline';
export const oddsSyncIntervalMinutes = Number(process.env.ODDS_SYNC_INTERVAL_MINUTES || 0);
export const oddsSyncSport = process.env.ODDS_SYNC_SPORT || null;
export const oddsSyncLeague = process.env.ODDS_SYNC_LEAGUE || null;
