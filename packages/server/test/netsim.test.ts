import { LEAD_POLICY, LeadController, MATCH_CONFIG, type WireInput } from '@brick-riot/shared';
import { describe, expect, it } from 'vitest';
import { MatchEngine } from '../src/match/MatchEngine';
import { quickBoard } from './helpers';

/**
 * Deterministic network simulation: the REAL MatchEngine on a simulated
 * clock, a simulated client running the REAL LeadController, and a network
 * with latency, jitter, loss (modelled as TCP retransmission spikes: the
 * WebSocket transport is TCP, so a lost packet arrives late rather than never)
 * and client frame stalls. Measures late inputs with a fixed lead (Phase 3/4)
 * versus the adaptive lead (Phase 5).
 */
interface Conditions {
  /** One-way base latency (ms). */
  latencyMs: number;
  /** Extra uniform random delay per message (ms). */
  jitterMs: number;
  /** Chance a message hits a retransmission spike... */
  spikeChance: number;
  /** ...of this many ms. */
  spikeMs: number;
  /** Chance a client frame stalls (starved CPU, GC)... */
  stallChance: number;
  /** ...for this long (ms). */
  stallMs: number;
}

interface SimResult {
  lateRatio: number;
  inputs: number;
  meanLeadTicks: number;
  maxLeadTicks: number;
  finalExtra: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulate(c: Conditions, adaptive: boolean, seconds = 60, seed = 7): SimResult {
  const tps = MATCH_CONFIG.tickRate;
  const engine = new MatchEngine(
    [
      { seat: 'A', board: quickBoard('a', ['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS']), seed: 1 },
      { seat: 'B', board: quickBoard('b'), seed: 2 },
    ],
    { durationTicks: (seconds + 5) * tps },
  );
  const random = rng(seed);
  const lead = new LeadController(LEAD_POLICY, adaptive);
  const rtt = 2 * c.latencyMs + c.jitterMs;
  const delay = () => c.latencyMs + random() * c.jitterMs + (random() < c.spikeChance ? c.spikeMs : 0);
  const serverTickAt = (ms: number) => Math.floor((ms * tps) / 1000);

  // In-flight messages (TCP keeps order per direction).
  const uplink: { at: number; inputs: WireInput[]; seq: number }[] = [];
  const downlink: { at: number; late: number; margin: number | null; inputs: number }[] = [];
  let lastUp = 0;
  let lastDown = 0;
  let seq = 0;
  let localTick = 0;
  const pending: WireInput[] = [];
  let lastFlush = 0;
  let nextFrame = 0;
  let nextServer = 0;
  let lastSyncIndex = 0;
  let leadSum = 0;
  let leadSamples = 0;
  let maxLead = 0;

  for (let now = 0; now < seconds * 1000; now++) {
    // Server loop (~60 Hz): apply arrived inputs, advance, send feedback with syncs.
    while (uplink.length > 0 && (uplink[0]?.at ?? Infinity) <= now) {
      const m = uplink.shift();
      if (m) engine.submitInputs('A', { seq: m.seq, inputs: m.inputs });
    }
    if (now >= nextServer) {
      nextServer += 1000 / 60;
      engine.advanceTo(serverTickAt(now));
      const syncIndex = Math.floor(engine.tick / MATCH_CONFIG.syncEveryTicks);
      if (syncIndex > lastSyncIndex) {
        lastSyncIndex = syncIndex;
        const f = engine.takeLeadFeedback('A');
        lastDown = Math.max(lastDown, now + delay());
        downlink.push({ at: lastDown, ...f });
      }
    }
    // Client receives feedback.
    while (downlink.length > 0 && (downlink[0]?.at ?? Infinity) <= now) {
      const f = downlink.shift();
      if (f) lead.onFeedback(f, now);
    }
    // Client frames (~60 Hz, sometimes stalled).
    if (now >= nextFrame) {
      nextFrame = now + (random() < c.stallChance ? c.stallMs : 1000 / 60);
      const leadTicks = lead.leadTicks(rtt, tps);
      leadSum += leadTicks;
      leadSamples++;
      maxLead = Math.max(maxLead, leadTicks);
      const target = Math.floor(serverTickAt(now) + leadTicks);
      while (localTick < target) {
        localTick++;
        pending.push([localTick, 240, 0, 0]);
      }
      if (pending.length > 0 && (now - lastFlush >= 33 || pending.length >= 8)) {
        while (pending.length > 0) {
          lastUp = Math.max(lastUp, now + delay());
          uplink.push({ at: lastUp, inputs: pending.splice(0, MATCH_CONFIG.maxInputsPerMessage), seq: seq++ });
        }
        lastFlush = now;
      }
    }
  }
  const timing = engine.inputTiming('A');
  return {
    lateRatio: timing.inputs > 0 ? timing.late / timing.inputs : 0,
    inputs: timing.inputs,
    meanLeadTicks: leadSum / Math.max(1, leadSamples),
    maxLeadTicks: maxLead,
    finalExtra: lead.extraTicks,
  };
}

const CLEAN: Conditions = { latencyMs: 15, jitterMs: 0, spikeChance: 0, spikeMs: 0, stallChance: 0, stallMs: 0 };
const JITTERY: Conditions = { latencyMs: 40, jitterMs: 60, spikeChance: 0.02, spikeMs: 220, stallChance: 0, stallMs: 0 };
const STARVED: Conditions = { latencyMs: 5, jitterMs: 10, spikeChance: 0, spikeMs: 0, stallChance: 0.06, stallMs: 120 };

describe('adaptive input lead (simulated network)', () => {
  it('on a clean connection the adaptive lead stays within a few ticks of the fixed one (no blind growth)', () => {
    const fixed = simulate(CLEAN, false, 30);
    const adaptive = simulate(CLEAN, true, 30);
    console.log('netsim clean', { fixed, adaptive });
    expect(fixed.lateRatio).toBeLessThan(0.01);
    expect(adaptive.lateRatio).toBeLessThanOrEqual(fixed.lateRatio);
    // At most ~25 ms more lead, and only because the server reported late inputs.
    expect(adaptive.meanLeadTicks).toBeLessThan(fixed.meanLeadTicks + 3);
    expect(adaptive.finalExtra).toBeLessThanOrEqual(3);
  });

  it('with jitter and loss spikes the adaptive lead cuts late inputs sharply, staying under the cap', () => {
    const fixed = simulate(JITTERY, false);
    const adaptive = simulate(JITTERY, true);
    console.log('netsim jitter', { fixed, adaptive });
    expect(fixed.lateRatio).toBeGreaterThan(0.03);
    expect(adaptive.lateRatio).toBeLessThan(fixed.lateRatio / 2);
    expect(adaptive.maxLeadTicks).toBeLessThanOrEqual(LEAD_POLICY.maxTicks);
  });

  it('with client frame stalls (starved CPU) the adaptive lead also reduces late inputs', () => {
    const fixed = simulate(STARVED, false);
    const adaptive = simulate(STARVED, true);
    console.log('netsim stalls', { fixed, adaptive });
    expect(fixed.lateRatio).toBeGreaterThan(0.03);
    expect(adaptive.lateRatio).toBeLessThan(fixed.lateRatio);
    // Stalls longer than any sane lead can never be fully hidden: the cap still holds.
    expect(adaptive.maxLeadTicks).toBeLessThanOrEqual(LEAD_POLICY.maxTicks);
  });

  it('is deterministic for a given seed', () => {
    expect(simulate(JITTERY, true, 10, 3)).toEqual(simulate(JITTERY, true, 10, 3));
  });
});

describe('lead controller', () => {
  it('raises on reported late inputs, decays slowly after sustained comfortable margins, and respects caps', () => {
    const c = new LeadController();
    c.onFeedback({ late: 2, margin: -1, inputs: 6 }, 0);
    expect(c.extraTicks).toBe(LEAD_POLICY.raiseTicks);
    for (let i = 0; i < 100; i++) c.onFeedback({ late: 1, margin: 0, inputs: 6 }, i);
    expect(c.extraTicks).toBe(LEAD_POLICY.maxExtraTicks);
    c.onFeedback({ late: 0, margin: 20, inputs: 6 }, 1000);
    c.onFeedback({ late: 0, margin: 20, inputs: 6 }, 1000 + LEAD_POLICY.lowerAfterMs - 1);
    expect(c.extraTicks).toBe(LEAD_POLICY.maxExtraTicks);
    c.onFeedback({ late: 0, margin: 20, inputs: 6 }, 1000 + LEAD_POLICY.lowerAfterMs);
    expect(c.extraTicks).toBe(LEAD_POLICY.maxExtraTicks - 1);
    expect(c.leadTicks(10_000, 120)).toBe(LEAD_POLICY.maxTicks);
    expect(new LeadController(LEAD_POLICY, false).leadTicks(0, 120)).toBeGreaterThanOrEqual(LEAD_POLICY.minTicks);
  });

  it('the lead cap leaves room for server-scheduled ability effects (48-tick delay)', () => {
    expect(LEAD_POLICY.maxTicks).toBeLessThan(48);
  });
});
