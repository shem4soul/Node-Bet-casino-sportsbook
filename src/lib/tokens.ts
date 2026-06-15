import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // user id
  role: 'user' | 'admin';
  username: string;
}

export function signAccessToken(payload: { id: number; role: 'user' | 'admin'; username: string }): string {
  return jwt.sign({ role: payload.role, username: payload.username }, env.JWT_ACCESS_SECRET, {
    subject: String(payload.id),
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: env.JWT_ISSUER,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    algorithms: ['HS256'],
  }) as AccessTokenPayload;
}

/** Cryptographically random opaque token (URL safe). */
export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const BOOKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function bookingCode(length = 7): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += BOOKING_ALPHABET[bytes[i] % BOOKING_ALPHABET.length];
  return out;
}

/** Paystack references: 16–50 chars of [a-z0-9_-]. */
export function paymentReference(prefix: 'dep' | 'wd'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}
