/**
 * Mulberry32 seeded PRNG. Pure integer arithmetic, so results are identical
 * across JS engines (browser and Node), which server-side replay relies on.
 */
export interface RandomResult {
  value: number;
  state: number;
}

export function nextRandom(state: number): RandomResult {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

export function normalizeSeed(seed: number): number {
  return Math.floor(seed) | 0;
}
