import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp } from '../lib/http';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import * as auth from '../services/authService';
import * as rg from '../services/responsibleGamblingService';

const router = Router();
router.use(requireAuth);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json(await auth.getProfile(req.user!.id));
  })
);

router.patch(
  '/me',
  validate({
    body: z
      .object({
        firstName: z.string().trim().min(1).max(80).optional(),
        lastName: z.string().trim().min(1).max(80).optional(),
        phone: z
          .string()
          .regex(/^\+?[0-9]{10,15}$/)
          .optional(),
      })
      .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
  }),
  asyncHandler(async (req, res) => {
    res.json(await auth.updateProfile(req.user!.id, req.body));
  })
);

router.post(
  '/change-password',
  validate({
    body: z.object({
      currentPassword: z.string().min(1),
      newPassword: z
        .string()
        .min(8)
        .max(128)
        .regex(/[A-Za-z]/)
        .regex(/\d/),
    }),
  }),
  asyncHandler(async (req, res) => {
    await auth.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword);
    res.json({ message: 'Password changed. Other sessions have been signed out.' });
  })
);

// ---- Responsible gambling ----

router.get(
  '/limits',
  asyncHandler(async (req, res) => {
    res.json(await rg.getLimits(req.user!.id));
  })
);

router.put(
  '/limits/deposit',
  validate({
    body: z.object({
      period: z.enum(['daily', 'weekly', 'monthly']),
      amount: z.number().positive().max(1_000_000_000).nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await rg.setDepositLimit(req.user!.id, req.body.period, req.body.amount, clientIp(req)));
  })
);

router.post(
  '/self-exclusion',
  validate({ body: z.object({ days: z.number().int().min(1).max(3650), confirm: z.literal(true) }) }),
  asyncHandler(async (req, res) => {
    res.json(await rg.selfExclude(req.user!.id, req.body.days, clientIp(req)));
  })
);

export default router;
