import express from 'express';
import authRoutes from './authRoutes';
import walletRoutes from './walletRoutes';
import casinoRoutes from './casinoRoutes';
import sportsRoutes from './sportsRoutes';
import adminRoutes from './adminRoutes';
import webhookRoutes from './webhookRoutes';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/casino', casinoRoutes);
router.use('/sports', sportsRoutes);
router.use('/admin', adminRoutes);
router.use('/webhooks', webhookRoutes);

router.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

export default router;
