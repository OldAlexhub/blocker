import { RouterAdapter, RouterError } from './RouterAdapter.js';
import { normalizeMac } from '../core/mac.js';

/**
 * In-memory router for tests and for trying the dashboard without touching
 * real hardware (ROUTER_ADAPTER=mock).
 */
export class MockRouterAdapter extends RouterAdapter {
  constructor({ devices, isProtectedMac } = {}) {
    super();
    this.isProtectedMac = isProtectedMac ?? (() => false);
    this.devices = new Map();
    this.offline = new Set();
    this.calls = [];
    this.down = false; // simulate router unreachable
    this.ignoreCommands = false; // simulate command accepted but not applied
    this.accessControl = true;
    for (const d of devices ?? MockRouterAdapter.sampleDevices()) {
      const mac = normalizeMac(d.mac);
      this.devices.set(mac, { allowOrBlock: 'Allow', connectionType: 'wireless', ...d, mac });
    }
  }

  static sampleDevices() {
    return [
      { mac: '02:11:22:33:44:01', ip: '192.168.0.20', name: 'Kids-PC', connectionType: 'wired' },
      { mac: '02:11:22:33:44:02', ip: '192.168.0.21', name: 'Tablet' },
      { mac: '02:11:22:33:44:03', ip: '192.168.0.22', name: 'Living-Room-TV' },
    ];
  }

  #check(op) {
    this.calls.push(op);
    if (this.down) throw new RouterError('unreachable', 'Mock router is down');
  }

  async authenticate() {
    this.#check('authenticate');
  }
  async healthCheck() {
    this.#check('healthCheck');
    return { model: 'MOCK', firmware: '0.0.0' };
  }
  async getConnectedDevices() {
    this.#check('getConnectedDevices');
    return [...this.devices.values()].filter((d) => !this.offline.has(d.mac)).map((d) => ({ ...d }));
  }
  async getDeviceRestrictionState(mac) {
    this.#check('getDeviceRestrictionState');
    const m = normalizeMac(mac);
    if (this.offline.has(m)) return null;
    return this.devices.get(m)?.allowOrBlock ?? null;
  }
  async getAccessControlEnabled() {
    this.#check('getAccessControlEnabled');
    return this.accessControl;
  }
  async getRouterHealth() {
    this.#check('getRouterHealth');
    const t = (d, u) => ({ downloadMb: d, uploadMb: u });
    return {
      cpuPercent: this.cpuPercent ?? 23,
      memoryPercent: 61,
      memoryTotalMb: 256,
      traffic: { today: t(1250.5, 88.2), yesterday: t(4210, 302), week: t(9800, 700), month: t(31000, 2100), lastMonth: t(52000, 3900) },
      trafficMeterEnabled: true,
    };
  }
  async rebootRouter() {
    this.#check('rebootRouter');
  }
  async #set(mac, value) {
    this.#check(`${value === 'Block' ? 'block' : 'unblock'}:${normalizeMac(mac)}`);
    const m = normalizeMac(mac);
    if (value === 'Block' && this.isProtectedMac(m)) throw new RouterError('refused', 'protected');
    if (this.ignoreCommands) return;
    const d = this.devices.get(m) ?? { mac: m, ip: null, name: null, connectionType: null };
    this.devices.set(m, { ...d, allowOrBlock: value });
  }
  blockDevice(mac) {
    return this.#set(mac, 'Block');
  }
  unblockDevice(mac) {
    return this.#set(mac, 'Allow');
  }
}
