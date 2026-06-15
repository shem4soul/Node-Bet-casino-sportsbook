/**
 * Minimal, dependency-free SQL migration runner.
 *
 *   npm run db:migrate          (dev, via tsx)
 *   node dist/db/migrate.js     (prod / Docker)
 *
 * Applies every `migrations/NNN_name.sql` file that hasn't been applied yet,
 * in filename order, each inside its own transaction, and records it in
 * `schema_migrations` with a checksum. A cluster-wide advisory lock makes it
 * safe to run from several replicas at once (only one applies migrations).
 * Edited-after-apply migrations are detected and refused.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { env } from '../config/env';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 727_001;

export async function runMigrations(databaseUrl = env.DATABASE_URL, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new Client({
    connectionString: databaseUrl,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        }
        continue;
      }

      log(`→ applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    log(applied.length ? `✔ applied ${applied.length} migration(s)` : '✔ database schema is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('✖ migration failed:', err.message);
    process.exit(1);
  });
}
