import { levelForXp } from '../config/economy';
import { getLevel, levelNumber } from '../levels/catalog';
import type { BoardDefinition, UnlockRequirement } from '../levels/schema';
import type { PlayerProgress } from './types';

/**
 * Unlocks are derived from recorded completions and XP, never stored as a
 * separate flag, so the two can never disagree.
 */
export function isRequirementMet(req: UnlockRequirement, progress: PlayerProgress): boolean {
  switch (req.kind) {
    case 'none':
      return true;
    case 'boardCleared':
      return (progress.boards[req.boardId]?.completions ?? 0) > 0;
    case 'playerLevel':
      return levelForXp(progress.xp).level >= req.level;
  }
}

export function isBoardUnlocked(board: BoardDefinition, progress: PlayerProgress): boolean {
  return isRequirementMet(board.unlock, progress);
}

export function unlockedBoardIds(boards: readonly BoardDefinition[], progress: PlayerProgress): string[] {
  return boards.filter((b) => isBoardUnlocked(b, progress)).map((b) => b.id);
}

/** The first unlocked board that has never been cleared, else the last unlocked one. */
export function currentBoardId(boards: readonly BoardDefinition[], progress: PlayerProgress): string | null {
  let lastUnlocked: string | null = null;
  for (const b of boards) {
    if (!isBoardUnlocked(b, progress)) continue;
    lastUnlocked = b.id;
    if ((progress.boards[b.id]?.completions ?? 0) === 0) return b.id;
  }
  return lastUnlocked;
}

export function describeRequirement(req: UnlockRequirement, boards: readonly BoardDefinition[]): string {
  switch (req.kind) {
    case 'none':
      return 'Available';
    case 'boardCleared': {
      const index = boards.findIndex((b) => b.id === req.boardId);
      const board = boards[index];
      if (board) return `Clear ${index + 1}. ${board.name}`;
      // Endless levels are generated rather than listed.
      const n = levelNumber(req.boardId);
      const level = getLevel(req.boardId);
      return n !== null && level ? `Clear ${n}. ${level.name}` : `Clear ${req.boardId}`;
    }
    case 'playerLevel':
      return `Reach player level ${req.level}`;
  }
}
