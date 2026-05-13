import express from 'express';
import rateLimit from 'express-rate-limit';
import * as casinoController from '../controllers/casinoController';
import { requireAuth } from '../middleware/auth';

const router = express.Router();

// Caps rounds-per-minute per IP as a basic anti-abuse measure on top of
// the DB-level row locking that already serializes balance updates.
const playLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

router.use(requireAuth);
router.get('/fairness', casinoController.getFairness);
router.post('/fairness/rotate', casinoController.rotateSeed);
router.post('/dice/play', playLimiter, casinoController.playDice);
router.post('/coinflip/play', playLimiter, casinoController.playCoinflip);
router.post('/slots/play', playLimiter, casinoController.playSlots);
router.get('/history', casinoController.getHistory);

export default router;
