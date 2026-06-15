import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { pool, withAdvisoryLock } from '../config/db';
import { jobRuns } from '../middleware/metrics';
import { reconcilePendingDeposits } from '../services/paymentService';
import { reconcileWithdrawals } from '../services/withdrawalService';
import { syncLeagues } from '../services/oddsSyncService';

/**
 * Kick-off guard: the book is pre-match only, so once an event's start time
 * passes it's marked live and all its open markets are suspended.
 * (Bet placement re-checks start_time too — this just keeps state tidy.)
 */
export async function closeStartedEvents(): Promise<{ events: number; markets: number }> {
  const ev = await pool.query(`UPDATE events SET status = 'live' WHERE status = 'scheduled' AND start_time <= now() RETURNING id`);
  const mk = await pool.query(
    `UPDATE markets SET status = 'suspended'
     WHERE status = 'open' AND event_id IN (SELECT id FROM events WHERE status <> 'scheduled' OR start_time <= now())`
  );
  return { events: ev.rowCount ?? 0, markets: mk.rowCount ?? 0 };
}

export async function cleanupTokens(): Promise<{ deleted: number }> {
  const a = await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`);
  const b = await pool.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`);
  const c = await pool.query(`DELETE FROM booking_codes WHERE expires_at < now() - interval '7 days'`);
  return { deleted: (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0) };
}

interface JobDef {
  name: string;
  schedule: string;
  lockKey: number;
  enabled: () => boolean;
  run: () => Promise<unknown>;
}

export const JOBS: JobDef[] = [
  { name: 'close-started-events', schedule: '* * * * *', lockKey: 727_101, enabled: () => true, run: closeStartedEvents },
  {
    name: 'reconcile-deposits',
    schedule: '*/5 * * * *',
    lockKey: 727_102,
    enabled: () => !!env.PAYSTACK_SECRET_KEY,
    run: reconcilePendingDeposits,
  },
  {
    name: 'reconcile-withdrawals',
    schedule: '*/5 * * * *',
    lockKey: 727_103,
    enabled: () => !!env.PAYSTACK_SECRET_KEY,
    run: reconcileWithdrawals,
  },
  { name: 'odds-sync', schedule: env.ODDS_SYNC_CRON, lockKey: 727_104, enabled: () => !!env.ODDS_API_KEY, run: () => syncLeagues() },
  { name: 'cleanup-tokens', schedule: '17 3 * * *', lockKey: 727_105, enabled: () => true, run: cleanupTokens },
];

async function runJob(job: JobDef) {
  const started = Date.now();
  try {
    const { ran, result } = await withAdvisoryLock(job.lockKey, job.run);
    if (!ran) return;
    jobRuns.inc({ job: job.name, outcome: 'success' });
    logger.info({ job: job.name, ms: Date.now() - started, result }, 'job finished');
  } catch (err) {
    jobRuns.inc({ job: job.name, outcome: 'error' });
    logger.error({ err, job: job.name }, 'job failed');
  }
}

let tasks: ScheduledTask[] = [];

export function startScheduler(): void {
  for (const job of JOBS) {
    if (!job.enabled()) {
      logger.info({ job: job.name }, 'job disabled (missing configuration)');
      continue;
    }
    if (!cron.validate(job.schedule)) {
      logger.error({ job: job.name, schedule: job.schedule }, 'invalid cron expression; job not scheduled');
      continue;
    }
    tasks.push(cron.schedule(job.schedule, () => void runJob(job), { timezone: 'UTC' }));
  }
  logger.info({ jobs: tasks.length }, 'scheduler started');
}

export function stopScheduler(): void {
  for (const t of tasks) t.stop();
  tasks = [];
}
