import type { ActiveAbility, PassiveAbility } from '../abilities/definitions';
import type { Loadout } from '../abilities/loadout';
import type { RunOutcome } from '../progress/results';
import type { PlayerSettings, StarRating } from '../progress/types';
import type { EncodedRun } from '../sim/inputCodec';
import type { RunSummary } from '../sim/replay';
import type { UpgradeId, UpgradeLevels } from '../upgrades/upgrades';

/**
 * HTTP API contract between the client and the server (Phase 5). All values
 * here are SERVER-AUTHORITATIVE: the client displays them and sends requests;
 * it never computes or submits balances, levels, ownership or records.
 */

export interface AccountView {
  id: string;
  name: string;
  /** Only ever shown to the account owner. */
  email: string;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProgressView {
  xp: number;
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
  coins: number;
}

export interface BoardRecordView {
  boardId: string;
  attempts: number;
  completions: number;
  bestScore: number | null;
  bestTimeMs: number | null;
  bestStars: StarRating;
  mastery: string[];
}

/** Carried over from a local save: shown as unverified, never on leaderboards. */
export interface ImportedRecordView {
  boardId: string;
  completions: number;
  bestScore: number | null;
  bestTimeMs: number | null;
  bestStars: StarRating;
}

export interface EquipmentView {
  ownedAbilities: (ActiveAbility | PassiveAbility)[];
  loadout: Loadout;
  upgrades: UpgradeLevels;
  /** Loadout power (budget use). */
  loadoutPower: number;
  /** Equipment Power Rating in an upgrades-on casual room (server-verified). */
  equipmentPower: number;
}

export interface ProfileView {
  account: AccountView;
  progress: ProgressView;
  boards: BoardRecordView[];
  unlockedBoardIds: string[];
  importedRecords: ImportedRecordView[];
  equipment: EquipmentView;
  settings: PlayerSettings;
  localImport: { importedAt: string; summary: ImportSummary } | null;
  stats: PlayerStatsView;
}

export interface PlayerStatsView {
  casualMatches: number;
  casualWins: number;
  casualDraws: number;
  privateMatches: number;
}

/** What anyone may see about a player. No email, no internal ids beyond the public id. */
export interface PublicProfileView {
  id: string;
  name: string;
  level: number;
  memberSince: string;
  boardsCleared: number;
  masteryCount: number;
  stats: PlayerStatsView;
}

// ---- Solo runs -----------------------------------------------------------------

export interface IssueRunRequest {
  boardId: string;
}

export interface IssueRunResponse {
  runId: string;
  seed: number;
  boardId: string;
  boardVersion: number;
  /** The upgrade levels this run is simulated (and verified) with. */
  upgrades: UpgradeLevels;
}

export interface FinishRunRequest {
  inputs: EncodedRun[];
}

export type RunRejectReason = 'unknown_run' | 'expired' | 'malformed' | 'too_long' | 'unfinished' | 'board_changed';

export interface FinishRunResponse {
  /** True when this run had already been recorded; the stored outcome is returned. */
  duplicate: boolean;
  outcome: RunOutcome;
  summary: RunSummary;
  progress: ProgressView;
}

// ---- Workshop and loadout --------------------------------------------------------

export interface PurchaseRequest {
  upgradeId: UpgradeId;
  /** The level the client believes it is buying from (stale-request guard). */
  expectedLevel: number;
}

export type ApiPurchaseError = 'unknown_upgrade' | 'max_level' | 'insufficient_coins' | 'stale_level' | 'bad_idempotency_key';

export interface PurchaseResponse {
  purchaseId: string;
  upgradeId: UpgradeId;
  level: number;
  cost: number;
  coins: number;
  /** True when this idempotency key was already processed (nothing charged again). */
  replayed: boolean;
}

export interface LoadoutResponse {
  equipment: EquipmentView;
}

// ---- Guest progress import ----------------------------------------------------------

export interface ImportSummary {
  boardsUnlocked: string[];
  recordsImported: number;
  settingsImported: boolean;
  loadoutImported: boolean;
  /** Local values deliberately NOT imported (unverifiable). */
  notImported: { xp: number; coins: number; upgradeLevels: number; masteryObjectives: number; historyEntries: number };
}

export type ImportError = 'invalid_save' | 'already_imported' | 'too_large' | 'empty_save';

// ---- Match history ---------------------------------------------------------------

export interface MatchHistoryEntry {
  matchId: string;
  mode: 'private' | 'quick';
  endedAt: string;
  result: 'win' | 'loss' | 'draw' | 'cancelled';
  reason: string;
  myBoardId: string;
  opponentName: string;
  opponentBoardId: string;
  myCompletionTick: number | null;
  opponentCompletionTick: number | null;
  myScore: number;
  opponentScore: number;
  replayVerified: boolean;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  next: string | null;
}

// ---- Leaderboards ----------------------------------------------------------------

export type LeaderboardCategoryId = 'solo_time' | 'solo_score' | 'mastery' | 'casual_wins';

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  value: number;
  achievedAt: string;
}

export interface LeaderboardPage {
  category: LeaderboardCategoryId;
  boardId: string | null;
  seasonId: string;
  rows: LeaderboardRow[];
  page: number;
  pageSize: number;
  total: number;
  /** The viewer's own row when signed in and ranked. */
  me: LeaderboardRow | null;
}

export interface RankedStatus {
  enabled: false;
  /** Requirements still unmet before ranked can launch. */
  blockers: string[];
}

/** Game tickets let a signed-in browser prove its account to a match room. */
export interface GameTicketResponse {
  ticket: string;
  expiresInSeconds: number;
}
