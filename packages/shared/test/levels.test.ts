import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { CLASSIC_BOARDS } from '../src/levels/classic';
import { compileBoard, validateBoard } from '../src/levels/schema';
import { testBoard } from './helpers';

describe('board definitions', () => {
  it.each(CLASSIC_BOARDS.map((b) => [b.id, b] as const))('%s is valid and fits the world', (_id, board) => {
    expect(validateBoard(board)).toEqual([]);
    for (const brick of compileBoard(board, SIM.worldWidth)) {
      expect(brick.x).toBeGreaterThanOrEqual(0);
      expect(brick.x + brick.width).toBeLessThanOrEqual(SIM.worldWidth + 1e-9);
      expect(brick.y + brick.height).toBeLessThan(SIM.worldHeight / 2);
    }
  });

  it('rejects undefined legend characters', () => {
    expect(validateBoard(testBoard(['SSZ']))).toContain('row 0 uses undefined legend key "Z"');
  });

  it('rejects rows of the wrong width', () => {
    const errors = validateBoard(testBoard(['SSS', 'SS']));
    expect(errors).toContain('row 1 has 2 cells, expected 3');
  });

  it('requires moving bricks to declare their motion', () => {
    const board = testBoard(['SM'], {
      legend: { S: { type: 'standard', color: 'red' }, M: { type: 'moving', color: 'blue' } },
    });
    expect(validateBoard(board)).toContain('legend "M" is a moving brick without "move"');
  });

  it('rejects moving bricks whose path leaves the grid or crosses another brick', () => {
    const legend = {
      S: { type: 'standard', color: 'red' },
      M: { type: 'moving', color: 'blue', move: { cells: 3, speed: 60 } },
    } as const;
    expect(validateBoard(testBoard(['S......M..'], { legend })).join()).toContain('would leave the grid');
    expect(validateBoard(testBoard(['M..S......'], { legend })).join()).toContain('must be empty');
    expect(validateBoard(testBoard(['M...S.....'], { legend }))).toEqual([]);
  });

  it('rejects invalid motion parameters and misplaced fields', () => {
    const errors = validateBoard(
      testBoard(['SM....', 'P.....'], {
        legend: {
          S: { type: 'standard', color: 'red', move: { cells: 1, speed: 50 } },
          M: { type: 'moving', color: 'blue', move: { cells: 0, speed: 999 } },
          P: { type: 'standard', color: 'violet', powerUp: 'laser' },
        },
      }),
    ).join('\n');
    expect(errors).toContain('only moving or indestructible bricks may move');
    expect(errors).toContain('move.cells must be a positive integer');
    expect(errors).toContain('move.speed must be in');
    expect(errors).toContain('sets powerUp but is not a powerup brick');
  });

  it('enforces campaign requirements only when asked', () => {
    const board = testBoard(['S']);
    expect(validateBoard(board)).toEqual([]);
    const errors = validateBoard(board, { campaign: true });
    expect(errors).toContain('campaign boards need star thresholds');
    expect(errors).toContain('campaign boards need exactly 5 mastery objectives');
  });

  it('requires at least one required brick', () => {
    expect(validateBoard(testBoard(['###']))).toContain('board must contain at least one required brick');
  });

  it('throws when compiling an invalid board', () => {
    expect(() => compileBoard(testBoard(['Q']), SIM.worldWidth)).toThrow(/Invalid board/);
  });
});
