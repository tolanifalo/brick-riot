import { CAMPAIGN_BOARDS, CLASSIC_07, CLASSIC_10, getCampaignBoard } from '../levels/classic';
import type { BoardDefinition, BrickType, CollectionId, UnlockRequirement } from '../levels/schema';
import { isBoardUnlocked } from '../progress/unlocks';
import { createEmptyBoardProgress, createEmptyProgress } from '../progress/save';

/** Where a board's expected completion time comes from. */
export type CalibrationSource = 'none' | 'bot-estimate' | 'human-playtest';

/** Coarse length class used to pre-filter matchmaking candidates. */
export type DifficultyBand = 'sprint' | 'standard' | 'marathon';

/** Gameplay modifiers a board may accept (all active since Phase 4). */
export type GameplayModifier = 'loadout' | 'upgrades' | 'sabotage';

export interface MultiplayerBoardProfile {
  boardId: string;
  boardVersion: number;
  collection: CollectionId;
  /** Designer difficulty rating (Board Difficulty Rating input). */
  difficulty: number;
  multiplayerEligible: boolean;
  /** Why a board is (in)eligible: shown to designers, not players. */
  eligibilityNote: string;
  /** Campaign unlock needed to pick this board in normal (non-dev) rooms. */
  requiredUnlock: UnlockRequirement;
  minPlayerLevel: number;
  /** Median clear time in seconds, or null when never measured. */
  expectedCompletionSeconds: number | null;
  /** Interquartile range of clear times (seconds); a variance measure. */
  completionIqrSeconds: number | null;
  /** Clear-time quantiles at 5%, 15%, ... 95%: used to estimate who clears first. */
  completionDeciles: number[] | null;
  /** Share of calibration runs that clear within 120 s. */
  timerCompletionRate: number | null;
  /** Campaign board this multiplayer variant derives from, or null. */
  variantOf: string | null;
  calibration: CalibrationSource;
  calibrationSamples: number;
  allowedModifiers: GameplayModifier[];
  band: DifficultyBand;
  /** Special mechanics present, for compatibility reporting. */
  mechanics: BrickType[];
}

function mechanicsOf(board: BoardDefinition): BrickType[] {
  const used = new Set(board.layout.join('').split(''));
  const types = new Set<BrickType>();
  for (const [key, entry] of Object.entries(board.legend)) {
    if (!used.has(key)) continue;
    if (entry.type !== 'standard' && entry.type !== 'reinforced') types.add(entry.type);
    if (entry.move) types.add('moving');
  }
  return [...types].sort();
}

function bandFor(seconds: number | null): DifficultyBand {
  if (seconds === null || seconds > 100) return 'marathon';
  return seconds < 65 ? 'sprint' : 'standard';
}

/**
 * Versioned multiplayer-only variants of campaign boards (see
 * BOARD_COMPATIBILITY.md). Each has its own id and version so match records
 * and replays always refer to the exact layout that was played. Campaign
 * boards themselves are never changed for multiplayer.
 */
export const MULTIPLAYER_VARIANTS: readonly BoardDefinition[] = [
  multiplayerVariant(CLASSIC_07, {
    name: 'Fortress Sprint',
    // Cap, shoulders and feet drop from 3 to 2 hp; the armoured side walls stay.
    layout: ['..RRRRRR..', '.RH....HR.', '#H.OXXO.H#', '#H.OPPO.H#', '#H.OOOO.H#', '.RH....HR.', '..RR..RR..'],
  }),
  multiplayerVariant(CLASSIC_10, {
    name: 'Gatekeeper Sprint',
    // The inner armoured row becomes a standard row; the gates are unchanged.
    layout: ['RRRRRRRRRR', 'ROOOOOOOOR', 'ROXOPOOXOR', 'OOOOOOOOOO', '..........', 'K....K....', '..........', 'YY.YYYY.YY'],
  }),
];

/**
 * A multiplayer-only copy of a campaign board with a new id ("<base>-mp") and
 * its own version. Unlocked exactly when the base board is; no campaign
 * mastery or rewards.
 */
function multiplayerVariant(base: BoardDefinition, change: { name: string; layout: string[]; version?: number }): BoardDefinition {
  return {
    ...base,
    id: `${base.id}-mp`,
    version: change.version ?? 1,
    name: change.name,
    mastery: [],
    layout: change.layout,
  };
}

/** The campaign board a multiplayer variant was derived from (null for campaign boards). */
export function variantBaseId(boardId: string): string | null {
  return boardId.endsWith('-mp') ? boardId.slice(0, -3) : null;
}

/** Bot runs per board behind the statistics below (`npm run compat`). */
export const CALIBRATION_SAMPLES = 48;

interface ProfileSpec {
  eligible: boolean;
  note: string;
  /** [median, q1, q3] clear seconds. */
  stats: [number, number, number] | null;
  /** Clear-time quantiles at 5%, 15%, ... 95% (seconds): the distribution shape. */
  deciles: number[] | null;
  /** Share of runs that clear within 120 s (the default match timer). */
  withinTimer: number | null;
}

/**
 * Bot-estimated statistics: 48 seeds, autoplayer v2, multiplayer config with
 * the default loadout (`npm run compat`, see BOARD_COMPATIBILITY.md).
 * PROVISIONAL: the bot never loses a ball and aims differently from people.
 * Human playtesting must replace these before any ranked use.
 */
const SPECS: Record<string, ProfileSpec> = {
  'classic-01': { eligible: false, note: 'Median clear (~256 s) far exceeds the 120 s match timer.', stats: null, deciles: null, withinTimer: null },
  'classic-02': {
    eligible: true,
    note: 'Symmetric; moderate variance.',
    stats: [81, 71, 100],
    deciles: [41, 53, 71, 75, 79, 86, 89, 100, 108, 121],
    withinTimer: 0.94,
  },
  'classic-03': {
    eligible: true,
    note: 'Short; high relative variance (CV 0.50). Only fair against itself.',
    stats: [42, 35, 62],
    deciles: [22, 27, 35, 36, 39, 45, 51, 62, 80, 107],
    withinTimer: 1,
  },
  'classic-04': { eligible: false, note: 'Precision corridor: median ~190 s, exceeds the timer.', stats: null, deciles: null, withinTimer: null },
  'classic-05': {
    eligible: true,
    note: 'Short; wide upper tail.',
    stats: [54, 43, 84],
    deciles: [22, 37, 43, 47, 52, 55, 67, 84, 94, 106],
    withinTimer: 1,
  },
  'classic-06': { eligible: false, note: 'One explosive chain decides too much; ~185 s median.', stats: null, deciles: null, withinTimer: null },
  'classic-07': {
    eligible: true,
    note: 'Long: a third of bot runs exceed the timer. See Fortress Sprint.',
    stats: [100, 65, 129],
    deciles: [45, 55, 65, 80, 90, 101, 112, 129, 141, 151],
    withinTimer: 0.67,
  },
  'classic-08': {
    eligible: true,
    note: 'Moving bricks; lowest variance (CV 0.31).',
    stats: [59, 45, 70],
    deciles: [30, 40, 45, 48, 55, 61, 66, 70, 73, 88],
    withinTimer: 1,
  },
  'classic-09': { eligible: false, note: 'Very high variance (67-505 s); exceeds the timer.', stats: null, deciles: null, withinTimer: null },
  'classic-10': {
    eligible: true,
    note: 'Long: a quarter of bot runs exceed the timer. See Gatekeeper Sprint.',
    stats: [97, 73, 121],
    deciles: [48, 62, 73, 81, 88, 102, 108, 121, 137, 166],
    withinTimer: 0.75,
  },
  'classic-11': {
    eligible: false,
    note: 'Excluded: highest variance (CV 0.55, p90 161 s) and the most upgrade-sensitive board (-24%).',
    stats: [76, 48, 112],
    deciles: [29, 38, 48, 54, 67, 82, 103, 112, 138, 161],
    withinTimer: 0.77,
  },
  'classic-12': { eligible: false, note: 'Finale: median ~250 s, exceeds the timer.', stats: null, deciles: null, withinTimer: null },
  'classic-07-mp': {
    eligible: true,
    note: 'Variant v1 of Fortress: 2-hp cap and feet. Median 100 -> 86 s; within timer 67% -> 81%.',
    stats: [86, 69, 110],
    deciles: [35, 50, 69, 80, 85, 87, 93, 110, 130, 155],
    withinTimer: 0.81,
  },
  'classic-10-mp': {
    eligible: true,
    note: 'Variant v1 of Gatekeeper: inner armoured row softened. Median 97 -> 82 s; within timer 75% -> 90%.',
    stats: [82, 54, 109],
    deciles: [26, 46, 54, 59, 70, 88, 95, 109, 116, 136],
    withinTimer: 0.9,
  },
};

const NO_SPEC: ProfileSpec = { eligible: false, note: 'No multiplayer review yet.', stats: null, deciles: null, withinTimer: null };

export const MULTIPLAYER_BOARD_PROFILES: readonly MultiplayerBoardProfile[] = [...CAMPAIGN_BOARDS, ...MULTIPLAYER_VARIANTS].map((board) => {
  const spec = SPECS[board.id] ?? NO_SPEC;
  const median = spec.stats ? spec.stats[0] : null;
  return {
    boardId: board.id,
    boardVersion: board.version,
    collection: board.collection,
    difficulty: board.difficulty.designerRating,
    multiplayerEligible: spec.eligible && board.multiplayerEligible,
    eligibilityNote: spec.note,
    requiredUnlock: board.unlock,
    minPlayerLevel: 1,
    expectedCompletionSeconds: median,
    completionIqrSeconds: spec.stats ? spec.stats[2] - spec.stats[1] : null,
    completionDeciles: spec.deciles,
    timerCompletionRate: spec.withinTimer,
    variantOf: variantBaseId(board.id),
    calibration: spec.stats ? 'bot-estimate' : 'none',
    calibrationSamples: spec.stats ? CALIBRATION_SAMPLES : 0,
    allowedModifiers: ['loadout', 'upgrades', 'sabotage'],
    band: bandFor(median),
    mechanics: mechanicsOf(board),
  };
});

export const MULTIPLAYER_BOARDS: readonly MultiplayerBoardProfile[] = MULTIPLAYER_BOARD_PROFILES.filter(
  (p) => p.multiplayerEligible,
);

/** Any board a match can be played on: campaign boards and multiplayer variants. */
export function getMatchBoard(boardId: string): BoardDefinition | undefined {
  return getCampaignBoard(boardId) ?? MULTIPLAYER_VARIANTS.find((b) => b.id === boardId);
}

export function getMultiplayerProfile(boardId: string): MultiplayerBoardProfile | undefined {
  return MULTIPLAYER_BOARD_PROFILES.find((p) => p.boardId === boardId);
}

/**
 * Entitlement claimed by a client from its LOCAL save. Untrusted: acceptable for
 * private matches only. Ranked play must use server-verified progression.
 */
export interface ClaimedProgress {
  clearedBoardIds: string[];
  xp: number;
}

export type BoardChoiceError = 'unknown_board' | 'not_multiplayer_eligible' | 'locked';

/** Validates a board choice. `devMode` skips unlock checks but never eligibility. */
export function checkBoardChoice(
  boardId: string,
  claim: ClaimedProgress,
  devMode: boolean,
): { ok: true; board: BoardDefinition; profile: MultiplayerBoardProfile } | { ok: false; error: BoardChoiceError } {
  const board = getMatchBoard(boardId);
  const profile = getMultiplayerProfile(boardId);
  if (!board || !profile) return { ok: false, error: 'unknown_board' };
  if (!profile.multiplayerEligible) return { ok: false, error: 'not_multiplayer_eligible' };
  if (devMode) return { ok: true, board, profile };
  const progress = createEmptyProgress('claim');
  progress.xp = Math.max(0, Math.floor(claim.xp));
  for (const id of claim.clearedBoardIds) {
    progress.boards[id] = { ...createEmptyBoardProgress(id), attempts: 1, completions: 1 };
  }
  if (!isBoardUnlocked(board, progress)) return { ok: false, error: 'locked' };
  return { ok: true, board, profile };
}

/** Boards a player may pick, given their claimed progress. */
export function selectableBoards(claim: ClaimedProgress, devMode: boolean): MultiplayerBoardProfile[] {
  return MULTIPLAYER_BOARDS.filter((p) => checkBoardChoice(p.boardId, claim, devMode).ok);
}
