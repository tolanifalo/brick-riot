/**
 * Adaptive input lead (Phase 5).
 *
 * The client simulates ahead of the server so its inputs arrive before the
 * server needs them. Phase 3/4 used a fixed lead (RTT/2 + 40 ms). Under CPU
 * starvation or network jitter that was often too small: ~20% of inputs arrived
 * late, each causing a misprediction and a resync.
 *
 * This controller reacts to what the SERVER observes (late inputs and the
 * smallest arrival margin, sent with every sync), not to guesses:
 * - any late input  -> raise the extra lead by `raiseTicks` (fast reaction);
 * - margins comfortably above target for `lowerAfterMs` -> lower it by one
 *   tick (slow decay), so the lead never grows without evidence.
 * The lead is capped below the ability apply delay (48 ticks) so server-
 * scheduled effects still reach the client before it simulates them.
 *
 * A larger lead does NOT delay local controls: the local simulation still
 * applies input immediately; the lead only changes how far ahead it runs.
 */
export interface LeadFeedback {
  /** Inputs that arrived after the server had simulated their tick. */
  late: number;
  /** Smallest (tick - serverTick) at arrival among accepted inputs; null if none. */
  margin: number | null;
  inputs: number;
}

export interface LeadPolicy {
  /** Fixed safety added to RTT/2 (milliseconds). */
  baseMs: number;
  minTicks: number;
  /** Hard cap on the total lead (ticks): must stay below the 48-tick ability delay. */
  maxTicks: number;
  maxExtraTicks: number;
  raiseTicks: number;
  /** Margins above this (ticks) count as comfortable. */
  comfortableMarginTicks: number;
  lowerAfterMs: number;
}

export const LEAD_POLICY: LeadPolicy = {
  baseMs: 40,
  minTicks: 3,
  maxTicks: 36,
  maxExtraTicks: 24,
  raiseTicks: 3,
  // Lowering by one tick still leaves >= 2 ticks of margin, so the lead
  // settles at the smallest value that keeps inputs on time.
  comfortableMarginTicks: 3,
  lowerAfterMs: 3000,
};

export class LeadController {
  /** Extra ticks of lead on top of the RTT-based estimate. */
  extraTicks = 0;
  /** Diagnostics. */
  readonly stats = { raises: 0, lowers: 0, lateReported: 0, lastMargin: null as number | null };
  private comfortableSince: number | null = null;

  constructor(
    private readonly policy: LeadPolicy = LEAD_POLICY,
    private readonly adaptive = true,
  ) {}

  onFeedback(f: LeadFeedback, nowMs: number): void {
    this.stats.lateReported += f.late;
    this.stats.lastMargin = f.margin;
    if (!this.adaptive) return;
    if (f.late > 0) {
      this.extraTicks = Math.min(this.policy.maxExtraTicks, this.extraTicks + this.policy.raiseTicks);
      this.stats.raises++;
      this.comfortableSince = null;
      return;
    }
    if (f.margin === null || f.margin <= this.policy.comfortableMarginTicks) {
      this.comfortableSince = null;
      return;
    }
    this.comfortableSince ??= nowMs;
    if (nowMs - this.comfortableSince >= this.policy.lowerAfterMs && this.extraTicks > 0) {
      this.extraTicks--;
      this.stats.lowers++;
      this.comfortableSince = nowMs;
    }
  }

  /** Total lead in ticks for the current round-trip time. */
  leadTicks(rttMs: number, ticksPerSecond: number): number {
    const base = ((rttMs / 2 + this.policy.baseMs) * ticksPerSecond) / 1000;
    return Math.min(this.policy.maxTicks, Math.max(this.policy.minTicks, base + this.extraTicks));
  }
}
