import crypto from 'crypto';
import { PoolClient } from 'pg';
import { env } from '../config/env';
import { pool, queryOne, withTransaction, PG_UNIQUE_VIOLATION } from '../config/db';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { burnPasswordCheck, comparePassword, hashPassword } from '../lib/password';
import { randomToken, sha256, signAccessToken } from '../lib/tokens';
import * as walletRepo from '../repositories/walletRepository';
import { sendMail } from './notificationService';
import type { UserRow } from '../types/db';
import { createLogger, maskEmail } from '../config/logger';

const log = createLogger('auth');

export interface ClientContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.role,
    kycStatus: u.kyc_status,
    status: u.status,
    selfExclusionUntil: u.self_exclusion_until,
    createdAt: u.created_at,
  };
}

function ageInYears(dob: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

async function issueTokens(
  db: PoolClient | typeof pool,
  user: Pick<UserRow, 'id' | 'role' | 'username'>,
  ctx: ClientContext,
  familyId?: string
) {
  const refreshToken = randomToken();
  const family = familyId ?? crypto.randomUUID();
  const row = await queryOne<{ id: number }>(
    db,
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6) RETURNING id`,
    [user.id, sha256(refreshToken), family, env.REFRESH_TOKEN_TTL_DAYS, ctx.userAgent?.slice(0, 255) ?? null, ctx.ip ?? null]
  );
  const tokens: AuthTokens = {
    accessToken: signAccessToken(user),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_TTL,
  };
  return { tokens, refreshTokenId: row!.id };
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  dateOfBirth: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

export async function register(input: RegisterInput, ctx: ClientContext) {
  const dob = new Date(`${input.dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) throw badRequest('Invalid dateOfBirth');
  if (ageInYears(dob) < env.MIN_AGE_YEARS) {
    log.info({ event: 'auth.register.rejected', reason: 'underage', ip: ctx.ip }, 'Registration rejected: under age');
    throw new AppError(`You must be at least ${env.MIN_AGE_YEARS} years old to register`, 403, 'UNDERAGE');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const result = await withTransaction(async (c) => {
      const user = await queryOne<UserRow>(
        c,
        `INSERT INTO users (username, email, phone, password_hash, date_of_birth, first_name, last_name)
         VALUES ($1, lower($2), $3, $4, $5, $6, $7) RETURNING *`,
        [input.username, input.email, input.phone ?? null, passwordHash, input.dateOfBirth, input.firstName ?? null, input.lastName ?? null]
      );
      const starting = env.isProduction ? 0 : env.DEMO_STARTING_BALANCE;
      await walletRepo.createWallet(c, user!.id, env.CURRENCY, starting);
      const { tokens } = await issueTokens(c, user!, ctx);
      return { user: publicUser(user!), ...tokens };
    });
    log.info(
      {
        event: 'auth.register',
        newUserId: result.user.id,
        username: result.user.username,
        email: maskEmail(result.user.email),
        ip: ctx.ip,
      },
      'User registered'
    );
    return result;
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION) {
      log.info({ event: 'auth.register.rejected', reason: 'duplicate', ip: ctx.ip }, 'Registration rejected: account exists');
      throw conflict('Username, email or phone already in use', 'ACCOUNT_EXISTS');
    }
    throw err;
  }
}

export async function login(identifier: string, password: string, ctx: ClientContext) {
  const user = await queryOne<UserRow>(
    pool,
    'SELECT * FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($1) OR phone = $1 LIMIT 1',
    [identifier.trim()]
  );

  if (!user) {
    await burnPasswordCheck(password);
    log.warn({ event: 'auth.login.failed', reason: 'unknown_account', ip: ctx.ip }, 'Login failed: unknown account');
    throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  if (user.locked_until && user.locked_until > new Date()) {
    log.warn(
      { event: 'auth.login.blocked', targetUserId: user.id, lockedUntil: user.locked_until, ip: ctx.ip },
      'Login attempt on locked account'
    );
    throw new AppError('Too many failed login attempts. Try again later.', 429, 'ACCOUNT_LOCKED');
  }

  const ok = await comparePassword(password, user.password_hash);
  if (!ok) {
    await pool.query(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1,
           locked_until = CASE WHEN failed_login_attempts + 1 >= $2
                               THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [user.id, env.MAX_FAILED_LOGINS, env.LOCKOUT_MINUTES]
    );
    const attempts = user.failed_login_attempts + 1;
    const locked = attempts >= env.MAX_FAILED_LOGINS;
    log.warn(
      { event: locked ? 'auth.account.locked' : 'auth.login.failed', reason: 'bad_password', targetUserId: user.id, attempts, ip: ctx.ip },
      locked ? `Account locked for ${env.LOCKOUT_MINUTES} min after ${attempts} failed logins` : 'Login failed: wrong password'
    );
    throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  if (user.status === 'banned' || user.status === 'closed') throw forbidden(`Account is ${user.status}`, 'ACCOUNT_DISABLED');

  await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  const { tokens } = await issueTokens(pool, user, ctx);
  log.info({ event: 'auth.login', targetUserId: user.id, role: user.role, ip: ctx.ip, userAgent: ctx.userAgent }, 'User logged in');
  return { user: publicUser(user), ...tokens };
}

/**
 * Refresh-token rotation with reuse detection: each refresh token is single
 * use. Presenting an already-rotated token means it leaked, so the whole
 * token family is revoked and the user must log in again.
 */
export async function refresh(refreshToken: string, ctx: ClientContext) {
  const result = await withTransaction(async (c) => {
    const row = await queryOne<{ id: number; user_id: number; family_id: string; expires_at: Date; revoked_at: Date | null }>(
      c,
      'SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [sha256(refreshToken)]
    );
    if (!row) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');

    if (row.revoked_at) {
      // Must COMMIT the family revocation, so signal reuse instead of throwing inside the transaction.
      await c.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1', [row.family_id]);
      return { reused: true as const, userId: row.user_id, familyId: row.family_id };
    }
    if (row.expires_at < new Date()) throw unauthorized('Refresh token expired', 'REFRESH_EXPIRED');

    const user = await queryOne<UserRow>(c, 'SELECT * FROM users WHERE id = $1', [row.user_id]);
    if (!user || user.status === 'banned' || user.status === 'closed') throw forbidden('Account disabled', 'ACCOUNT_DISABLED');

    const { tokens, refreshTokenId } = await issueTokens(c, user, ctx, row.family_id);
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [row.id, refreshTokenId]);
    return { reused: false as const, tokens };
  });
  if (result.reused) {
    log.warn(
      { event: 'auth.refresh.reuse_detected', targetUserId: result.userId, familyId: result.familyId, ip: ctx.ip },
      'Refresh token reuse detected — session chain revoked (possible token theft)'
    );
    throw unauthorized('Refresh token reuse detected; all sessions in this chain were revoked', 'REFRESH_REUSED');
  }
  return result.tokens;
}

export async function logout(refreshToken: string): Promise<void> {
  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(refreshToken)]);
}

export async function logoutAll(userId: number): Promise<void> {
  const r = await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  log.info({ event: 'auth.logout_all', sessionsRevoked: r.rowCount }, 'All sessions revoked');
}

export async function getProfile(userId: number) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw unauthorized();
  const wallet = await walletRepo.getWallet(pool, userId);
  return { ...publicUser(user), wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null };
}

export async function updateProfile(userId: number, p: { firstName?: string; lastName?: string; phone?: string }) {
  try {
    const user = await queryOne<UserRow>(
      pool,
      `UPDATE users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), phone = COALESCE($4, phone)
       WHERE id = $1 RETURNING *`,
      [userId, p.firstName ?? null, p.lastName ?? null, p.phone ?? null]
    );
    return publicUser(user!);
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION) throw conflict('Phone number already in use');
    throw err;
  }
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!user || !(await comparePassword(currentPassword, user.password_hash))) {
    log.warn({ event: 'auth.password_change.failed' }, 'Password change failed: wrong current password');
    throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  }
  const hash = await hashPassword(newPassword);
  await withTransaction(async (c) => {
    await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  });
  log.info({ event: 'auth.password.changed' }, 'Password changed; other sessions revoked');
}

/** Always resolves the same way whether or not the email exists (no enumeration). */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  if (!user || user.status === 'banned' || user.status === 'closed') {
    log.info(
      { event: 'auth.password_reset.requested', matched: false, email: maskEmail(email) },
      'Password reset requested for unknown/disabled account'
    );
    return;
  }

  const token = randomToken(32);
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [user.id, sha256(token), env.PASSWORD_RESET_TTL_MINUTES]
  );
  await sendMail({
    to: user.email,
    subject: 'Reset your password',
    text:
      `Hi ${user.username},\n\nUse the link below to reset your password. It expires in ` +
      `${env.PASSWORD_RESET_TTL_MINUTES} minutes.\n\n${env.FRONTEND_URL}/reset-password?token=${token}\n\n` +
      `If you didn't ask for this, you can ignore this email.`,
  });
  log.info({ event: 'auth.password_reset.requested', matched: true, targetUserId: user.id }, 'Password reset email issued');
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  await withTransaction(async (c) => {
    const row = await queryOne<{ id: number; user_id: number }>(
      c,
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(token)]
    );
    if (!row) {
      log.warn({ event: 'auth.password_reset.invalid_token' }, 'Password reset with invalid/expired token');
      throw badRequest('Reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
    }
    await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
    await c.query('UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [row.user_id, hash]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    log.info({ event: 'auth.password_reset.completed', targetUserId: row.user_id }, 'Password reset completed');
  });
}
