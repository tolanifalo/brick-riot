import { describe, expect, it } from 'vitest';
import { levelForXp, xpToAdvance } from '../src/config/economy';
import type { BoardDefinition } from '../src/levels/schema';
import { createEmptyBoardProgress, createEmptyProgress } from '../src/progress/save';
import { currentBoardId, describeRequirement, isBoardUnlocked, unlockedBoardIds } from '../src/progress/unlocks';
import { testBoard } from './helpers';

const curve = { firstLevelXp: 100, growth: 1.5, maxLevel: 4 };

describe('XP level curve', () => {
  it('grows the requirement per level', () => {
    expect(xpToAdvance(1, curve)).toBe(100);
    expect(xpToAdvance(2, curve)).toBe(150);
    expect(xpToAdvance(3, curve)).toBe(225);
  });

  it('maps XP to level and progress within the level', () => {
    expect(levelForXp(0, curve)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 100 });
    expect(levelForXp(99, curve)).toEqual({ level: 1, xpIntoLevel: 99, xpForNext: 100 });
    expect(levelForXp(100, curve)).toEqual({ level: 2, xpIntoLevel: 0, xpForNext: 150 });
    expect(levelForXp(260, curve)).toEqual({ level: 3, xpIntoLevel: 10, xpForNext: 225 });
  });

  it('caps at the max level', () => {
    expect(levelForXp(1e9, curve)).toEqual({ level: 4, xpIntoLevel: 0, xpForNext: 0 });
  });
});

describe('unlocks', () => {
  const alpha = testBoard(['S'], { id: 'a', name: 'Alpha' });
  const beta = testBoard(['S'], { id: 'b', name: 'Beta', unlock: { kind: 'boardCleared', boardId: 'a' } });
  const gamma = testBoard(['S'], { id: 'c', name: 'Gamma', unlock: { kind: 'boardCleared', boardId: 'b' } });
  const delta = testBoard(['S'], { id: 'd', name: 'Delta', unlock: { kind: 'playerLevel', level: 3 } });
  const boards: BoardDefinition[] = [alpha, beta, gamma, delta];

  it('starts with only unrequired boards open', () => {
    const p = createEmptyProgress('t');
    expect(unlockedBoardIds(boards, p)).toEqual(['a']);
    expect(currentBoardId(boards, p)).toBe('a');
  });

  it('opens the next board only after a completion, not an attempt', () => {
    const p = createEmptyProgress('t');
    p.boards['a'] = { ...createEmptyBoardProgress('a'), attempts: 5 };
    expect(isBoardUnlocked(beta, p)).toBe(false);
    p.boards['a'] = { ...createEmptyBoardProgress('a'), attempts: 5, completions: 1 };
    expect(unlockedBoardIds(boards, p)).toEqual(['a', 'b']);
    expect(currentBoardId(boards, p)).toBe('b');
  });

  it('supports player-level requirements', () => {
    const p = createEmptyProgress('t');
    expect(isBoardUnlocked(delta, p)).toBe(false);
    p.xp = 100_000;
    expect(isBoardUnlocked(delta, p)).toBe(true);
  });

  it('describes requirements for the UI', () => {
    expect(describeRequirement(beta.unlock, boards)).toBe('Clear 1. Alpha');
    expect(describeRequirement({ kind: 'playerLevel', level: 5 }, boards)).toBe('Reach player level 5');
  });
});
