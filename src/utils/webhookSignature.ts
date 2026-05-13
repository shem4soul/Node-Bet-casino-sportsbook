import crypto from 'crypto';

/**
 * Paystack (and this mock) sign webhooks as:
 *   HMAC-SHA512(secretKey, rawRequestBody) -> hex digest
 * sent in the `x-mock-paystack-signature` header. Verify against the RAW
 * bytes of the body, not the re-serialized JSON object — re-serializing
 * can reorder keys or change whitespace and break the signature even
 * when the payload is "the same".
 */
export function signPayload(secretKey: string, rawBody: string | Buffer): string {
  return crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
}

export function verifySignature(
  secretKey: string,
  rawBody: string | Buffer,
  signatureHeader: string | string[] | undefined
): boolean {
  if (!signatureHeader) return false;

  const expected = signPayload(secretKey, rawBody);
  const expectedBuf = Buffer.from(expected, 'hex');
  const givenBuf = Buffer.from(String(signatureHeader), 'hex');

  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}
