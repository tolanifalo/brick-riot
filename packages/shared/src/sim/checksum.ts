import type { SimState } from './types';

/** FNV-1a (32-bit) over a string. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Checksum of the complete simulation state. JSON number formatting is the
 * shortest round-trip representation in every engine, and the simulation
 * builds objects with a fixed key order, so equal states hash equally on the
 * server and in the browser. Used to detect client prediction divergence.
 */
export function stateChecksum(state: SimState): string {
  return fnv1a(JSON.stringify(state));
}
