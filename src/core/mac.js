/** Normalize any MAC notation to "AA:BB:CC:DD:EE:FF". Returns null if invalid. */
export function normalizeMac(value) {
  if (!value) return null;
  const hex = String(value).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  if (hex === '000000000000' || hex === 'FFFFFFFFFFFF') return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Locally-administered MAC (second-lowest bit of first octet set).
 * Phones/PCs using "private/random Wi-Fi address" show up this way.
 */
export function isRandomizedMac(mac) {
  const m = normalizeMac(mac);
  if (!m) return false;
  return (Number.parseInt(m.slice(0, 2), 16) & 0x02) === 0x02;
}
