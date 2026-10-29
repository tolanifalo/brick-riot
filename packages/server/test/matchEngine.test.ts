import {
  BALANCE,
  buildPlayerConfig,
  CLASSIC_02,
  CLASSIC_08,
  createAutoplayer,
  DEFAULT_LOADOUT,
  encodeInput,
  MATCH_CONFIG,
  NO_UPGRADES,
  stateChecksum,
  type Simulation,
  type TickInput,
} from '@brick-riot/shared';
import { describe, expect, it } from 'vitest';
import { MatchEngine } from '../src/match/MatchEngine';
import { engineFor, play, quickBoard, type Policy } from './helpers';

const T = MATCH_CONFIG.tickRate;

describe('independent simulations on different boards', () => {
  it('runs each player on their own board and seed', () => {
    const engine = engineFor(CLASSIC_02, CLASSIC_08);
    expect(engine.state('A').boardId).toBe('classic-02');
    expect(engine.state('B').boardId).toBe('classic-08');
    play(engine, { A: 'win', B: 'idle' }, 10 * T);
    // A has played; B never launched and still waits on its own serve.
    expect(engine.state('A').status).toBe('playing');
    expect(engine.state('A').score).toBeGreaterThan(0);
    expect(engine.state('B').status).toBe('ready');
    expect(engine.state('B').score).toBe(0);
    expect(engine.state('B').tick).toBe(engine.tick);
  });

  it('shares one clock: both simulations advance on every match tick', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(300);
    expect(engine.tick).toBe(300);
    expect(engine.state('A').tick).toBe(300);
    expect(engine.state('B').tick).toBe(300);
  });
});

describe('race rules', () => {
  it('first player to clear wins', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b', ['SSSSSSSSSS', 'RRRRRRRRRR']));
    play(engine, { A: 'win', B: 'idle' }, 120 * T);
    expect(engine.outcome).toMatchObject({ outcome: 'win', winnerSeat: 'A', reason: 'board_cleared' });
    expect(engine.outcome?.endTick).toBe(engine.slotInfo('A').completionTick);
  });

  it('a player who runs out of balls does not end the match; the other can still win', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    play(engine, { A: 'lose', B: 'win' }, 120 * T);
    const a = engine.slotInfo('A');
    const b = engine.slotInfo('B');
    expect(a.exhaustedTick).not.toBeNull();
    expect(b.completionTick).not.toBeNull();
    expect((b.completionTick ?? 0) > (a.exhaustedTick ?? 0)).toBe(true);
    expect(engine.outcome).toMatchObject({ outcome: 'win', winnerSeat: 'B', reason: 'board_cleared' });
  });

  it('both players running out of balls is a draw', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    play(engine, { A: 'lose', B: 'lose' }, 120 * T);
    expect(engine.outcome).toMatchObject({ outcome: 'draw', winnerSeat: null, reason: 'both_exhausted' });
    const end = engine.outcome?.endTick;
    expect(end).toBe(Math.max(engine.slotInfo('A').exhaustedTick ?? 0, engine.slotInfo('B').exhaustedTick ?? 0));
  });

  it('timer expiry without a clear is a draw, exactly at the duration tick', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'), 600);
    play(engine, { A: 'idle', B: 'idle' }, 10_000);
    expect(engine.outcome).toEqual({ outcome: 'draw', winnerSeat: null, reason: 'time_expired', endTick: 600 });
    expect(engine.tick).toBe(600);
  });

  it('clearing on the same authoritative tick is a draw', () => {
    // Identical boards, seeds and inputs => both clear on exactly the same tick.
    const engine = engineFor(quickBoard('a'), quickBoard('a'), 120 * T, [7, 7]);
    play(engine, { A: 'win', B: 'win' }, 120 * T);
    const a = engine.slotInfo('A').completionTick;
    expect(a).not.toBeNull();
    expect(engine.slotInfo('B').completionTick).toBe(a);
    expect(engine.outcome).toMatchObject({ outcome: 'draw', reason: 'same_tick_clear', endTick: a });
  });

  it('the earlier tick wins even when the other player is exactly one tick behind', () => {
    // Same board and seed; B's input stream is A's shifted one tick later.
    const delayed = () => {
      const bot = createAutoplayer('win');
      return (sim: Simulation, tick: number): TickInput =>
        tick === 1 ? { targetX: null, axis: 0, launch: false } : bot(sim);
    };
    // Measure each player's clear tick alone (the opponent idles).
    const solo = (policy: Policy, seat: 'A' | 'B') => {
      const e = engineFor(quickBoard('a'), quickBoard('a'), 120 * T, [7, 7]);
      play(e, seat === 'A' ? { A: policy, B: 'idle' } : { A: 'idle', B: policy }, 120 * T);
      return e.slotInfo(seat).completionTick;
    };
    const aAlone = solo('win', 'A');
    const bAlone = solo(delayed(), 'B');
    expect(aAlone).not.toBeNull();
    expect(bAlone).toBe((aAlone ?? 0) + 1);

    const engine = engineFor(quickBoard('a'), quickBoard('a'), 120 * T, [7, 7]);
    play(engine, { A: 'win', B: delayed() }, 120 * T);
    expect(engine.outcome).toEqual({ outcome: 'win', winnerSeat: 'A', reason: 'board_cleared', endTick: aAlone });
  });
});

describe('forfeit, abandonment and finality', () => {
  it('forfeit awards the opponent the win', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(200);
    engine.forfeit('B');
    expect(engine.outcome).toEqual({ outcome: 'win', winnerSeat: 'A', reason: 'forfeit', endTick: 200 });
  });

  it('abandonment cancels with no winner', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(50);
    engine.abandon();
    expect(engine.outcome).toMatchObject({ outcome: 'cancelled', winnerSeat: null, reason: 'both_disconnected' });
  });

  it('a decided match never changes: later clears, forfeits, inputs and ticks are ignored', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(100);
    engine.forfeit('A');
    const decided = engine.outcome;
    engine.forfeit('B');
    engine.abandon();
    engine.advanceTo(10_000);
    play(engine, { A: 'win', B: 'win' }, 10_000);
    expect(engine.outcome).toBe(decided);
    expect(engine.tick).toBe(100);
    expect(engine.submitInputs('B', { seq: 99, inputs: [[101, 240, 0, 1]] }).rejected).toEqual(['match_over']);
  });
});

describe('input validation', () => {
  it('rejects malformed, impossible and out-of-bounds inputs', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    expect(engine.submitInputs('A', null).rejected).toEqual(['malformed']);
    expect(engine.submitInputs('A', { seq: 'x', inputs: [] }).rejected).toEqual(['malformed']);
    expect(engine.submitInputs('A', { seq: 1, inputs: new Array(40).fill([1, 0, 0, 0]) }).rejected).toEqual(['too_many_inputs']);
    const report = engine.submitInputs('A', {
      seq: 2,
      inputs: [
        [1.5, 100, 0, 0],
        [2, Number.NaN, 0, 0],
        [3, 1e9, 0, 0],
        [4, 100, 2, 0],
        [5, 100, 0, 'yes'],
        [6, 'center', 0, 0],
        ['7', 100, 0, 0],
        [8, 100, 0],
      ],
    });
    expect(report.accepted).toBe(0);
    expect(report.rejected.sort()).toEqual(
      ['bad_axis', 'bad_launch', 'bad_target', 'bad_target', 'bad_target', 'bad_tick', 'bad_tick', 'malformed'].sort(),
    );
  });

  it('drops duplicate sequence numbers and duplicate ticks', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    expect(engine.submitInputs('A', { seq: 5, inputs: [[1, 100, 0, 0]] }).accepted).toBe(1);
    expect(engine.submitInputs('A', { seq: 5, inputs: [[2, 100, 0, 0]] }).rejected).toEqual(['duplicate_seq']);
    expect(engine.submitInputs('A', { seq: 4, inputs: [[3, 100, 0, 0]] }).rejected).toEqual(['duplicate_seq']);
    expect(engine.submitInputs('A', { seq: 6, inputs: [[1, 300, 0, 0]] }).rejected).toEqual(['duplicate_tick']);
  });

  it('rejects inputs stamped too far in the future', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    const r = engine.submitInputs('A', { seq: 1, inputs: [[MATCH_CONFIG.maxInputLeadTicks + 1, 100, 0, 0]] });
    expect(r.rejected).toEqual(['future_tick']);
  });

  it('applies a buffered input exactly on its tick, and moves the paddle within the sim bounds', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.submitInputs('A', { seq: 1, inputs: [[3, -400, 0, 0]] });
    engine.advanceTo(2);
    expect(engine.state('A').paddle.x).toBe(240);
    engine.advanceTo(3);
    expect(engine.state('A').paddle.x).toBeLessThan(240);
    engine.advanceTo(60);
    // The held target keeps moving the paddle; the simulation clamps it in the field.
    expect(engine.state('A').paddle.x).toBe(engine.state('A').paddle.width / 2);
  });

  it('applies a late launch on the next tick instead of dropping it', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(10);
    const r = engine.submitInputs('A', { seq: 1, inputs: [[5, null, 0, 1]] });
    expect(r.late).toBe(1);
    expect(engine.state('A').status).toBe('ready');
    engine.advanceTo(11);
    expect(engine.state('A').status).toBe('playing');
  });

  it('rate-limits launch actions', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    const inputs = Array.from({ length: 30 }, (_, i) => [i + 1, 240, 0, 1] as [number, number, number, number]);
    const r = engine.submitInputs('A', { seq: 1, inputs });
    expect(r.rejected.filter((x) => x === 'launch_rate')).toHaveLength(30 - MATCH_CONFIG.maxLaunchesPerSecond);
  });
});

describe('forged results', () => {
  it('no input can declare a clear: only destroying every brick in the simulation does', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    // A "malicious" client spams every legal input value; none of them is a completion claim.
    let seq = 0;
    for (let t = 1; t <= 600; t++) {
      engine.submitInputs('A', { seq: seq++, inputs: [[t, (t * 37) % 480, (t % 3) - 1, t % 2]] });
      engine.submitInputs('A', { seq: seq++, inputs: [[t, null, 0, 1], ['complete', true, 0, 0]] });
      engine.advanceTo(t);
    }
    const a = engine.state('A');
    if (engine.outcome?.winnerSeat === 'A') {
      // Only possible if the simulation genuinely destroyed every required brick.
      expect(a.requiredRemaining).toBe(0);
    } else {
      expect(a.requiredRemaining).toBeGreaterThan(0);
    }
  });
});

describe('verification', () => {
  it('replays each applied input log to the identical final state', () => {
    const engine = engineFor(CLASSIC_02, CLASSIC_08);
    play(engine, { A: 'win', B: 'lose' }, 40 * T);
    expect(engine.verifyReplays()).toBe(true);
    expect(engine.appliedInputs('A').length).toBe(engine.state('A').tick);
  });

  it('detects a state that its input log cannot reproduce', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    play(engine, { A: 'win', B: 'win' }, 5 * T);
    engine.state('B').score += 1000;
    expect(engine.verifyReplays()).toBe(false);
  });

  it('is deterministic: identical inputs give identical outcomes and checksums', () => {
    const run = () => {
      const engine = engineFor(CLASSIC_02, CLASSIC_08, 30 * T);
      play(engine, { A: 'win', B: 'win' }, 30 * T);
      return [engine.outcome, stateChecksum(engine.state('A')), stateChecksum(engine.state('B'))];
    };
    expect(run()).toEqual(run());
  });

  it('records a checksum at every sync interval', () => {
    const engine = engineFor(quickBoard('a'), quickBoard('b'));
    engine.advanceTo(13);
    expect(engine.latestHash('A').tick).toBe(12);
    expect(engine.latestHash('A').hash).toMatch(/^[0-9a-f]{8}$/);
    engine.advanceTo(18);
    expect(engine.latestHash('A')).toEqual({ tick: 18, hash: stateChecksum(engine.state('A')) });
  });
});

describe('abilities in the engine', () => {
  const charged = () => ({ ...buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual'), energy: { ...BALANCE.energy, max: 100, start: 100 } });
  const board = quickBoard('s', ['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS']);

  function mirrored() {
    return new MatchEngine(
      [
        { seat: 'A', board, seed: 7, config: charged() },
        { seat: 'B', board, seed: 7, config: charged() },
      ],
      { durationTicks: 180 * T },
    );
  }

  it('symmetric attacks on the same tick keep a same-tick clear a draw, and replays verify', () => {
    const engine = mirrored();
    const bots = { A: createAutoplayer('win'), B: createAutoplayer('win') };
    const seqs = { A: 0, B: 0 };
    const decisions: { accepted: boolean }[] = [];
    while (!engine.isOver && engine.tick < 180 * T) {
      const next = engine.tick + 1;
      if (next === 7 * T) {
        engine.queueAbility('A', { ability: 'emp', seq: 1, tick: next });
        engine.queueAbility('B', { ability: 'emp', seq: 1, tick: next });
      }
      decisions.push(...engine.resolveAbilities());
      for (const seat of ['A', 'B'] as const) {
        engine.submitInputs(seat, { seq: seqs[seat]++, inputs: [encodeInput(next, bots[seat](engine.sim(seat)))] });
      }
      engine.advanceTo(next);
    }
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.accepted)).toBe(true);
    const a = engine.slotInfo('A').completionTick;
    expect(a).not.toBeNull();
    expect(engine.slotInfo('B').completionTick).toBe(a);
    expect(engine.outcome).toMatchObject({ outcome: 'draw', reason: 'same_tick_clear' });
    expect(engine.verifyReplays()).toBe(true);
  });

  it('client-supplied ext on inputs is ignored; only the arbiter schedules commands', () => {
    const engine = mirrored();
    engine.submitInputs('A', { seq: 0, inputs: [[1, 240, 0, 1]], ext: [{ k: 'shield', untilTick: 99999 }] } as never);
    engine.advanceTo(5);
    expect(engine.state('A').shieldUntil).toBe(0);
    expect(engine.state('A').energy10).toBe(1000);
  });
});

describe('performance', () => {
  it('simulates a full two-player match far faster than real time', () => {
    const engine = engineFor(CLASSIC_02, CLASSIC_08);
    const start = performance.now();
    play(engine, { A: 'win', B: 'win' }, 120 * T);
    const ms = performance.now() - start;
    // 120 s of match in well under 2 s of CPU (the bots' own work included).
    expect(ms).toBeLessThan(2000);
  });
});
