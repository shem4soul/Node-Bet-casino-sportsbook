import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { mockGatewaySecretKey, appBaseUrl } from '../config/env';
import { signPayload } from '../utils/webhookSignature';

/**
 * A self-contained stand-in for a hosted payment gateway (shaped like
 * Paystack's API/webhook contract) so the rest of the app can be built and
 * tested against something that behaves like a real one — WITHOUT moving
 * real money or needing real gateway credentials.
 *
 * In production you would delete this whole module and point
 * paymentService at the real gateway's SDK/API instead. The webhook
 * receiver in src/routes/webhookRoutes.ts doesn't know or care that the
 * sender is fake — it verifies the signature the same way it would for
 * a real provider.
 *
 * Flow this simulates:
 *   1. Your server calls POST /transaction/initialize -> gets back an
 *      authorization_url + reference.
 *   2. The "customer" is redirected to that URL (a plain HTML page here).
 *   3. Customer clicks "Simulate successful payment" or "Simulate failed
 *      payment" -> this module POSTs a signed webhook to your app's
 *      /api/webhooks/paystack, exactly like a real gateway would after a
 *      real charge attempt.
 */

const router = express.Router();

interface MockTransaction {
  amount: number;
  email: string;
  reference: string;
  currency: string;
  callbackUrl?: string;
  status: 'pending' | 'success' | 'failed';
  accessCode: string;
}

// In-memory store of initialized transactions. A real gateway holds this;
// we don't need to persist it in our own DB — payment_intents (in our DB)
// is the source of truth on our side.
const transactions = new Map<string, MockTransaction>();

// Note: JSON body parsing is already applied globally in app.ts (with the
// verify hook that captures req.rawBody for webhook signing elsewhere) —
// no need to re-parse it here.
router.post('/transaction/initialize', (req: Request, res: Response) => {
  const { amount, email, reference, currency, callback_url: callbackUrl } = req.body;

  if (!amount || !email || !reference) {
    return res.status(400).json({ status: false, message: 'amount, email and reference are required' });
  }
  if (transactions.has(reference)) {
    return res.status(409).json({ status: false, message: 'Reference already used' });
  }

  const accessCode = crypto.randomBytes(12).toString('hex');
  transactions.set(reference, {
    amount,
    email,
    reference,
    currency: currency || 'NGN',
    callbackUrl,
    status: 'pending',
    accessCode,
  });

  return res.status(200).json({
    status: true,
    message: 'Authorization URL created',
    data: {
      authorization_url: `${appBaseUrl}/mock-paystack/checkout/${accessCode}`,
      access_code: accessCode,
      reference,
    },
  });
});

router.get('/checkout/:accessCode', (req: Request, res: Response) => {
  const tx = [...transactions.values()].find((t) => t.accessCode === req.params.accessCode);
  if (!tx) return res.status(404).send('Checkout session not found or already used.');

  res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mock Paystack Checkout</title></head>
<body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align: center;">
  <h2>Test Checkout (mock)</h2>
  <p>Amount: <strong>${tx.amount / 100} ${tx.currency || ''}</strong></p>
  <p>Reference: <code>${tx.reference}</code></p>
  <p style="color:#888; font-size: 13px;">No real payment happens here — this simulates a gateway's hosted checkout for local testing.</p>
  <form method="POST" action="/mock-paystack/simulate/${tx.reference}/success" style="margin-top: 24px;">
    <button style="padding: 10px 18px; background:#0a0; color:#fff; border:0; border-radius:4px; cursor:pointer;">
      Simulate successful payment
    </button>
  </form>
  <form method="POST" action="/mock-paystack/simulate/${tx.reference}/failed" style="margin-top: 12px;">
    <button style="padding: 10px 18px; background:#a00; color:#fff; border:0; border-radius:4px; cursor:pointer;">
      Simulate failed payment
    </button>
  </form>
</body>
</html>`);
});

async function sendWebhook(eventType: 'charge.success' | 'charge.failed', tx: MockTransaction): Promise<void> {
  const payload = {
    event: eventType,
    data: {
      reference: tx.reference,
      amount: tx.amount,
      currency: tx.currency || 'NGN',
      status: eventType === 'charge.success' ? 'success' : 'failed',
      customer: { email: tx.email },
      paid_at: new Date().toISOString(),
    },
  };

  const rawBody = JSON.stringify(payload);
  const signature = signPayload(mockGatewaySecretKey, rawBody);

  await fetch(`${appBaseUrl}/api/webhooks/paystack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mock-paystack-signature': signature,
    },
    body: rawBody,
  });
}

router.post('/simulate/:reference/:outcome', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const { reference, outcome } = req.params;
  const tx = transactions.get(reference);
  if (!tx) return res.status(404).send('Transaction not found');
  if (!['success', 'failed'].includes(outcome)) return res.status(400).send('Invalid outcome');

  tx.status = outcome as 'success' | 'failed';
  const eventType = outcome === 'success' ? 'charge.success' : 'charge.failed';

  try {
    await sendWebhook(eventType, tx);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('Mock gateway failed to deliver webhook:', err.message);
  }

  res.type('html').send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 420px; margin: 60px auto; text-align: center;">
  <h2>${outcome === 'success' ? '✅ Payment simulated as successful' : '❌ Payment simulated as failed'}</h2>
  <p>A signed <code>${eventType}</code> webhook was sent to your app.</p>
  <p style="color:#888; font-size: 13px;">Reference: ${reference}</p>
</body></html>`);
});

/** Paystack also offers polling verification as a fallback to webhooks. */
router.get('/transaction/verify/:reference', (req: Request, res: Response) => {
  const tx = transactions.get(req.params.reference);
  if (!tx) return res.status(404).json({ status: false, message: 'Transaction not found' });

  res.json({
    status: true,
    data: {
      reference: tx.reference,
      amount: tx.amount,
      status: tx.status === 'pending' ? 'pending' : tx.status === 'success' ? 'success' : 'failed',
    },
  });
});

export default router;
