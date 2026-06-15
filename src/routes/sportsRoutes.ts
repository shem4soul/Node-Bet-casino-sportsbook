import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, idParam, paginationSchema } from '../lib/http';
import { validate } from '../middleware/validate';
import { requireAuth, requireCanGamble } from '../middleware/auth';
import { betLimiter } from '../middleware/rateLimit';
import * as catalog from '../services/catalogService';
import * as bets from '../services/betService';
import { listMarketDefinitions } from '../services/markets/footballMarkets';
import { verifyAccessToken } from '../lib/tokens';

const router = Router();
const boolish = z.enum(['true', 'false']).transform((v) => v === 'true');

// ---- Public catalogue ----

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await catalog.listSports());
  })
);

router.get('/markets', (_req, res) => {
  res.json(listMarketDefinitions());
});

router.get(
  '/leagues',
  validate({ query: z.object({ sport: z.string().optional(), featured: boolish.optional(), country: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await catalog.listLeagues(req.query as any));
  })
);

router.get(
  '/leagues/:slug',
  asyncHandler(async (req, res) => {
    res.json(await catalog.getLeague(req.params.slug));
  })
);

router.get(
  '/leagues/:slug/events',
  validate({ query: paginationSchema.extend({ status: z.enum(['upcoming', 'live', 'finished', 'all']).optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await catalog.listEvents({ ...(req.query as any), league: req.params.slug }));
  })
);

router.get(
  '/featured',
  validate({ query: z.object({ perLeague: z.coerce.number().int().min(1).max(20).default(5) }) }),
  asyncHandler(async (req, res) => {
    res.json(await catalog.featuredBoard((req.query as any).perLeague));
  })
);

router.get(
  '/events',
  validate({
    query: paginationSchema.extend({
      sport: z.string().optional(),
      league: z.string().optional(),
      status: z.enum(['upcoming', 'live', 'finished', 'all']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      featured: boolish.optional(),
      search: z.string().max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await catalog.listEvents(req.query as any));
  })
);

router.get(
  '/events/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await catalog.getEventDetail(Number(req.params.id)));
  })
);

// ---- Booking codes (create works logged-in or anonymous) ----

router.post(
  '/booking-codes',
  betLimiter,
  validate({ body: z.object({ oddsIds: z.array(z.number().int().positive()).min(1).max(100) }) }),
  asyncHandler(async (req, res) => {
    let userId: number | null = null;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      try {
        userId = Number(verifyAccessToken(h.slice(7)).sub);
      } catch {
        /* anonymous */
      }
    }
    res.status(201).json(await bets.createBookingCode(userId, req.body.oddsIds));
  })
);

router.get(
  '/booking-codes/:code',
  validate({ params: z.object({ code: z.string().regex(/^[A-Za-z0-9]{5,12}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json(await bets.loadBookingCode(req.params.code));
  })
);

// ---- Bets (authenticated) ----

const placeBetSchema = z.object({
  stake: z.number().positive().multipleOf(0.01),
  selections: z
    .array(z.object({ oddsId: z.number().int().positive(), price: z.number().min(1.01).optional() }))
    .min(1)
    .max(100),
  acceptOddsChanges: z.enum(['none', 'higher', 'any']).optional(),
  bookingCode: z.string().max(12).optional(),
});

router.post(
  '/bets',
  requireAuth,
  requireCanGamble,
  betLimiter,
  validate({ body: placeBetSchema }),
  asyncHandler(async (req, res) => {
    const key = req.get('Idempotency-Key');
    const result = await bets.placeBet(req.user!.id, { ...req.body, idempotencyKey: key ? key.slice(0, 100) : undefined });
    res.status('idempotentReplay' in result ? 200 : 201).json(result);
  })
);

router.get(
  '/bets',
  requireAuth,
  validate({ query: paginationSchema.extend({ status: z.enum(['pending', 'won', 'lost', 'void', 'cashed_out']).optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await bets.listBets(req.user!.id, req.query as any));
  })
);

router.get(
  '/bets/:id',
  requireAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await bets.getBet(req.user!.id, Number(req.params.id)));
  })
);

router.get(
  '/bets/:id/cashout',
  requireAuth,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await bets.cashoutQuote(req.user!.id, Number(req.params.id)));
  })
);

router.post(
  '/bets/:id/cashout',
  requireAuth,
  betLimiter,
  validate({ params: idParam, body: z.object({ expectedAmount: z.number().positive().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json(await bets.executeCashout(req.user!.id, Number(req.params.id), req.body.expectedAmount));
  })
);

export default router;
