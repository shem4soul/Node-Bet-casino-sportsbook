import { Router } from 'express';
import authRoutes from './authRoutes';
import accountRoutes from './accountRoutes';
import walletRoutes from './walletRoutes';
import sportsRoutes from './sportsRoutes';
import casinoRoutes from './casinoRoutes';
import adminRoutes from './adminRoutes';
import webhookRoutes from './webhookRoutes';
import { env } from '../config/env';
import { notFound } from '../lib/errors';

const router = Router();

router.use('/auth', authRoutes);
router.use('/account', accountRoutes);
router.use('/wallet', walletRoutes);
router.use('/sports', sportsRoutes);
router.use('/casino', (_req, _res, next) => (env.CASINO_ENABLED ? next() : next(notFound('Casino'))), casinoRoutes);
router.use('/admin', adminRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
