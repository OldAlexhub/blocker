import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply pending *.sql migrations in order, each in its own transaction. */
export async function migrate(pool, logger) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('nexus-internet-scheduler-migrate'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger?.info({ migration: file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('nexus-internet-scheduler-migrate'))").catch(() => {});
    client.release();
  }
}

// `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('../config.js');
  const { logger } = await import('../logger.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(config.databaseUrl, logger);
  try {
    await migrate(pool, logger);
    logger.info('Migrations complete');
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
