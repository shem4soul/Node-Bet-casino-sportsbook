import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, idParam, paginationSchema } from '../lib/http';
import { validate } from '../middleware/validate';
import { requireAdmin, requireAuth } from '../middleware/auth';
import * as admin from '../services/adminService';
import * as catalog from '../services/catalogService';
import * as settlement from '../services/settlementService';
import * as withdrawals from '../services/withdrawalService';
import * as oddsSync from '../services/oddsSyncService';
import { listAuditLogs } from '../services/auditService';

const router = Router();
router.use(requireAuth, requireAdmin);

const price = z.number().min(1.01).max(1000);
const marketInput = z.object({
  type: z
    .string()
    .min(2)
    .max(40)
    .transform((s) => s.toUpperCase()),
  line: z.number().min(-20).max(50).nullable().optional(),
  odds: z
    .array(z.object({ selection: z.string().min(1).max(20), price }))
    .min(2)
    .max(60),
});
const reason = z.string().trim().min(3).max(500);

// ---------------- Users ----------------

router.get(
  '/users',
  validate({
    query: paginationSchema.extend({
      search: z.string().max(100).optional(),
      status: z.enum(['active', 'suspended', 'banned', 'closed']).optional(),
      kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await admin.listUsers(req.query as any)))
);

router.get(
  '/users/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await admin.getUser(Number(req.params.id))))
);

router.patch(
  '/users/:id/status',
  validate({ params: idParam, body: z.object({ status: z.enum(['active', 'suspended', 'banned', 'closed']), reason }) }),
  asyncHandler(async (req, res) =>
    res.json(await admin.setUserStatus(req.user!.id, Number(req.params.id), req.body.status, req.body.reason, clientIp(req)))
  )
);

router.patch(
  '/users/:id/kyc',
  validate({
    params: idParam,
    body: z.object({ kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']), note: z.string().max(500).optional() }),
  }),
  asyncHandler(async (req, res) =>
    res.json(await admin.setKycStatus(req.user!.id, Number(req.params.id), req.body.kycStatus, req.body.note, clientIp(req)))
  )
);

router.post(
  '/users/:id/adjust-balance',
  validate({
    params: idParam,
    body: z.object({
      amount: z
        .number()
        .multipleOf(0.01)
        .refine((n) => n !== 0, 'Amount cannot be zero'),
      note: reason,
    }),
  }),
  asyncHandler(async (req, res) =>
    res.json(await admin.adjustBalance(req.user!.id, Number(req.params.id), req.body.amount, req.body.note, clientIp(req)))
  )
);

// ---------------- Catalogue ----------------

router.post(
  '/sports',
  validate({ body: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(2).max(60) }) }),
  asyncHandler(async (req, res) => res.status(201).json(await catalog.upsertSport(req.body.slug, req.body.name)))
);

router.get(
  '/leagues',
  asyncHandler(async (_req, res) => res.json(await catalog.adminListLeagues()))
);

router.post(
  '/leagues',
  validate({
    body: z.object({
      sportId: z.number().int().positive(),
      slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
      name: z.string().min(2).max(100),
      shortName: z.string().max(30).optional(),
      country: z.string().max(60).optional(),
      countryCode: z.string().length(2).optional(),
      providerSlug: z.string().max(120).optional(),
      syncEnabled: z.boolean().optional(),
      isFeatured: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json(await catalog.createLeague(req.body)))
);

router.patch(
  '/leagues/:id',
  validate({
    params: idParam,
    body: z.object({
      name: z.string().min(2).max(100).optional(),
      shortName: z.string().max(30).optional(),
      providerSlug: z.string().max(120).nullable().optional(),
      syncEnabled: z.boolean().optional(),
      isFeatured: z.boolean().optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await catalog.updateLeague(Number(req.params.id), req.body)))
);

router.get(
  '/events',
  validate({
    query: paginationSchema.extend({
      status: z.enum(['scheduled', 'live', 'finished', 'cancelled', 'postponed']).optional(),
      league: z.string().optional(),
      needsResult: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await catalog.adminListEvents(req.query as any)))
);

router.post(
  '/events',
  validate({
    body: z.object({
      leagueId: z.number().int().positive(),
      homeTeam: z.string().trim().min(2).max(100),
      awayTeam: z.string().trim().min(2).max(100),
      startTime: z.coerce.date(),
      isFeatured: z.boolean().optional(),
      markets: z.array(marketInput).max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json(await catalog.createEvent(req.user!.id, req.body, clientIp(req))))
);

router.patch(
  '/events/:id',
  validate({
    params: idParam,
    body: z.object({
      startTime: z.coerce.date().optional(),
      isFeatured: z.boolean().optional(),
      status: z.enum(['scheduled', 'postponed']).optional(),
      homeTeam: z.string().trim().min(2).max(100).optional(),
      awayTeam: z.string().trim().min(2).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await catalog.updateEvent(req.user!.id, Number(req.params.id), req.body, clientIp(req))))
);

const goals = z.number().int().min(0).max(99);
router.post(
  '/events/:id/result',
  validate({
    params: idParam,
    body: z.object({ homeScore: goals, awayScore: goals, htHomeScore: goals.optional(), htAwayScore: goals.optional() }),
  }),
  asyncHandler(async (req, res) =>
    res.json(
      await settlement.recordResultAndSettle(
        req.user!.id,
        Number(req.params.id),
        { home: req.body.homeScore, away: req.body.awayScore, htHome: req.body.htHomeScore, htAway: req.body.htAwayScore },
        clientIp(req)
      )
    )
  )
);

router.post(
  '/events/:id/cancel',
  validate({ params: idParam, body: z.object({ reason }) }),
  asyncHandler(async (req, res) =>
    res.json(await settlement.cancelEvent(req.user!.id, Number(req.params.id), req.body.reason, clientIp(req)))
  )
);

router.post(
  '/events/:id/markets',
  validate({ params: idParam, body: marketInput }),
  asyncHandler(async (req, res) =>
    res.status(201).json(await catalog.addMarket(req.user!.id, Number(req.params.id), req.body, clientIp(req)))
  )
);

router.post(
  '/markets/:id/suspend',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await catalog.setMarketStatus(req.user!.id, Number(req.params.id), 'suspended', clientIp(req))))
);

router.post(
  '/markets/:id/reopen',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await catalog.setMarketStatus(req.user!.id, Number(req.params.id), 'open', clientIp(req))))
);

router.post(
  '/markets/:id/settle',
  validate({
    params: idParam,
    body: z
      .object({
        winningSelection: z.string().optional(),
        results: z.record(z.enum(['won', 'lost', 'void'])).optional(),
        voidMarket: z.boolean().optional(),
      })
      .refine(
        (b) => [b.winningSelection, b.results, b.voidMarket].filter(Boolean).length === 1,
        'Provide exactly one of winningSelection, results, voidMarket'
      ),
  }),
  asyncHandler(async (req, res) =>
    res.json(await settlement.settleMarketManually(req.user!.id, Number(req.params.id), req.body, clientIp(req)))
  )
);

router.post(
  '/markets/:id/odds',
  validate({ params: idParam, body: z.object({ selection: z.string().min(1).max(20), price }) }),
  asyncHandler(async (req, res) =>
    res.status(201).json(await catalog.addOdds(req.user!.id, Number(req.params.id), req.body.selection, req.body.price, clientIp(req)))
  )
);

router.patch(
  '/odds/:id',
  validate({
    params: idParam,
    body: z
      .object({ price: price.optional(), isActive: z.boolean().optional() })
      .refine((b) => b.price !== undefined || b.isActive !== undefined, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => res.json(await catalog.updateOdds(req.user!.id, Number(req.params.id), req.body, clientIp(req))))
);

// ---------------- Odds feed ----------------

router.post(
  '/odds-sync',
  validate({ body: z.object({ leagues: z.array(z.string()).max(20).optional() }) }),
  asyncHandler(async (req, res) => res.json(await oddsSync.syncLeagues(req.body.leagues)))
);

router.get(
  '/odds-provider/leagues',
  validate({ query: z.object({ sport: z.string().default('football') }) }),
  asyncHandler(async (req, res) => res.json(await oddsSync.providerLeagues((req.query as any).sport)))
);

// ---------------- Bets, withdrawals, reports ----------------

router.get(
  '/bets',
  validate({
    query: paginationSchema.extend({
      status: z.enum(['pending', 'won', 'lost', 'void', 'cashed_out']).optional(),
      userId: z.coerce.number().int().positive().optional(),
      eventId: z.coerce.number().int().positive().optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await admin.adminListBets(req.query as any)))
);

router.get(
  '/withdrawals',
  validate({
    query: paginationSchema.extend({
      status: z.enum(['pending_review', 'approved', 'processing', 'success', 'failed', 'reversed', 'rejected']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await withdrawals.adminListWithdrawals(req.query as any)))
);

router.post(
  '/withdrawals/:id/approve',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => res.json(await withdrawals.approveWithdrawal(req.user!.id, Number(req.params.id), clientIp(req))))
);

router.post(
  '/withdrawals/:id/reject',
  validate({ params: idParam, body: z.object({ reason }) }),
  asyncHandler(async (req, res) =>
    res.json(await withdrawals.rejectWithdrawal(req.user!.id, Number(req.params.id), req.body.reason, clientIp(req)))
  )
);

router.get(
  '/reports/summary',
  validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    res.json(await admin.summaryReport(from, to));
  })
);

router.get(
  '/reports/liability',
  validate({ query: paginationSchema.extend({ eventId: z.coerce.number().int().positive().optional() }) }),
  asyncHandler(async (req, res) => res.json(await admin.liabilityReport(req.query as any)))
);

router.get(
  '/audit-logs',
  validate({
    query: paginationSchema.extend({ action: z.string().optional(), entityType: z.string().optional(), entityId: z.string().optional() }),
  }),
  asyncHandler(async (req, res) => res.json(await listAuditLogs(req.query as any)))
);

export default router;
