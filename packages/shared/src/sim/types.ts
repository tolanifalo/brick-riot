import type { ActiveAbility, OffensiveAbility } from '../abilities/definitions';
import type { PowerUpKind, TimedPowerUp } from '../config/powerups';
import type { BrickColor, BrickType } from '../levels/schema';

export type SimStatus = 'ready' | 'playing' | 'won' | 'lost';

export interface PaddleState {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Velocity applied during the last tick (px/s). */
  vx: number;
}

export interface BallState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  radius: number;
  /** True while resting on the paddle (serve, or caught by the magnet). */
  attached: boolean;
  /** Horizontal offset from the paddle centre while attached. */
  attachOffset: number;
  /** Ticks spent held by the magnet. */
  heldTicks: number;
}

export interface BrickState {
  id: number;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: BrickType;
  color: BrickColor;
  hp: number;
  maxHp: number;
  required: boolean;
  alive: boolean;
  /** Layout X; moving bricks oscillate between baseX and baseX + moveRange. */
  baseX: number;
  moveRange: number;
  moveSpeed: number;
  /** Current horizontal velocity (u/s); 0 for static bricks. */
  vx: number;
  powerUp: PowerUpKind | 'random' | null;
}

/** A falling power-up capsule. */
export interface PickupState {
  id: number;
  kind: PowerUpKind;
  x: number;
  y: number;
}

export interface LaserBoltState {
  id: number;
  x: number;
  y: number;
}

/** Remaining ticks per timed power-up; 0 = inactive. */
export type EffectTimers = Record<TimedPowerUp, number>;

/** Plain, serialisable simulation state (no class instances or functions). */
export interface SimState {
  boardId: string;
  boardVersion: number;
  seed: number;
  tick: number;
  status: SimStatus;
  paused: boolean;
  rngState: number;
  /** Separate stream for power-up drops, so drops never perturb launch angles. */
  dropRngState: number;
  lives: number;
  score: number;
  combo: number;
  bestCombo: number;
  bricksDestroyed: number;
  ballsLost: number;
  /** Ticks elapsed since the first launch, excluding pauses. */
  elapsedTicks: number;
  started: boolean;
  requiredTotal: number;
  requiredRemaining: number;
  ticksSinceProgress: number;
  speedHits: number;
  nextBallId: number;
  nextEntityId: number;
  clearBonus: number;
  paddle: PaddleState;
  balls: BallState[];
  bricks: BrickState[];
  pickups: PickupState[];
  lasers: LaserBoltState[];
  effects: EffectTimers;
  laserCooldown: number;
  powerUpsCollected: number;
  // ---- Phase 4: abilities (inert unless external commands arrive) ----
  /** Ability energy in tenths (0..config.energy.max * 10). */
  energy10: number;
  /** Tick at which each active ability is usable again (0 = ready). */
  cooldowns: Record<ActiveAbility, number>;
  /** Shield is up while tick < shieldUntil. */
  shieldUntil: number;
  /** The single offensive effect on this player, if any. */
  debuff: DebuffState | null;
  /** New offensive effects are refused while tick < immuneUntil. */
  immuneUntil: number;
  /** After a lost ball, launch is accepted from this tick on. */
  serveReadyTick: number;
  /** Ball Power upgrade: accumulated bonus damage (0..1). */
  armorCharge: number;
}

export type DebuffKind = 'emp' | 'shrink' | 'frost';

export interface DebuffState {
  kind: DebuffKind;
  /**
   * 'pending': waiting for a safe moment to start (no ball descending close to
   * the paddle), so a size change can never cause an unavoidable miss.
   */
  phase: 'pending' | 'active';
  /** Active ticks left. */
  remaining: number;
  /** Ticks spent pending (bounded). */
  deferred: number;
  /** Shrink: width multiplier. */
  factor: number;
  /** Frost: the obstacle's brick id. */
  brickId: number | null;
  /** Frost: obstacle hit points. */
  hp: number;
  /** Immunity granted when this effect ends. */
  immunityTicks: number;
}

/**
 * Mechanical commands the server schedules into a player's simulation at an
 * exact tick (decided by the ability arbiter, recorded in the applied input
 * log so replays verify). Clients can never send these.
 */
export type ExternalCommand =
  | { k: 'spend'; ability: ActiveAbility; cost10: number; readyTick: number }
  | { k: 'shield'; untilTick: number }
  | { k: 'block'; ability: OffensiveAbility }
  | { k: 'debuff'; kind: DebuffKind; ticks: number; immunityTicks: number; factor: number; hp: number }
  | { k: 'cleanse'; immunityTicks: number };

export interface TickInput {
  /** Absolute paddle target in world X, from pointer/touch. Null when unused. */
  targetX: number | null;
  /** Keyboard axis, -1..1. Ignored when targetX is set. */
  axis: number;
  /**
   * Edge-triggered action: launches a served ball, releases magnet-held balls
   * and fires the laser when available.
   */
  launch: boolean;
  /** Server-scheduled commands for this tick (multiplayer only). */
  ext?: ExternalCommand[];
}

export const IDLE_INPUT: Readonly<TickInput> = { targetX: null, axis: 0, launch: false };

export type SimEvent =
  | { type: 'launch'; ballId: number; x: number; y: number }
  | { type: 'wall'; x: number; y: number }
  | { type: 'paddle'; x: number; y: number; offset: number }
  | { type: 'brickHit'; brickId: number; x: number; y: number; destroyed: boolean; points: number; combo: number }
  | { type: 'brickDeflect'; brickId: number; x: number; y: number }
  | { type: 'explosion'; brickId: number; x: number; y: number; radius: number; source: 'brick' | 'bomb' }
  | { type: 'ballLost'; x: number; livesRemaining: number }
  | { type: 'ballDrained'; ballId: number; x: number }
  | { type: 'nudge'; ballId: number }
  | { type: 'pickupSpawned'; pickupId: number; kind: PowerUpKind; x: number; y: number }
  | { type: 'powerUp'; kind: PowerUpKind; x: number; y: number }
  | { type: 'pickupMissed'; pickupId: number }
  | { type: 'effectEnded'; kind: TimedPowerUp }
  | { type: 'multiball'; spawned: number }
  | { type: 'magnetCatch'; ballId: number }
  | { type: 'magnetRelease'; ballId: number }
  | { type: 'laserFired'; leftX: number; rightX: number; y: number }
  | { type: 'abilityUsed'; ability: ActiveAbility }
  | { type: 'shieldUp' }
  | { type: 'attackBlocked'; ability: OffensiveAbility }
  | { type: 'debuffIncoming'; kind: DebuffKind }
  | { type: 'debuffActive'; kind: DebuffKind }
  | { type: 'debuffEnded'; kind: DebuffKind; reason: 'expired' | 'cleansed' | 'shattered' | 'fizzled' }
  | { type: 'frostSpawned'; brickId: number; x: number; y: number }
  | { type: 'laserHit'; boltId: number; x: number; y: number }
  | { type: 'won'; clearBonus: number }
  | { type: 'lost' };
