import express from 'express';
import * as adminController from '../controllers/adminController';
import { requireAuth, requireAdmin } from '../middleware/auth';

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.post('/sports', adminController.createSport);
router.post('/leagues', adminController.createLeague);
router.post('/events', adminController.createEvent);
router.post('/markets', adminController.createMarket);
router.post('/odds', adminController.createOdds);
router.patch('/odds/:oddsId', adminController.updateOddsPrice);
router.post('/markets/:marketId/suspend', adminController.suspendMarket);
router.post('/markets/:marketId/reopen', adminController.reopenMarket);
router.post('/markets/:marketId/settle', adminController.settleMarket);
router.post('/odds-sync', adminController.syncOdds);

export default router;
