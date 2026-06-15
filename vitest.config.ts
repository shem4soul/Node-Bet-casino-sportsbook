import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    // Integration tests share one database and the fake Paystack port: run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://betting:betting@localhost:5432/betting_test',
      JWT_ACCESS_SECRET: 'test_secret_that_is_long_enough_for_hs256_0123456789',
      BCRYPT_ROUNDS: '4',
      PAYSTACK_SECRET_KEY: 'sk_test_fake_secret_for_tests',
      PAYSTACK_BASE_URL: 'http://127.0.0.1:45999',
      PAYSTACK_TIMEOUT_MS: '3000',
      MIN_STAKE: '100',
      MIN_DEPOSIT: '100',
      MIN_WITHDRAWAL: '1000',
      WITHDRAWAL_REVIEW_THRESHOLD: '200000',
      CASHOUT_MARGIN_PERCENT: '5',
      LOG_LEVEL: 'silent',
      // Pin values a developer's local .env might otherwise leak into tests.
      DEMO_STARTING_BALANCE: '0',
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD: '',
      ODDS_API_KEY: 'test-odds-key',
      ODDS_API_BASE_URL: 'http://127.0.0.1:45998',
      ODDS_AGGREGATION: 'average',
      ODDS_MARGIN_PERCENT: '0',
      RUN_JOBS_IN_API: 'false',
      WITHDRAWAL_REQUIRE_KYC: 'true',
      PAYSTACK_VERIFY_ON_WEBHOOK: 'true',
      PAYSTACK_ENFORCE_IP_WHITELIST: 'false',
    },
  },
});
