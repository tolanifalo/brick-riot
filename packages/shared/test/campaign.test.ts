import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { CAMPAIGN_BOARDS } from '../src/levels/classic';
import { compileBoard, validateBoard } from '../src/levels/schema';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

/** Seeds used for scripted playtests; each must clear every board. */
const SEEDS = [1, 2, 3, 4, 5];
const MAX_SECONDS = 15 * 60;

function playthrough(boardIndex: number, seed: number) {
  const board = CAMPAIGN_BOARDS[boardIndex];
  if (!board) throw new Error('missing board');
  const sim = new Simulation(board, { seed });
  const bot = createAutoplayer('win');
  while (!sim.isOver && sim.state.tick < MAX_SECONDS * SIM.tickRate) sim.step(bot(sim));
  return sim.state;
}

describe('campaign definitions', () => {
  it('has 12 boards with unique ids and names', () => {
    expect(CAMPAIGN_BOARDS).toHaveLength(12);
    expect(new Set(CAMPAIGN_BOARDS.map((b) => b.id)).size).toBe(12);
    expect(new Set(CAMPAIGN_BOARDS.map((b) => b.name)).size).toBe(12);
    expect(new Set(CAMPAIGN_BOARDS.map((b) => b.layout.join('|'))).size).toBe(12);
  });

  it.each(CAMPAIGN_BOARDS.map((b) => [b.id, b] as const))('%s passes campaign validation', (_id, board) => {
    expect(validateBoard(board, { campaign: true })).toEqual([]);
    for (const brick of compileBoard(board, SIM.worldWidth)) {
      expect(brick.x).toBeGreaterThanOrEqual(0);
      expect(brick.x + brick.width + brick.moveRange).toBeLessThanOrEqual(SIM.worldWidth + 1e-9);
      expect(brick.y + brick.height).toBeLessThan(SIM.worldHeight / 2);
    }
  });

  it('forms a single unlock chain starting from level 1', () => {
    expect(CAMPAIGN_BOARDS[0]?.unlock).toEqual({ kind: 'none' });
    CAMPAIGN_BOARDS.slice(1).forEach((board, i) => {
      expect(board.unlock).toEqual({ kind: 'boardCleared', boardId: CAMPAIGN_BOARDS[i]?.id });
    });
  });

  it('increases in designer difficulty', () => {
    const ratings = CAMPAIGN_BOARDS.map((b) => b.difficulty.designerRating);
    expect([...ratings].sort((a, b) => a - b)).toEqual(ratings);
    expect(new Set(ratings).size).toBe(12);
  });

  it('introduces the special bricks in later levels', () => {
    const types = (i: number) => new Set(Object.values(CAMPAIGN_BOARDS[i]?.legend ?? {}).map((e) => e.type));
    const used = (i: number) => {
      const board = CAMPAIGN_BOARDS[i];
      if (!board) return new Set<string>();
      const chars = new Set(board.layout.join(''));
      return new Set([...chars].flatMap((c) => (board.legend[c] ? [board.legend[c].type] : [])));
    };
    expect(types(0).has('moving')).toBe(false);
    expect(used(1).has('powerup')).toBe(true);
    expect(used(7).has('moving')).toBe(true);
    expect(CAMPAIGN_BOARDS.some((b) => Object.values(b.legend).some((e) => e.type === 'indestructible' && e.move))).toBe(true);
  });
});

/**
 * Scripted playtests: the autoplayer must clear every board on every seed.
 * This proves each board is completable by real inputs through the real
 * engine. It does not prove a human can meet the star times.
 */
describe.each(CAMPAIGN_BOARDS.map((b, i) => [b.id, i] as const))('playtest %s', (_id, index) => {
  it.each(SEEDS)('seed %i clears', (seed) => {
    const end = playthrough(index, seed);
    expect(end.status).toBe('won');
    expect(end.requiredRemaining).toBe(0);
  });
});
