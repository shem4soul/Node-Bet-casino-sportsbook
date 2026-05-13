import { oddsSyncIntervalMinutes, oddsSyncSport, oddsSyncLeague } from '../config/env';
import * as oddsSyncService from '../services/oddsSyncService';

/**
 * Starts a simple interval-based background sync if configured. This is
 * intentionally minimal (setInterval, not a cron library) — swap in
 * node-cron or a queue-based job runner if you need multiple sport/league
 * schedules or retry/backoff semantics.
 */
export function startOddsSyncScheduler(): NodeJS.Timeout | null {
  if (!oddsSyncIntervalMinutes || oddsSyncIntervalMinutes <= 0) return null;
  if (!oddsSyncSport) {
    // eslint-disable-next-line no-console
    console.warn('ODDS_SYNC_INTERVAL_MINUTES is set but ODDS_SYNC_SPORT is not — scheduler not started.');
    return null;
  }

  const run = async () => {
    try {
      const summary = await oddsSyncService.syncSportLeague({
        sport: oddsSyncSport as string,
        league: oddsSyncLeague || undefined,
      });
      // eslint-disable-next-line no-console
      console.log('[odds-sync]', JSON.stringify(summary));
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[odds-sync] failed:', err.message);
    }
  };

  run(); // fire once on startup, then on the interval
  return setInterval(run, oddsSyncIntervalMinutes * 60 * 1000);
}
