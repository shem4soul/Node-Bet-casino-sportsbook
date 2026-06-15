import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp } from '../lib/http';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimit';
import * as auth from '../services/authService';

const router = Router();

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const registerSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,32}$/, 'Username: 3-32 letters, digits or underscores'),
  email: z.string().email().max(254),
  password,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/, 'Phone must be 10-15 digits, optionally starting with +')
    .optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
});

const ctx = (req: any) => ({ ip: clientIp(req), userAgent: req.get('user-agent') ?? null });

router.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await auth.register(req.body, ctx(req)));
  })
);

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    res.json(await auth.login(req.body.identifier, req.body.password, ctx(req)));
  })
);

router.post(
  '/refresh',
  authLimiter,
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  asyncHandler(async (req, res) => {
    res.json(await auth.refresh(req.body.refreshToken, ctx(req)));
  })
);

router.post(
  '/logout',
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  asyncHandler(async (req, res) => {
    await auth.logout(req.body.refreshToken);
    res.status(204).end();
  })
);

router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    await auth.logoutAll(req.user!.id);
    res.status(204).end();
  })
);

router.post(
  '/forgot-password',
  passwordResetLimiter,
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    await auth.requestPasswordReset(req.body.email);
    res.status(202).json({ message: 'If that email is registered, a reset link has been sent.' });
  })
);

router.post(
  '/reset-password',
  passwordResetLimiter,
  validate({ body: z.object({ token: z.string().min(20).max(200), newPassword: password }) }),
  asyncHandler(async (req, res) => {
    await auth.resetPassword(req.body.token, req.body.newPassword);
    res.json({ message: 'Password updated. Please log in again.' });
  })
);

export default router;
