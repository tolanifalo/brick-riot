import type { ActiveAbility } from '../abilities/definitions';
import { buildPlayerConfig, type Equipment, type EquipmentCompatibility, type EquipmentMode, type EquipmentRating } from '../abilities/equipment';
import type { BalanceConfig } from '../config/balance';
import type { Loadout } from '../abilities/loadout';
import type { DebuffKind, ExternalCommand, SimState, TickInput } from '../sim/types';
import type { UpgradeLevels } from '../upgrades/upgrades';
import type { CompatibilityReport } from './compatibility';
import type { LeadFeedback } from './leadController';
import { MATCH_CONFIG, type Seat } from './config';

/**
 * BRICK RIOT multiplayer protocol (Colyseus messages, msgpack-encoded).
 * Clients only ever send INTENTIONS. Nothing a client sends can set score,
 * bricks, lives, ball positions, completion or results.
 */

export const ROOM_NAME = 'match';
/** Public casual matchmaking queue (Phase 5). */
export const QUEUE_ROOM_NAME = 'quickmatch';

/** Queue room -> client: search progress (every ~2 s). */
export interface QueueStatusMessage {
  waitedSeconds: number;
  playersSearching: number;
  timeoutSeconds: number;
}

/** Queue room -> client: an opponent was found; consume the seat reservation to join. */
export interface QueueMatchedMessage {
  reservation: unknown;
  seat: 'A' | 'B';
  myBoardId: string;
  opponentBoardId: string;
  opponentName: string;
  /** Why this board (which preference, or a suggested alternative). */
  note: string;
  readySeconds: number;
}

/** Match room -> clients when a Quick Match room is called off before starting. */
export interface QuickClosedMessage {
  reason: 'ready_timeout' | 'opponent_left' | 'match_failed';
  /** Seats that caused it (did not confirm / left); empty when nobody did. */
  seats: ('A' | 'B')[];
}

// ---- Client -> server -------------------------------------------------------

/** One tick of input: [tick, targetX | null, axis (-1|0|1), launch (0|1)]. */
export type WireInput = [number, number | null, number, number];

export interface InputBatch {
  /** Strictly increasing per connection seat; duplicates are dropped. */
  seq: number;
  inputs: WireInput[];
}

export interface JoinOptions {
  name: string;
  /** Persistent per-browser id; prevents one browser taking two seats. Not an auth credential. */
  profileId: string;
  /** Untrusted local progress, used for board unlocks in private rooms only. */
  clearedBoardIds: string[];
  xp: number;
  /** Required when joining by id; validated against the room's code. */
  code?: string;
  /** Create-only: development room where any eligible board may be chosen. */
  devMode?: boolean;
  /** Preferred loadout (validated by the server; untrusted for ranked). */
  loadout?: Loadout;
  /**
   * IGNORED since Phase 5: client-claimed upgrade levels are never trusted.
   * Signed-in players' upgrades come from the server; guests have none.
   */
  upgrades?: UpgradeLevels;
  /** Single-use game ticket from POST /api/game/ticket: proves the signed-in account. */
  ticket?: string;
}

export type RematchAction = 'request' | 'accept' | 'decline';

/** Ability activation request. The server decides everything else. */
export interface AbilityRequest {
  ability: ActiveAbility;
  /** Strictly increasing per player; duplicates are dropped. */
  seq: number;
  /** The client's predicted tick, used only to order simultaneous requests. */
  tick: number;
}

/** Room equipment mode chosen by the host (private matches are always unranked). */
export type RoomEquipmentMode = Extract<EquipmentMode, 'casual' | 'casualUpgrades'>;

export interface ClientMessages {
  selectBoard: { boardId: string };
  setReady: { ready: boolean };
  acceptUnranked: { accept: boolean };
  input: InputBatch;
  resync: Record<string, never>;
  ping: { t: number };
  rematch: { action: RematchAction };
  /** After a result, a player left alone reopens the room for a new opponent. */
  returnToLobby: Record<string, never>;
  cancel: Record<string, never>;
  ability: AbilityRequest;
  /** Lobby only, while not ready. */
  setLoadout: { loadout: Loadout };
  /** Host only, lobby only. */
  setEquipmentMode: { mode: RoomEquipmentMode };
}

// ---- Server -> client -------------------------------------------------------

export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'finished';
export type PlayerRunStatus = 'waiting' | 'playing' | 'cleared' | 'exhausted' | 'forfeited';

export interface LobbyPlayerView {
  seat: Seat;
  /** Public per-room player id (not the profile id). */
  playerId: string;
  name: string;
  isHost: boolean;
  boardId: string | null;
  ready: boolean;
  acceptsUnranked: boolean;
  connected: boolean;
  /** Epoch ms when an absent player forfeits, else null. */
  reconnectDeadline: number | null;
  rematch: 'none' | 'requested' | 'accepted' | 'declined';
  /** Visible to both players (locked once the countdown starts). */
  loadout: Loadout;
  /** Equipment Power Rating under the room's equipment mode. */
  equipment: EquipmentRating;
}

export interface LobbyView {
  roomCode: string;
  phase: RoomPhase;
  devMode: boolean;
  matchNumber: number;
  matchId: string | null;
  players: LobbyPlayerView[];
  compatibility: CompatibilityReport | null;
  equipmentMode: RoomEquipmentMode;
  equipmentCompatibility: EquipmentCompatibility | null;
  /** True when both players must accept an uneven (board and/or equipment) unranked race. */
  needsUnrankedAcceptance: boolean;
  /** Public Quick Match rooms only: confirmation deadline and why each board was chosen. */
  matchmaking: { readyDeadline: number; notes: Record<Seat, string> } | null;
  /** Server epoch ms of the authoritative start (tick 0 → 1). */
  goAt: number | null;
  durationTicks: number;
  ticksPerSecond: number;
  result: MatchResult | null;
}

export interface MatchStartInfo {
  matchId: string;
  seat: Seat;
  /** Seed for this player's own simulation (needed for local prediction). */
  seed: number;
  boards: Record<Seat, { boardId: string; boardVersion: number }>;
  names: Record<Seat, string>;
  goAt: number;
  serverTime: number;
  ticksPerSecond: number;
  durationTicks: number;
  equipmentMode: RoomEquipmentMode;
  /** Both players' locked loadouts. */
  loadouts: Record<Seat, Loadout>;
  /**
   * The receiver's own equipment exactly as the server applies it; the client
   * builds its simulation config from this (buildPlayerConfig) for prediction.
   */
  equipment: Equipment;
  /** Test servers only (TEST_START_ENERGY): overrides starting energy. Null in normal play. */
  startEnergyOverride: number | null;
}

/** The exact config a player's simulation uses in a match (server and client). */
export function matchConfig(info: Pick<MatchStartInfo, 'equipment' | 'equipmentMode' | 'startEnergyOverride'>): BalanceConfig {
  const cfg = buildPlayerConfig(info.equipment, info.equipmentMode);
  if (info.startEnergyOverride === null) return cfg;
  return { ...cfg, energy: { ...cfg.energy, start: Math.min(cfg.energy.max, info.startEnergyOverride) } };
}

export interface PlayerProgressView {
  seat: Seat;
  score: number;
  lives: number;
  bricksRemaining: number;
  bricksTotal: number;
  status: PlayerRunStatus;
  connected: boolean;
  energy: number;
  debuff: DebuffKind | null;
  shielded: boolean;
  immune: boolean;
}

/** To the requester: the server's decision on an ability request. */
export interface AbilityResultMessage {
  ability: ActiveAbility;
  accepted: boolean;
  reason?: string;
  applyTick?: number;
  blocked?: boolean;
}

/** To both players: an accepted activation (for "incoming"/"blocked" feedback). */
export interface AbilityEventMessage {
  by: Seat;
  ability: ActiveAbility;
  applyTick: number;
  /** Offensive only. */
  target: Seat | null;
  blocked: boolean;
}

/** To one player: commands scheduled for their own simulation, not yet applied. */
export interface ExtMessage {
  upcoming: { tick: number; commands: ExternalCommand[] }[];
}

/** 20 Hz authoritative update; `hash` is the checksum of the receiver's own sim at `hashTick`. */
export interface SyncMessage {
  tick: number;
  hashTick: number;
  hash: string;
  timeLeftTicks: number;
  players: PlayerProgressView[];
  /** The receiver's own input timing since the previous sync (adaptive lead). */
  lead?: LeadFeedback;
  /** Development diagnostics (NET_DIAGNOSTICS=1 only; never in production). */
  diag?: NetDiagnostics;
}

/** Server-side timing seen by one player. Contains no session or identity data. */
export interface NetDiagnostics {
  /** Longest gap between server loop iterations since the last sync (ms). */
  maxLoopGapMs: number;
  /** Ticks simulated in the last server loop iteration. */
  lastStepTicks: number;
  /** Whole-match late inputs / inputs for the receiver. */
  lateInputs: number;
  inputs: number;
}

/** 10 Hz compact view of the opponent's board. */
export interface PreviewMessage {
  tick: number;
  seat: Seat;
  paddleX: number;
  paddleWidth: number;
  balls: [number, number][];
  /** One char per brick in id order: '.' destroyed, else remaining hp (max 9). */
  bricks: string;
  /** Current x of moving bricks: [brickId, x] pairs. */
  movers: [number, number][];
  /** Active Frost Bricks: [x, y, width, height]. */
  frost: [number, number, number, number][];
}

export interface StateMessage {
  tick: number;
  state: SimState;
  /** Scheduled commands the state has not applied yet. */
  upcoming: { tick: number; commands: ExternalCommand[] }[];
}

export interface PongMessage {
  t: number;
  serverTime: number;
}

export interface RejectedMessage {
  type: string;
  reason: string;
}

// ---- Results ---------------------------------------------------------------

export type MatchOutcome = 'win' | 'draw' | 'cancelled';
export type ResultReason =
  | 'board_cleared'
  | 'same_tick_clear'
  | 'both_exhausted'
  | 'time_expired'
  | 'forfeit'
  | 'both_disconnected'
  | 'match_cancelled';

export interface MatchResultPlayer {
  seat: Seat;
  playerId: string;
  name: string;
  boardId: string;
  boardVersion: number;
  completionTick: number | null;
  exhaustedTick: number | null;
  ballsRemaining: number;
  bricksCleared: number;
  bricksTotal: number;
  score: number;
  forfeited: boolean;
  disconnectedAtEnd: boolean;
}

export interface MatchResult {
  matchId: string;
  roomId: string;
  ranked: false;
  devMode: boolean;
  outcome: MatchOutcome;
  winnerPlayerId: string | null;
  winnerSeat: Seat | null;
  reason: ResultReason;
  startTick: number;
  endTick: number;
  durationTicks: number;
  ticksPerSecond: number;
  players: MatchResultPlayer[];
  compatibility: CompatibilityReport | null;
  verification: {
    method: 'server-authoritative-simulation';
    /** Each player's applied input log replayed from scratch to the same final state. */
    replayVerified: boolean;
    inputLogHashes: Record<Seat, string>;
  };
  finalizedAt: string;
}

// ---- Validation ------------------------------------------------------------

export type InputRejectReason =
  | 'malformed'
  | 'too_many_inputs'
  | 'duplicate_seq'
  | 'bad_tick'
  | 'duplicate_tick'
  | 'future_tick'
  | 'bad_target'
  | 'bad_axis'
  | 'bad_launch';

export interface ParsedInput {
  tick: number;
  input: TickInput;
}

export interface ParsedBatch {
  seq: number;
  inputs: ParsedInput[];
  rejected: { index: number; reason: InputRejectReason }[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Structural validation of an input batch. Tick-window checks that depend on
 * match state happen in the match engine. Never throws.
 */
export function parseInputBatch(raw: unknown): { ok: true; batch: ParsedBatch } | { ok: false; reason: InputRejectReason } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'malformed' };
  const { seq, inputs } = raw as { seq?: unknown; inputs?: unknown };
  if (!isInt(seq) || seq < 0 || !Array.isArray(inputs)) return { ok: false, reason: 'malformed' };
  if (inputs.length === 0) return { ok: false, reason: 'malformed' };
  if (inputs.length > MATCH_CONFIG.maxInputsPerMessage) return { ok: false, reason: 'too_many_inputs' };
  const parsed: ParsedInput[] = [];
  const rejected: { index: number; reason: InputRejectReason }[] = [];
  inputs.forEach((entry: unknown, index) => {
    if (!Array.isArray(entry) || entry.length !== 4) {
      rejected.push({ index, reason: 'malformed' });
      return;
    }
    const [tick, targetX, axis, launch] = entry as unknown[];
    if (!isInt(tick) || tick < 1) return void rejected.push({ index, reason: 'bad_tick' });
    if (
      targetX !== null &&
      (typeof targetX !== 'number' || !Number.isFinite(targetX) || targetX < MATCH_CONFIG.minTargetX || targetX > MATCH_CONFIG.maxTargetX)
    ) {
      return void rejected.push({ index, reason: 'bad_target' });
    }
    if (axis !== -1 && axis !== 0 && axis !== 1) return void rejected.push({ index, reason: 'bad_axis' });
    if (launch !== 0 && launch !== 1) return void rejected.push({ index, reason: 'bad_launch' });
    parsed.push({ tick, input: { targetX: targetX as number | null, axis, launch: launch === 1 } });
  });
  return { ok: true, batch: { seq, inputs: parsed, rejected } };
}

export function encodeInput(tick: number, input: TickInput): WireInput {
  return [tick, input.targetX, input.axis < 0 ? -1 : input.axis > 0 ? 1 : 0, input.launch ? 1 : 0];
}

/** Sanitises a display name: printable, trimmed, 1-16 chars. */
export function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const clean = text.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return clean.length > 0 ? clean : 'PLAYER';
}
