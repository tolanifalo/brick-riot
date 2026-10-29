import { compareEquipment, type EquipmentRating } from '../abilities/equipment';
import { getMatchBoard, getMultiplayerProfile, MULTIPLAYER_BOARDS } from '../multiplayer/boards';
import { evaluateCompatibility, type CompatibilityReport } from '../multiplayer/compatibility';
import type { CriterionCheck } from './pairing';

/**
 * PUBLIC CASUAL MATCHMAKING (Quick Match). Pure and deterministic.
 *
 * A pair is acceptable only if EVERY criterion passes; criteria are never
 * blended into one weighted number:
 *   1. Skill: hidden casual Glicko-2 estimates within a window that widens
 *      with uncertainty and waiting time.
 *   2. Boards: a pair of boards (each from its player's verified unlocks)
 *      that the Board Compatibility Service rates compatible. Thresholds are
 *      never loosened here.
 *   3. Equipment: loadout power within the even-equipment gap (Quick Match
 *      uses loadouts only; upgrades never apply).
 *   4. Beginner protection: new players only meet other new-ish players.
 * Players race on DIFFERENT boards whenever their preferences differ.
 */
export interface QuickPreferences {
  /** Preferred boards, most preferred first (1-3). */
  boards: string[];
  /** May the matchmaker suggest another unlocked, compatible board? */
  allowAlternatives: boolean;
}

export interface QuickCandidate {
  id: string;
  rating: number;
  deviation: number;
  /** Finished casual matches (experience; never a skill measure). */
  gamesPlayed: number;
  equipment: EquipmentRating;
  /** Server-verified unlocked campaign boards. */
  unlockedBoardIds: readonly string[];
  preferences: QuickPreferences;
  enqueuedAt: number;
}

export interface QuickPolicy {
  baseSkillGap: number;
  /** Seconds of waiting before the skill window starts widening... */
  widenAfterSeconds: number;
  /** ...by this many points per second... */
  widenPerSecond: number;
  /** ...up to this gap. */
  maxSkillGap: number;
  /** Players with fewer games than this are beginners... */
  beginnerGames: number;
  /** ...and only meet players with fewer games than this. */
  beginnerOpponentCeiling: number;
  matchSeconds: number;
  /** Queue time limit before the search stops (seconds). */
  queueTimeoutSeconds: number;
}

export const QUICK_POLICY: QuickPolicy = {
  baseSkillGap: 150,
  widenAfterSeconds: 15,
  widenPerSecond: 6,
  maxSkillGap: 500,
  beginnerGames: 10,
  beginnerOpponentCeiling: 30,
  matchSeconds: 120,
  queueTimeoutSeconds: 300,
};

export interface BoardAssignment {
  boardA: string;
  boardB: string;
  /** Player-facing explanation per player (which preference, or a suggested alternative). */
  noteA: string;
  noteB: string;
  report: CompatibilityReport;
}

export interface QuickPairing {
  acceptable: boolean;
  skill: CriterionCheck;
  boards: CriterionCheck & { assignment: BoardAssignment | null };
  equipment: CriterionCheck;
  beginner: CriterionCheck;
}

/** Eligible, unlocked boards a player would race on, in their order of preference. */
export function boardOptions(c: QuickCandidate): { boardId: string; rank: number | null }[] {
  const playable = (id: string) => {
    const p = getMultiplayerProfile(id);
    if (!p?.multiplayerEligible) return false;
    return c.unlockedBoardIds.includes(p.variantOf ?? id);
  };
  const preferred = c.preferences.boards.filter(playable).slice(0, 3).map((boardId, rank) => ({ boardId, rank: rank as number | null }));
  if (!c.preferences.allowAlternatives) return preferred;
  const seen = new Set(preferred.map((p) => p.boardId));
  const extra = MULTIPLAYER_BOARDS.filter((p) => !seen.has(p.boardId) && playable(p.boardId)).map((p) => ({ boardId: p.boardId, rank: null }));
  return [...preferred, ...extra];
}

const ORDINAL = ['1st', '2nd', '3rd'];

function note(rank: number | null, boardId: string): string {
  const name = getMatchBoard(boardId)?.name ?? boardId;
  return rank === null
    ? `Suggested alternative ${name}: none of your chosen boards had a compatible match-up with this opponent.`
    : `Your ${ORDINAL[rank] ?? `#${rank + 1}`} choice.`;
}

/**
 * The best compatible board pair: lowest combined preference rank first
 * (alternatives rank after every preference), compatible without needing
 * acceptance. Never loosens compatibility thresholds.
 */
export function assignBoards(a: QuickCandidate, b: QuickCandidate, policy: QuickPolicy = QUICK_POLICY): BoardAssignment | null {
  const optsA = boardOptions(a);
  const optsB = boardOptions(b);
  const cost = (r: number | null) => (r === null ? 10 : r);
  const combos: { a: (typeof optsA)[number]; b: (typeof optsB)[number]; cost: number }[] = [];
  for (const oa of optsA) for (const ob of optsB) combos.push({ a: oa, b: ob, cost: cost(oa.rank) + cost(ob.rank) });
  combos.sort((x, y) => x.cost - y.cost || x.a.boardId.localeCompare(y.a.boardId) || x.b.boardId.localeCompare(y.b.boardId));
  for (const c of combos) {
    const pa = getMultiplayerProfile(c.a.boardId);
    const pb = getMultiplayerProfile(c.b.boardId);
    if (!pa || !pb) continue;
    const report = evaluateCompatibility(pa, pb, policy.matchSeconds);
    if (!report.compatible) continue;
    return { boardA: c.a.boardId, boardB: c.b.boardId, noteA: note(c.a.rank, c.a.boardId), noteB: note(c.b.rank, c.b.boardId), report };
  }
  return null;
}

export function evaluateQuickPair(a: QuickCandidate, b: QuickCandidate, now: number, policy: QuickPolicy = QUICK_POLICY): QuickPairing {
  // 1. Skill.
  const waited = Math.min(now - a.enqueuedAt, now - b.enqueuedAt) / 1000;
  const widen = Math.max(0, waited - policy.widenAfterSeconds) * policy.widenPerSecond;
  const allowed = Math.min(policy.maxSkillGap, policy.baseSkillGap + (a.deviation + b.deviation) / 4 + widen);
  const gap = Math.abs(a.rating - b.rating);
  const skill = { ok: gap <= allowed, detail: `skill gap ${Math.round(gap)} / allowed ${Math.round(allowed)}` };

  // 2. Boards.
  const assignment = assignBoards(a, b, policy);
  const boards = { ok: assignment !== null, detail: assignment ? `${assignment.boardA} vs ${assignment.boardB}` : 'no compatible board pair', assignment };

  // 3. Equipment (loadout power; Quick Match never applies upgrades).
  const eq = compareEquipment(a.equipment, b.equipment);
  const equipment = { ok: eq.even, detail: `equipment gap ${eq.gap}` };

  // 4. Beginner protection.
  const beginner = (c: QuickCandidate) => c.gamesPlayed < policy.beginnerGames;
  const tooExperienced = (c: QuickCandidate) => c.gamesPlayed >= policy.beginnerOpponentCeiling;
  const clash = (beginner(a) && tooExperienced(b)) || (beginner(b) && tooExperienced(a));
  const beginnerCheck = { ok: !clash, detail: clash ? 'beginner would face an experienced player' : 'ok' };

  return { acceptable: skill.ok && boards.ok && equipment.ok && beginnerCheck.ok, skill, boards, equipment, beginner: beginnerCheck };
}

/**
 * Pairs a queue snapshot. Longest-waiting players are served first; each takes
 * the acceptable partner with the smallest skill gap. Deterministic for a given
 * snapshot and time. Never pairs a player with themselves.
 */
export function findQuickPairs(
  queue: readonly QuickCandidate[],
  now: number,
  policy: QuickPolicy = QUICK_POLICY,
): { a: QuickCandidate; b: QuickCandidate; assignment: BoardAssignment }[] {
  const order = [...queue].sort((x, y) => x.enqueuedAt - y.enqueuedAt || x.id.localeCompare(y.id));
  const taken = new Set<string>();
  const pairs: { a: QuickCandidate; b: QuickCandidate; assignment: BoardAssignment }[] = [];
  for (const a of order) {
    if (taken.has(a.id)) continue;
    let best: { b: QuickCandidate; assignment: BoardAssignment; gap: number } | null = null;
    for (const b of order) {
      if (b.id === a.id || taken.has(b.id)) continue;
      const e = evaluateQuickPair(a, b, now, policy);
      if (!e.acceptable || !e.boards.assignment) continue;
      const gap = Math.abs(a.rating - b.rating);
      if (!best || gap < best.gap) best = { b, assignment: e.boards.assignment, gap };
    }
    if (best) {
      taken.add(a.id);
      taken.add(best.b.id);
      pairs.push({ a, b: best.b, assignment: best.assignment });
    }
  }
  return pairs;
}
