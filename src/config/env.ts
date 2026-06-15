import 'dotenv/config';
import { z } from 'zod';

/**
 * All configuration is read from the environment once, validated with zod,
 * and exported as a typed, frozen object. The process refuses to boot with
 * an invalid configuration instead of failing later at request time.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_NAME: z.string().default('naija-sportsbook-api'),
  APP_BASE_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Pretty, human-readable logs. Defaults to true outside production, JSON in production.
  LOG_PRETTY: z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional(),
  // Optional extra JSON log file sink, e.g. /var/log/sportsbook/app.log
  LOG_FILE: z.string().optional(),
  // Log request/response timing for /health, /ready and /metrics too (noisy).
  LOG_PROBES: bool(false),
  TRUST_PROXY: z.string().default('loopback'),
  CORS_ORIGINS: csv,
  DOCS_ENABLED: bool(true),
  // If both are set, /docs requires HTTP Basic auth (recommended in production).
  DOCS_USERNAME: z.string().optional(),
  DOCS_PASSWORD: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),

  // PostgreSQL
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // Auth
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_ISSUER: z.string().default('naija-sportsbook-api'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  MIN_AGE_YEARS: z.coerce.number().int().min(18).default(18),

  // Wallet / currency
  CURRENCY: z.string().length(3).default('NGN'),
  DEMO_STARTING_BALANCE: z.coerce.number().min(0).default(0),

  // Sportsbook risk
  MIN_STAKE: z.coerce.number().positive().default(100),
  MAX_STAKE: z.coerce.number().positive().default(1_000_000),
  MAX_PAYOUT: z.coerce.number().positive().default(50_000_000),
  MAX_SELECTIONS: z.coerce.number().int().positive().default(40),
  CASHOUT_ENABLED: bool(true),
  CASHOUT_MARGIN_PERCENT: z.coerce.number().min(0).max(50).default(5),
  BOOKING_CODE_TTL_HOURS: z.coerce.number().int().positive().default(72),

  // Casino
  CASINO_ENABLED: bool(true),

  // Paystack
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_PUBLIC_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  PAYSTACK_VERIFY_ON_WEBHOOK: bool(true),
  PAYSTACK_ENFORCE_IP_WHITELIST: bool(false),
  PAYSTACK_WEBHOOK_IPS: z.string().default('52.31.139.75,52.49.173.169,52.214.14.220'),
  PAYSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MIN_DEPOSIT: z.coerce.number().positive().default(100),
  MAX_DEPOSIT: z.coerce.number().positive().default(5_000_000),
  MIN_WITHDRAWAL: z.coerce.number().positive().default(1000),
  MAX_WITHDRAWAL: z.coerce.number().positive().default(5_000_000),
  WITHDRAWAL_REVIEW_THRESHOLD: z.coerce.number().positive().default(200_000),
  WITHDRAWAL_REQUIRE_KYC: bool(true),
  WITHDRAWAL_DAILY_LIMIT: z.coerce.number().positive().default(10_000_000),

  // Odds feed (odds-api.io)
  ODDS_API_KEY: z.string().optional(),
  ODDS_API_BASE_URL: z.string().url().default('https://api.odds-api.io/v3'),
  ODDS_API_BOOKMAKERS: csv,
  ODDS_AGGREGATION: z.enum(['best', 'average', 'first']).default('average'),
  ODDS_MARGIN_PERCENT: z.coerce.number().min(0).max(30).default(0),
  ODDS_SYNC_CRON: z.string().default('*/15 * * * *'),
  AUTO_SETTLE_FROM_FEED: bool(false),

  // Background jobs
  RUN_JOBS_IN_API: bool(false),

  // Email (password reset). If SMTP_URL is unset, emails are logged instead.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Sportsbook <no-reply@example.com>'),
});

// Treat `FOO=` (empty) the same as unset, so blank lines copied from .env.example fall back to defaults.
const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
const parsed = schema.safeParse(raw);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const e = parsed.data;

if (e.NODE_ENV === 'production') {
  const problems: string[] = [];
  if (!e.PAYSTACK_SECRET_KEY) problems.push('PAYSTACK_SECRET_KEY must be set in production');
  if (e.DEMO_STARTING_BALANCE > 0) problems.push('DEMO_STARTING_BALANCE must be 0 in production');
  if (e.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
    console.warn('⚠️  Running in production with a Paystack TEST key.');
  }
  if (problems.length) {
    console.error('❌ Production configuration problems:\n   - ' + problems.join('\n   - '));
    process.exit(1);
  }
}

export const env = Object.freeze({
  ...e,
  isProduction: e.NODE_ENV === 'production',
  isTest: e.NODE_ENV === 'test',
  LOG_PRETTY: e.LOG_PRETTY === undefined ? e.NODE_ENV !== 'production' : ['true', '1', 'yes'].includes(e.LOG_PRETTY),
  paystackWebhookIps: e.PAYSTACK_WEBHOOK_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  paystackCallbackUrl: e.PAYSTACK_CALLBACK_URL || `${e.FRONTEND_URL}/wallet/deposit/callback`,
});

export type Env = typeof env;
