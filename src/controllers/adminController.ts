import { Request, Response } from 'express';
import { pool } from '../config/db';
import * as sportsRepo from '../repositories/sportsRepository';
import * as sportsService from '../services/sportsService';
import * as oddsSyncService from '../services/oddsSyncService';
import { asyncHandler } from '../utils/asyncHandler';

export const createSport = asyncHandler(async (req: Request, res: Response) => {
  const sport = await sportsRepo.upsertSport(pool, req.body);
  res.status(201).json(sport);
});

export const createLeague = asyncHandler(async (req: Request, res: Response) => {
  const { sportId, slug, name, country } = req.body;
  const league = await sportsRepo.upsertLeague(pool, { sportId, slug, name, country });
  res.status(201).json(league);
});

export const createEvent = asyncHandler(async (req: Request, res: Response) => {
  const { leagueId, homeTeam, awayTeam, startTime } = req.body;
  const eventId = await sportsRepo.createEvent(pool, { leagueId, homeTeam, awayTeam, startTime });
  res.status(201).json({ eventId });
});

export const createMarket = asyncHandler(async (req: Request, res: Response) => {
  const { eventId, marketType, line } = req.body;
  const marketId = await sportsRepo.createMarket(pool, { eventId, marketType, line });
  res.status(201).json({ marketId });
});

export const createOdds = asyncHandler(async (req: Request, res: Response) => {
  const { marketId, selection, priceDecimal } = req.body;
  const oddsId = await sportsRepo.createOdds(pool, { marketId, selection, priceDecimal });
  res.status(201).json({ oddsId });
});

export const updateOddsPrice = asyncHandler(async (req: Request, res: Response) => {
  await sportsRepo.updateOddsPrice(pool, Number(req.params.oddsId), req.body.priceDecimal);
  res.json({ ok: true });
});

export const suspendMarket = asyncHandler(async (req: Request, res: Response) => {
  await sportsRepo.setMarketStatus(pool, Number(req.params.marketId), 'suspended');
  res.json({ ok: true });
});

export const reopenMarket = asyncHandler(async (req: Request, res: Response) => {
  await sportsRepo.setMarketStatus(pool, Number(req.params.marketId), 'open');
  res.json({ ok: true });
});

export const settleMarket = asyncHandler(async (req: Request, res: Response) => {
  const { winningSelection, voidMarket } = req.body;
  const result = await sportsService.settleMarket({
    marketId: Number(req.params.marketId),
    winningSelection,
    voidMarket: Boolean(voidMarket),
  });
  res.json(result);
});

// Pulls events + odds from Odds-API.io (github.com/shem4soul/Bet-Odds-API)
// and upserts them into our events/markets/odds tables. Re-running is
// safe — matched by (odds_provider, external_ref) — it refreshes prices
// rather than duplicating rows. Never settles bets automatically.
export const syncOdds = asyncHandler(async (req: Request, res: Response) => {
  const { sport, league, bookmakers, market } = req.body;
  const result = await oddsSyncService.syncSportLeague({
    sport,
    league,
    bookmakers: Array.isArray(bookmakers) ? bookmakers : undefined,
    market,
  });
  res.json(result);
});
