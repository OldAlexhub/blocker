import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetgearSoapAdapter, parseAttach1, parseAttach2, parseSystemInfo, parseTrafficMeter } from '../src/router/netgearSoap.js';
import { normalizeMac, isRandomizedMac } from '../src/core/mac.js';

const ok = (body, headers = {}) =>
  new Response(`<soap-env:Envelope><soap-env:Body>${body}<ResponseCode>000</ResponseCode></soap-env:Body></soap-env:Envelope>`, { status: 200, headers });
const unauthorized = () => new Response('<soap-env:Body><ResponseCode>401</ResponseCode></soap-env:Body>', { status: 200 });

function fakeRouter(handlers) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const action = init.headers.SOAPAction.split('#')[1];
    calls.push({ action, body: init.body, cookie: init.headers.Cookie });
    const h = handlers[action];
    if (!h) return new Response('<ResponseCode>404</ResponseCode>', { status: 200 });
    return h(init, calls);
  };
  return { calls, fetchImpl };
}

test('normalizeMac / randomized MAC detection', () => {
  assert.equal(normalizeMac('00-1a-2b-3c-4d-5e'), '00:1A:2B:3C:4D:5E');
  assert.equal(normalizeMac('nope'), null);
  assert.equal(isRandomizedMac('DA:11:22:33:44:55'), true);
  assert.equal(isRandomizedMac('00:1A:2B:3C:4D:5E'), false);
});

test('parseAttach2', () => {
  const xml = `<NewAttachDevice><Device><IP>192.168.0.20</IP><Name>Kids-PC</Name><MAC>aa:bb:cc:dd:ee:01</MAC>
    <ConnectionType>wired</ConnectionType><AllowOrBlock>Block</AllowOrBlock></Device>
    <Device><IP>192.168.0.21</IP><Name>&lt;unknown&gt;</Name><MAC>AA:BB:CC:DD:EE:02</MAC><AllowOrBlock>Allow</AllowOrBlock></Device></NewAttachDevice>`;
  assert.deepEqual(parseAttach2(xml), [
    { mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.0.20', name: 'Kids-PC', connectionType: 'wired', allowOrBlock: 'Block' },
    { mac: 'AA:BB:CC:DD:EE:02', ip: '192.168.0.21', name: null, connectionType: null, allowOrBlock: 'Allow' },
  ]);
  assert.equal(parseAttach2('<Other/>'), null);
});

test('parseAttach1', () => {
  const xml = '<NewAttachDevice>2@1;192.168.0.20;Kids-PC;AA:BB:CC:DD:EE:01;wired;1000;100;Allow@2;192.168.0.21;&lt;unknown&gt;;AA:BB:CC:DD:EE:02;5GHz;866;80;Block</NewAttachDevice>';
  const r = parseAttach1(xml);
  assert.equal(r.length, 2);
  assert.equal(r[1].name, null);
  assert.equal(r[1].allowOrBlock, 'Block');
});

test('login v2 then cookie is sent; re-login on 401', async () => {
  let loggedIn = 0;
  let first = true;
  const { calls, fetchImpl } = fakeRouter({
    SOAPLogin: () => {
      loggedIn++;
      return ok('', { 'Set-Cookie': `sess_id=abc${loggedIn}; path=/` });
    },
    GetInfo: () => {
      if (first) { first = false; return unauthorized(); }
      return ok('<ModelName>C6230</ModelName><Firmwareversion>V1.00.17</Firmwareversion>');
    },
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'admin', password: 'p<w', fetchImpl });
  assert.deepEqual(await r.healthCheck(), { model: 'C6230', firmware: 'V1.00.17' });
  assert.equal(loggedIn, 2);
  assert.equal(calls.at(-1).cookie, 'sess_id=abc2');
  assert.match(calls[0].body, /<Password>p&lt;w<\/Password>/); // credentials are XML-escaped
});

test('block wraps SetBlockDeviceByMAC in ConfigurationStarted/Finished', async () => {
  const { calls, fetchImpl } = fakeRouter({
    SOAPLogin: () => ok(''),
    ConfigurationStarted: () => ok(''),
    SetBlockDeviceByMAC: () => ok(''),
    ConfigurationFinished: () => ok(''),
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl });
  await r.blockDevice('aa-bb-cc-dd-ee-01');
  assert.deepEqual(calls.map((c) => c.action), ['SOAPLogin', 'ConfigurationStarted', 'SetBlockDeviceByMAC', 'ConfigurationFinished']);
  assert.match(calls[2].body, /<NewAllowOrBlock>Block<\/NewAllowOrBlock><NewMACAddress>AA:BB:CC:DD:EE:01<\/NewMACAddress>/);
});

test('adapter refuses to block protected MACs without contacting the router', async () => {
  const { calls, fetchImpl } = fakeRouter({});
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl, isProtectedMac: () => true });
  await assert.rejects(r.blockDevice('00:1A:2B:3C:4D:5E'), (e) => e.code === 'refused');
  assert.equal(calls.length, 0);
});

test('network failure maps to RouterError unreachable', async () => {
  const r = new NetgearSoapAdapter({
    host: 'x', username: 'a', password: 'b',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(r.getConnectedDevices(), (e) => e.code === 'unreachable');
});

test('commands are serialized (never interleaved)', async () => {
  let active = 0;
  let maxActive = 0;
  const slow = (body) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((res) => setTimeout(res, 5));
    active--;
    return ok(body);
  };
  const { fetchImpl } = fakeRouter({
    SOAPLogin: slow(''), ConfigurationStarted: slow(''), SetBlockDeviceByMAC: slow(''), ConfigurationFinished: slow(''),
    GetAttachDevice2: slow('<NewAttachDevice></NewAttachDevice>'),
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl });
  await Promise.all([r.blockDevice('AA:BB:CC:DD:EE:01'), r.unblockDevice('AA:BB:CC:DD:EE:02'), r.getConnectedDevices()]);
  assert.equal(maxActive, 1);
});

// Shapes below are the real C6230 V1.00.17 answers captured 2026-11-19.
test('parseSystemInfo / parseTrafficMeter', () => {
  assert.deepEqual(
    parseSystemInfo('<NewCPUUtilization>98</NewCPUUtilization><NewPhysicalMemory>256</NewPhysicalMemory><NewMemoryUtilization>86</NewMemoryUtilization>'),
    { cpuPercent: 98, memoryPercent: 86, memoryTotalMb: 256 },
  );
  assert.deepEqual(parseSystemInfo('<Other/>'), { cpuPercent: null, memoryPercent: null, memoryTotalMb: null });
  const t = parseTrafficMeter(
    '<NewTodayUpload>17.57</NewTodayUpload><NewTodayDownload>198.30</NewTodayDownload>' +
      '<NewMonthUpload>17.57/17.57</NewMonthUpload><NewMonthDownload>198.30/198.30</NewMonthDownload>',
  );
  assert.deepEqual(t.today, { downloadMb: 198.3, uploadMb: 17.57 });
  assert.deepEqual(t.month, { downloadMb: 198.3, uploadMb: 17.57 });
  assert.deepEqual(t.lastMonth, { downloadMb: null, uploadMb: null });
});

test('getRouterHealth reads system info, traffic meter and meter status', async () => {
  const { calls, fetchImpl } = fakeRouter({
    SOAPLogin: () => ok(''),
    GetSystemInfo: () => ok('<NewCPUUtilization>91</NewCPUUtilization><NewPhysicalMemory>256</NewPhysicalMemory><NewMemoryUtilization>86</NewMemoryUtilization>'),
    GetTrafficMeterStatistics: () => ok('<NewTodayUpload>1.5</NewTodayUpload><NewTodayDownload>20</NewTodayDownload>'),
    GetTrafficMeterEnabled: () => ok('<NewTrafficMeterEnable>0</NewTrafficMeterEnable>'),
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl });
  const h = await r.getRouterHealth();
  assert.equal(h.cpuPercent, 91);
  assert.equal(h.memoryPercent, 86);
  assert.deepEqual(h.traffic.today, { downloadMb: 20, uploadMb: 1.5 });
  assert.equal(h.trafficMeterEnabled, false);
  assert.ok(!calls.some((c) => /Set|Configuration|Reboot/.test(c.action)), 'health check must be read-only');
});

test('getRouterHealth tolerates a router without a traffic meter', async () => {
  const { fetchImpl } = fakeRouter({
    SOAPLogin: () => ok(''),
    GetSystemInfo: () => ok('<NewCPUUtilization>10</NewCPUUtilization>'),
    // Traffic meter actions fall through to the 404 response code
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl });
  const h = await r.getRouterHealth();
  assert.equal(h.cpuPercent, 10);
  assert.equal(h.traffic, null);
  assert.equal(h.trafficMeterEnabled, null);
});

test('rebootRouter wraps Reboot in ConfigurationStarted/Finished', async () => {
  const { calls, fetchImpl } = fakeRouter({
    SOAPLogin: () => ok(''),
    ConfigurationStarted: () => ok(''),
    Reboot: () => ok(''),
    ConfigurationFinished: () => ok(''),
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl });
  await r.rebootRouter();
  assert.deepEqual(calls.map((c) => c.action), ['SOAPLogin', 'ConfigurationStarted', 'Reboot', 'ConfigurationFinished']);
});

test('rebootRouter: dropped connection counts as restarting; 501 is reported as unsupported', async () => {
  const dropped = fakeRouter({
    SOAPLogin: () => ok(''),
    ConfigurationStarted: () => ok(''),
    Reboot: () => { throw new TypeError('fetch failed'); },
  });
  await new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl: dropped.fetchImpl }).rebootRouter();

  const refused = fakeRouter({
    SOAPLogin: () => ok(''),
    ConfigurationStarted: () => ok(''),
    Reboot: () => new Response('<ResponseCode>501</ResponseCode>', { status: 200 }),
    ConfigurationFinished: () => ok(''),
  });
  const r = new NetgearSoapAdapter({ host: 'x', username: 'a', password: 'b', fetchImpl: refused.fetchImpl });
  await assert.rejects(r.rebootRouter(), (err) => err.code === 'unsupported');
  assert.equal(refused.calls.at(-1).action, 'ConfigurationFinished');
});
