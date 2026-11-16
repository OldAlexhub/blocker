import session from 'express-session';

/** Minimal PostgreSQL session store (sessions survive restarts; no extra dependency). */
export class PgSessionStore extends session.Store {
  constructor(pool, logger) {
    super();
    this.pool = pool;
    this.timer = setInterval(() => {
      pool.query('DELETE FROM sessions WHERE expire < now()').catch((err) => logger?.warn({ err: err.message }, 'Session prune failed'));
    }, 15 * 60_000);
    this.timer.unref();
  }

  #expiry(sess) {
    const e = sess?.cookie?.expires;
    return e ? new Date(e) : new Date(Date.now() + 12 * 3600_000);
  }

  get(sid, cb) {
    this.pool
      .query('SELECT sess FROM sessions WHERE sid = $1 AND expire > now()', [sid])
      .then((r) => cb(null, r.rows[0]?.sess ?? null), cb);
  }

  set(sid, sess, cb) {
    this.pool
      .query(
        `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify(sess), this.#expiry(sess)],
      )
      .then(() => cb?.(null), cb);
  }

  touch(sid, sess, cb) {
    this.pool.query('UPDATE sessions SET expire = $2 WHERE sid = $1', [sid, this.#expiry(sess)]).then(() => cb?.(null), cb);
  }

  destroy(sid, cb) {
    this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => cb?.(null), cb);
  }
}
