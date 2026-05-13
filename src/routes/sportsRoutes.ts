import express from 'express';
import * as sportsController from '../controllers/sportsController';
import { requireAuth } from '../middleware/auth';

const router = express.Router();

// Browsing events/odds is public; placing bets and viewing your own bets requires auth.
router.get('/events', sportsController.listEvents);
router.get('/events/:eventId', sportsController.getEvent);

router.post('/bets', requireAuth, sportsController.placeBet);
router.get('/bets/mine', requireAuth, sportsController.listMyBets);

export default router;
