/**
 * Contract between the app and a router. Everything router-specific lives
 * behind this interface so the router can be swapped without touching the
 * scheduler, database, or dashboard.
 *
 * Device objects returned by getConnectedDevices():
 *   { mac: 'AA:BB:..', ip: string|null, name: string|null,
 *     connectionType: string|null, allowOrBlock: 'Allow'|'Block'|null }
 */
export class RouterError extends Error {
  /** code: unreachable | timeout | auth | unauthorized | bad_response | unsupported | refused */
  constructor(code, message, cause) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export class RouterAdapter {
  async authenticate() {
    throw new RouterError('unsupported', 'authenticate() not supported by this adapter');
  }
  /** @returns {Promise<{model?:string, firmware?:string}>} */
  async healthCheck() {
    throw new RouterError('unsupported', 'healthCheck() not supported by this adapter');
  }
  async getConnectedDevices() {
    throw new RouterError('unsupported', 'getConnectedDevices() not supported by this adapter');
  }
  /** @returns {Promise<'Allow'|'Block'|null>} null = device not currently listed by the router */
  async getDeviceRestrictionState(_mac) {
    throw new RouterError('unsupported', 'getDeviceRestrictionState() not supported by this adapter');
  }
  /** @returns {Promise<boolean|null>} null = router cannot tell us */
  async getAccessControlEnabled() {
    return null;
  }
  /**
   * @returns {Promise<{cpuPercent:number|null, memoryPercent:number|null, memoryTotalMb:number|null,
   *   traffic: null | Record<'today'|'yesterday'|'week'|'month'|'lastMonth', {downloadMb:number|null, uploadMb:number|null}>,
   *   trafficMeterEnabled: boolean|null}>}
   */
  async getRouterHealth() {
    throw new RouterError('unsupported', 'getRouterHealth() not supported by this adapter');
  }
  /** Restart the router. Interrupts the whole network for a few minutes. */
  async rebootRouter() {
    throw new RouterError('unsupported', 'rebootRouter() not supported by this adapter');
  }
  async blockDevice(_mac) {
    throw new RouterError('unsupported', 'blockDevice() not supported by this adapter');
  }
  async unblockDevice(_mac) {
    throw new RouterError('unsupported', 'unblockDevice() not supported by this adapter');
  }
}
