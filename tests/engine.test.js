import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScheduleActive,
  evaluateDevice,
  nextScheduleChange,
  validateSchedule,
  zonedParts,
  parseTime,
} from '../src/core/engine.js';

const TZ = 'America/New_York';
// Helper: build a UTC instant from a New York wall time with explicit offset.
const ny = (iso, offset = '-05:00') => new Date(`${iso}${offset}`);

const schoolNights = { name: 'School nights', start_time: '21:00', end_time: '07:00', days_of_week: [0, 1, 2, 3, 4], enabled: true };
const homework = { name: 'Homework', start_time: '16:00', end_time: '18:00', days_of_week: [1, 2, 3, 4, 5], enabled: true };

test('parseTime', () => {
  assert.equal(parseTime('21:00'), 1260);
  assert.equal(parseTime('07:05:00'), 425);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('abc'), null);
});

test('zonedParts honours timezone', () => {
  // 2026-01-05 is a Monday. 02:00Z = Sunday 21:00 in New York.
  assert.deepEqual(zonedParts(new Date('2026-01-05T02:00:00Z'), TZ), { weekday: 0, minutes: 21 * 60 });
});

test('same-day window: start inclusive, end exclusive', () => {
  assert.equal(isScheduleActive(homework, ny('2026-01-05T15:59'), TZ), false);
  assert.equal(isScheduleActive(homework, ny('2026-01-05T16:00'), TZ), true);
  assert.equal(isScheduleActive(homework, ny('2026-01-05T17:59'), TZ), true);
  assert.equal(isScheduleActive(homework, ny('2026-01-05T18:00'), TZ), false);
});

test('day-of-week selection', () => {
  assert.equal(isScheduleActive(homework, ny('2026-01-10T17:00'), TZ), false); // Saturday
  assert.equal(isScheduleActive(homework, ny('2026-01-09T17:00'), TZ), true); // Friday
});

test('overnight Sun-Thu 21:00-07:00', () => {
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-04T20:59'), TZ), false); // Sun before
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-04T21:00'), TZ), true); // Sun night
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-05T03:00'), TZ), true); // Mon early (from Sun)
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-05T07:00'), TZ), false); // Mon 7:00 restore
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-09T06:59'), TZ), true); // Fri early (from Thu)
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-09T21:30'), TZ), false); // Fri night: not selected
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-10T02:00'), TZ), false); // Sat early: Fri not selected
  assert.equal(isScheduleActive(schoolNights, ny('2026-01-04T03:00'), TZ), false); // Sun early: Sat not selected
});

test('DST spring forward (2026-03-08): window covering the skipped hour still applies', () => {
  const s = { name: 'x', start_time: '02:30', end_time: '05:00', days_of_week: [0], enabled: true };
  // 01:59 EST
  assert.equal(isScheduleActive(s, new Date('2026-03-08T06:59:00Z'), TZ), false);
  // Clock jumps to 03:00 EDT at 07:00Z: now inside window
  assert.equal(isScheduleActive(s, new Date('2026-03-08T07:00:00Z'), TZ), true);
  assert.equal(isScheduleActive(schoolNights, new Date('2026-03-08T07:30:00Z'), TZ), false); // Sun 03:30, Sat not selected
  // Overnight through the change: Sun 21:00 EDT = 01:00Z Mon
  assert.equal(isScheduleActive(schoolNights, new Date('2026-03-09T01:00:00Z'), TZ), true);
  assert.equal(isScheduleActive(schoolNights, new Date('2026-03-09T10:59:00Z'), TZ), true); // Mon 06:59 EDT
  assert.equal(isScheduleActive(schoolNights, new Date('2026-03-09T11:00:00Z'), TZ), false); // Mon 07:00 EDT
});

test('DST fall back (2026-11-01): restores at 07:00 local, not 07:00 old offset', () => {
  // Sat->Sun night not selected; use Sunday night -> Monday
  assert.equal(isScheduleActive(schoolNights, new Date('2026-11-02T11:59:00Z'), TZ), true); // Mon 06:59 EST
  assert.equal(isScheduleActive(schoolNights, new Date('2026-11-02T12:00:00Z'), TZ), false); // Mon 07:00 EST
  const s = { name: 'x', start_time: '01:00', end_time: '02:00', days_of_week: [0], enabled: true };
  // 01:30 occurs twice; both are inside
  assert.equal(isScheduleActive(s, new Date('2026-11-01T05:30:00Z'), TZ), true); // 01:30 EDT
  assert.equal(isScheduleActive(s, new Date('2026-11-01T06:30:00Z'), TZ), true); // 01:30 EST
  assert.equal(isScheduleActive(s, new Date('2026-11-01T07:00:00Z'), TZ), false); // 02:00 EST
});

const managed = { id: 1, restrictions_enabled: true };

test('overlapping schedules: blocked until neither applies', () => {
  const a = { name: 'A', start_time: '20:00', end_time: '22:00', days_of_week: [1], enabled: true };
  const b = { name: 'B', start_time: '21:00', end_time: '23:00', days_of_week: [1], enabled: true };
  const at = (t) => evaluateDevice({ device: managed, schedules: [a, b], now: ny(`2026-01-05T${t}`), timezone: TZ }).state;
  assert.equal(at('19:59'), 'allow');
  assert.equal(at('20:30'), 'block');
  assert.equal(at('22:30'), 'block'); // A ended, B still active
  assert.equal(at('23:00'), 'allow');
});

test('disabling one schedule does not restore while another still applies', () => {
  const a = { name: 'A', start_time: '20:00', end_time: '23:00', days_of_week: [1], enabled: false };
  const b = { name: 'B', start_time: '21:00', end_time: '23:00', days_of_week: [1], enabled: true };
  const r = evaluateDevice({ device: managed, schedules: [a, b], now: ny('2026-01-05T21:30'), timezone: TZ });
  assert.equal(r.state, 'block');
  assert.deepEqual(r.active, ['B']);
});

test('manual override wins until it expires', () => {
  const now = ny('2026-01-05T22:00');
  const allow = { override_type: 'allow', expires_at: new Date(now.getTime() + 60_000) };
  assert.equal(evaluateDevice({ device: managed, schedules: [schoolNights], override: allow, now, timezone: TZ }).state, 'allow');
  const expired = { override_type: 'allow', expires_at: new Date(now.getTime() - 1) };
  assert.equal(evaluateDevice({ device: managed, schedules: [schoolNights], override: expired, now, timezone: TZ }).state, 'block');
  const block = { override_type: 'block', expires_at: new Date(now.getTime() + 60_000) };
  assert.equal(evaluateDevice({ device: { id: 2, restrictions_enabled: false }, schedules: [], override: block, now, timezone: TZ }).state, 'block');
});

test('protected devices are never blocked, even by override', () => {
  const now = ny('2026-01-05T22:00');
  const block = { override_type: 'block', expires_at: new Date(now.getTime() + 60_000) };
  const r = evaluateDevice({ device: managed, schedules: [schoolNights], override: block, now, timezone: TZ, isProtected: true });
  assert.equal(r.state, null);
  const r2 = evaluateDevice({ device: managed, schedules: [schoolNights], now, timezone: TZ, isProtected: true, appBlocked: true });
  assert.equal(r2.state, 'allow');
});

test('unmanaged device: left alone unless the app blocked it', () => {
  const now = ny('2026-01-05T22:00');
  const d = { id: 3, restrictions_enabled: false };
  assert.equal(evaluateDevice({ device: d, schedules: [schoolNights], now, timezone: TZ }).state, null);
  assert.equal(evaluateDevice({ device: d, schedules: [schoolNights], now, timezone: TZ, appBlocked: true }).state, 'allow');
});

test('nextScheduleChange finds the next flip', () => {
  const next = nextScheduleChange([schoolNights], ny('2026-01-05T22:15'), TZ);
  assert.equal(next.toISOString(), ny('2026-01-06T07:00').toISOString());
  const next2 = nextScheduleChange([schoolNights], ny('2026-01-09T08:00'), TZ); // Friday morning
  assert.equal(next2.toISOString(), ny('2026-01-11T21:00').toISOString()); // Sunday night
  assert.equal(nextScheduleChange([], new Date(), TZ), null);
});

test('validateSchedule', () => {
  const ok = validateSchedule({ name: ' Night ', start_time: '21:00', end_time: '7:00', days_of_week: [4, 0], device_ids: [1] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { name: 'Night', start_time: '21:00', end_time: '07:00', days_of_week: [0, 4], device_ids: [1], enabled: true });
  assert.ok(validateSchedule({ name: 'x', start_time: '21:00', end_time: '21:00', days_of_week: [1], device_ids: [1] }).errors.length);
  assert.ok(validateSchedule({ name: 'x', start_time: '21:00', end_time: '22:00', days_of_week: [7], device_ids: [1] }).errors.length);
  assert.ok(validateSchedule({ name: 'x', start_time: '21:00', end_time: '22:00', days_of_week: [1], device_ids: [] }).errors.length);
});
