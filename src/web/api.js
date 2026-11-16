import express from 'express';
import { evaluateDevice, isScheduleActive, nextScheduleChange, validateSchedule, isOvernight } from '../core/engine.js';
import { isRandomizedMac } from '../core/mac.js';

const OVERRIDE_MINUTES = new Set([15, 30, 60, 120, 240, 480, 720, 1440]);

const httpError = (status, message) => Object.assign(new Error(message), { status });

function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid id');
  return n;
}

export function apiRouter({ config, store, reconciler, protection, logger }) {
  const r = express.Router();
  const tz = config.timezone;

  // ---------- full dashboard state ----------
  r.get('/state', async (_req, res) => {
    const now = new Date();
    const [devices, schedules, overrides, states, activity, armed] = await Promise.all([
      store.listDevices(),
      store.listSchedules(),
      store.listOverrides(),
      store.getRestrictionStates(),
      store.listActivity(100),
      reconciler.isArmed(),
    ]);
    const deviceOut = devices.map((d) => {
      const rs = states.get(d.id) ?? {};
      const own = schedules.filter((s) => s.device_ids.includes(d.id));
      const isProt = protection.isProtected(d);
      const ov = overrides.get(d.id);
      const ev = evaluateDevice({ device: d, schedules: own, override: ov, appBlocked: !!rs.app_blocked, now, timezone: tz, isProtected: isProt });
      return {
        ...d,
        protected: isProt,
        protected_reason: protection.reasonFor(d) ?? d.protected_reason ?? (d.is_protected ? 'Marked protected' : null),
        auto_protected: protection.reasonFor(d) !== null,
        randomized_mac: isRandomizedMac(d.mac_address),
        desired: ev.state,
        desired_reason: ev.reason,
        active_schedules: ev.active,
        override: ov && new Date(ov.expires_at) > now ? { type: ov.override_type, expires_at: ov.expires_at } : null,
        app_blocked: !!rs.app_blocked,
        last_command: rs.last_command ?? null,
        last_command_at: rs.last_command_at ?? null,
        last_result: rs.last_result ?? null,
        dry_state: rs.dry_state ?? null,
        next_attempt_at: rs.next_attempt_at ?? null,
        schedule_count: own.length,
        next_change: !isProt && own.some((s) => s.enabled) ? nextScheduleChange(own, now, tz) : null,
      };
    });
    res.json({
      now,
      status: {
        ...reconciler.status,
        armed,
        dryRun: config.dryRun,
        schedulerEnabled: config.schedulerEnabled,
        timezone: tz,
        routerHost: config.routerHost,
        adapter: config.routerAdapter,
      },
      devices: deviceOut,
      schedules: schedules.map((s) => ({ ...s, overnight: isOvernight(s), active_now: s.enabled && isScheduleActive(s, now, tz) })),
      activity,
    });
  });

  // ---------- devices ----------
  r.post('/devices/refresh', async (_req, res) => {
    await reconciler.tick({ forcePoll: true, trigger: 'manual' });
    res.json({ ok: !reconciler.status.routerError, error: reconciler.status.routerError });
  });

  r.patch('/devices/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const device = await store.getDevice(id);
    if (!device) throw httpError(404, 'Device not found');
    const patch = {};
    if (req.body.display_name !== undefined) {
      const name = String(req.body.display_name ?? '').trim();
      if (name.length > 60) throw httpError(400, 'Name too long (max 60)');
      patch.display_name = name || null;
    }
    if (req.body.is_protected !== undefined) {
      const v = req.body.is_protected === true;
      if (!v && protection.reasonFor(device)) throw httpError(403, `Cannot unprotect: ${protection.reasonFor(device)}`);
      patch.is_protected = v;
    }
    if (req.body.restrictions_enabled !== undefined) {
      const v = req.body.restrictions_enabled === true;
      const willBeProtected = patch.is_protected ?? protection.isProtected(device);
      if (v && willBeProtected) throw httpError(403, 'Protected devices cannot be restricted');
      patch.restrictions_enabled = v;
    }
    const updated = await store.updateDevice(id, patch);
    const changes = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ');
    await store.logActivity({ device_id: id, action: 'device_updated', trigger: 'manual', result: 'info', detail: changes });
    if (patch.restrictions_enabled !== undefined || patch.is_protected !== undefined) await reconciler.tick({ trigger: 'manual' });
    res.json({ ok: true, device: updated });
  });

  r.delete('/devices/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const device = await store.getDevice(id);
    if (!device) throw httpError(404, 'Device not found');
    const rs = (await store.getRestrictionStates()).get(id);
    if (device.is_online) throw httpError(409, 'Only offline devices can be removed');
    if (rs?.app_blocked) throw httpError(409, 'The app blocked this device; restore it before removing');
    await store.deleteDevice(id);
    await store.logActivity({ action: 'device_removed', trigger: 'manual', result: 'info', detail: device.display_name ?? device.hostname ?? device.mac_address });
    res.json({ ok: true });
  });

  // ---------- manual overrides ("Block now" / "Restore now") ----------
  r.post('/devices/:id/override', async (req, res) => {
    const id = parseId(req.params.id);
    const device = await store.getDevice(id);
    if (!device) throw httpError(404, 'Device not found');
    const type = req.body.type;
    if (!['block', 'allow'].includes(type)) throw httpError(400, 'type must be "block" or "allow"');
    if (type === 'block' && protection.isProtected(device)) throw httpError(403, 'This device is protected and can never be blocked');

    const now = new Date();
    let expiresAt;
    if (req.body.duration === 'next') {
      const own = (await store.listSchedules()).filter((s) => s.device_ids.includes(id));
      expiresAt = nextScheduleChange(own, now, tz);
      if (!expiresAt) throw httpError(400, 'No upcoming schedule change for this device - choose a fixed duration');
    } else {
      const minutes = Number(req.body.duration);
      if (!OVERRIDE_MINUTES.has(minutes)) throw httpError(400, 'Invalid duration');
      expiresAt = new Date(now.getTime() + minutes * 60_000);
    }
    await store.setOverride(id, type, expiresAt);
    await store.logActivity({
      device_id: id,
      action: type === 'block' ? 'override_block' : 'override_allow',
      trigger: 'manual',
      result: 'info',
      detail: `Manual ${type === 'block' ? 'block' : 'restore'} until ${expiresAt.toISOString()}`,
    });
    await reconciler.tick({ forcePoll: true, trigger: 'manual' });
    const rs = (await store.getRestrictionStates()).get(id);
    res.json({ ok: true, armed: await reconciler.isArmed(), result: rs?.last_result ?? null, expires_at: expiresAt });
  });

  r.delete('/devices/:id/override', async (req, res) => {
    const id = parseId(req.params.id);
    const removed = await store.deleteOverride(id);
    if (removed) {
      await store.logActivity({ device_id: id, action: 'override_cleared', trigger: 'manual', result: 'info', detail: 'Manual override cleared; schedules apply again' });
      await reconciler.tick({ forcePoll: true, trigger: 'manual' });
    }
    res.json({ ok: true });
  });

  // ---------- schedules ----------
  async function checkScheduleDevices(ids) {
    const devices = await store.listDevices();
    for (const id of ids) {
      const d = devices.find((x) => x.id === id);
      if (!d) throw httpError(400, `Device ${id} does not exist`);
      if (protection.isProtected(d)) throw httpError(403, `${d.display_name ?? d.hostname ?? d.mac_address} is protected and cannot be scheduled`);
    }
    return devices;
  }

  async function enableRestrictions(ids, devices) {
    for (const id of ids) {
      const d = devices.find((x) => x.id === id);
      if (d && !d.restrictions_enabled) await store.updateDevice(id, { restrictions_enabled: true });
    }
  }

  r.post('/schedules', async (req, res) => {
    const { errors, value } = validateSchedule(req.body);
    if (errors.length) throw httpError(400, errors.join(' '));
    const devices = await checkScheduleDevices(value.device_ids);
    const id = await store.createSchedule(value);
    await enableRestrictions(value.device_ids, devices);
    await store.logActivity({ action: 'schedule_created', trigger: 'manual', result: 'info', detail: `${value.name}: ${value.start_time}-${value.end_time}` });
    await reconciler.tick({ trigger: 'manual' });
    res.status(201).json({ ok: true, id });
  });

  r.put('/schedules/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { errors, value } = validateSchedule(req.body);
    if (errors.length) throw httpError(400, errors.join(' '));
    const devices = await checkScheduleDevices(value.device_ids);
    if (!(await store.updateSchedule(id, value))) throw httpError(404, 'Schedule not found');
    await enableRestrictions(value.device_ids, devices);
    await store.logActivity({ action: 'schedule_updated', trigger: 'manual', result: 'info', detail: `${value.name}: ${value.start_time}-${value.end_time}` });
    await reconciler.tick({ trigger: 'manual' });
    res.json({ ok: true });
  });

  r.post('/schedules/:id/enabled', async (req, res) => {
    const id = parseId(req.params.id);
    const enabled = req.body.enabled === true;
    if (!(await store.setScheduleEnabled(id, enabled))) throw httpError(404, 'Schedule not found');
    await store.logActivity({ action: enabled ? 'schedule_enabled' : 'schedule_disabled', trigger: 'manual', result: 'info', detail: `Schedule #${id}` });
    await reconciler.tick({ trigger: 'manual' });
    res.json({ ok: true });
  });

  r.delete('/schedules/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!(await store.deleteSchedule(id))) throw httpError(404, 'Schedule not found');
    await store.logActivity({ action: 'schedule_deleted', trigger: 'manual', result: 'info', detail: `Schedule #${id}` });
    await reconciler.tick({ trigger: 'manual' });
    res.json({ ok: true });
  });

  // ---------- router control safety gate ----------
  r.post('/control/check', async (_req, res) => {
    res.json(await reconciler.checkRouter());
  });

  r.post('/control/arm', async (req, res) => {
    if (config.dryRun) throw httpError(409, 'DRY_RUN=true in .env. Set DRY_RUN=false and restart the app to allow router changes.');
    if (req.body.confirm !== 'ARM') throw httpError(400, 'Type ARM to confirm');
    const check = await reconciler.checkRouter();
    if (!check.ok) throw httpError(503, `Router check failed: ${check.error}`);
    if (check.accessControlEnabled === false) {
      throw httpError(409, 'Access Control is OFF on the router (ADVANCED > Security > Access Control). Turn it on with "Allow all new devices", then try again.');
    }
    await reconciler.arm();
    logger.warn('Router control ARMED by operator');
    await reconciler.tick({ forcePoll: true, trigger: 'manual' });
    res.json({ ok: true, accessControlEnabled: check.accessControlEnabled });
  });

  r.post('/control/disarm', async (_req, res) => {
    const results = await reconciler.disarm();
    logger.warn('Router control disarmed by operator');
    res.json({ ok: true, restored: results });
  });

  return r;
}
