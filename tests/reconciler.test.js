import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler } from '../src/services/reconciler.js';
import { MockRouterAdapter } from '../src/router/mockAdapter.js';
import { Protection } from '../src/core/protection.js';
import { MemoryStore } from './support/memoryStore.js';

const TZ = 'America/New_York';
const KID = '02:11:22:33:44:01';
const TABLET = '02:11:22:33:44:02';
const SERVER = '00:1A:2B:3C:4D:5E';

function setup({ armed = true, dryRun = false, schedulerEnabled = true, at = '2026-01-05T22:00:00-05:00' } = {}) {
  const store = new MemoryStore();
  const protection = new Protection({ macs: [{ mac: SERVER, reason: 'This server (Nexus)' }], ips: [{ ip: '192.168.0.1', reason: 'Router' }] });
  const router = new MockRouterAdapter({
    isProtectedMac: (m) => protection.isProtectedMac(m),
    devices: [
      { mac: KID, ip: '192.168.0.20', name: 'Kids-PC' },
      { mac: TABLET, ip: '192.168.0.21', name: 'Tablet' },
      { mac: SERVER, ip: '192.168.0.13', name: 'NEXUS' },
    ],
  });
  if (armed) store.settings.set('control_armed', true);
  const clock = { now: new Date(at) };
  const make = () =>
    new Reconciler({ store, router, protection, timezone: TZ, dryRun, schedulerEnabled, pollMinutes: 5, verifyDelayMs: 0, now: () => clock.now });
  return { store, router, protection, clock, make, rec: make() };
}

async function discover(ctx) {
  await ctx.rec.tick({ forcePoll: true, trigger: 'startup' });
  const by = (mac) => ctx.store.devices.find((d) => d.mac_address === mac);
  return { kid: by(KID), tablet: by(TABLET), server: by(SERVER) };
}

const night = (ids) => ({ name: 'School nights', start_time: '21:00', end_time: '07:00', days_of_week: [0, 1, 2, 3, 4], device_ids: ids });
const blockCalls = (router) => router.calls.filter((c) => c.startsWith('block:'));

test('armed: schedule blocks device and verifies via router read-back', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
  const log = ctx.store.activity.find((a) => a.action === 'block');
  assert.equal(log.result, 'verified');
  assert.equal(ctx.store.states.get(kid.id).app_blocked, true);
});

test('dry run: no router commands, simulated actions logged once', async () => {
  const ctx = setup({ armed: false, dryRun: true });
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  await ctx.rec.tick();
  assert.equal(blockCalls(ctx.router).length, 0);
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Allow');
  const dry = ctx.store.activity.filter((a) => a.result === 'dry_run');
  assert.equal(dry.length, 1);
  // morning: simulated restore
  ctx.clock.now = new Date('2026-01-06T07:00:00-05:00');
  await ctx.rec.tick();
  assert.equal(ctx.store.activity.filter((a) => a.result === 'dry_run' && a.action === 'restore').length, 1);
});

test('armed in settings but DRY_RUN=true still sends nothing', async () => {
  const ctx = setup({ armed: true, dryRun: true });
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  assert.equal(blockCalls(ctx.router).length, 0);
});

test('no duplicate commands once the router reports the desired state', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await Promise.all([ctx.rec.tick(), ctx.rec.tick(), ctx.rec.tick({ trigger: 'manual' })]);
  await ctx.rec.tick({ forcePoll: true, trigger: 'manual' });
  assert.equal(blockCalls(ctx.router).length, 1);
});

test('restores at end of window', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  ctx.clock.now = new Date('2026-01-06T07:00:00-05:00');
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Allow');
  assert.equal(ctx.store.activity.find((a) => a.action === 'restore').result, 'verified');
  assert.equal(ctx.store.states.get(kid.id).app_blocked, false);
});

test('protected server is never blocked (override + adapter guard)', async () => {
  const ctx = setup();
  const { server } = await discover(ctx);
  assert.equal(server.is_protected, true);
  ctx.store.overrides.set(server.id, { override_type: 'block', expires_at: new Date('2026-01-06T00:00:00Z') });
  ctx.store.addSchedule(night([server.id]));
  server.restrictions_enabled = true; // even if the DB were tampered with
  await ctx.rec.tick();
  assert.equal(blockCalls(ctx.router).length, 0);
  await assert.rejects(ctx.router.blockDevice(SERVER), /protected/);
});

test('router failure: logged as failed, router backoff, no false success', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  ctx.router.down = true;
  await ctx.rec.tick({ forcePoll: true, trigger: 'manual' });
  assert.ok(ctx.rec.status.routerError);
  assert.ok(ctx.store.activity.some((a) => a.action === 'router_unreachable' && a.result === 'failed'));
  assert.ok(!ctx.store.activity.some((a) => a.result === 'verified'));
  const calls = ctx.router.calls.length;
  await ctx.rec.tick(); // inside backoff window: router not contacted
  assert.equal(ctx.router.calls.length, calls);
  // recovery after backoff
  ctx.router.down = false;
  ctx.clock.now = new Date(ctx.clock.now.getTime() + 2 * 60_000);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
  assert.ok(ctx.store.activity.some((a) => a.action === 'router_recovered'));
});

test('command accepted but not applied -> failed + per-device backoff', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  ctx.router.ignoreCommands = true;
  await ctx.rec.tick();
  assert.equal(ctx.store.activity.find((a) => a.action === 'block').result, 'failed');
  await ctx.rec.tick();
  assert.equal(blockCalls(ctx.router).length, 1); // backoff prevents hammering
  ctx.router.ignoreCommands = false;
  ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
});

test('offline device: command is unverified, not repeated', async () => {
  const ctx = setup();
  const { tablet } = await discover(ctx);
  tablet.restrictions_enabled = true;
  ctx.store.addSchedule(night([tablet.id]));
  ctx.router.offline.add(TABLET);
  await ctx.rec.tick({ forcePoll: true, trigger: 'manual' });
  assert.equal(ctx.store.activity.find((a) => a.action === 'block').result, 'unverified');
  await ctx.rec.tick({ forcePoll: true, trigger: 'manual' });
  assert.equal(blockCalls(ctx.router).length, 1);
});

test('restart reconciliation: fresh instance mid-window applies the block', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  // App was down at 21:00; comes back at 23:30
  ctx.clock.now = new Date('2026-01-05T23:30:00-05:00');
  const fresh = ctx.make();
  await fresh.tick({ forcePoll: true, trigger: 'startup' });
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
});

test('router reboot that drops the block is corrected on next poll', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  ctx.router.devices.get(KID).allowOrBlock = 'Allow'; // router forgot
  ctx.clock.now = new Date(ctx.clock.now.getTime() + 5 * 60_000);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
  assert.equal(blockCalls(ctx.router).length, 2);
});

test('manual allow override during a window restores, expiry re-blocks', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  ctx.store.overrides.set(kid.id, { override_type: 'allow', expires_at: new Date(ctx.clock.now.getTime() + 30 * 60_000) });
  await ctx.rec.tick({ forcePoll: true, trigger: 'manual' });
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Allow');
  ctx.clock.now = new Date(ctx.clock.now.getTime() + 31 * 60_000);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
  assert.ok(ctx.store.activity.some((a) => a.action === 'override_expired'));
});

test('unmanaging a device the app blocked restores it', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  kid.restrictions_enabled = false;
  await ctx.rec.tick({ trigger: 'manual' });
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Allow');
});

test('unmanaged devices blocked by someone else are left alone', async () => {
  const ctx = setup();
  ctx.router.devices.get(TABLET).allowOrBlock = 'Block';
  await discover(ctx);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(TABLET).allowOrBlock, 'Block');
  assert.equal(ctx.router.calls.filter((c) => c.startsWith('unblock:')).length, 0);
});

test('SCHEDULER_ENABLED=false suppresses automatic blocks but not manual ones', async () => {
  const ctx = setup({ schedulerEnabled: false });
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  await ctx.rec.tick();
  assert.equal(blockCalls(ctx.router).length, 0);
  ctx.store.overrides.set(kid.id, { override_type: 'block', expires_at: new Date(ctx.clock.now.getTime() + 60_000) });
  await ctx.rec.tick({ trigger: 'manual' });
  assert.equal(blockCalls(ctx.router).length, 1);
});

test('database outage does not crash; next tick recovers', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  ctx.store.failNext = 1;
  await ctx.rec.tick(); // swallowed + logged, does not throw
  assert.match(ctx.rec.status.lastError, /connection terminated/);
  assert.equal(blockCalls(ctx.router).length, 0);
  await ctx.rec.tick();
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
  assert.equal(ctx.rec.status.lastError, null);
});

test('disarm restores everything the app blocked', async () => {
  const ctx = setup();
  const { kid, tablet } = await discover(ctx);
  kid.restrictions_enabled = true;
  tablet.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id, tablet.id]));
  await ctx.rec.tick();
  const results = await ctx.rec.disarm();
  assert.equal(results.length, 2);
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Allow');
  assert.equal(ctx.router.devices.get(TABLET).allowOrBlock, 'Allow');
  assert.equal(await ctx.rec.isArmed(), false);
});

test('standby instance (lock held elsewhere) never touches the router until activated', async () => {
  const ctx = setup();
  const { kid } = await discover(ctx);
  kid.restrictions_enabled = true;
  ctx.store.addSchedule(night([kid.id]));
  const standby = ctx.make();
  standby.active = false;
  const before = ctx.router.calls.length;
  await standby.tick({ forcePoll: true, trigger: 'startup' });
  await assert.rejects(standby.checkRouter(), /Standby/);
  await assert.rejects(standby.arm(), /Standby/);
  assert.equal(ctx.router.calls.length, before);
  standby.active = true; // previous instance stopped, lock acquired
  await standby.tick({ forcePoll: true, trigger: 'startup' });
  assert.equal(ctx.router.devices.get(KID).allowOrBlock, 'Block');
});

test('router health is read-only and reported even when unsupported', async () => {
  const ctx = setup({ armed: false });
  const h = await ctx.rec.routerHealth();
  assert.equal(h.ok, true);
  assert.equal(typeof h.cpuPercent, 'number');
  assert.deepEqual(ctx.router.calls, ['getRouterHealth']);
  ctx.router.down = true;
  const bad = await ctx.rec.routerHealth();
  assert.equal(bad.ok, false);
});

test('router restart: logged, outage not counted as failures, device list re-read afterwards', async () => {
  const ctx = setup();
  await discover(ctx);
  const { restartingUntil } = await ctx.rec.rebootRouter();
  assert.ok(ctx.router.calls.includes('rebootRouter'));
  assert.equal(ctx.rec.status.routerFailures, 0);
  assert.equal(ctx.rec.status.lastPollAt, null);
  assert.ok(ctx.store.activity.some((a) => a.action === 'router_restart' && a.result === 'requested'));
  assert.equal((await ctx.rec.routerHealth()).restarting, true);

  // While restarting, ticks don't hit the router.
  const before = ctx.router.calls.length;
  await ctx.rec.tick();
  assert.equal(ctx.router.calls.length, before);

  // After the window the router is polled again and the restart flag clears.
  ctx.clock.now = new Date(new Date(restartingUntil).getTime() + 1000);
  await ctx.rec.tick();
  assert.ok(ctx.router.calls.slice(before).includes('getConnectedDevices'));
  assert.equal(ctx.rec.status.restartingUntil, null);
  assert.equal(ctx.rec.status.routerError, null);
});

test('router restart failure is logged and rethrown', async () => {
  const ctx = setup();
  ctx.router.down = true;
  await assert.rejects(ctx.rec.rebootRouter());
  assert.ok(ctx.store.activity.some((a) => a.action === 'router_restart' && a.result === 'failed'));
});
