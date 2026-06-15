import { createApp } from './app';
import { env } from './config/env';
import { flushLogs, logger } from './config/logger';
import { pool } from './config/db';
import { startScheduler, stopScheduler } from './jobs/scheduler';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      event: 'server.started',
      port: env.PORT,
      env: env.NODE_ENV,
      node: process.version,
      docs: env.DOCS_ENABLED ? `${env.APP_BASE_URL}/docs` : false,
      jobsInApi: env.RUN_JOBS_IN_API,
      paystack: !env.PAYSTACK_SECRET_KEY ? 'disabled' : env.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test',
      oddsFeed: Boolean(env.ODDS_API_KEY),
      logLevel: env.LOG_LEVEL,
      logFile: env.LOG_FILE ?? false,
    },
    `${env.APP_NAME} listening on :${env.PORT}`
  );
  if (env.RUN_JOBS_IN_API) startScheduler();
});

// Slightly above typical LB idle timeouts so the LB closes first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down gracefully');
  stopScheduler();

  const force = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    flushLogs();
    process.exit(1);
  }, 25_000);
  force.unref();

  server.close(async () => {
    await pool.end().catch(() => undefined);
    logger.info('shutdown complete');
    flushLogs();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  void shutdown('uncaughtException');
});
