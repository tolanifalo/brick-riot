/**
 * Ranked-play foundation (Phase 6). INTERFACES ONLY: no rating changes are
 * applied until verified identity, persistence and match integrity exist.
 *
 * Matchmaking priority, evaluated as separate constraints (never one blended
 * score): 1. competitive skill, 2. board difficulty compatibility,
 * 3. equipment strength, 4. beginner protection.
 */

/** Glicko-2 style rating with uncertainty. */
export interface PlayerRating {
  playerId: string;
  /** Matchmaking rating (Glicko scale, 1500 start). */
  mmr: number;
  /** Rating deviation: uncertainty; high for new or inactive players. */
  deviation: number;
  volatility: number;
  gamesPlayed: number;
  /** Placement matches still to play before the rating is shown. */
  placementRemaining: number;
  lastPlayedAt: string | null;
}

export const DIVISIONS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Riot Master'] as const;
export type Division = (typeof DIVISIONS)[number];

/** Board Difficulty Rating: how hard a specific board version is to clear. */
export interface BoardDifficultyRating {
  boardId: string;
  boardVersion: number;
  /** Expected clear time in seconds for an average ranked player. */
  expectedSeconds: number;
  /** Spread of clear times (seconds), e.g. interquartile range. */
  spreadSeconds: number;
  /** Fraction of attempts that clear within the match timer. */
  clearRate: number;
  sampleSize: number;
  source: 'designer' | 'bot-estimate' | 'human-calibrated';
}

/** Estimated strength of a player's loadout + permanent upgrades (Phase 4). */
export interface EquipmentPowerRating {
  /** 0 = no equipment. Comparable across players by construction. */
  power: number;
  /** Power band; ranked pairs require equal or adjacent bands. */
  band: number;
  components: { source: string; power: number }[];
}

/** Progression level from XP. Never used as a skill measure. */
export interface ExperienceLevel {
  level: number;
  xp: number;
}

export interface QueueEntry {
  playerId: string;
  rating: PlayerRating;
  experience: ExperienceLevel;
  /** Server-verified unlocked boards (ranked never trusts client claims). */
  verifiedBoardIds: string[];
  preferredBoardId: string | null;
  equipment: EquipmentPowerRating;
  enqueuedAt: number;
}

export type EligibilityProblem =
  | 'identity_unverified'
  | 'progress_unverified'
  | 'placement_incomplete'
  | 'no_eligible_board'
  | 'banned';

export interface MatchmakingEligibility {
  eligible: boolean;
  problems: EligibilityProblem[];
}

/** How a finished match was verified before it may affect ratings. */
export interface MatchResultVerification {
  matchId: string;
  serverAuthoritative: boolean;
  replayVerified: boolean;
  bothIdentitiesVerified: boolean;
  /** Only true when every check passes. */
  ratingEligible: boolean;
}
