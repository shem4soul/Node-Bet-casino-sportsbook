import crypto from 'crypto';
import { pool, withTransaction } from '../config/db';
import * as paymentRepo from '../repositories/paymentRepository';
import * as walletRepo from '../repositories/walletRepository';
import { AppError } from '../middleware/errorHandler';
import { verifySignature } from '../utils/webhookSignature';
import { appBaseUrl, mockGatewaySecretKey } from '../config/env';

const PROVIDER = 'mock_paystack';

interface MockGatewayInitResponse {
  status: boolean;
  message?: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

/**
 * Kicks off a deposit: creates a `pending` payment_intent in OUR db, then
 * asks the (mock) gateway to open a checkout session. The wallet is NOT
 * touched here — only a confirmed webhook credits it.
 */
export async function initializeDeposit(userId: number, { amount, email }: { amount: number; email: string }) {
  if (!(amount > 0)) throw new AppError('amount must be positive', 400);
  if (!email) throw new AppError('email is required', 400);

  const reference = `dep_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

  await paymentRepo.createPaymentIntent(pool, { userId, provider: PROVIDER, reference, amount });

  // Paystack-style APIs take amount in the smallest currency unit (kobo).
  const amountInMinorUnits = Math.round(amount * 100);

  let gatewayJson: MockGatewayInitResponse;
  try {
    const gatewayRes = await fetch(`${appBaseUrl}/mock-paystack/transaction/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountInMinorUnits,
        email,
        reference,
        callback_url: `${appBaseUrl}/api/wallet/deposit/callback`,
      }),
    });
    gatewayJson = (await gatewayRes.json()) as MockGatewayInitResponse;
    if (!gatewayRes.ok || !gatewayJson.status) {
      throw new Error(gatewayJson.message || 'Gateway rejected initialization');
    }
  } catch (err: any) {
    await paymentRepo.updateStatus(pool, reference, 'abandoned', { error: err.message });
    throw new AppError('Failed to initialize payment with gateway', 502);
  }

  return {
    reference,
    authorizationUrl: gatewayJson.data.authorization_url,
    amount,
  };
}

interface WebhookPayload {
  event: string;
  data: {
    reference: string;
    amount: number;
    currency?: string;
    status?: string;
    customer?: { email: string };
    paid_at?: string;
  };
}

/**
 * Handles an inbound webhook. `rawBody` MUST be the exact bytes the
 * gateway signed — see app.ts's json `verify` hook — not a re-serialized
 * object, or the signature check will spuriously fail.
 *
 * Idempotency: the INSERT into webhook_events has a UNIQUE KEY on
 * (provider, reference, event_type). If this exact event was already
 * recorded, the insert throws ER_DUP_ENTRY and we treat that as "already
 * processed" and return success without touching the wallet again — this
 * matters because gateways retry webhooks that don't get a fast 200.
 */
export async function handleWebhook({
  rawBody,
  signatureHeader,
}: {
  rawBody: Buffer | undefined;
  signatureHeader: string | string[] | undefined;
}) {
  if (!rawBody || !verifySignature(mockGatewaySecretKey, rawBody, signatureHeader)) {
    throw new AppError('Invalid webhook signature', 401);
  }

  let event: WebhookPayload;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError('Invalid JSON payload', 400);
  }

  const { event: eventType, data } = event;
  const reference = data && data.reference;
  if (!eventType || !reference) throw new AppError('Malformed webhook payload', 400);

  if (!['charge.success', 'charge.failed'].includes(eventType)) {
    // Unknown/irrelevant event type for this integration — acknowledge and ignore.
    return { ignored: true, eventType };
  }

  try {
    return await withTransaction(async (conn) => {
      // Atomic idempotency check: throws ER_DUP_ENTRY if we've seen this
      // exact (provider, reference, event_type) before.
      await paymentRepo.recordWebhookEventOrThrow(conn, {
        provider: PROVIDER,
        reference,
        eventType,
        payload: event,
      });

      const intent = await paymentRepo.getByReferenceForUpdate(conn, reference);
      if (!intent) throw new AppError(`Unknown payment reference: ${reference}`, 404);
      if (intent.provider !== PROVIDER) throw new AppError('Provider mismatch for reference', 409);

      if (intent.status !== 'pending') {
        // Already finalized by an earlier event — nothing further to do.
        return { alreadyFinalized: true, status: intent.status };
      }

      if (eventType === 'charge.success') {
        // Defense in depth: confirm the amount the gateway says was paid
        // matches what we originally asked for, in minor units.
        const expectedMinorUnits = Math.round(Number(intent.amount) * 100);
        if (Number(data.amount) !== expectedMinorUnits) {
          await paymentRepo.updateStatus(conn, reference, 'failed', data);
          throw new AppError('Webhook amount does not match payment intent amount', 400);
        }

        await paymentRepo.updateStatus(conn, reference, 'success', data);

        await walletRepo.adjustBalance(conn, {
          userId: intent.user_id,
          amount: Number(intent.amount),
          type: 'deposit',
          referenceType: 'payment_intent',
          referenceId: intent.id,
          note: `Confirmed via ${PROVIDER} webhook`,
        });

        return { credited: true, userId: intent.user_id, amount: intent.amount };
      }

      // charge.failed
      await paymentRepo.updateStatus(conn, reference, 'failed', data);
      return { credited: false };
    });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      // Duplicate delivery of an event we've already fully processed —
      // this is the expected, successful idempotent path, not an error.
      return { duplicate: true };
    }
    throw err;
  }
}

export async function getDepositStatus(userId: number, reference: string) {
  const intent = await paymentRepo.getByReference(pool, reference);
  if (!intent || intent.user_id !== userId) throw new AppError('Payment not found', 404);
  return intent;
}
