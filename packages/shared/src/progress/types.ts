/**
 * Player progression, persisted locally in Phase 2 (server-backed in Phase 5).
 *
 * LOCAL PROGRESS IS NOT AUTHORITATIVE. The device owner can edit it. It drives
 * the single-player experience only and must never be accepted as a competitive
 * or leaderboard submission; those go through server replay verification.
 */

import type { Loadout } from '../abilities/loadout';
import type { UpgradeLevels } from '../upgrades/upgrades';

export type StarRating = 0 | 1 | 2 | 3;

export interface BoardProgress {
  boardId: string;
  attempts: number;
  completions: number;
  bestScore: number;
  /** Fastest completion whose replay was verified locally; null if none. */
  bestTimeMs: number | null;
  bestStars: StarRating;
  /** Ids of completed mastery objectives. */
  mastery: string[];
  firstClearedAt: string | null;
  lastPlayedAt: string | null;
}

export interface RunHistoryEntry {
  runId: string;
  boardId: string;
  boardVersion: number;
  outcome: 'won' | 'lost';
  score: number;
  elapsedMs: number;
  stars: StarRating;
  ballsLost: number;
  bestCombo: number;
  xpEarned: number;
  coinsEarned: number;
  /** True when the run's input log replayed to the same result on this device. */
  verified: boolean;
  finishedAt: string;
}

export interface PlayerSettings {
  /** Fewer particles, no screen shake, softer flashes. */
  reducedEffects: boolean;
}

export interface PlayerProgress {
  version: number;
  xp: number;
  coins: number;
  /** Permanent upgrade levels (save v2). LOCAL ONLY: not proof of ownership. */
  upgrades: UpgradeLevels;
  /** Preferred multiplayer loadout (save v2). */
  loadout: Loadout;
  settings: PlayerSettings;
  boards: Record<string, BoardProgress>;
  /** Newest first, capped (see PROGRESS_LIMITS). */
  history: RunHistoryEntry[];
  /** Run ids already applied, so a result can never be rewarded twice. */
  appliedRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const PROGRESS_LIMITS = {
  history: 100,
  appliedRunIds: 500,
  maxXp: 100_000_000,
  maxCoins: 100_000_000,
  maxScore: 100_000_000,
  maxTimeMs: 24 * 60 * 60 * 1000,
} as const;
