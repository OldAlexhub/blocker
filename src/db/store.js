/**
 * All SQL lives here. Parameterized queries only.
 * The reconciler depends only on the method names below, so tests use an
 * in-memory implementation with the same shape (tests/support/memoryStore.js).
 */

const DEVICE_COLUMNS = `id, mac_address, host(ip_address) AS ip_address, hostname, display_name, connection_type,
  is_protected, protected_reason, restrictions_enabled, is_online, router_status, router_status_at,
  last_seen_at, created_at, updated_at`;

const STATE_COLUMNS = new Set([
  'desired', 'desired_reason', 'app_blocked', 'last_command', 'last_command_at', 'last_result',
  'verified_state', 'verified_at', 'failure_count', 'next_attempt_at', 'dry_state',
]);

export class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  async #tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- settings ----------
  async getSetting(key) {
    const { rows } = await this.pool.query('SELECT value FROM application_settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }
  async setSetting(key, value) {
    await this.pool.query(
      `INSERT INTO application_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  // ---------- devices ----------
  async listDevices() {
    const { rows } = await this.pool.query(
      `SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY is_online DESC, COALESCE(display_name, hostname, mac_address)`,
    );
    return rows;
  }
  async getDevice(id) {
    const { rows } = await this.pool.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Merge a router device list into the table. Devices not in the list are marked offline. */
  async upsertObservedDevices(list, now, protectionReasonFor) {
    await this.#tx(async (c) => {
      for (const d of list) {
        const reason = protectionReasonFor({ mac_address: d.mac, ip_address: d.ip });
        await c.query(
          `INSERT INTO devices (mac_address, ip_address, hostname, connection_type, router_status, router_status_at,
                                is_online, last_seen_at, is_protected, protected_reason)
           VALUES ($1, $2, $3, $4, $5, $6, true, $6, $7, $8)
           ON CONFLICT (mac_address) DO UPDATE SET
             ip_address = COALESCE(EXCLUDED.ip_address, devices.ip_address),
             hostname = COALESCE(EXCLUDED.hostname, devices.hostname),
             connection_type = COALESCE(EXCLUDED.connection_type, devices.connection_type),
             router_status = EXCLUDED.router_status,
             router_status_at = EXCLUDED.router_status_at,
             is_online = true,
             last_seen_at = EXCLUDED.last_seen_at,
             is_protected = devices.is_protected OR EXCLUDED.is_protected,
             restrictions_enabled = devices.restrictions_enabled AND NOT EXCLUDED.is_protected,
             protected_reason = COALESCE(devices.protected_reason, EXCLUDED.protected_reason),
             updated_at = now()`,
          [d.mac, d.ip || null, d.name || null, d.connectionType || null, d.allowOrBlock, now, !!reason, reason],
        );
      }
      await c.query(
        `UPDATE devices SET is_online = false, updated_at = now()
         WHERE is_online AND NOT (mac_address = ANY($1::text[]))`,
        [list.map((d) => d.mac)],
      );
    });
  }

  /** Record what the router reported for one device right after a command. */
  async updateDeviceObservation(deviceId, routerStatus, now) {
    await this.pool.query(
      `UPDATE devices SET router_status = $2, router_status_at = $3, is_online = true, last_seen_at = $3, updated_at = now()
       WHERE id = $1`,
      [deviceId, routerStatus, now],
    );
  }

  async updateDevice(id, patch) {
    if (patch.is_protected === true) patch = { ...patch, restrictions_enabled: false }; // same statement: satisfies CHECK
    const sets = [];
    const params = [id];
    for (const col of ['display_name', 'restrictions_enabled', 'is_protected']) {
      if (patch[col] !== undefined) {
        params.push(patch[col]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) return this.getDevice(id);
    return this.#tx(async (c) => {
      await c.query(`UPDATE devices SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      if (patch.is_protected === true) {
        await c.query('DELETE FROM schedule_devices WHERE device_id = $1', [id]);
        await c.query('DELETE FROM device_overrides WHERE device_id = $1', [id]);
      }
      const { rows } = await c.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
  }

  async deleteDevice(id) {
    await this.pool.query('DELETE FROM devices WHERE id = $1', [id]);
  }

  // ---------- schedules ----------
  async listSchedules() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.name, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time,
              s.days_of_week, s.enabled, s.created_at, s.updated_at,
              COALESCE(array_agg(sd.device_id ORDER BY sd.device_id) FILTER (WHERE sd.device_id IS NOT NULL), '{}') AS device_ids
       FROM schedules s LEFT JOIN schedule_devices sd ON sd.schedule_id = s.id
       GROUP BY s.id ORDER BY s.start_time, s.id`,
    );
    return rows;
  }

  async createSchedule(v) {
    return this.#tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO schedules (name, start_time, end_time, days_of_week, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [v.name, v.start_time, v.end_time, v.days_of_week, v.enabled],
      );
      const id = rows[0].id;
      await c.query(
        'INSERT INTO schedule_devices (schedule_id, device_id) SELECT $1, unnest($2::int[])',
        [id, v.device_ids],
      );
      return id;
    });
  }

  async updateSchedule(id, v) {
    return this.#tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE schedules SET name = $2, start_time = $3, end_time = $4, days_of_week = $5, enabled = $6, updated_at = now()
         WHERE id = $1`,
        [id, v.name, v.start_time, v.end_time, v.days_of_week, v.enabled],
      );
      if (!rowCount) return false;
      await c.query('DELETE FROM schedule_devices WHERE schedule_id = $1', [id]);
      await c.query('INSERT INTO schedule_devices (schedule_id, device_id) SELECT $1, unnest($2::int[])', [id, v.device_ids]);
      return true;
    });
  }

  async setScheduleEnabled(id, enabled) {
    const { rowCount } = await this.pool.query('UPDATE schedules SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
    return rowCount > 0;
  }

  async deleteSchedule(id) {
    const { rowCount } = await this.pool.query('DELETE FROM schedules WHERE id = $1', [id]);
    return rowCount > 0;
  }

  // ---------- overrides ----------
  async listOverrides() {
    const { rows } = await this.pool.query('SELECT device_id, override_type, expires_at FROM device_overrides');
    return new Map(rows.map((r) => [r.device_id, r]));
  }
  async setOverride(deviceId, type, expiresAt) {
    await this.pool.query(
      `INSERT INTO device_overrides (device_id, override_type, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE SET override_type = EXCLUDED.override_type, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [deviceId, type, expiresAt],
    );
  }
  async deleteOverride(deviceId) {
    const { rows } = await this.pool.query('DELETE FROM device_overrides WHERE device_id = $1 RETURNING *', [deviceId]);
    return rows[0] ?? null;
  }
  async deleteExpiredOverrides(now) {
    const { rows } = await this.pool.query('DELETE FROM device_overrides WHERE expires_at <= $1 RETURNING *', [now]);
    return rows;
  }

  // ---------- restriction state ----------
  async getRestrictionStates() {
    const { rows } = await this.pool.query('SELECT * FROM restriction_state');
    return new Map(rows.map((r) => [r.device_id, r]));
  }
  async saveRestrictionState(deviceId, patch) {
    const cols = Object.keys(patch).filter((k) => STATE_COLUMNS.has(k));
    if (!cols.length) return;
    const values = cols.map((k) => patch[k]);
    await this.pool.query(
      `INSERT INTO restriction_state (device_id, ${cols.join(', ')}, updated_at)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, now())
       ON CONFLICT (device_id) DO UPDATE SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`,
      [deviceId, ...values],
    );
  }
  async clearDryStates() {
    await this.pool.query(
      `UPDATE restriction_state SET dry_state = NULL,
         last_command = CASE WHEN last_command LIKE 'dry:%' THEN NULL ELSE last_command END,
         last_result = CASE WHEN last_result = 'dry_run' THEN NULL ELSE last_result END,
         updated_at = now()`,
    );
  }

  // ---------- activity ----------
  async logActivity({ device_id = null, action, trigger, result, detail = null }) {
    await this.pool.query(
      `INSERT INTO activity_logs (device_id, device_label, action, trigger, result, detail)
       VALUES ($1, (SELECT COALESCE(display_name, hostname, mac_address) FROM devices WHERE id = $1), $2, $3, $4, $5)`,
      [device_id, action, trigger, result, detail],
    );
  }
  async listActivity(limit = 100) {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.created_at, a.device_id, COALESCE(d.display_name, d.hostname, a.device_label) AS device_label,
              a.action, a.trigger, a.result, a.detail
       FROM activity_logs a LEFT JOIN devices d ON d.id = a.device_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
