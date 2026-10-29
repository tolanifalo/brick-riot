import { SIM } from '../config/balance';

/**
 * Multiplayer timing and protocol limits. The server reads these defaults and
 * may override the timing values from environment variables (see the server's
 * config.ts); limits that protect the server are not overridable by clients.
 */
export const MATCH_CONFIG = {
  /** Simulation rate. The engine is fixed at 120 Hz (see SIM.tickRate). */
  tickRate: SIM.tickRate,
  /** Default match length. */
  durationSeconds: 120,
  /** Countdown between "both ready" and the authoritative start tick. */
  countdownMs: 3000,
  /** Grace period for a dropped player before they forfeit. */
  reconnectSeconds: 20,
  /** A lobby with no match started for this long is closed. */
  lobbyIdleMinutes: 15,
  /** Checksum + progress update cadence: every 6 ticks = 20 Hz. */
  syncEveryTicks: 6,
  /** Opponent board preview cadence: every 12 ticks = 10 Hz. */
  previewEveryTicks: 12,
  /** Inputs stamped further ahead than this are rejected (2 s). */
  maxInputLeadTicks: 240,
  maxInputsPerMessage: 32,
  /** Per-client message budget (token bucket refill per second / burst). */
  messagesPerSecond: 90,
  messageBurst: 150,
  /** Launch/fire actions accepted per second per player. */
  maxLaunchesPerSecond: 15,
  /** Full-state resync requests allowed per second per player. */
  resyncPerSecond: 2,
  /** Paddle target bounds accepted from clients (world units; the sim clamps further). */
  minTargetX: -SIM.worldWidth,
  maxTargetX: SIM.worldWidth * 2,
  /** Join-code lookups per IP per minute. */
  codeLookupsPerMinute: 20,
  /** Failed code guesses per IP before a 10-minute block. */
  maxFailedCodeGuesses: 10,
} as const;

export type Seat = 'A' | 'B';
export const SEATS: readonly Seat[] = ['A', 'B'];
export const otherSeat = (seat: Seat): Seat => (seat === 'A' ? 'B' : 'A');
