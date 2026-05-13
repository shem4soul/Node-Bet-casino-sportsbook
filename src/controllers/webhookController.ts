import { Request, Response } from 'express';
import * as paymentService from '../services/paymentService';
import { asyncHandler } from '../utils/asyncHandler';

// No requireAuth here — gateways call this endpoint directly, unauthenticated,
// identifying themselves purely via the signature. That signature check
// (in paymentService.handleWebhook) is what stands in for auth on this route.
export const paystackWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signatureHeader = req.headers['x-mock-paystack-signature'];
  // req.rawBody is captured by the express.json `verify` hook in app.ts —
  // signing/verifying must happen over the exact bytes the sender signed.
  const result = await paymentService.handleWebhook({ rawBody: req.rawBody, signatureHeader });
  res.status(200).json({ received: true, result });
});
