import { Request, Response } from 'express';
import * as sportsService from '../services/sportsService';
import { asyncHandler } from '../utils/asyncHandler';

export const listEvents = asyncHandler(async (req: Request, res: Response) => {
  const { status, limit, offset } = req.query;
  const events = await sportsService.listUpcomingEvents({
    status: status as any,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(events);
});

export const getEvent = asyncHandler(async (req: Request, res: Response) => {
  const event = await sportsService.getEvent(Number(req.params.eventId));
  res.json(event);
});

export const placeBet = asyncHandler(async (req: Request, res: Response) => {
  const { stake, selections } = req.body;
  const result = await sportsService.placeBet(req.user!.id, { stake: Number(stake), selections });
  res.status(201).json(result);
});

export const listMyBets = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = req.query;
  const bets = await sportsService.listMyBets(req.user!.id, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(bets);
});
