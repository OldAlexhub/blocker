import { NetgearSoapAdapter } from './netgearSoap.js';
import { MockRouterAdapter } from './mockAdapter.js';

export function createRouterAdapter(config, protection, logger) {
  const isProtectedMac = (mac) => protection.isProtectedMac(mac);
  if (config.routerAdapter === 'mock') return new MockRouterAdapter({ isProtectedMac });
  return new NetgearSoapAdapter({
    host: config.routerHost,
    port: config.routerPort,
    username: config.routerUsername,
    password: config.routerPassword,
    timeoutMs: config.routerTimeoutMs,
    isProtectedMac,
    logger,
  });
}
