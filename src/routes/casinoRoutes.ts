import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, paginationSchema } from '../lib/http';
import { validate } from '../middleware/validate';
import { requireAuth, requireCanGamble } from '../middleware/auth';
import { casinoLimiter } from '../middleware/rateLimit';
import * as casino from '../services/casinoService';

const router = Router();

const stake = z.number().positive().multipleOf(0.01);
const clientSeed = z.string().min(1).max(64).optional();

router.get(
  '/games',
  asyncHandler(async (_req, res) => {
    res.json(await casino.listGames());
  })
);

router.use(requireAuth);

router.get(
  '/fairness',
  asyncHandler(async (req, res) => {
    res.json(await casino.getFairness(req.user!.id));
  })
);

router.post(
  '/fairness/rotate',
  validate({ body: z.object({ clientSeed }) }),
  asyncHandler(async (req, res) => {
    res.json(await casino.rotateSeed(req.user!.id, req.body.clientSeed));
  })
);

router.post(
  '/dice/play',
  requireCanGamble,
  casinoLimiter,
  validate({ body: z.object({ stake, target: z.number().min(2).max(98), direction: z.enum(['under', 'over']), clientSeed }) }),
  asyncHandler(async (req, res) => {
    res.json(await casino.playDice(req.user!.id, req.body));
  })
);

router.post(
  '/coinflip/play',
  requireCanGamble,
  casinoLimiter,
  validate({ body: z.object({ stake, call: z.enum(['heads', 'tails']), clientSeed }) }),
  asyncHandler(async (req, res) => {
    res.json(await casino.playCoinflip(req.user!.id, req.body));
  })
);

router.post(
  '/slots/play',
  requireCanGamble,
  casinoLimiter,
  validate({ body: z.object({ stake, clientSeed }) }),
  asyncHandler(async (req, res) => {
    res.json(await casino.playSlots(req.user!.id, req.body));
  })
);

router.get(
  '/history',
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await casino.history(req.user!.id, req.query as any));
  })
);

export default router;
