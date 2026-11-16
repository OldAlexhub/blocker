import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const env = (name, def = '') => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? def : v.trim();
};
const bool = (name, def) => {
  const v = env(name, '');
  return v === '' ? def : /^(1|true|yes|on)$/i.test(v);
};
const int = (name, def, min, max) => {
  const n = Number.parseInt(env(name, String(def)), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const config = Object.freeze({
  nodeEnv: env('NODE_ENV', 'development'),
  host: env('HOST', '127.0.0.1'),
  port: int('PORT', 3000, 1, 65535),
  allowLan: bool('ALLOW_LAN', false),
  databaseUrl: env('DATABASE_URL'),
  sessionSecret: env('SESSION_SECRET'),
  dashboardUsername: env('DASHBOARD_USERNAME', 'admin'),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '', // not trimmed: spaces may be intentional
  routerAdapter: env('ROUTER_ADAPTER', 'netgear'),
  routerHost: env('ROUTER_HOST', '192.168.0.1'),
  routerPort: int('ROUTER_PORT', 5000, 1, 65535),
  routerUsername: env('ROUTER_USERNAME', 'admin'),
  routerPassword: env('ROUTER_PASSWORD'),
  routerTimeoutMs: int('ROUTER_TIMEOUT_MS', 10000, 2000, 60000),
  routerPollMinutes: int('ROUTER_POLL_MINUTES', 5, 1, 60),
  protectedMacs: env('PROTECTED_MACS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  timezone: env('APP_TIMEZONE', 'America/New_York'),
  schedulerEnabled: bool('SCHEDULER_ENABLED', true),
  dryRun: bool('DRY_RUN', true),
  logLevel: env('LOG_LEVEL', 'info'),
});

/** Validate settings the web server cannot run without. Returns a list of problems. */
export function serverConfigProblems(c = config) {
  const problems = [];
  if (!c.databaseUrl) problems.push('DATABASE_URL is not set');
  if (c.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!isValidTimezone(c.timezone)) problems.push(`APP_TIMEZONE "${c.timezone}" is not a valid IANA timezone`);
  if (!['netgear', 'mock'].includes(c.routerAdapter)) problems.push('ROUTER_ADAPTER must be "netgear" or "mock"');
  if (c.routerAdapter === 'netgear' && !c.routerPassword) problems.push('ROUTER_PASSWORD is not set');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(c.host);
  if (!loopback && !c.allowLan) {
    problems.push(`HOST=${c.host} exposes the dashboard to the LAN; set ALLOW_LAN=true only after login and firewall are verified`);
  }
  return problems;
}
