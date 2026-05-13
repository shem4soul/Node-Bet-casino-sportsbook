/**
 * Runs schema.sql and seed.sql against the configured MySQL server.
 * Usage: npm run db:init
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

async function run(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('Applying schema...');
    await connection.query(schema);

    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    console.log('Applying seed data...');
    await connection.query(seed);

    console.log('Database initialized successfully.');
  } finally {
    await connection.end();
  }
}

run().catch((err) => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
