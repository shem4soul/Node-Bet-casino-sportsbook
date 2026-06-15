/**
 * Dedicated background worker (cron jobs only, no HTTP). Run one or more of
 * these next to the API; advisory locks guarantee each job tick runs once
 * cluster-wide.
 */
import { flushLogs, logger } from './config/logger';
import { pool } from './config/db';
import { startScheduler, stopScheduler } from './jobs/scheduler';

startScheduler();
logger.info('worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  stopScheduler();
  await pool.end().catch(() => undefined);
  flushLogs();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
