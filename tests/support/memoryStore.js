/** In-memory store with the same interface the reconciler uses from PgStore. */
export class MemoryStore {
  constructor() {
    this.settings = new Map();
    this.devices = [];
    this.schedules = [];
    this.overrides = new Map();
    this.states = new Map();
    this.activity = [];
    this.failNext = 0; // simulate DB outage for N calls
    this.nextId = 1;
  }

  #maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('connection terminated unexpectedly');
    }
  }

  addDevice(d) {
    const dev = {
      id: this.nextId++,
      ip_address: null,
      hostname: null,
      display_name: null,
      is_protected: false,
      restrictions_enabled: false,
      is_online: true,
      router_status: 'Allow',
      ...d,
    };
    this.devices.push(dev);
    return dev;
  }
  addSchedule(s) {
    const sch = { id: this.nextId++, enabled: true, ...s };
    this.schedules.push(sch);
    return sch;
  }

  async getSetting(k) { this.#maybeFail(); return this.settings.has(k) ? this.settings.get(k) : null; }
  async setSetting(k, v) { this.#maybeFail(); this.settings.set(k, v); }
  async listDevices() { this.#maybeFail(); return this.devices.map((d) => ({ ...d })); }
  async listSchedules() { this.#maybeFail(); return this.schedules.map((s) => ({ ...s })); }
  async listOverrides() { this.#maybeFail(); return new Map(this.overrides); }
  async deleteExpiredOverrides(now) {
    this.#maybeFail();
    const out = [];
    for (const [id, o] of this.overrides) if (new Date(o.expires_at) <= now) { out.push({ device_id: id, ...o }); this.overrides.delete(id); }
    return out;
  }
  async getRestrictionStates() { this.#maybeFail(); return new Map([...this.states].map(([k, v]) => [k, { ...v }])); }
  async saveRestrictionState(id, patch) { this.#maybeFail(); this.states.set(id, { ...(this.states.get(id) ?? {}), ...patch }); }
  async clearDryStates() {
    for (const s of this.states.values()) {
      s.dry_state = null;
      if (s.last_command?.startsWith('dry:')) s.last_command = null;
      if (s.last_result === 'dry_run') s.last_result = null;
    }
  }
  async upsertObservedDevices(list, now, reasonFor) {
    this.#maybeFail();
    const seen = new Set();
    for (const r of list) {
      seen.add(r.mac);
      let d = this.devices.find((x) => x.mac_address === r.mac);
      const reason = reasonFor({ mac_address: r.mac, ip_address: r.ip });
      if (!d) d = this.addDevice({ mac_address: r.mac });
      Object.assign(d, { ip_address: r.ip, hostname: r.name, router_status: r.allowOrBlock, is_online: true, last_seen_at: now });
      if (reason) { d.is_protected = true; d.restrictions_enabled = false; }
    }
    for (const d of this.devices) if (!seen.has(d.mac_address)) d.is_online = false;
  }
  async updateDeviceObservation(id, status, now) {
    const d = this.devices.find((x) => x.id === id);
    Object.assign(d, { router_status: status, is_online: true, last_seen_at: now });
  }
  async logActivity(e) { this.#maybeFail(); this.activity.push({ ...e, created_at: new Date() }); }
}
