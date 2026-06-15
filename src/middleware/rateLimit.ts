import rateLimit, { Options } from 'express-rate-limit';
import { env } from '../config/env';

/**
 * In-memory limiters (per process). When running several replicas behind a
 * load balancer, plug a shared store (e.g. rate-limit-redis) into `store`.
 */
const base = (opts: Partial<Options>) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } },
    ...opts,
  });

export const globalLimiter = base({ windowMs: 60_000, limit: 300 });
export const authLimiter = base({ windowMs: 15 * 60_000, limit: 20 });
export const passwordResetLimiter = base({ windowMs: 60 * 60_000, limit: 5 });
export const betLimiter = base({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.ip || 'anon'),
});
export const casinoLimiter = base({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.ip || 'anon'),
});
export const paymentLimiter = base({
  windowMs: 60_000,
  limit: 15,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.ip || 'anon'),
});
export const webhookLimiter = base({ windowMs: 60_000, limit: 600 });
