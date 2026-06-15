import { Router } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { asyncHandler } from '../lib/http';
import { forbidden } from '../lib/errors';
import { webhookLimiter } from '../middleware/rateLimit';
import { handlePaystackWebhook } from '../services/paymentService';

const router = Router();

/**
 * Paystack → us. Unauthenticated by design: the HMAC signature IS the auth.
 * Optionally also restricts the source IP to Paystack's published addresses
 * (requires TRUST_PROXY to be configured correctly behind a load balancer).
 */
router.post(
  '/paystack',
  webhookLimiter,
  asyncHandler(async (req, res) => {
    if (env.PAYSTACK_ENFORCE_IP_WHITELIST && !env.paystackWebhookIps.includes((req.ip || '').replace(/^::ffff:/, ''))) {
      logger.warn({ ip: req.ip }, 'Rejected Paystack webhook from non-whitelisted IP');
      throw forbidden('Source IP not allowed');
    }
    const result = await handlePaystackWebhook(req.rawBody, req.headers['x-paystack-signature']);
    logger.info({ event: req.body?.event, reference: req.body?.data?.reference, result }, 'Paystack webhook processed');
    res.status(200).json({ received: true });
  })
);

export default router;
