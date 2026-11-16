/**
 * Pure scheduling logic. No I/O. Everything here is unit-tested.
 *
 * Conflict rules (deterministic, highest priority first):
 *  1. Protected device  -> never blocked. If the app had blocked it earlier, restore it.
 *  2. Active manual override (not expired) -> its type ('block' | 'allow') wins.
 *  3. Device not managed (restrictions disabled) -> app leaves it alone,
 *     except it restores access if the app itself blocked it earlier.
 *  4. Managed device -> blocked if ANY enabled schedule covering it is active now,
 *     otherwise allowed. Disabling one schedule never restores access while
 *     another enabled schedule still applies.
 *
 * Schedules are evaluated against wall-clock time in the app timezone, as a
 * level (is it inside a window right now?) rather than as edge events. That
 * makes restarts and DST transitions self-correcting.
 */

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const partFormatters = new Map();
function partFormatter(tz) {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

const offsetCache = new Map();
/** Minutes to add to UTC to get local wall time, cached per UTC hour (DST changes on the hour). */
function offsetMinutes(date, tz) {
  const hourKey = `${tz}|${Math.floor(date.getTime() / 3_600_000)}`;
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;
  const p = {};
  for (const part of partFormatter(tz).formatToParts(date)) p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  const floored = Math.floor(date.getTime() / 60_000) * 60_000;
  const off = Math.round((asUtc - floored) / 60_000);
  if (offsetCache.size > 20_000) offsetCache.clear();
  offsetCache.set(hourKey, off);
  return off;
}

/** Weekday (0=Sunday) and minutes since local midnight for `date` in `tz`. */
export function zonedParts(date, tz) {
  const local = new Date(date.getTime() + offsetMinutes(date, tz) * 60_000);
  return { weekday: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** "21:00", "21:00:00" -> 1260 */
export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function isOvernight(schedule) {
  return parseTime(schedule.start_time) > parseTime(schedule.end_time);
}

function activeAtParts(schedule, { weekday, minutes }) {
  const start = parseTime(schedule.start_time);
  const end = parseTime(schedule.end_time);
  const days = schedule.days_of_week;
  if (start === null || end === null || start === end || !days?.length) return false;
  if (start < end) return days.includes(weekday) && minutes >= start && minutes < end;
  // Overnight: the window belongs to the day it STARTS on.
  const yesterday = (weekday + 6) % 7;
  return (days.includes(weekday) && minutes >= start) || (days.includes(yesterday) && minutes < end);
}

/** Is this schedule's blocking window in effect at `date`? (ignores `enabled`) */
export function isScheduleActive(schedule, date, tz) {
  return activeAtParts(schedule, zonedParts(date, tz));
}

export function evaluateDevice({ device, schedules, override, appBlocked, now, timezone, isProtected }) {
  if (isProtected) {
    return appBlocked
      ? { state: 'allow', reason: 'protected-restore', active: [] }
      : { state: null, reason: 'protected', active: [] };
  }
  if (override && new Date(override.expires_at) > now) {
    return { state: override.override_type, reason: 'override', active: [] };
  }
  if (!device.restrictions_enabled) {
    return appBlocked
      ? { state: 'allow', reason: 'unmanaged-restore', active: [] }
      : { state: null, reason: 'unmanaged', active: [] };
  }
  const active = (schedules ?? []).filter((s) => s.enabled && isScheduleActive(s, now, timezone));
  return active.length
    ? { state: 'block', reason: 'schedule', active: active.map((s) => s.name) }
    : { state: 'allow', reason: 'schedule-idle', active: [] };
}

/** Next instant (minute resolution) at which the combined schedule state flips. null if none within the horizon. */
export function nextScheduleChange(schedules, from, tz, horizonDays = 8) {
  const enabled = (schedules ?? []).filter((s) => s.enabled);
  if (!enabled.length) return null;
  const startMs = Math.floor(from.getTime() / 60_000) * 60_000;
  const activeAt = (t) => {
    const parts = zonedParts(t, tz);
    return enabled.some((s) => activeAtParts(s, parts));
  };
  const current = activeAt(from);
  for (let i = 1; i <= horizonDays * 1440; i++) {
    const t = new Date(startMs + i * 60_000);
    if (activeAt(t) !== current) return t;
  }
  return null;
}

/** Validate and normalize schedule input from the dashboard. */
export function validateSchedule(input) {
  const errors = [];
  const name = String(input?.name ?? '').trim();
  if (!name || name.length > 80) errors.push('Name is required (max 80 characters).');
  const start = parseTime(input?.start_time);
  const end = parseTime(input?.end_time);
  if (start === null) errors.push('Start time must be HH:MM.');
  if (end === null) errors.push('End time must be HH:MM.');
  if (start !== null && start === end) errors.push('Start and end time must differ.');
  const rawDays = Array.isArray(input?.days_of_week) ? input.days_of_week : [];
  const days = [...new Set(rawDays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length || days.length !== rawDays.length) errors.push('Select at least one valid day.');
  const rawIds = Array.isArray(input?.device_ids) ? input.device_ids : [];
  const deviceIds = [...new Set(rawIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (deviceIds.length !== rawIds.length) errors.push('Invalid device selection.');
  if (!deviceIds.length) errors.push('Select at least one device.');
  const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    errors,
    value: errors.length
      ? null
      : { name, start_time: pad(start), end_time: pad(end), days_of_week: days, device_ids: deviceIds, enabled: input?.enabled !== false },
  };
}
