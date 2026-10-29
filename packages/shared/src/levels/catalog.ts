import { CAMPAIGN_BOARDS, getCampaignBoard } from './classic';
import { CLASSIC_LEVELS, endlessLevelNumber, ENDLESS_FIRST_LEVEL, ENDLESS_MAX_LEVEL, generateLevel } from './endless';
import type { BoardDefinition } from './schema';

/**
 * The solo level catalog: levels 1-12 are the hand-made CLASSIC boards
 * (chapter 1), 13+ are generated (endless). Use this for solo play, rewards,
 * unlocks and records. Multiplayer keeps using its own curated board list.
 */
export { levelId } from './endless';

export const LAST_LEVEL = ENDLESS_MAX_LEVEL;
/** Chapter 1 holds the 12 hand-made levels; every later chapter holds 20 generated ones. */
export const CHAPTER_SIZE = 20;

/** 1-based level number of a board id, or null if it is not a solo level. */
export function levelNumber(id: string): number | null {
  const classic = CAMPAIGN_BOARDS.findIndex((b) => b.id === id);
  if (classic >= 0) return classic + 1;
  return endlessLevelNumber(id);
}

export function getLevel(id: string): BoardDefinition | undefined {
  const classic = getCampaignBoard(id);
  if (classic) return classic;
  const n = endlessLevelNumber(id);
  return n === null ? undefined : generateLevel(n);
}

export function getLevelAt(n: number): BoardDefinition | undefined {
  if (!Number.isInteger(n) || n < 1 || n > LAST_LEVEL) return undefined;
  return n <= CLASSIC_LEVELS ? CAMPAIGN_BOARDS[n - 1] : generateLevel(n);
}

/** The level after this one (the one clearing it unlocks), if any. */
export function nextLevel(id: string): BoardDefinition | undefined {
  const n = levelNumber(id);
  return n === null ? undefined : getLevelAt(n + 1);
}

export interface ChapterInfo {
  chapter: number;
  first: number;
  last: number;
}

export function chapterOf(n: number): ChapterInfo {
  if (n <= CLASSIC_LEVELS) return { chapter: 1, first: 1, last: CLASSIC_LEVELS };
  const index = Math.floor((n - ENDLESS_FIRST_LEVEL) / CHAPTER_SIZE);
  const first = ENDLESS_FIRST_LEVEL + index * CHAPTER_SIZE;
  return { chapter: index + 2, first, last: Math.min(LAST_LEVEL, first + CHAPTER_SIZE - 1) };
}

export function chapterInfo(chapter: number): ChapterInfo {
  if (chapter <= 1) return chapterOf(1);
  return chapterOf(ENDLESS_FIRST_LEVEL + (chapter - 2) * CHAPTER_SIZE);
}

/** Boards whose unlock state can change when `cleared` boards are complete: chapter 1 plus each cleared level's successor. */
export function unlockCandidates(clearedIds: Iterable<string>): BoardDefinition[] {
  const out = new Map<string, BoardDefinition>(CAMPAIGN_BOARDS.map((b) => [b.id, b]));
  for (const id of clearedIds) {
    const next = nextLevel(id);
    if (next) out.set(next.id, next);
  }
  return [...out.values()];
}

/**
 * Records (leaderboards) are kept per board VERSION: a changed layout starts a
 * fresh board. Version 1 keeps the plain id, so older records stay valid.
 */
export function recordKey(board: Pick<BoardDefinition, 'id' | 'version'>): string {
  return board.version === 1 ? board.id : `${board.id}@v${board.version}`;
}

/** Highest level number among these ids (0 if none). */
export function highestLevel(ids: Iterable<string>): number {
  let best = 0;
  for (const id of ids) best = Math.max(best, levelNumber(id) ?? 0);
  return best;
}
