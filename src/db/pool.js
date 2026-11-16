import pg from 'pg';

export function createPool(databaseUrl, logger) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'nexus-internet-scheduler',
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => logger?.error({ err: err.message }, 'PostgreSQL idle client error'));
  return pool;
}

/** Wait for PostgreSQL (it may start after us at boot). Retries with backoff up to ~5 minutes. */
export async function waitForDatabase(pool, logger, { attempts = 30 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(i, 5));
      logger?.warn({ attempt: i, err: err.message }, `PostgreSQL not reachable, retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Hold a session-level advisory lock for the life of the process so two
 * copies of the app can never run the scheduler at the same time.
 * Returns { client } on success, or { client: null, holder } describing who has it.
 */
export async function acquireInstanceLock(databaseUrl, logger) {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'nexus-internet-scheduler-lock',
    keepAlive: true, // a dead holder's connection is detected and its lock released sooner
  });
  await client.connect();
  const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('nexus-internet-scheduler')) AS ok");
  if (!rows[0].ok) {
    const info = await client
      .query(
        `SELECT pid, host(client_addr) AS client, to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS') AS since
         FROM pg_stat_activity
         WHERE application_name = 'nexus-internet-scheduler-lock' AND pid <> pg_backend_pid()
         ORDER BY backend_start LIMIT 1`,
      )
      .catch(() => ({ rows: [] }));
    await client.end();
    return { client: null, holder: info.rows[0] ?? null };
  }
  client.on('error', (err) => {
    // Lost the lock connection: exit so the supervisor restarts us cleanly.
    logger?.fatal({ err: err.message }, 'Lost database lock connection; exiting for restart');
    process.exit(1);
  });
  return { client };
}
