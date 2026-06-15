import { pool, query, queryOne, withTransaction } from '../config/db';
import { badRequest, notFound } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import * as walletRepo from '../repositories/walletRepository';
import { audit } from './auditService';
import { publicUser } from './authService';
import type { KycStatus, UserRow, UserStatus } from '../types/db';
import type { Pagination } from '../lib/http';

export async function listUsers(p: Pagination & { search?: string; status?: UserStatus; kycStatus?: KycStatus }) {
  const rows = await query<UserRow & { balance: string }>(
    pool,
    `SELECT u.*, w.balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     WHERE ($1::text IS NULL OR u.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR u.status = $2)
       AND ($3::text IS NULL OR u.kyc_status = $3)
     ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`,
    [p.search?.trim() || null, p.status ?? null, p.kycStatus ?? null, p.limit, p.offset]
  );
  return rows.map((u) => ({ ...publicUser(u), balance: u.balance }));
}

export async function getUser(id: number) {
  const u = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE id = $1', [id]);
  if (!u) throw notFound('User');
  const wallet = await walletRepo.getWallet(pool, id);
  const stats = await queryOne(
    pool,
    `SELECT
       (SELECT COALESCE(SUM(amount),0) FROM payment_intents WHERE user_id = $1 AND status = 'success')::text AS total_deposits,
       (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE user_id = $1 AND status = 'success')::text AS total_withdrawals,
       (SELECT COUNT(*) FROM bet_slips WHERE user_id = $1) AS bets_placed,
       (SELECT COALESCE(SUM(stake),0) FROM bet_slips WHERE user_id = $1)::text AS total_staked,
       (SELECT COALESCE(SUM(payout),0) FROM bet_slips WHERE user_id = $1)::text AS total_returned`,
    [id]
  );
  return { ...publicUser(u), lastLoginAt: u.last_login_at, wallet, stats };
}

export async function setUserStatus(actorId: number, id: number, status: UserStatus, reason: string, ip?: string | null) {
  if (actorId === id) throw badRequest('You cannot change your own status');
  return withTransaction(async (c) => {
    const u = await queryOne<UserRow>(c, 'UPDATE users SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
    if (!u) throw notFound('User');
    if (status !== 'active') await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, { actorId, action: 'user.status', entityType: 'user', entityId: id, metadata: { status, reason }, ip });
    return publicUser(u);
  });
}

export async function setKycStatus(actorId: number, id: number, kycStatus: KycStatus, note: string | undefined, ip?: string | null) {
  return withTransaction(async (c) => {
    const u = await queryOne<UserRow>(c, 'UPDATE users SET kyc_status = $2 WHERE id = $1 RETURNING *', [id, kycStatus]);
    if (!u) throw notFound('User');
    await audit(c, { actorId, action: 'user.kyc', entityType: 'user', entityId: id, metadata: { kycStatus, note }, ip });
    return publicUser(u);
  });
}

export async function adjustBalance(actorId: number, id: number, amount: number, note: string, ip?: string | null) {
  if (toMinor(amount) === 0) throw badRequest('Amount cannot be zero');
  return withTransaction(async (c) => {
    const balance = await walletRepo.adjustBalance(c, {
      userId: id,
      amount: fromMinor(toMinor(amount)),
      type: 'adjustment',
      referenceType: 'admin_adjustment',
      note: `Admin: ${note}`.slice(0, 255),
    });
    await audit(c, { actorId, action: 'wallet.adjust', entityType: 'user', entityId: id, metadata: { amount, note }, ip });
    return { userId: id, balance };
  });
}

/**
 * Operator P&L for a window. GGR (gross gaming revenue) = stakes − payouts
 * (payouts include winnings, void refunds and cash-outs).
 */
export async function summaryReport(from: Date, to: Date) {
  const r = await queryOne(
    pool,
    `SELECT
       COALESCE(SUM(-amount) FILTER (WHERE type = 'bet_stake'), 0)::text AS sports_stakes,
       COALESCE(SUM(amount)  FILTER (WHERE type IN ('bet_payout', 'bet_void_refund', 'bet_cashout')), 0)::text AS sports_payouts,
       COALESCE(SUM(-amount) FILTER (WHERE type = 'game_stake'), 0)::text AS casino_stakes,
       COALESCE(SUM(amount)  FILTER (WHERE type = 'game_payout'), 0)::text AS casino_payouts,
       COALESCE(SUM(amount)  FILTER (WHERE type = 'deposit'), 0)::text AS deposits,
       COALESCE(SUM(-amount) FILTER (WHERE type = 'withdrawal'), 0)::text AS withdrawals_requested,
       COALESCE(SUM(amount)  FILTER (WHERE type = 'withdrawal_reversal'), 0)::text AS withdrawals_reversed,
       COALESCE(SUM(amount)  FILTER (WHERE type = 'adjustment'), 0)::text AS adjustments,
       COUNT(DISTINCT user_id) AS active_users
     FROM transactions WHERE created_at >= $1 AND created_at < $2`,
    [from, to]
  );
  const extra = await queryOne(
    pool,
    `SELECT
       (SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2) AS new_users,
       (SELECT COUNT(*) FROM bet_slips WHERE created_at >= $1 AND created_at < $2) AS bets_placed,
       (SELECT COUNT(DISTINCT user_id) FROM payment_intents WHERE status = 'success' AND paid_at >= $1 AND paid_at < $2) AS depositors,
       (SELECT COALESCE(SUM(balance),0) FROM wallets)::text AS total_customer_balances,
       (SELECT COALESCE(SUM(potential_payout),0) FROM bet_slips WHERE status = 'pending')::text AS open_bet_liability`,
    [from, to]
  );
  const sportsGgr = fromMinor(toMinor(r.sports_stakes) - toMinor(r.sports_payouts));
  const casinoGgr = fromMinor(toMinor(r.casino_stakes) - toMinor(r.casino_payouts));
  return {
    window: { from, to },
    sportsbook: { stakes: r.sports_stakes, payouts: r.sports_payouts, ggr: sportsGgr },
    casino: { stakes: r.casino_stakes, payouts: r.casino_payouts, ggr: casinoGgr },
    totalGgr: fromMinor(toMinor(sportsGgr) + toMinor(casinoGgr)),
    payments: {
      deposits: r.deposits,
      withdrawalsNet: fromMinor(toMinor(r.withdrawals_requested) - toMinor(r.withdrawals_reversed)),
      depositors: extra!.depositors,
    },
    adjustments: r.adjustments,
    activeUsers: r.active_users,
    newUsers: extra!.new_users,
    betsPlaced: extra!.bets_placed,
    totalCustomerBalances: extra!.total_customer_balances,
    openBetLiability: extra!.open_bet_liability,
  };
}

/**
 * Exposure per selection on unsettled markets: how much the book pays if
 * that selection wins (single bets exactly, multis counted at full
 * potential payout as a conservative upper bound).
 */
export function liabilityReport(p: Pagination & { eventId?: number }) {
  return query(
    pool,
    `SELECT e.id AS event_id, e.home_team, e.away_team, e.start_time, m.id AS market_id, m.market_type, m.line,
            bs.selection, COUNT(*) AS legs,
            SUM(sl.stake)::text AS stakes,
            SUM(sl.potential_payout) FILTER (WHERE sl.bet_type = 'single')::text AS single_liability,
            SUM(sl.potential_payout) FILTER (WHERE sl.bet_type = 'multi')::text AS multi_liability_upper_bound
     FROM bet_selections bs
     JOIN bet_slips sl ON sl.id = bs.bet_slip_id AND sl.status = 'pending'
     JOIN markets m ON m.id = bs.market_id
     JOIN events e ON e.id = bs.event_id
     WHERE bs.result = 'pending' AND ($1::bigint IS NULL OR e.id = $1)
     GROUP BY e.id, m.id, bs.selection
     ORDER BY SUM(sl.potential_payout) DESC
     LIMIT $2 OFFSET $3`,
    [p.eventId ?? null, p.limit, p.offset]
  );
}

export function adminListBets(p: Pagination & { status?: string; userId?: number; eventId?: number }) {
  return query(
    pool,
    `SELECT sl.*, u.username FROM bet_slips sl JOIN users u ON u.id = sl.user_id
     WHERE ($1::text IS NULL OR sl.status = $1)
       AND ($2::bigint IS NULL OR sl.user_id = $2)
       AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM bet_selections bs WHERE bs.bet_slip_id = sl.id AND bs.event_id = $3))
     ORDER BY sl.created_at DESC LIMIT $4 OFFSET $5`,
    [p.status ?? null, p.userId ?? null, p.eventId ?? null, p.limit, p.offset]
  );
}
