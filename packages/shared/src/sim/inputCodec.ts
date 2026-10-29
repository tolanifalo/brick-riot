import type { TickInput } from './types';

/**
 * Compact, lossless encoding of a solo input log for upload and storage.
 * Consecutive identical inputs collapse into one run: [count, targetX, axis, launch].
 * targetX is kept as the exact number the simulation consumed (JSON round-trips
 * doubles exactly), so replays stay bit-identical. Server commands (`ext`) are
 * never part of a solo log and are rejected.
 */
export type EncodedRun = [count: number, targetX: number | null, axis: -1 | 0 | 1, launch: 0 | 1];

/** 15 minutes at 120 Hz: longer solo runs are not accepted. */
export const MAX_SOLO_TICKS = 15 * 60 * 120;

export function encodeInputLog(inputs: readonly TickInput[]): EncodedRun[] {
  const out: EncodedRun[] = [];
  for (const input of inputs) {
    const axis: -1 | 0 | 1 = input.axis < 0 ? -1 : input.axis > 0 ? 1 : 0;
    const launch: 0 | 1 = input.launch ? 1 : 0;
    const last = out[out.length - 1];
    if (last && last[1] === input.targetX && last[2] === axis && last[3] === launch) last[0]++;
    else out.push([1, input.targetX, axis, launch]);
  }
  return out;
}

export type DecodeError = 'malformed' | 'too_long';

/** Validates and expands an untrusted encoded log. Never throws. */
export function decodeInputLog(raw: unknown): { ok: true; inputs: TickInput[] } | { ok: false; error: DecodeError } {
  if (!Array.isArray(raw)) return { ok: false, error: 'malformed' };
  const inputs: TickInput[] = [];
  for (const run of raw as unknown[]) {
    if (!Array.isArray(run) || run.length !== 4) return { ok: false, error: 'malformed' };
    const [count, targetX, axis, launch] = run as unknown[];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return { ok: false, error: 'malformed' };
    if (targetX !== null && (typeof targetX !== 'number' || !Number.isFinite(targetX) || Math.abs(targetX) > 10_000)) {
      return { ok: false, error: 'malformed' };
    }
    if (axis !== -1 && axis !== 0 && axis !== 1) return { ok: false, error: 'malformed' };
    if (launch !== 0 && launch !== 1) return { ok: false, error: 'malformed' };
    if (inputs.length + count > MAX_SOLO_TICKS) return { ok: false, error: 'too_long' };
    for (let i = 0; i < count; i++) inputs.push({ targetX: targetX as number | null, axis, launch: launch === 1 });
  }
  return { ok: true, inputs };
}
