import { Client } from 'pg';

/**
 * Integration tests run against a real PostgreSQL. The test database's
 * public schema is wiped once per run; migrations are then applied fresh.
 * Unit tests don't touch the DB, so if it's unreachable only they run.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgres://betting:betting@localhost:5432/betting_test';
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    console.warn(`\n⚠️  Test database unreachable at ${url} — integration tests will fail.\n`);
    return;
  }
  if (!/test/i.test(url)) throw new Error('Refusing to wipe a database whose URL does not contain "test"');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  process.env.DATABASE_URL = url;
  process.env.JWT_ACCESS_SECRET ||= 'test_secret_that_is_long_enough_for_hs256_0123456789';
  const { runMigrations } = await import('../../src/db/migrate');
  await runMigrations(url, () => undefined);
}
