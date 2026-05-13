import express from 'express';
import rateLimit from 'express-rate-limit';
import * as webhookController from '../controllers/webhookController';

const router = express.Router();

// Generous but present — a misbehaving/compromised sender shouldn't be
// able to hammer this endpoint indefinitely.
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

router.post('/paystack', webhookLimiter, webhookController.paystackWebhook);

export default router;
