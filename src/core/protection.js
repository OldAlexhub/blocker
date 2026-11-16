import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeMac } from './mac.js';

const execFileAsync = promisify(execFile);

/**
 * Devices that must never be blocked: this server, the router, and any
 * configured MACs. Enforced in the backend (reconciler + router adapter),
 * not just hidden in the UI.
 */
export class Protection {
  constructor({ macs = [], ips = [] } = {}) {
    this.macs = new Map();
    this.ips = new Map();
    for (const { mac, reason } of macs) {
      const m = normalizeMac(mac);
      if (m && !this.macs.has(m)) this.macs.set(m, reason);
    }
    for (const { ip, reason } of ips) if (ip && !this.ips.has(ip)) this.ips.set(ip, reason);
  }

  static async detect({ routerHost, extraMacs = [], logger } = {}) {
    const macs = [];
    const ips = [{ ip: routerHost, reason: 'Router' }];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const nic of list ?? []) {
        if (nic.internal) continue;
        if (nic.mac && nic.mac !== '00:00:00:00:00:00') macs.push({ mac: nic.mac, reason: 'This server (Nexus)' });
        if (nic.family === 'IPv4') ips.push({ ip: nic.address, reason: 'This server (Nexus)' });
      }
    }
    for (const mac of extraMacs) {
      if (normalizeMac(mac)) macs.push({ mac, reason: 'Listed in PROTECTED_MACS' });
      else logger?.warn({ mac }, 'Ignoring invalid MAC in PROTECTED_MACS');
    }
    const routerMac = await lookupArpMac(routerHost).catch(() => null);
    if (routerMac) macs.push({ mac: routerMac, reason: 'Router' });
    else logger?.warn('Could not read router MAC from ARP table; router stays protected by IP address');
    const p = new Protection({ macs, ips });
    logger?.info({ protectedMacs: [...p.macs.keys()], protectedIps: [...p.ips.keys()] }, 'Protected infrastructure detected');
    return p;
  }

  reasonFor(device) {
    const mac = normalizeMac(device?.mac_address ?? device?.mac);
    if (mac && this.macs.has(mac)) return this.macs.get(mac);
    const ip = device?.ip_address ?? device?.ip;
    if (ip && this.ips.has(ip)) return this.ips.get(ip);
    return null;
  }

  isProtectedMac(mac) {
    const m = normalizeMac(mac);
    return !!m && this.macs.has(m);
  }

  isProtected(device) {
    return !!device?.is_protected || this.reasonFor(device) !== null;
  }
}

async function lookupArpMac(ip) {
  if (!ip) return null;
  const { stdout } = await execFileAsync('arp', ['-a', ip], { timeout: 5000, windowsHide: true });
  const escaped = ip.replace(/\./g, '\\.');
  const m = new RegExp(`${escaped}\\s+([0-9a-fA-F]{2}[-:](?:[0-9a-fA-F]{2}[-:]){4}[0-9a-fA-F]{2})`).exec(stdout);
  return m ? normalizeMac(m[1]) : null;
}
