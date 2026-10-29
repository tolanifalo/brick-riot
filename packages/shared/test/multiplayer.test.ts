import { describe, expect, it } from 'vitest';
import { evaluatePairing, verifyForRating } from '../src/competitive/pairing';
import type { QueueEntry } from '../src/competitive/types';
import { CAMPAIGN_BOARDS, CLASSIC_02, getCampaignBoard } from '../src/levels/classic';
import { validateBoard } from '../src/levels/schema';
import {
  checkBoardChoice,
  getMatchBoard,
  getMultiplayerProfile,
  MULTIPLAYER_BOARDS,
  MULTIPLAYER_VARIANTS,
  selectableBoards,
  variantBaseId,
  type MultiplayerBoardProfile,
} from '../src/multiplayer/boards';
import { evaluateCompatibility, firstClearProbability } from '../src/multiplayer/compatibility';
import { createAutoplayer } from '../src/tools/autoplayer';
import { encodeInput, parseInputBatch, sanitizeName } from '../src/multiplayer/protocol';
import { stateChecksum } from '../src/sim/checksum';
import { Simulation } from '../src/sim/simulation';

const profile = (id: string): MultiplayerBoardProfile => {
  const p = getMultiplayerProfile(id);
  if (!p) throw new Error(id);
  return p;
};

describe('multiplayer board eligibility', () => {
  it('offers at least six eligible boards, all with measured completion data', () => {
    expect(MULTIPLAYER_BOARDS.length).toBeGreaterThanOrEqual(6);
    for (const p of MULTIPLAYER_BOARDS) {
      expect(p.expectedCompletionSeconds).not.toBeNull();
      expect(p.calibration).toBe('bot-estimate');
      expect(p.calibrationSamples).toBeGreaterThanOrEqual(16);
      expect(p.boardVersion).toBeGreaterThan(0);
      expect(p.allowedModifiers.length).toBeGreaterThan(0);
    }
  });

  it('excludes boards that cannot be finished within the timer or are too luck-dependent', () => {
    for (const id of ['classic-01', 'classic-04', 'classic-09', 'classic-11', 'classic-12']) {
      expect(profile(id).multiplayerEligible).toBe(false);
    }
  });

  it('derives mechanics and bands from the board data', () => {
    expect(profile('classic-08').mechanics).toContain('moving');
    expect(profile('classic-05').band).toBe('sprint');
    expect(profile('classic-10').band).toBe('standard');
    // Unmeasured boards are treated as long.
    expect(profile('classic-01').band).toBe('marathon');
  });

  it('checks unlocks from claimed progress, except in dev rooms', () => {
    const fresh = { clearedBoardIds: [], xp: 0 };
    expect(checkBoardChoice('classic-02', fresh, false)).toEqual({ ok: false, error: 'locked' });
    expect(checkBoardChoice('classic-02', { clearedBoardIds: ['classic-01'], xp: 0 }, false).ok).toBe(true);
    expect(checkBoardChoice('classic-02', fresh, true).ok).toBe(true);
    expect(checkBoardChoice('classic-01', fresh, true)).toEqual({ ok: false, error: 'not_multiplayer_eligible' });
    expect(checkBoardChoice('bogus', fresh, true)).toEqual({ ok: false, error: 'unknown_board' });
    expect(selectableBoards(fresh, false)).toEqual([]);
    expect(selectableBoards(fresh, true).length).toBe(MULTIPLAYER_BOARDS.length);
  });
});

describe('board compatibility', () => {
  it('the same board is always compatible', () => {
    const r = evaluateCompatibility(profile('classic-03'), profile('classic-03'), 120);
    expect(r.compatible).toBe(true);
    expect(r.expectedTimeRatio).toBe(1);
  });

  it('accepts boards whose expected times are within 15%', () => {
    const r = evaluateCompatibility(profile('classic-05'), profile('classic-08'), 120);
    expect(r.compatible).toBe(true);
    expect(r.expectedTimeRatio).toBeLessThanOrEqual(1.15);
    expect(r.warnings).toContain('The boards use different special bricks.');
  });

  it('yields exactly the documented compatible pairs of different boards (BALANCE_CONFIG.md)', () => {
    const pairs: string[] = [];
    MULTIPLAYER_BOARDS.forEach((a, i) =>
      MULTIPLAYER_BOARDS.slice(i + 1).forEach((b) => {
        if (evaluateCompatibility(a, b, 120).compatible) pairs.push(`${a.boardId}+${b.boardId}`);
      }),
    );
    expect(pairs).toEqual([
      'classic-05+classic-08',
      'classic-07+classic-10',
      'classic-10+classic-07-mp',
      'classic-07-mp+classic-10-mp',
    ]);
  });

  it('rejects pairs the median ratio alone would pass, when low variance makes one board win almost every race', () => {
    const base = { ...profile('classic-08'), difficulty: 5, mechanics: [] };
    // Medians 10% apart (inside the 15% ratio limit), but both boards are very consistent.
    const fast = { ...base, boardId: 'fast', expectedCompletionSeconds: 60, completionIqrSeconds: 4, completionDeciles: [56, 57, 58, 59, 60, 60, 61, 62, 63, 64] };
    const slow = { ...base, boardId: 'slow', expectedCompletionSeconds: 66, completionIqrSeconds: 4, completionDeciles: [62, 63, 64, 65, 66, 66, 67, 68, 69, 70] };
    const r = evaluateCompatibility(fast, slow, 120);
    expect(r.expectedTimeRatio).toBeCloseTo(1.1);
    expect(r.firstClearProbability).toBeGreaterThan(0.9);
    expect(r.compatible).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/clears first/);
    // With realistic spread the same medians are a fair race.
    const wide = (d: number[]) => d.map((v, i) => v + (i - 4.5) * 8);
    const fair = evaluateCompatibility(
      { ...fast, completionDeciles: wide(fast.completionDeciles) },
      { ...slow, completionDeciles: wide(slow.completionDeciles) },
      120,
    );
    expect(fair.compatible).toBe(true);
  });

  it('estimates first-to-clear from distributions, consistent with the measured pairs', () => {
    expect(firstClearProbability([1, 2, 3], [1, 2, 3])).toBe(0.5);
    expect(firstClearProbability([1, 1], [2, 2])).toBe(1);
    // BOARD_COMPATIBILITY.md: 48-seed sample estimates 0.49 (05 vs 08) and 0.62 (02 vs 07).
    const p0508 = evaluateCompatibility(profile('classic-05'), profile('classic-08'), 120).firstClearProbability ?? 0;
    expect(Math.abs(p0508 - 0.49)).toBeLessThan(0.06);
    const p0207 = evaluateCompatibility(profile('classic-02'), profile('classic-07'), 120).firstClearProbability ?? 0;
    expect(Math.abs(p0207 - 0.62)).toBeLessThan(0.06);
  });

  it('rejects boards with very different expected times', () => {
    const r = evaluateCompatibility(profile('classic-03'), profile('classic-10'), 120);
    expect(r.compatible).toBe(false);
    expect(r.problems.join()).toMatch(/differ by/);
  });

  it('never claims ranked eligibility for bot-estimated data', () => {
    const r = evaluateCompatibility(profile('classic-05'), profile('classic-05'), 120);
    expect(r.calibration).toBe('estimated');
    expect(r.rankedEligible).toBe(false);
    const human = { ...profile('classic-05'), calibration: 'human-playtest' as const };
    expect(evaluateCompatibility(human, human, 120).rankedEligible).toBe(true);
  });

  it('refuses to call boards balanced without data', () => {
    const unknown = { ...profile('classic-05'), boardId: 'x', expectedCompletionSeconds: null, calibration: 'none' as const };
    const r = evaluateCompatibility(unknown, profile('classic-08'), 120);
    expect(r.compatible).toBe(false);
    expect(r.calibration).toBe('uncalibrated');
  });

  it('warns about timer pressure and high variance', () => {
    const r = evaluateCompatibility(profile('classic-07'), profile('classic-10'), 120);
    expect(r.warnings.join(' ')).toMatch(/timer/);
    const v = evaluateCompatibility(profile('classic-03'), profile('classic-03'), 120);
    expect(v.warnings.join(' ')).toMatch(/variance/);
  });
});

describe('multiplayer board variants', () => {
  it('are versioned, valid, separate from the campaign, and unlock with their base board', () => {
    expect(MULTIPLAYER_VARIANTS.map((b) => `${b.id}@${b.version}`)).toEqual(['classic-07-mp@1', 'classic-10-mp@1']);
    for (const variant of MULTIPLAYER_VARIANTS) {
      expect(validateBoard(variant)).toEqual([]);
      expect(getCampaignBoard(variant.id)).toBeUndefined();
      expect(CAMPAIGN_BOARDS.some((b) => b.id === variant.id)).toBe(false);
      const base = getCampaignBoard(variantBaseId(variant.id) ?? '');
      expect(base).toBeDefined();
      expect(variant.unlock).toEqual(base?.unlock);
      expect(variant.mastery).toEqual([]);
      expect(getMatchBoard(variant.id)).toBe(variant);
      expect(profile(variant.id)).toMatchObject({ variantOf: base?.id, multiplayerEligible: true, calibration: 'bot-estimate' });
    }
    const locked = { clearedBoardIds: ['classic-01', 'classic-02', 'classic-03', 'classic-04', 'classic-05'], xp: 0 };
    expect(checkBoardChoice('classic-07-mp', locked, false)).toEqual({ ok: false, error: 'locked' });
    const unlocked = { ...locked, clearedBoardIds: [...locked.clearedBoardIds, 'classic-06'] };
    expect(checkBoardChoice('classic-07-mp', unlocked, false).ok).toBe(true);
  });

  it('leave the campaign boards themselves untouched', () => {
    expect(getCampaignBoard('classic-07')?.layout[0]).toBe('..HHHHHH..');
    expect(getCampaignBoard('classic-10')?.layout[3]).toBe('RRRRRRRRRR');
  });

  it('replay deterministically like any other board', () => {
    const board = getMatchBoard('classic-10-mp');
    if (!board) throw new Error('missing variant');
    const run = () => {
      const sim = new Simulation(board, { seed: 9 });
      const bot = createAutoplayer('win');
      for (let i = 0; i < 3000 && !sim.isOver; i++) sim.step(bot(sim));
      return stateChecksum(sim.state);
    };
    expect(run()).toBe(run());
  });
});

describe('protocol', () => {
  it('round-trips inputs through the wire format', () => {
    const wire = encodeInput(42, { targetX: 123.456, axis: -1, launch: true });
    const parsed = parseInputBatch({ seq: 0, inputs: [wire] });
    expect(parsed).toEqual({
      ok: true,
      batch: { seq: 0, inputs: [{ tick: 42, input: { targetX: 123.456, axis: -1, launch: true } }], rejected: [] },
    });
  });

  it('sanitises display names', () => {
    expect(sanitizeName('  Ace<script>  ')).toBe('Acescript');
    expect(sanitizeName('')).toBe('PLAYER');
    expect(sanitizeName(42)).toBe('PLAYER');
    expect(sanitizeName('a'.repeat(40))).toHaveLength(16);
  });

  it('state checksums match for equal states and survive JSON transport', () => {
    const a = new Simulation(CLASSIC_02, { seed: 5 });
    const b = new Simulation(CLASSIC_02, { seed: 5 });
    const step = { targetX: 200, axis: 0, launch: true };
    for (let i = 0; i < 300; i++) {
      a.step(step);
      b.step(step);
    }
    expect(stateChecksum(a.state)).toBe(stateChecksum(b.state));
    expect(stateChecksum(JSON.parse(JSON.stringify(a.state)))).toBe(stateChecksum(a.state));
    b.step(step);
    expect(stateChecksum(b.state)).not.toBe(stateChecksum(a.state));
  });

  it('a simulation restored from transported state continues identically', () => {
    const live = new Simulation(CLASSIC_02, { seed: 9 });
    const input = (t: number) => ({ targetX: 100 + (t % 280), axis: 0, launch: t % 50 === 0 });
    for (let t = 1; t <= 600; t++) live.step(input(t));
    const restored = new Simulation(CLASSIC_02, { seed: 9 });
    restored.state = JSON.parse(JSON.stringify(live.state));
    for (let t = 601; t <= 1500; t++) {
      live.step(input(t));
      restored.step(input(t));
    }
    expect(stateChecksum(restored.state)).toBe(stateChecksum(live.state));
  });
});

describe('ranked pairing foundation', () => {
  const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
    playerId: 'p',
    rating: { playerId: 'p', mmr: 1500, deviation: 50, volatility: 0.06, gamesPlayed: 30, placementRemaining: 0, lastPlayedAt: null },
    experience: { level: 20, xp: 10_000 },
    verifiedBoardIds: ['classic-05', 'classic-08'],
    preferredBoardId: 'classic-05',
    equipment: { power: 0, band: 0, components: [] },
    enqueuedAt: 0,
    ...over,
  });

  it('checks each priority separately and never blends them into one score', () => {
    const r = evaluatePairing(entry(), entry({ playerId: 'q' }), 1000);
    expect(Object.keys(r).sort()).toEqual(['acceptable', 'beginner', 'boards', 'equipment', 'skill']);
    expect(r.skill.ok && r.equipment.ok && r.beginner.ok).toBe(true);
    // Boards fail: only bot-estimated data exists, so nothing is ranked-eligible yet.
    expect(r.boards.ok).toBe(false);
    expect(r.acceptable).toBe(false);
  });

  it('a skill mismatch fails regardless of everything else', () => {
    const strong = entry({ rating: { ...entry().rating, mmr: 2200 } });
    expect(evaluatePairing(entry(), strong, 1000).skill.ok).toBe(false);
    // Waiting widens the window, up to a cap.
    expect(evaluatePairing(entry(), strong, 10_000_000).skill.ok).toBe(false);
    const closer = entry({ rating: { ...entry().rating, mmr: 1800 } });
    expect(evaluatePairing(entry(), closer, 1000).skill.ok).toBe(false);
    expect(evaluatePairing(entry(), closer, 60_000).skill.ok).toBe(true);
  });

  it('protects beginners and requires comparable equipment', () => {
    const beginner = entry({ experience: { level: 2, xp: 100 } });
    expect(evaluatePairing(beginner, entry(), 1000).beginner.ok).toBe(false);
    const geared = entry({ equipment: { power: 50, band: 3, components: [] } });
    expect(evaluatePairing(entry(), geared, 1000).equipment.ok).toBe(false);
  });

  it('only fully verified results may ever affect ratings', () => {
    expect(verifyForRating('m', true, true, false).ratingEligible).toBe(false);
    expect(verifyForRating('m', true, true, true).ratingEligible).toBe(true);
  });
});
