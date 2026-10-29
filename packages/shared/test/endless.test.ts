import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { isPowerDown } from '../src/config/powerups';
import { chapterInfo, chapterOf, getLevel, getLevelAt, levelNumber, nextLevel, unlockCandidates } from '../src/levels/catalog';
import { CAMPAIGN_BOARDS } from '../src/levels/classic';
import {
  endlessLevelNumber,
  endlessRating,
  ENDLESS_FIRST_LEVEL,
  ENDLESS_GENERATOR_VERSION,
  generateLevel,
  levelId,
  levelTag,
  powerDownChanceFor,
} from '../src/levels/endless';
import { validateBoard } from '../src/levels/schema';
import { applyRunResult } from '../src/progress/results';
import { createEmptyProgress } from '../src/progress/save';
import { isBoardUnlocked } from '../src/progress/unlocks';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe('endless generator', () => {
  it('is frozen per generator version: if this changes, bump ENDLESS_GENERATOR_VERSION', () => {
    const boards = [];
    for (let n = 13; n <= 80; n++) boards.push(generateLevel(n));
    expect(ENDLESS_GENERATOR_VERSION).toBe(1);
    expect(fnv1a(JSON.stringify(boards))).toMatchInlineSnapshot(`"eae2b90c"`);
  });

  it('generates a valid campaign board for every level from 13 to 3000, chained to the previous level', () => {
    for (let n = ENDLESS_FIRST_LEVEL; n <= 3000; n++) {
      const board = generateLevel(n);
      expect(validateBoard(board, { campaign: true })).toEqual([]);
      expect(board.id).toBe(`endless-${n}`);
      expect(board.unlock).toEqual({ kind: 'boardCleared', boardId: levelId(n - 1) });
      expect(board.multiplayerEligible).toBe(false);
      expect(board.layout.length).toBeLessThanOrEqual(16);
      for (const entry of Object.values(board.legend)) {
        if (entry.powerUp && entry.powerUp !== 'random') expect(isPowerDown(entry.powerUp)).toBe(false);
      }
      expect((board.powerUpPool ?? []).some(isPowerDown)).toBe(false);
      const stars = board.stars;
      expect(stars && stars.threeStarSeconds < stars.twoStarSeconds).toBe(true);
    }
    expect(generateLevel(9999).id).toBe('endless-9999');
    expect(() => generateLevel(12)).toThrow();
    expect(() => generateLevel(10000)).toThrow();
  });

  it('names are unique within every chapter', () => {
    for (let first = 13; first < 1000; first += 20) {
      const names = Array.from({ length: 20 }, (_, i) => generateLevel(first + i).name.replace('Boss: ', ''));
      expect(new Set(names).size).toBe(20);
    }
  });

  it('follows the sawtooth: rising base, hard every 10th, boss every 50th, breathers after them', () => {
    expect(levelTag(20)).toBe('hard');
    expect(levelTag(50)).toBe('boss');
    expect(levelTag(21)).toBe('breather');
    expect(endlessRating(20)).toBeGreaterThan(endlessRating(19));
    expect(endlessRating(21)).toBeLessThan(endlessRating(19));
    expect(endlessRating(50)).toBeGreaterThan(endlessRating(40));
    const normals = [13, 33, 73, 153, 503, 2003];
    for (let i = 1; i < normals.length; i++) expect(endlessRating(normals[i] ?? 0)).toBeGreaterThanOrEqual(endlessRating(normals[i - 1] ?? 0));
    expect(endlessRating(9999)).toBeLessThanOrEqual(10);
  });

  it('introduces power-downs gradually: none before level 16, never above 35%', () => {
    for (let n = 13; n < 16; n++) expect(powerDownChanceFor(n)).toBe(0);
    for (let n = 16; n <= 1000; n++) expect(powerDownChanceFor(n)).toBeLessThanOrEqual(0.35);
    expect(powerDownChanceFor(40)).toBeGreaterThan(powerDownChanceFor(20));
  });

  it('every sampled level is beatable by the test bot', () => {
    for (const n of [13, 16, 20, 33, 50, 100, 400, 2500, 9999]) {
      const board = generateLevel(n);
      for (const seed of [3, 9]) {
        const sim = new Simulation(board, { seed });
        const bot = createAutoplayer('win');
        while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) sim.step(bot(sim));
        expect(`${n}/${seed}: ${sim.state.status}`).toBe(`${n}/${seed}: won`);
      }
    }
  }, 120_000);
});

describe('level catalog', () => {
  it('numbers, resolves and chains hand-made and generated levels', () => {
    expect(levelNumber('classic-01')).toBe(1);
    expect(levelNumber('classic-12')).toBe(12);
    expect(levelNumber('endless-13')).toBe(13);
    expect(levelNumber('endless-12')).toBeNull();
    expect(levelNumber('endless-013')).toBeNull();
    expect(levelNumber('classic-07-mp')).toBeNull();
    expect(endlessLevelNumber('endless-10000')).toBeNull();
    expect(getLevel('endless-40')?.id).toBe('endless-40');
    expect(getLevel('nope')).toBeUndefined();
    expect(getLevelAt(1)?.id).toBe('classic-01');
    expect(getLevelAt(13)?.id).toBe('endless-13');
    expect(nextLevel('classic-12')?.id).toBe('endless-13');
    expect(nextLevel('endless-13')?.id).toBe('endless-14');
    expect(nextLevel('endless-9999')).toBeUndefined();
  });

  it('groups levels into chapters: 12 hand-made, then 20 each', () => {
    expect(chapterOf(5)).toEqual({ chapter: 1, first: 1, last: 12 });
    expect(chapterOf(13)).toEqual({ chapter: 2, first: 13, last: 32 });
    expect(chapterOf(33)).toEqual({ chapter: 3, first: 33, last: 52 });
    expect(chapterInfo(3)).toEqual(chapterOf(40));
  });

  it('clearing level 12 unlocks level 13, and each endless level unlocks the next', () => {
    let progress = createEmptyProgress('2026-10-29T00:00:00.000Z');
    const win = (id: string, i: number) => {
      const board = getLevel(id);
      if (!board) throw new Error(id);
      const r = applyRunResult(progress, board, CAMPAIGN_BOARDS, {
        runId: `r${i}`,
        verified: true,
        finishedAt: '2026-10-29T00:00:00.000Z',
        summary: { boardId: id, boardVersion: board.version, status: 'won', score: 100, elapsedMs: 60_000, livesRemaining: 3, ballsLost: 0, bestCombo: 3, powerUpsCollected: 0, ticks: 7200 },
      });
      progress = r.progress;
      return r.outcome;
    };
    for (let n = 1; n <= 12; n++) win(levelId(n), n);
    const thirteen = getLevel('endless-13');
    expect(thirteen && isBoardUnlocked(thirteen, progress)).toBe(true);
    expect(win('endless-13', 13).unlocked).toEqual(['endless-14']);
    expect(unlockCandidates(['endless-13']).map((b) => b.id)).toContain('endless-14');
  });
});
