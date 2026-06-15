import fs from 'fs';
import path from 'path';
import pino, { Logger } from 'pino';
import { env } from './env';
import { getContext } from '../lib/requestContext';

/**
 * Structured JSON logging (pino).
 *
 *  - stdout: JSON in production (for Docker / log shippers), pretty in dev.
 *  - LOG_FILE: optional extra JSON file sink (e.g. /var/log/sportsbook/app.log).
 *  - Every line carries service/env/version, plus requestId/userId/job from
 *    the async request context, so a single request or user can be traced
 *    across HTTP, service and database layers.
 *  - Business events use a stable `event` field (e.g. "deposit.credited")
 *    so they can be filtered, counted and alerted on.
 *  - Secrets are redacted; emails are masked via `maskEmail`.
 */

let version = 'unknown';
try {
  version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version;
} catch {
  /* running from an unusual layout */
}

const level = env.isTest ? 'silent' : env.LOG_LEVEL;

/**
 * In-process multistream (rather than worker-thread transports): it routes by
 * pino's internal level, so it works with the string level labels below, and
 * it adds no extra threads to the container.
 */
function buildStreams() {
  const streams: pino.StreamEntry[] = [];
  if (env.LOG_PRETTY) {
    // pino-pretty is a dev dependency; fall back to JSON if it isn't installed (e.g. prod image).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pretty = require('pino-pretty');
      streams.push({
        level: level as pino.Level,
        stream: pretty({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname,service,env,version' }),
      });
    } catch {
      streams.push({ level: level as pino.Level, stream: pino.destination({ dest: 1, sync: false }) });
    }
  } else {
    streams.push({ level: level as pino.Level, stream: pino.destination({ dest: 1, sync: false }) });
  }
  if (env.LOG_FILE) {
    streams.push({ level: level as pino.Level, stream: pino.destination({ dest: env.LOG_FILE, mkdir: true, sync: false }) });
  }
  activeStreams.push(...streams);
  return pino.multistream(streams);
}

const activeStreams: pino.StreamEntry[] = [];

export const logger: Logger = pino(
  {
    level,
    base: { service: env.APP_NAME, env: env.NODE_ENV, version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const ctx = getContext();
      if (!ctx) return {};
      const out: Record<string, unknown> = {};
      if (ctx.requestId) out.requestId = ctx.requestId;
      if (ctx.userId) out.userId = ctx.userId;
      if (ctx.job) out.job = ctx.job;
      return out;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-paystack-signature"]',
        'password',
        'newPassword',
        'currentPassword',
        'refreshToken',
        'accessToken',
        'token',
        '*.password',
        '*.passwordHash',
        '*.password_hash',
        '*.refreshToken',
        '*.accessToken',
        '*.token',
        '*.server_seed',
        '*.recipient_code',
      ],
      censor: '[redacted]',
    },
    serializers: { err: pino.stdSerializers.err },
  },
  env.isTest ? undefined : buildStreams()
);

/** Synchronously flush buffered log lines (call right before process.exit). */
export function flushLogs(): void {
  for (const s of activeStreams) {
    const stream = s.stream as any;
    // A SonicBoom that hasn't opened its fd yet (fd < 0) would throw "not ready".
    if (typeof stream?.flushSync !== 'function' || (typeof stream.fd === 'number' && stream.fd < 0)) continue;
    try {
      stream.flushSync();
    } catch {
      /* best effort during shutdown */
    }
  }
}

/** Module-scoped logger: every line gets `module: <name>`. */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}

/** "chidi.okafor@example.com" -> "ch***@example.com" (PII-light logs). */
export function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/** "0123456789" -> "******6789" */
export function maskAccount(acct: string | null | undefined): string | undefined {
  return acct ? `******${acct.slice(-4)}` : undefined;
}
