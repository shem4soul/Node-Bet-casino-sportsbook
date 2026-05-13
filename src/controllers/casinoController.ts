import { Request, Response } from 'express';
import * as casinoService from '../services/casinoService';
import { asyncHandler } from '../utils/asyncHandler';

export const getFairness = asyncHandler(async (req: Request, res: Response) => {
  const state = await casinoService.getFairnessState(req.user!.id);
  res.json(state);
});

export const rotateSeed = asyncHandler(async (req: Request, res: Response) => {
  const result = await casinoService.rotateSeed(req.user!.id, req.body.clientSeed);
  res.json(result);
});

export const playDice = asyncHandler(async (req: Request, res: Response) => {
  const { stake, target, direction, clientSeed } = req.body;
  const result = await casinoService.playDice(req.user!.id, {
    stake: Number(stake),
    target: Number(target),
    direction,
    clientSeed,
  });
  res.json(result);
});

export const playCoinflip = asyncHandler(async (req: Request, res: Response) => {
  const { stake, call, clientSeed } = req.body;
  const result = await casinoService.playCoinflip(req.user!.id, { stake: Number(stake), call, clientSeed });
  res.json(result);
});

export const playSlots = asyncHandler(async (req: Request, res: Response) => {
  const { stake, clientSeed } = req.body;
  const result = await casinoService.playSlots(req.user!.id, { stake: Number(stake), clientSeed });
  res.json(result);
});

export const getHistory = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = req.query;
  const rows = await casinoService.getHistory(req.user!.id, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(rows);
});
