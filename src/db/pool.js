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
 * Session-level PostgreSQL advisory lock that guarantees only ONE process runs
 * the scheduler, even while a deploy briefly runs the old and new versions side
 * by side. The process that does not hold the lock stays in standby (dashboard
 * up, no router commands) and keeps retrying until the holder stops.
 */
export class InstanceLock {
  #client = null;
  #stopped = false;
  held = false;

  constructor(databaseUrl, logger) {
    this.databaseUrl = databaseUrl;
    this.logger = logger;
  }

  async #connect() {
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      application_name: 'nexus-internet-scheduler-lock',
      keepAlive: true, // a dead holder's connection is detected and its lock released sooner
    });
    client.on('error', (err) => {
      if (this.held && !this.#stopped) {
        // Lost the lock: another instance may take over, so stop scheduling now.
        this.logger?.fatal({ err: err.message }, 'Lost database lock connection; exiting for restart');
        process.exit(1);
      }
      this.#client = null;
    });
    await client.connect();
    this.#client = client;
  }

  /** One attempt. Returns true if this process now holds the lock. */
  async tryAcquire() {
    if (this.held) return true;
    if (!this.#client) await this.#connect();
    const { rows } = await this.#client.query("SELECT pg_try_advisory_lock(hashtext('nexus-internet-scheduler')) AS ok");
    this.held = rows[0].ok === true;
    return this.held;
  }

  /** Who currently holds the lock (best effort, for log messages). */
  async holder() {
    try {
      if (!this.#client) await this.#connect();
      const { rows } = await this.#client.query(
        `SELECT pid, host(client_addr) AS client, to_char(backend_start, 'YYYY-MM-DD HH24:MI:SS') AS since
         FROM pg_stat_activity
         WHERE application_name = 'nexus-internet-scheduler-lock' AND pid <> pg_backend_pid()
         ORDER BY backend_start LIMIT 1`,
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Retry until acquired (resolves true) or release() is called (resolves false). */
  async waitUntilAcquired(intervalMs = 5000) {
    while (!this.#stopped) {
      try {
        if (await this.tryAcquire()) return true;
      } catch (err) {
        this.logger?.warn({ err: err.message }, 'Instance lock check failed; retrying');
        await this.#client?.end().catch(() => {});
        this.#client = null;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  async release() {
    this.#stopped = true;
    const c = this.#client;
    this.#client = null;
    this.held = false;
    await c?.end().catch(() => {}); // closing the session releases the advisory lock
  }
}
