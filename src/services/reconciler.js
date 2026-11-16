import { evaluateDevice } from '../core/engine.js';

const TARGET = { block: 'Block', allow: 'Allow' };
const MAX_BACKOFF_MIN = 30;

/**
 * The reconciler is the only component that changes router state.
 *
 * Every tick (once a minute, plus on startup and after manual actions) it:
 *   1. expires manual overrides,
 *   2. re-reads the router device list (every ROUTER_POLL_MINUTES, or when an action is pending),
 *   3. computes the desired state of every device from schedules + overrides,
 *   4. compares desired vs. what the router last REPORTED, and
 *   5. sends only the commands needed, then re-reads the router to verify.
 *
 * Because it compares levels instead of reacting to cron edges, missed
 * ticks, app restarts, Windows restarts and router reboots all self-heal on
 * the next tick.
 *
 * Nothing is sent to the router unless the app is ARMED (DRY_RUN=false and
 * the operator confirmed on the dashboard). Otherwise actions are simulated
 * and logged as dry_run.
 */
export class Reconciler {
  #chain = Promise.resolve();
  #pending = 0;

  constructor({
    store,
    router,
    protection,
    logger,
    timezone,
    dryRun = true,
    schedulerEnabled = true,
    pollMinutes = 5,
    verifyDelayMs = 2500,
    now = () => new Date(),
  }) {
    Object.assign(this, { store, router, protection, logger, timezone, dryRun, schedulerEnabled, pollMinutes, verifyDelayMs, now });
    this.status = {
      lastTickAt: null,
      lastPollAt: null,
      lastRouterOkAt: null,
      routerError: null,
      routerFailures: 0,
      nextRouterAttemptAt: null,
      accessControlEnabled: null,
      lastError: null,
    };
  }

  // ---------------- public API ----------------

  /**
   * Queue a reconciliation pass. Cron ticks are dropped if a pass is already queued.
   * Never rejects: failures (e.g. database outage) are logged and recorded in
   * status.lastError, and the next tick retries from scratch.
   */
  tick({ forcePoll = false, trigger = 'schedule' } = {}) {
    if (trigger === 'schedule' && this.#pending > 0) return this.#chain;
    return this.#exclusive(async () => {
      await this.#run({ forcePoll, trigger });
      this.status.lastError = null;
    }).catch(() => {});
  }

  /** Wait until all queued work is finished. */
  idle() {
    return this.#chain;
  }

  async isArmed() {
    if (this.dryRun) return false;
    return (await this.store.getSetting('control_armed')) === true;
  }

  /** Read-only router check used before arming. */
  checkRouter() {
    return this.#exclusive(async () => {
      try {
        const info = await this.router.healthCheck();
        let accessControlEnabled = null;
        try {
          accessControlEnabled = await this.router.getAccessControlEnabled();
        } catch {
          /* unknown */
        }
        this.status.accessControlEnabled = accessControlEnabled;
        return { ok: true, info, accessControlEnabled };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  arm() {
    return this.#exclusive(async () => {
      if (this.dryRun) throw new Error('DRY_RUN=true - router changes are disabled in .env');
      await this.store.clearDryStates();
      await this.store.setSetting('control_armed', true);
      await this.#log({ action: 'armed', trigger: 'manual', result: 'info', detail: 'Router control armed by operator' });
    });
  }

  /** Restore every device the app blocked, then stop sending router commands. */
  disarm() {
    return this.#exclusive(async () => {
      const results = [];
      if (await this.isArmed()) {
        const polled = await this.#poll(this.now());
        if (!polled) throw new Error('Router unreachable - cannot restore blocked devices. Use the manual recovery steps in the README.');
        const states = await this.store.getRestrictionStates();
        for (const d of await this.store.listDevices()) {
          if (!states.get(d.id)?.app_blocked) continue;
          results.push({ device: d.id, result: await this.#execute({ device: d, action: 'allow', reason: 'disarm', active: [] }, this.now()) });
        }
      }
      await this.store.setSetting('control_armed', false);
      await this.#log({ action: 'disarmed', trigger: 'manual', result: 'info', detail: `Router control disarmed; ${results.length} device(s) restored` });
      return results;
    });
  }

  // ---------------- internals ----------------

  #exclusive(fn) {
    this.#pending++;
    const run = this.#chain.then(fn).finally(() => this.#pending--);
    this.#chain = run.catch((err) => {
      this.status.lastError = err.message;
      this.logger?.error({ err: err.message }, 'Reconciliation failed');
    });
    return run;
  }

  async #log(entry) {
    try {
      await this.store.logActivity(entry);
    } catch (err) {
      this.logger?.error({ err: err.message, entry }, 'Could not write activity log');
    }
  }

  #pollDue(now) {
    return !this.status.lastPollAt || now - new Date(this.status.lastPollAt) >= this.pollMinutes * 60_000;
  }

  #routerAvailable(now) {
    return !this.status.nextRouterAttemptAt || now >= new Date(this.status.nextRouterAttemptAt);
  }

  async #poll(now) {
    try {
      const devices = await this.router.getConnectedDevices();
      await this.store.upsertObservedDevices(devices, now, (d) => this.protection.reasonFor(d));
      try {
        this.status.accessControlEnabled = await this.router.getAccessControlEnabled();
      } catch {
        this.status.accessControlEnabled = null;
      }
      if (this.status.routerFailures > 0) {
        await this.#log({ action: 'router_recovered', trigger: 'system', result: 'info', detail: `Router reachable again after ${this.status.routerFailures} failed attempt(s)` });
      }
      Object.assign(this.status, {
        lastPollAt: now.toISOString(),
        lastRouterOkAt: now.toISOString(),
        routerError: null,
        routerFailures: 0,
        nextRouterAttemptAt: null,
      });
      return true;
    } catch (err) {
      const failures = this.status.routerFailures + 1;
      const backoffMin = Math.min(MAX_BACKOFF_MIN, 2 ** (failures - 1));
      Object.assign(this.status, {
        routerError: err.message,
        routerFailures: failures,
        nextRouterAttemptAt: new Date(now.getTime() + backoffMin * 60_000).toISOString(),
      });
      this.logger?.warn({ err: err.message, failures, backoffMin }, 'Router poll failed');
      if (failures === 1 || failures % 10 === 0) {
        await this.#log({ action: 'router_unreachable', trigger: 'system', result: 'failed', detail: `${err.message} (retry in ${backoffMin} min)` });
      }
      return false;
    }
  }

  async #plan(now, armed) {
    const [devices, schedules, overrides, states] = await Promise.all([
      this.store.listDevices(),
      this.store.listSchedules(),
      this.store.listOverrides(),
      this.store.getRestrictionStates(),
    ]);
    const plans = [];
    for (const device of devices) {
      const rs = states.get(device.id) ?? {};
      const ev = evaluateDevice({
        device,
        schedules: schedules.filter((s) => s.device_ids.includes(device.id)),
        override: overrides.get(device.id),
        appBlocked: !!rs.app_blocked,
        now,
        timezone: this.timezone,
        isProtected: this.protection.isProtected(device),
      });
      if (ev.state === null) continue;
      if (rs.desired !== ev.state || rs.desired_reason !== ev.reason) {
        await this.store.saveRestrictionState(device.id, { desired: ev.state, desired_reason: ev.reason });
      }
      // Automatic schedule BLOCKS are suppressed when the scheduler is off; restores are always allowed.
      if (!this.schedulerEnabled && ev.state === 'block' && ev.reason === 'schedule') continue;
      if (rs.next_attempt_at && new Date(rs.next_attempt_at) > now) continue; // per-device backoff after failures

      const routerView = device.is_online ? device.router_status ?? null : null;
      const observed = armed ? routerView : rs.dry_state ?? routerView;

      if (armed && ev.state === 'allow' && observed === 'Allow' && rs.app_blocked) {
        await this.store.saveRestrictionState(device.id, { app_blocked: false });
      }
      if (observed === TARGET[ev.state]) continue;

      if (observed === null) {
        // Router does not list the device (offline). Do not spam it with commands.
        if (ev.state === 'allow' && !rs.app_blocked) continue;
        const cmd = armed ? ev.state : `dry:${ev.state}`;
        if (rs.last_command === cmd && rs.last_result !== 'failed') continue;
      }
      plans.push({ device, action: ev.state, reason: ev.reason, active: ev.active });
    }
    return plans;
  }

  async #run({ forcePoll, trigger }) {
    const now = this.now();
    this.status.lastTickAt = now.toISOString();
    const armed = await this.isArmed();

    for (const o of await this.store.deleteExpiredOverrides(now)) {
      await this.#log({ device_id: o.device_id, action: 'override_expired', trigger: 'override', result: 'info', detail: `Manual ${o.override_type} override expired` });
    }

    let polled = false;
    if (this.#routerAvailable(now) && (forcePoll || this.#pollDue(now))) polled = await this.#poll(now);

    let plans = await this.#plan(now, armed);
    if (plans.length && armed && !polled && this.#routerAvailable(now)) {
      // Never act on a stale view of the router.
      polled = await this.#poll(now);
      plans = await this.#plan(now, armed);
    }

    for (const plan of plans) {
      if (!armed) await this.#dryRun(plan, now);
      else if (polled) await this.#execute(plan, now);
    }
    if (trigger === 'startup') {
      await this.#log({ action: 'startup_reconcile', trigger: 'startup', result: 'info', detail: `${plans.length} action(s) needed after start (${armed ? 'armed' : 'dry-run'})` });
    }
  }

  #triggerFor(reason) {
    if (reason === 'override') return 'manual';
    if (reason === 'schedule' || reason === 'schedule-idle') return 'schedule';
    if (reason === 'disarm') return 'manual';
    return 'reconcile';
  }

  #describe(plan) {
    const why = {
      schedule: `schedule: ${plan.active.join(', ')}`,
      'schedule-idle': 'no schedule active',
      override: 'manual override',
      'protected-restore': 'device is protected',
      'unmanaged-restore': 'restrictions disabled for device',
      disarm: 'router control disarmed',
    }[plan.reason] ?? plan.reason;
    return why;
  }

  async #dryRun(plan, now) {
    const { device, action } = plan;
    await this.store.saveRestrictionState(device.id, {
      dry_state: TARGET[action],
      last_command: `dry:${action}`,
      last_command_at: now,
      last_result: 'dry_run',
    });
    await this.#log({
      device_id: device.id,
      action: action === 'block' ? 'block' : 'restore',
      trigger: this.#triggerFor(plan.reason),
      result: 'dry_run',
      detail: `Would ${action === 'block' ? 'block' : 'restore'} (${this.#describe(plan)}). No command sent.`,
    });
  }

  /** Send one command, then verify by re-reading the router. Returns the result label. */
  async #execute(plan, now) {
    const { device, action } = plan;
    const trigger = this.#triggerFor(plan.reason);
    const label = action === 'block' ? 'block' : 'restore';

    if (action === 'block' && this.protection.isProtected(device)) {
      await this.#log({ device_id: device.id, action: label, trigger, result: 'skipped', detail: 'Refused: device is protected' });
      return 'skipped';
    }

    await this.store.saveRestrictionState(device.id, { last_command: action, last_command_at: now, last_result: 'requested' });
    try {
      if (action === 'block') await this.router.blockDevice(device.mac_address);
      else await this.router.unblockDevice(device.mac_address);
    } catch (err) {
      return this.#fail(device, label, trigger, `Command failed: ${err.message}`, now);
    }
    if (action === 'block') await this.store.saveRestrictionState(device.id, { app_blocked: true });

    if (this.verifyDelayMs) await new Promise((r) => setTimeout(r, this.verifyDelayMs));
    let observed;
    try {
      observed = await this.router.getDeviceRestrictionState(device.mac_address);
    } catch (err) {
      observed = undefined;
      this.logger?.warn({ err: err.message }, 'Verification read failed');
    }
    const at = this.now();
    if (observed === TARGET[action]) {
      await this.store.updateDeviceObservation(device.id, observed, at);
      await this.store.saveRestrictionState(device.id, {
        last_result: 'verified',
        verified_state: observed,
        verified_at: at,
        failure_count: 0,
        next_attempt_at: null,
        ...(action === 'allow' ? { app_blocked: false } : {}),
      });
      await this.#log({ device_id: device.id, action: label, trigger, result: 'verified', detail: `Router reports ${observed} (${this.#describe(plan)})` });
      return 'verified';
    }
    if (observed === null || observed === undefined) {
      await this.store.saveRestrictionState(device.id, { last_result: 'unverified', failure_count: 0, next_attempt_at: null });
      await this.#log({
        device_id: device.id,
        action: label,
        trigger,
        result: 'unverified',
        detail: observed === null
          ? `Command accepted, but the router does not list this device (offline), so the result cannot be confirmed (${this.#describe(plan)})`
          : `Command accepted, but the verification read failed (${this.#describe(plan)})`,
      });
      return 'unverified';
    }
    await this.store.updateDeviceObservation(device.id, observed, at);
    return this.#fail(device, label, trigger, `Router still reports ${observed} after the command`, now);
  }

  async #fail(device, label, trigger, detail, now) {
    const states = await this.store.getRestrictionStates();
    const failures = (states.get(device.id)?.failure_count ?? 0) + 1;
    const backoffMin = Math.min(MAX_BACKOFF_MIN, 2 ** (failures - 1));
    await this.store.saveRestrictionState(device.id, {
      last_result: 'failed',
      failure_count: failures,
      next_attempt_at: new Date(now.getTime() + backoffMin * 60_000),
    });
    await this.#log({ device_id: device.id, action: label, trigger, result: 'failed', detail: `${detail}. Retrying in ${backoffMin} min.` });
    return 'failed';
  }
}
