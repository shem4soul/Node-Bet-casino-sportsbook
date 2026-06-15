import { Queryable, pool, query, withTransaction } from '../config/db';
import { AppError, badRequest } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import { audit } from './auditService';
import type { DepositLimitRow, LimitPeriod } from '../types/db';

const PERIOD_INTERVAL: Record<LimitPeriod, string> = { daily: '1 day', weekly: '7 days', monthly: '30 days' };
export const LIMIT_INCREASE_COOLING_HOURS = 24;

/** Applies any staged limit change whose cooling-off period has elapsed. */
async function applyDueChanges(db: Queryable, userId: number): Promise<void> {
  await db.query(
    `DELETE FROM deposit_limits
     WHERE user_id = $1 AND pending_removal AND pending_effective_at <= now()`,
    [userId]
  );
  await db.query(
    `UPDATE deposit_limits
     SET amount_limit = pending_amount_limit, pending_amount_limit = NULL, pending_effective_at = NULL, updated_at = now()
     WHERE user_id = $1 AND pending_amount_limit IS NOT NULL AND pending_effective_at <= now()`,
    [userId]
  );
}

export async function getLimits(userId: number) {
  await applyDueChanges(pool, userId);
  const limits = await query<DepositLimitRow>(pool, 'SELECT * FROM deposit_limits WHERE user_id = $1 ORDER BY period', [userId]);
  const usage = await query<{ period: LimitPeriod; used: string }>(
    pool,
    `SELECT p.period, COALESCE(SUM(pi.amount), 0)::numeric(18,2)::text AS used
     FROM (VALUES ('daily', interval '1 day'), ('weekly', interval '7 days'), ('monthly', interval '30 days')) AS p(period, span)
     LEFT JOIN payment_intents pi
       ON pi.user_id = $1 AND pi.status IN ('success', 'pending') AND pi.created_at > now() - p.span
     GROUP BY p.period`,
    [userId]
  );
  const usedBy = Object.fromEntries(usage.map((u) => [u.period, u.used]));
  return {
    deposit: limits.map((l) => ({
      period: l.period,
      limit: l.amount_limit,
      used: usedBy[l.period] ?? '0.00',
      pendingLimit: l.pending_amount_limit,
      pendingRemoval: l.pending_removal,
      pendingEffectiveAt: l.pending_effective_at,
    })),
  };
}

/**
 * Lowering (or first setting) a limit applies immediately. Raising or
 * removing one is staged and only applies after a cooling-off period, so a
 * user can't lift their own limit in the heat of the moment.
 */
export async function setDepositLimit(userId: number, period: LimitPeriod, amount: number | null, ip?: string | null) {
  return withTransaction(async (c) => {
    await applyDueChanges(c, userId);
    const existing = (
      await query<DepositLimitRow>(c, 'SELECT * FROM deposit_limits WHERE user_id = $1 AND period = $2 FOR UPDATE', [userId, period])
    )[0];

    const newLimit = amount === null ? null : fromMinor(toMinor(amount));
    let effect: 'immediate' | 'scheduled';

    if (!existing) {
      if (newLimit === null) throw badRequest('No limit set for this period');
      await c.query('INSERT INTO deposit_limits (user_id, period, amount_limit) VALUES ($1, $2, $3)', [userId, period, newLimit]);
      effect = 'immediate';
    } else if (newLimit !== null && existing.amount_limit !== null && toMinor(newLimit) <= toMinor(existing.amount_limit)) {
      await c.query(
        `UPDATE deposit_limits SET amount_limit = $3, pending_amount_limit = NULL, pending_effective_at = NULL,
           pending_removal = false, updated_at = now()
         WHERE user_id = $1 AND period = $2`,
        [userId, period, newLimit]
      );
      effect = 'immediate';
    } else {
      await c.query(
        `UPDATE deposit_limits
         SET pending_amount_limit = $3, pending_removal = $4,
             pending_effective_at = now() + make_interval(hours => $5), updated_at = now()
         WHERE user_id = $1 AND period = $2`,
        [userId, period, newLimit, newLimit === null, LIMIT_INCREASE_COOLING_HOURS]
      );
      effect = 'scheduled';
    }

    await audit(c, {
      actorId: userId,
      action: 'rg.deposit_limit.set',
      entityType: 'user',
      entityId: userId,
      metadata: { period, amount: newLimit, effect },
      ip,
    });
    return { period, limit: newLimit, effect, coolingOffHours: effect === 'scheduled' ? LIMIT_INCREASE_COOLING_HOURS : 0 };
  });
}

/** Throws if depositing `amount` would breach any active deposit limit. */
export async function assertDepositAllowed(db: Queryable, userId: number, amount: number): Promise<void> {
  await applyDueChanges(db, userId);
  const breaches = await query<{ period: LimitPeriod; amount_limit: string; used: string }>(
    db,
    `SELECT dl.period, dl.amount_limit::text,
            COALESCE((SELECT SUM(pi.amount) FROM payment_intents pi
                      WHERE pi.user_id = dl.user_id AND pi.status IN ('success', 'pending')
                        AND pi.created_at > now() - CASE dl.period
                          WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days' ELSE interval '30 days' END), 0)::text AS used
     FROM deposit_limits dl
     WHERE dl.user_id = $1 AND dl.amount_limit IS NOT NULL`,
    [userId]
  );
  for (const b of breaches) {
    const remaining = toMinor(b.amount_limit) - toMinor(b.used);
    if (toMinor(amount) > remaining) {
      throw new AppError(
        `This deposit exceeds your ${b.period} deposit limit. Remaining: ${fromMinor(Math.max(0, remaining))}`,
        422,
        'DEPOSIT_LIMIT_EXCEEDED',
        { period: b.period, limit: b.amount_limit, used: b.used }
      );
    }
  }
}

/** Self-exclusion cannot be shortened or lifted by the user once set. */
export async function selfExclude(userId: number, days: number, ip?: string | null) {
  return withTransaction(async (c) => {
    const row = (
      await query<{ self_exclusion_until: Date }>(
        c,
        `UPDATE users
         SET self_exclusion_until = GREATEST(COALESCE(self_exclusion_until, now()), now() + make_interval(days => $2))
         WHERE id = $1 RETURNING self_exclusion_until`,
        [userId, days]
      )
    )[0];
    // Revoke sessions so every device sees the exclusion straight away.
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await audit(c, { actorId: userId, action: 'rg.self_exclusion', entityType: 'user', entityId: userId, metadata: { days }, ip });
    return { selfExclusionUntil: row.self_exclusion_until };
  });
}

export { PERIOD_INTERVAL };
