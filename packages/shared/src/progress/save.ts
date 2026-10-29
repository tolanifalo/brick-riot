import { DEFAULT_LOADOUT, validateLoadout } from '../abilities/loadout';
import { NO_UPGRADES, sanitizeUpgradeLevels } from '../upgrades/upgrades';
import { PROGRESS_LIMITS, type BoardProgress, type PlayerProgress, type RunHistoryEntry, type StarRating } from './types';

/** Current on-disk save format version. Bump it and add a migration when the shape changes. */
export const SAVE_VERSION = 2;
export const SAVE_FORMAT = 'brick-riot-save';

export interface SaveEnvelope {
  format: typeof SAVE_FORMAT;
  version: number;
  savedAt: string;
  data: unknown;
}

/** Upgrades save data from version `n` to `n + 1`. */
export type Migration = (data: unknown) => unknown;
export type MigrationRegistry = Readonly<Record<number, Migration>>;

/**
 * Real migrations.
 * 1 -> 2 (Phase 4): adds permanent upgrades (none owned), the default loadout
 * and settings. Every Phase 2-3 field is kept as is.
 */
export const MIGRATIONS: MigrationRegistry = {
  1: (data) => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('v1 data is not an object');
    return {
      ...(data as Record<string, unknown>),
      upgrades: { ...NO_UPGRADES },
      loadout: { ...DEFAULT_LOADOUT },
      settings: { reducedEffects: false },
    };
  },
};

export type ParseResult =
  | { kind: 'empty' }
  | { kind: 'ok'; progress: PlayerProgress; migratedFrom: number | null; repairs: string[] }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unsupported'; version: number };

export interface ParseOptions {
  currentVersion?: number;
  migrations?: MigrationRegistry;
  now?: string;
}

export function createEmptyProgress(now: string): PlayerProgress {
  return {
    version: SAVE_VERSION,
    xp: 0,
    coins: 0,
    upgrades: { ...NO_UPGRADES },
    loadout: { ...DEFAULT_LOADOUT },
    settings: { reducedEffects: false },
    boards: {},
    history: [],
    appliedRunIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createEmptyBoardProgress(boardId: string): BoardProgress {
  return {
    boardId,
    attempts: 0,
    completions: 0,
    bestScore: 0,
    bestTimeMs: null,
    bestStars: 0,
    mastery: [],
    firstClearedAt: null,
    lastPlayedAt: null,
  };
}

export function serializeProgress(progress: PlayerProgress, now: string): string {
  const envelope: SaveEnvelope = { format: SAVE_FORMAT, version: SAVE_VERSION, savedAt: now, data: progress };
  return JSON.stringify(envelope);
}

/**
 * Parses, migrates and sanitises a raw save string. Never throws: malformed
 * input yields 'corrupt', and individually invalid fields are repaired
 * (reported in `repairs`) rather than discarding the whole save.
 */
export function parseSave(raw: string | null | undefined, options: ParseOptions = {}): ParseResult {
  const currentVersion = options.currentVersion ?? SAVE_VERSION;
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? new Date(0).toISOString();
  if (raw === null || raw === undefined || raw === '') return { kind: 'empty' };

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', reason: 'save is not valid JSON' };
  }
  if (!isRecord(envelope) || envelope['format'] !== SAVE_FORMAT) {
    return { kind: 'corrupt', reason: 'save envelope is missing or has the wrong format tag' };
  }
  const version = envelope['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { kind: 'corrupt', reason: 'save version is invalid' };
  }
  if (version > currentVersion) return { kind: 'unsupported', version };

  let data = envelope['data'];
  for (let v = version; v < currentVersion; v++) {
    const migrate = migrations[v];
    if (!migrate) return { kind: 'corrupt', reason: `no migration from save version ${v}` };
    try {
      data = migrate(data);
    } catch (err) {
      return { kind: 'corrupt', reason: `migration from version ${v} failed: ${String(err)}` };
    }
  }
  if (!isRecord(data)) return { kind: 'corrupt', reason: 'save data is not an object' };

  const repairs: string[] = [];
  const progress = sanitizeProgress(data, now, currentVersion, repairs);
  return { kind: 'ok', progress, migratedFrom: version === currentVersion ? null : version, repairs };
}

// ---- Sanitising -------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown, min: number, max: number, fallback: number, field: string, repairs: string[]): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const clamped = Math.min(max, Math.max(min, Math.floor(value)));
    if (clamped !== value) repairs.push(`${field} clamped`);
    return clamped;
  }
  if (value !== undefined) repairs.push(`${field} reset`);
  return fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= 200 ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 ? value : null;
}

function stars(value: unknown): StarRating {
  return value === 1 || value === 2 || value === 3 ? value : 0;
}

function sanitizeBoard(id: string, raw: unknown, repairs: string[]): BoardProgress | null {
  if (!isRecord(raw)) {
    repairs.push(`board ${id} dropped`);
    return null;
  }
  const L = PROGRESS_LIMITS;
  const field = (name: string) => `boards.${id}.${name}`;
  const completions = int(raw['completions'], 0, 1e9, 0, field('completions'), repairs);
  const bestTime = raw['bestTimeMs'];
  const board: BoardProgress = {
    boardId: id,
    attempts: int(raw['attempts'], 0, 1e9, 0, field('attempts'), repairs),
    completions,
    bestScore: int(raw['bestScore'], 0, L.maxScore, 0, field('bestScore'), repairs),
    bestTimeMs:
      typeof bestTime === 'number' && Number.isFinite(bestTime) && bestTime > 0 && bestTime <= L.maxTimeMs
        ? Math.floor(bestTime)
        : null,
    bestStars: stars(raw['bestStars']),
    mastery: Array.isArray(raw['mastery'])
      ? [...new Set(raw['mastery'].filter((m): m is string => typeof m === 'string' && m.length <= 100))]
      : [],
    firstClearedAt: nullableStr(raw['firstClearedAt']),
    lastPlayedAt: nullableStr(raw['lastPlayedAt']),
  };
  if (board.attempts < board.completions) {
    board.attempts = board.completions;
    repairs.push(field('attempts') + ' raised to completions');
  }
  if (completions === 0 && (board.bestStars > 0 || board.bestTimeMs !== null)) {
    board.bestStars = 0;
    board.bestTimeMs = null;
    repairs.push(field('records') + ' cleared (no completions)');
  }
  return board;
}

function sanitizeLoadout(raw: unknown, repairs: string[]) {
  // Structure and budget only: unlocks depend on XP and are checked where used.
  const checked = validateLoadout(raw, Number.MAX_SAFE_INTEGER);
  if (checked.ok) return checked.loadout;
  if (raw !== undefined) repairs.push('loadout reset');
  return { ...DEFAULT_LOADOUT };
}

function sanitizeHistory(raw: unknown): RunHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RunHistoryEntry[] = [];
  for (const e of raw) {
    if (!isRecord(e)) continue;
    if (typeof e['runId'] !== 'string' || typeof e['boardId'] !== 'string') continue;
    if (e['outcome'] !== 'won' && e['outcome'] !== 'lost') continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    out.push({
      runId: e['runId'],
      boardId: e['boardId'],
      boardVersion: n(e['boardVersion']),
      outcome: e['outcome'],
      score: n(e['score']),
      elapsedMs: n(e['elapsedMs']),
      stars: stars(e['stars']),
      ballsLost: n(e['ballsLost']),
      bestCombo: n(e['bestCombo']),
      xpEarned: n(e['xpEarned']),
      coinsEarned: n(e['coinsEarned']),
      verified: e['verified'] === true,
      finishedAt: str(e['finishedAt'], ''),
    });
    if (out.length >= PROGRESS_LIMITS.history) break;
  }
  return out;
}

function sanitizeProgress(data: Record<string, unknown>, now: string, version: number, repairs: string[]): PlayerProgress {
  const boards: Record<string, BoardProgress> = {};
  const rawBoards = data['boards'];
  if (isRecord(rawBoards)) {
    for (const [id, raw] of Object.entries(rawBoards)) {
      if (id.length > 100) continue;
      const board = sanitizeBoard(id, raw, repairs);
      if (board) boards[id] = board;
    }
  } else if (rawBoards !== undefined) {
    repairs.push('boards reset');
  }
  const applied = Array.isArray(data['appliedRunIds'])
    ? data['appliedRunIds'].filter((id): id is string => typeof id === 'string').slice(0, PROGRESS_LIMITS.appliedRunIds)
    : [];
  return {
    version,
    xp: int(data['xp'], 0, PROGRESS_LIMITS.maxXp, 0, 'xp', repairs),
    coins: int(data['coins'], 0, PROGRESS_LIMITS.maxCoins, 0, 'coins', repairs),
    upgrades: sanitizeUpgradeLevels(data['upgrades']),
    loadout: sanitizeLoadout(data['loadout'], repairs),
    settings: {
      reducedEffects: isRecord(data['settings']) && data['settings']['reducedEffects'] === true,
    },
    boards,
    history: sanitizeHistory(data['history']),
    appliedRunIds: applied,
    createdAt: str(data['createdAt'], now),
    updatedAt: str(data['updatedAt'], now),
  };
}
