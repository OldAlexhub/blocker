/**
 * READ-ONLY router compatibility check. Changes nothing on the router.
 *   npm run router-check
 * Logs in, reads model/firmware, the attached-device list and the
 * Access Control status, and prints what it found.
 */
import { config } from '../src/config.js';
import { NetgearSoapAdapter } from '../src/router/netgearSoap.js';

if (!config.routerPassword) {
  console.error('Set ROUTER_PASSWORD in .env first.');
  process.exit(1);
}

const router = new NetgearSoapAdapter({
  host: config.routerHost,
  port: config.routerPort,
  username: config.routerUsername,
  password: config.routerPassword,
  timeoutMs: config.routerTimeoutMs,
});

const step = async (label, fn) => {
  process.stdout.write(`${label} ... `);
  try {
    const r = await fn();
    console.log('OK');
    return r;
  } catch (err) {
    console.log(`FAILED (${err.code ?? 'error'}: ${err.message})`);
    return undefined;
  }
};

console.log(`Router: http://${config.routerHost}:${config.routerPort}/soap/server_sa/  (read-only check)\n`);
try {
  const res = await fetch(`http://${config.routerHost}/currentsetting.htm`, { signal: AbortSignal.timeout(5000) });
  console.log((await res.text()).trim().replace(/\r/g, ''), '\n');
} catch {
  console.log('(currentsetting.htm not reachable)\n');
}

await step('Login', () => router.authenticate());
const info = await step('GetInfo', () => router.healthCheck());
if (info) console.log(`  model=${info.model} firmware=${info.firmware}`);
const health = await step('GetSystemInfo / GetTrafficMeterStatistics (router health)', () => router.getRouterHealth());
if (health) {
  console.log(`  CPU ${health.cpuPercent ?? '?'}%  memory ${health.memoryPercent ?? '?'}% of ${health.memoryTotalMb ?? '?'} MB`);
  if (health.traffic) console.log(`  today: ${health.traffic.today.downloadMb ?? '?'} MB down / ${health.traffic.today.uploadMb ?? '?'} MB up`);
  if (health.cpuPercent >= 80) console.log('  WARNING: router CPU is overloaded - a restart usually fixes a slow network.');
}
const ac = await step('GetBlockDeviceEnableStatus (Access Control)', () => router.getAccessControlEnabled());
if (ac !== undefined) console.log(`  Access Control: ${ac === null ? 'unknown (field not returned)' : ac ? 'ON' : 'OFF'}`);
const devices = await step('GetAttachDevice2 / GetAttachDevice', () => router.getConnectedDevices());
if (devices) {
  console.log(`  ${devices.length} device(s):`);
  console.table(devices.map((d) => ({ name: d.name, ip: d.ip, mac: d.mac, type: d.connectionType, status: d.allowOrBlock ?? '(not reported)' })));
  if (devices.length && devices.every((d) => d.allowOrBlock === null)) {
    console.log('  WARNING: the router did not report Allow/Block per device; verification would not be possible.');
  }
}
console.log('\nNo settings were changed.');
