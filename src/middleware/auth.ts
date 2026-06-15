import { NextFunction, Request, Response } from 'express';
import { pool, queryOne } from '../config/db';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import type { UserRow } from '../types/db';

/**
 * Verifies the bearer access token AND re-reads the user's role/status from
 * the database, so suspending/banning an account (or demoting an admin)
 * takes effect immediately instead of when the token expires.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw unauthorized('Missing or invalid Authorization header', 'TOKEN_MISSING');

    let userId: number;
    try {
      userId = Number(verifyAccessToken(token).sub);
    } catch {
      throw unauthorized('Invalid or expired access token', 'TOKEN_INVALID');
    }

    const user = await queryOne<Pick<UserRow, 'id' | 'role' | 'username' | 'email' | 'status' | 'kyc_status' | 'self_exclusion_until'>>(
      pool,
      'SELECT id, role, username, email, status, kyc_status, self_exclusion_until FROM users WHERE id = $1',
      [userId]
    );
    if (!user) throw unauthorized('Account no longer exists', 'TOKEN_INVALID');
    if (user.status === 'banned' || user.status === 'closed') throw forbidden(`Account is ${user.status}`, 'ACCOUNT_DISABLED');

    req.user = {
      id: user.id,
      role: user.role,
      username: user.username,
      email: user.email,
      status: user.status,
      kycStatus: user.kyc_status,
      selfExclusionUntil: user.self_exclusion_until,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') return next(forbidden('Admin access required'));
  next();
}

/**
 * Gate for anything that moves money INTO play (deposits, bets, casino).
 * Withdrawals and account access remain available to self-excluded users.
 */
export function requireCanGamble(req: Request, _res: Response, next: NextFunction): void {
  const u = req.user;
  if (!u) return next(unauthorized());
  if (u.status !== 'active') return next(forbidden(`Account is ${u.status}`, 'ACCOUNT_RESTRICTED'));
  if (u.selfExclusionUntil && new Date(u.selfExclusionUntil) > new Date()) {
    return next(forbidden(`You are self-excluded until ${new Date(u.selfExclusionUntil).toISOString()}`, 'SELF_EXCLUDED'));
  }
  next();
}
