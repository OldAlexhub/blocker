import { RouterAdapter, RouterError } from './RouterAdapter.js';
import { normalizeMac } from '../core/mac.js';

/**
 * NETGEAR local SOAP API ("Genie" API), as used by pynetgear / npm `netgear`.
 *
 * Verified on this network (2026-11-15, read-only, unauthenticated):
 *   - GET  http://192.168.0.1/currentsetting.htm -> Model=C6230, Firmware=V1.00.17,
 *     SOAPVersion=3.54, LoginMethod=2.0
 *   - POST http://192.168.0.1:5000/soap/server_sa/ answers SOAP with ResponseCode 401
 *
 * Action names / parameters follow pynetgear (MatMaul/pynetgear, const.py & router.py).
 * They are NOT documented by NETGEAR and depend on router firmware.
 * Use `npm run router-check` (read-only) to confirm them against your router.
 */

const SERVICE_PREFIX = 'urn:NETGEAR-ROUTER:service:';
const SESSION_ID = 'A7D88AE69687E58D9A00';
const OK_CODES = new Set(['0', '000', '0000', '1', '001', '2', '002', '3', '003']);

const DEVICE_CONFIG = 'DeviceConfig:1';
const DEVICE_INFO = 'DeviceInfo:1';
const PARENTAL_CONTROL = 'ParentalControl:1';

const xmlEscape = (v) =>
  String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const xmlDecode = (v) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

function tag(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? xmlDecode(m[1].trim()) : null;
}

function normAllowBlock(v) {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === 'allow') return 'Allow';
  if (s === 'block') return 'Block';
  return null;
}

function envelope(service, method, params, rawBody) {
  const inner = Object.entries(params ?? {})
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  const body =
    rawBody ??
    `<SOAP-ENV:Body><M1:${method} xmlns:M1="${SERVICE_PREFIX}${service}">${inner}</M1:${method}></SOAP-ENV:Body>`;
  return (
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<SOAP-ENV:Header><SessionID>${SESSION_ID}</SessionID></SOAP-ENV:Header>` +
    body +
    '</SOAP-ENV:Envelope>'
  );
}

export class NetgearSoapAdapter extends RouterAdapter {
  #cookie = null;
  #authenticated = false;
  #queue = Promise.resolve();
  #attachMethod = null; // 'GetAttachDevice2' | 'GetAttachDevice'

  constructor({ host, port = 5000, username, password, timeoutMs = 10000, isProtectedMac, logger, fetchImpl }) {
    super();
    this.url = `http://${host}:${port}/soap/server_sa/`;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.isProtectedMac = isProtectedMac ?? (() => false);
    this.logger = logger;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  /** Serialize every router conversation: one command at a time, never interleaved. */
  #exclusive(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #post(service, method, params, { rawBody, auth = true } = {}) {
    const headers = {
      SOAPAction: `${SERVICE_PREFIX}${service}#${method}`,
      'Content-Type': 'multipart/form-data',
    };
    if (auth && this.#cookie) headers.Cookie = this.#cookie;
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: envelope(service, method, params, rawBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const code = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'unreachable';
      throw new RouterError(code, `Router ${code === 'timeout' ? 'timed out' : 'unreachable'} (${method})`, err);
    }
    const text = await res.text();
    const responseCode = tag(text, 'ResponseCode');
    if (res.status === 401 || responseCode === '401') {
      throw new RouterError('unauthorized', `Router rejected session (${method})`);
    }
    if (res.status !== 200 || !OK_CODES.has(responseCode ?? '')) {
      throw new RouterError('bad_response', `Unexpected router response for ${method} (HTTP ${res.status}, code ${responseCode ?? 'none'})`);
    }
    return { text, headers: res.headers };
  }

  async #login() {
    this.#cookie = null;
    this.#authenticated = false;
    // Login v2 (router reports LoginMethod=2.0): DeviceConfig#SOAPLogin, session cookie in Set-Cookie.
    try {
      const { headers } = await this.#post(
        DEVICE_CONFIG,
        'SOAPLogin',
        { Username: this.username, Password: this.password },
        { auth: false },
      );
      const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
      this.#cookie = cookies.map((c) => c.split(';')[0]).join('; ') || null;
      this.#authenticated = true;
      return;
    } catch (err) {
      if (err.code === 'unreachable' || err.code === 'timeout') throw err;
      this.logger?.debug({ code: err.code }, 'SOAPLogin failed, trying legacy Authenticate');
    }
    // Login v1 fallback: ParentalControl#Authenticate.
    const rawBody =
      '<SOAP-ENV:Body><Authenticate>' +
      `<NewUsername>${xmlEscape(this.username)}</NewUsername>` +
      `<NewPassword>${xmlEscape(this.password)}</NewPassword>` +
      '</Authenticate></SOAP-ENV:Body>';
    try {
      await this.#post(PARENTAL_CONTROL, 'Authenticate', null, { rawBody, auth: false });
      this.#authenticated = true;
    } catch (err) {
      if (err.code === 'unreachable' || err.code === 'timeout') throw err;
      throw new RouterError('auth', 'Router login failed - check ROUTER_USERNAME / ROUTER_PASSWORD');
    }
  }

  /** Authenticated call; re-login once if the session expired (e.g. after a router restart). */
  async #call(service, method, params) {
    if (!this.#authenticated) await this.#login();
    try {
      return await this.#post(service, method, params);
    } catch (err) {
      if (err.code !== 'unauthorized') throw err;
      await this.#login();
      return this.#post(service, method, params);
    }
  }

  async #readDevices() {
    const methods = this.#attachMethod ? [this.#attachMethod] : ['GetAttachDevice2', 'GetAttachDevice'];
    let lastErr;
    for (const method of methods) {
      try {
        const { text } = await this.#call(DEVICE_INFO, method, {});
        const devices = method === 'GetAttachDevice2' ? parseAttach2(text) : parseAttach1(text);
        if (method === 'GetAttachDevice2' && devices === null) continue; // not supported -> fall back
        this.#attachMethod = method;
        return devices ?? [];
      } catch (err) {
        if (err.code === 'unreachable' || err.code === 'timeout' || err.code === 'auth') throw err;
        lastErr = err;
      }
    }
    throw lastErr ?? new RouterError('unsupported', 'Router did not return an attached-device list');
  }

  async #setBlock(mac, value) {
    const m = normalizeMac(mac);
    if (!m) throw new RouterError('refused', `Invalid MAC address: ${mac}`);
    if (value === 'Block' && this.isProtectedMac(m)) {
      throw new RouterError('refused', `Refusing to block protected device ${m}`);
    }
    await this.#call(DEVICE_CONFIG, 'ConfigurationStarted', { NewSessionID: SESSION_ID });
    try {
      await this.#call(DEVICE_CONFIG, 'SetBlockDeviceByMAC', { NewAllowOrBlock: value, NewMACAddress: m });
    } finally {
      await this.#call(DEVICE_CONFIG, 'ConfigurationFinished', { NewStatus: 'ChangesApplied' }).catch((err) =>
        this.logger?.warn({ code: err.code }, 'ConfigurationFinished failed'),
      );
    }
  }

  authenticate() {
    return this.#exclusive(() => this.#login());
  }

  healthCheck() {
    return this.#exclusive(async () => {
      const { text } = await this.#call(DEVICE_INFO, 'GetInfo', {});
      return { model: tag(text, 'ModelName'), firmware: tag(text, 'Firmwareversion') };
    });
  }

  getConnectedDevices() {
    return this.#exclusive(() => this.#readDevices());
  }

  getDeviceRestrictionState(mac) {
    const m = normalizeMac(mac);
    return this.#exclusive(async () => {
      const devices = await this.#readDevices();
      return devices.find((d) => d.mac === m)?.allowOrBlock ?? null;
    });
  }

  getAccessControlEnabled() {
    return this.#exclusive(async () => {
      const { text } = await this.#call(DEVICE_CONFIG, 'GetBlockDeviceEnableStatus', {});
      const v = tag(text, 'NewBlockDeviceEnable');
      return v === '1' ? true : v === '0' ? false : null;
    });
  }

  /**
   * Read-only router load + traffic totals.
   * Verified on the C6230 V1.00.17 (2026-11-19): DeviceInfo#GetSystemInfo and
   * DeviceConfig#GetTrafficMeterStatistics answer; every per-device bandwidth
   * action (AdvancedQoS:1#GetCurrentDeviceBandwidth etc.) returns 501, so this
   * router cannot say WHICH device uses the traffic.
   */
  getRouterHealth() {
    return this.#exclusive(async () => {
      const { text: sys } = await this.#call(DEVICE_INFO, 'GetSystemInfo', {});
      const health = parseSystemInfo(sys);
      try {
        const { text: meter } = await this.#call(DEVICE_CONFIG, 'GetTrafficMeterStatistics', {});
        health.traffic = parseTrafficMeter(meter);
      } catch (err) {
        if (err.code === 'unreachable' || err.code === 'timeout') throw err;
        health.traffic = null;
      }
      try {
        const { text: en } = await this.#call(DEVICE_CONFIG, 'GetTrafficMeterEnabled', {});
        const v = tag(en, 'NewTrafficMeterEnable');
        health.trafficMeterEnabled = v === '1' ? true : v === '0' ? false : null;
      } catch (err) {
        if (err.code === 'unreachable' || err.code === 'timeout') throw err;
        health.trafficMeterEnabled = null;
      }
      return health;
    });
  }

  /**
   * Restart the router (frees its memory). Everyone on the network loses internet
   * for a few minutes. NOT verified on the C6230 (testing it would reboot the router);
   * a 501 answer means the firmware does not support it.
   */
  rebootRouter() {
    return this.#exclusive(async () => {
      await this.#call(DEVICE_CONFIG, 'ConfigurationStarted', { NewSessionID: SESSION_ID });
      try {
        await this.#call(DEVICE_CONFIG, 'Reboot', {});
      } catch (err) {
        // Connection dropped mid-answer: the router is almost certainly already restarting.
        if (err.code === 'unreachable' || err.code === 'timeout') {
          this.#authenticated = false;
          this.#cookie = null;
          return;
        }
        await this.#call(DEVICE_CONFIG, 'ConfigurationFinished', { NewStatus: 'ChangesApplied' }).catch(() => {});
        if (err.code === 'bad_response') {
          throw new RouterError('unsupported', 'The router refused the restart command. Restart it with its power button instead.', err);
        }
        throw err;
      }
      // The router normally drops the connection here because it is already restarting.
      await this.#call(DEVICE_CONFIG, 'ConfigurationFinished', { NewStatus: 'ChangesApplied' }).catch(() => {});
      this.#authenticated = false;
      this.#cookie = null;
    });
  }

  blockDevice(mac) {
    return this.#exclusive(() => this.#setBlock(mac, 'Block'));
  }

  unblockDevice(mac) {
    return this.#exclusive(() => this.#setBlock(mac, 'Allow'));
  }
}

const pct = (v) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : null;
};

/** DeviceInfo#GetSystemInfo: CPU %, memory % and total memory (MB). */
export function parseSystemInfo(xml) {
  return {
    cpuPercent: pct(tag(xml, 'NewCPUUtilization')),
    memoryPercent: pct(tag(xml, 'NewMemoryUtilization')),
    memoryTotalMb: pct(tag(xml, 'NewPhysicalMemory')),
  };
}

/** DeviceConfig#GetTrafficMeterStatistics, in MB. Week/month values look like "total/average". */
export function parseTrafficMeter(xml) {
  const mb = (name) => {
    const v = tag(xml, name);
    if (v === null) return null;
    const n = Number(v.split('/')[0]);
    return Number.isFinite(n) ? n : null;
  };
  const period = (p) => ({ downloadMb: mb(`New${p}Download`), uploadMb: mb(`New${p}Upload`) });
  return {
    today: period('Today'),
    yesterday: period('Yesterday'),
    week: period('Week'),
    month: period('Month'),
    lastMonth: period('LastMonth'),
  };
}

/** GetAttachDevice2: <Device><IP/><Name/><MAC/><ConnectionType/><AllowOrBlock/>...</Device> */
export function parseAttach2(xml) {
  const blocks = [...xml.matchAll(/<Device>([\s\S]*?)<\/Device>/g)];
  if (!blocks.length && !/<NewAttachDevice/.test(xml)) return null;
  const out = [];
  for (const [, body] of blocks) {
    const mac = normalizeMac(tag(body, 'MAC'));
    if (!mac) continue;
    const name = tag(body, 'Name');
    out.push({
      mac,
      ip: tag(body, 'IP') || null,
      name: name && name !== '<unknown>' ? name : null,
      connectionType: tag(body, 'ConnectionType') || null,
      allowOrBlock: normAllowBlock(tag(body, 'AllowOrBlock')),
    });
  }
  return out;
}

/** GetAttachDevice (legacy): "count@1;ip;name;mac;type;rate;signal;allowOrBlock@2;..." */
export function parseAttach1(xml) {
  const raw = tag(xml, 'NewAttachDevice');
  if (!raw) return [];
  const entries = raw.split('@').slice(1);
  const out = [];
  for (const entry of entries) {
    const f = entry.split(';');
    const mac = normalizeMac(f[3]);
    if (!mac) continue;
    out.push({
      mac,
      ip: f[1] || null,
      name: f[2] && f[2] !== '<unknown>' ? f[2] : null,
      connectionType: f[4] || null,
      allowOrBlock: normAllowBlock(f[7]),
    });
  }
  return out;
}
