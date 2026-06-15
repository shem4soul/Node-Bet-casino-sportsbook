import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../lib/errors';

/**
 * Thin, typed wrapper around the Paystack REST API (https://paystack.com/docs/api).
 * Amounts are always in the SUBUNIT (kobo for NGN).
 */

export class PaystackError extends AppError {
  /**
   * `definitive` = Paystack answered and said no (safe to treat as failed).
   * Network errors/timeouts are NOT definitive: the operation may have
   * happened, so callers must reconcile later instead of assuming failure.
   */
  readonly definitive: boolean;
  readonly httpStatus?: number;

  constructor(message: string, definitive: boolean, httpStatus?: number) {
    super(message, 502, 'PAYMENT_PROVIDER_ERROR');
    this.definitive = definitive;
    this.httpStatus = httpStatus;
  }
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface InitializeTransactionParams {
  email: string;
  amount: number; // kobo
  reference: string;
  currency?: string;
  callback_url?: string;
  channels?: string[];
  metadata?: Record<string, unknown>;
}

export interface InitializeTransactionData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface VerifiedTransaction {
  id: number;
  status: 'success' | 'failed' | 'abandoned' | 'reversed' | 'pending' | 'ongoing' | 'processing' | 'queued';
  reference: string;
  amount: number; // kobo
  currency: string;
  channel?: string;
  paid_at?: string | null;
  gateway_response?: string;
  customer?: { email?: string };
}

export interface Bank {
  id: number;
  name: string;
  slug: string;
  code: string;
  longcode?: string;
  type?: string;
  currency: string;
  active: boolean;
}

export interface ResolvedAccount {
  account_number: string;
  account_name: string;
  bank_id?: number;
}

export interface TransferRecipient {
  recipient_code: string;
  details?: { account_number: string; account_name: string; bank_code: string; bank_name: string };
}

export interface TransferData {
  reference: string;
  transfer_code: string;
  status: 'success' | 'pending' | 'failed' | 'reversed' | 'otp' | 'abandoned' | 'blocked' | 'rejected' | 'received';
  amount: number;
  currency: string;
  reason?: string;
}

export interface PaystackApi {
  initializeTransaction(p: InitializeTransactionParams): Promise<InitializeTransactionData>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  listBanks(currency?: string): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount>;
  createTransferRecipient(p: { name: string; accountNumber: string; bankCode: string; currency?: string }): Promise<TransferRecipient>;
  initiateTransfer(p: { amount: number; recipient: string; reference: string; reason?: string; currency?: string }): Promise<TransferData>;
  verifyTransfer(reference: string): Promise<TransferData>;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!env.PAYSTACK_SECRET_KEY) throw new AppError('Payments are not configured (PAYSTACK_SECRET_KEY missing)', 503, 'PAYMENTS_DISABLED');

  let res: Response;
  try {
    res = await fetch(`${env.PAYSTACK_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(env.PAYSTACK_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err, path }, 'Paystack request failed (network/timeout)');
    throw new PaystackError('Payment provider unreachable', false);
  }

  let json: PaystackEnvelope<T> | null = null;
  try {
    json = (await res.json()) as PaystackEnvelope<T>;
  } catch {
    /* non-JSON response */
  }

  if (!res.ok || !json?.status) {
    const message = json?.message || `Paystack HTTP ${res.status}`;
    // 4xx = Paystack definitively rejected it; 5xx = unknown outcome.
    const definitive = res.status >= 400 && res.status < 500;
    logger.warn({ path, status: res.status, message }, 'Paystack returned an error');
    throw new PaystackError(message, definitive, res.status);
  }
  return json.data;
}

export const paystack: PaystackApi = {
  initializeTransaction: (p) => call('POST', '/transaction/initialize', p),
  verifyTransaction: (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`),
  listBanks: (currency = 'NGN') => call('GET', `/bank?currency=${encodeURIComponent(currency)}&perPage=100`),
  resolveAccount: (accountNumber, bankCode) =>
    call('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`),
  createTransferRecipient: ({ name, accountNumber, bankCode, currency = 'NGN' }) =>
    call('POST', '/transferrecipient', { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency }),
  initiateTransfer: ({ amount, recipient, reference, reason, currency = 'NGN' }) =>
    call('POST', '/transfer', { source: 'balance', amount, recipient, reference, reason, currency }),
  verifyTransfer: (reference) => call('GET', `/transfer/verify/${encodeURIComponent(reference)}`),
};

/**
 * Paystack signs every webhook as HMAC-SHA512(secretKey, rawBody), hex, in
 * the `x-paystack-signature` header. Must be checked against the RAW bytes.
 */
export function computeSignature(rawBody: Buffer | string, secret = env.PAYSTACK_SECRET_KEY): string {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

export function isValidSignature(
  rawBody: Buffer | undefined,
  header: string | string[] | undefined,
  secret = env.PAYSTACK_SECRET_KEY
): boolean {
  if (!rawBody || !header || !secret || Array.isArray(header)) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret), 'hex');
  const given = Buffer.from(header, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
