import { describe, expect, it } from 'vitest';
import { ECONOMY, levelForXp } from '../src/config/economy';
import { CAMPAIGN_BOARDS, CLASSIC_01, CLASSIC_02 } from '../src/levels/classic';
import {
  applyRunResult,
  computeStars,
  isObjectiveMet,
  repeatMultiplier,
  type RunResult,
} from '../src/progress/results';
import { createEmptyProgress } from '../src/progress/save';
import { isBoardUnlocked } from '../src/progress/unlocks';
import type { RunSummary } from '../src/sim/replay';

const NOW = '2026-10-24T12:00:00.000Z';
let nextId = 0;

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    boardId: CLASSIC_01.id,
    boardVersion: CLASSIC_01.version,
    status: 'won',
    score: 9000,
    elapsedMs: 200_000,
    bestCombo: 6,
    ballsLost: 0,
    livesRemaining: 3,
    powerUpsCollected: 0,
    ticks: 24_000,
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}, extra: Partial<RunResult> = {}): RunResult {
  return { runId: `run-${nextId++}`, summary: summary(overrides), verified: true, finishedAt: NOW, ...extra };
}

const apply = (p = createEmptyProgress(NOW), r = run(), board = CLASSIC_01) =>
  applyRunResult(p, board, CAMPAIGN_BOARDS, r);

describe('star ratings', () => {
  const stars = CLASSIC_01.stars ?? { twoStarSeconds: 0, threeStarSeconds: 0 };
  it('awards 0 for a loss and 1-3 by completion time', () => {
    expect(computeStars(CLASSIC_01, false, 1000)).toBe(0);
    expect(computeStars(CLASSIC_01, true, stars.threeStarSeconds * 1000)).toBe(3);
    expect(computeStars(CLASSIC_01, true, stars.threeStarSeconds * 1000 + 1)).toBe(2);
    expect(computeStars(CLASSIC_01, true, stars.twoStarSeconds * 1000)).toBe(2);
    expect(computeStars(CLASSIC_01, true, stars.twoStarSeconds * 1000 + 1)).toBe(1);
  });
});

describe('mastery objectives', () => {
  it('evaluates every objective kind and requires a clear', () => {
    const s = summary({ elapsedMs: 60_000, ballsLost: 1, livesRemaining: 2, bestCombo: 9, score: 5000 });
    expect(isObjectiveMet({ id: 'a', kind: 'clear' }, s)).toBe(true);
    expect(isObjectiveMet({ id: 'b', kind: 'clearUnderSeconds', seconds: 60 }, s)).toBe(true);
    expect(isObjectiveMet({ id: 'c', kind: 'clearUnderSeconds', seconds: 59 }, s)).toBe(false);
    expect(isObjectiveMet({ id: 'd', kind: 'noBallLost' }, s)).toBe(false);
    expect(isObjectiveMet({ id: 'e', kind: 'minBallsRemaining', balls: 2 }, s)).toBe(true);
    expect(isObjectiveMet({ id: 'f', kind: 'minCombo', combo: 10 }, s)).toBe(false);
    expect(isObjectiveMet({ id: 'g', kind: 'minScore', score: 5000 }, s)).toBe(true);
    expect(isObjectiveMet({ id: 'h', kind: 'clear' }, { ...s, status: 'lost' })).toBe(false);
  });
});

describe('applyRunResult', () => {
  it('records a first clear: stars, records, rewards, mastery and unlocks', () => {
    const { progress, outcome } = apply(createEmptyProgress(NOW), run({ elapsedMs: 100_000, bestCombo: 9 }));
    const record = progress.boards[CLASSIC_01.id];
    expect(record).toMatchObject({ attempts: 1, completions: 1, bestScore: 9000, bestTimeMs: 100_000, bestStars: 3 });
    expect(outcome.stars).toBe(3);
    expect(outcome.newBestScore && outcome.newBestTime).toBe(true);
    expect(outcome.unlocked).toEqual([CLASSIC_02.id]);
    expect(isBoardUnlocked(CLASSIC_02, progress)).toBe(true);
    // All five objectives: clear, 2+ balls, under 210 s, no ball lost, combo 8.
    expect(outcome.masteryCompleted.map((m) => m.kind).sort()).toEqual(
      ['clear', 'clearUnderSeconds', 'minBallsRemaining', 'minCombo', 'noBallLost'],
    );
    expect(record?.mastery).toHaveLength(5);
    expect(outcome.xp).toBeGreaterThan(0);
    expect(progress.xp).toBe(outcome.xp);
    expect(progress.coins).toBe(outcome.coins);
    expect(outcome.xp).toBe(outcome.rewards.reduce((n, r) => n + r.xp, 0));
    expect(progress.history[0]).toMatchObject({ outcome: 'won', stars: 3, verified: true });
  });

  it('computes the documented first-clear reward exactly', () => {
    const { outcome } = apply(createEmptyProgress(NOW), run({ elapsedMs: 250_000, bestCombo: 4, livesRemaining: 1, ballsLost: 2 }));
    const c = ECONOMY.completion;
    const k = ECONOMY.repeat.firstClearMultiplier;
    const rating = CLASSIC_01.difficulty.designerRating;
    const completionXp =
      (c.base.xp + c.perDifficulty.xp * rating) * k + c.perStar.xp * 2 * k + c.perBallRemaining.xp * 1 * k + c.comboXp * 4 * k;
    const starXp = ECONOMY.starImprovement.xp * 2;
    const masteryXp = ECONOMY.mastery.clear.xp; // only "clear" is met
    const rounded = Math.round((c.base.xp + c.perDifficulty.xp * rating) * k) + Math.round(c.perStar.xp * 2 * k) +
      Math.round(c.perBallRemaining.xp * k) + Math.round(c.comboXp * 4 * k) + starXp + masteryXp;
    expect(outcome.xp).toBe(rounded);
    expect(Math.abs(outcome.xp - (completionXp + starXp + masteryXp))).toBeLessThan(4);
  });

  it('never applies the same run twice', () => {
    const r = run();
    const first = apply(createEmptyProgress(NOW), r);
    const second = applyRunResult(first.progress, CLASSIC_01, CAMPAIGN_BOARDS, r);
    expect(second.outcome.duplicate).toBe(true);
    expect(second.outcome.xp).toBe(0);
    expect(second.progress).toBe(first.progress);
    expect(second.progress.boards[CLASSIC_01.id]?.completions).toBe(1);
  });

  it('decays replay rewards but still improves personal records', () => {
    let p = createEmptyProgress(NOW);
    const xps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { progress, outcome } = apply(p, run({ elapsedMs: 280_000 - i * 10_000, score: 8000 + i }));
      xps.push(outcome.xp - outcome.rewards.filter((r) => r.label.startsWith('Mastery') || r.label.startsWith('New star')).reduce((n, r) => n + r.xp, 0));
      p = progress;
    }
    for (let i = 1; i < xps.length; i++) expect(xps[i]).toBeLessThanOrEqual(xps[i - 1] ?? Infinity);
    expect(xps[5]).toBeLessThan((xps[0] ?? 0) * 0.15);
    expect(p.boards[CLASSIC_01.id]).toMatchObject({ completions: 6, bestScore: 8005, bestTimeMs: 230_000 });
  });

  it('keeps a floor on repeat rewards', () => {
    expect(repeatMultiplier(0)).toBe(ECONOMY.repeat.firstClearMultiplier);
    expect(repeatMultiplier(1)).toBeCloseTo(ECONOMY.repeat.decay);
    expect(repeatMultiplier(50)).toBe(ECONOMY.repeat.floor);
  });

  it('grants each mastery objective only once', () => {
    const first = apply(createEmptyProgress(NOW), run({ elapsedMs: 100_000, bestCombo: 9 }));
    const again = apply(first.progress, run({ elapsedMs: 90_000, bestCombo: 12 }));
    expect(again.outcome.masteryCompleted).toHaveLength(0);
    expect(again.outcome.rewards.some((r) => r.label.startsWith('Mastery'))).toBe(false);
  });

  it('gives no rewards for a loss but counts the attempt', () => {
    const { progress, outcome } = apply(createEmptyProgress(NOW), run({ status: 'lost', livesRemaining: 0 }));
    expect(outcome.xp + outcome.coins).toBe(0);
    expect(outcome.unlocked).toEqual([]);
    expect(progress.boards[CLASSIC_01.id]).toMatchObject({ attempts: 1, completions: 0, bestStars: 0, bestTimeMs: null });
    expect(progress.history[0]?.outcome).toBe('lost');
  });

  it('logs unverified runs without rewards or records', () => {
    const { progress, outcome } = apply(createEmptyProgress(NOW), run({}, { verified: false }));
    expect(outcome.xp).toBe(0);
    expect(outcome.stars).toBe(0);
    expect(progress.boards[CLASSIC_01.id]).toMatchObject({ completions: 0, bestScore: 0 });
    expect(isBoardUnlocked(CLASSIC_02, progress)).toBe(false);
    expect(progress.history[0]?.verified).toBe(false);
  });

  it('rejects a summary for a different board or version', () => {
    expect(() => apply(createEmptyProgress(NOW), run({ boardId: CLASSIC_02.id }))).toThrow();
    expect(() => apply(createEmptyProgress(NOW), run({ boardVersion: 99 }))).toThrow();
  });

  it('reports level-ups', () => {
    const p = createEmptyProgress(NOW);
    p.xp = ECONOMY.levelCurve.firstLevelXp - 1;
    const { outcome } = apply(p, run());
    expect(outcome.levelBefore).toBe(1);
    expect(outcome.levelAfter).toBe(levelForXp(p.xp + outcome.xp).level);
    expect(outcome.levelAfter).toBeGreaterThan(1);
  });

  it('does not mutate the input progress', () => {
    const p = createEmptyProgress(NOW);
    const snapshot = JSON.stringify(p);
    apply(p, run());
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
