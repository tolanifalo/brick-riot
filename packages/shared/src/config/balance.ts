import type { BrickType } from '../levels/schema';
import type { PowerUpDefinition, PowerUpKind } from './powerups';

/** Fixed simulation constants. Changing these changes replay results. */
export const SIM = {
  tickRate: 120,
  dt: 1 / 120,
  worldWidth: 480,
  worldHeight: 800,
} as const;

/**
 * Trigonometric values are stored as literals rather than computed with
 * Math.sin/Math.cos, whose last-bit results are engine-dependent. The
 * simulation only uses + - * / and Math.sqrt (correctly rounded by IEEE 754),
 * keeping client and server replays bit-identical.
 */
export const TRIG = {
  tan60: 1.7320508075688772,
  sin15: 0.25881904510252074,
  cos15: 0.9659258262890683,
  sin10: 0.17364817766693033,
  cos10: 0.984807753012208,
  sin25: 0.42261826174069944,
  cos25: 0.9063077870366499,
} as const;

export interface BalanceConfig {
  lives: number;
  paddle: {
    width: number;
    height: number;
    /** Paddle centre Y in world units. */
    y: number;
    /** Max speed when following an absolute pointer target (px/s). */
    pointerMaxSpeed: number;
    /** Speed when driven by keyboard axis (px/s). */
    keyboardSpeed: number;
  };
  ball: {
    radius: number;
    baseSpeed: number;
    maxSpeed: number;
    /** Speed added per brick contact, until maxSpeed. */
    speedPerHit: number;
    /** Max distance a ball may travel in one collision sub-step (anti-tunnelling). */
    maxStep: number;
    /** Max random launch deflection, as a fraction of the 60 degree rebound range. */
    launchSpread: number;
    /** Wait after a lost ball before the next launch is accepted (0 in solo). */
    relaunchDelaySeconds: number;
    /** Ball Power upgrade: bonus damage charge gained per brick contact (0 = none). */
    armorCharge: number;
  };
  rebound: {
    /** tan(max rebound angle from vertical). */
    maxTan: number;
    /** Precision Aim: multiplies the contact offset before clamping (1 = none). */
    offsetGain: number;
  };
  /** Ability energy (multiplayer). Earned only from brick damage, destruction and combos. */
  energy: {
    max: number;
    start: number;
    perDamage: number;
    perDestroy: number;
    /** Every Nth consecutive destroy grants `comboBonus`. */
    comboEvery: number;
    comboBonus: number;
    /** Energy Accelerator passive. */
    gainMultiplier: number;
  };
  /** Safety rules for offensive effects applied to this simulation. */
  sabotage: {
    /** The paddle never shrinks below this width. */
    minPaddleWidth: number;
    /** Width changes wait while a ball descends within this distance above the paddle. */
    safetyZone: number;
    /** ...but never longer than this. */
    maxDeferSeconds: number;
    /** Frost Bricks only spawn at least this far above the paddle. */
    frostMinClearance: number;
  };
  safeguards: {
    /** sin of the minimum angle between ball direction and horizontal. */
    minVerticalSin: number;
    minVerticalCos: number;
    /** Seconds without paddle contact or brick damage before a deterministic nudge. */
    stuckSeconds: number;
    /** Seconds between repeated nudges while still stuck. */
    nudgeRepeatSeconds: number;
    nudgeSin: number;
    nudgeCos: number;
  };
  scoring: {
    destroyPoints: Record<BrickType, number>;
    /** Points for damaging a multi-hit brick without destroying it. */
    hitPoints: number;
    /** Multiplier gained per consecutive destroyed brick without touching the paddle. */
    comboStep: number;
    comboMaxMultiplier: number;
    /** Clear bonus per ball remaining when the board is cleared. */
    lifeBonus: number;
    /** Clear bonus per whole second finished under the board's par time. */
    timeBonusPerSecond: number;
  };
  explosive: {
    /** Damage dealt to every brick in the surrounding 3x3 cells. */
    damage: number;
  };
  powerUps: {
    /** Falling capsule speed (u/s). */
    fallSpeed: number;
    capsuleWidth: number;
    capsuleHeight: number;
    /** Points for catching a capsule. */
    collectPoints: number;
    /** Points for catching a power-down instead (a brave catch). */
    powerDownBonus: number;
    /** World Y of the Safety Net barrier (below the paddle). */
    netY: number;
    /** Capsules allowed in flight at once; further drops are skipped. */
    maxPickups: number;
    /** Hard cap on simultaneous balls. */
    maxBalls: number;
    /** Multiball splits at +/- this angle from the source ball. */
    multiballSin: number;
    multiballCos: number;
    laserBoltSpeed: number;
    definitions: Record<PowerUpKind, PowerUpDefinition>;
  };
}

export const BALANCE: BalanceConfig = {
  lives: 3,
  paddle: {
    width: 88,
    height: 14,
    y: 728,
    pointerMaxSpeed: 3600,
    keyboardSpeed: 900,
  },
  ball: {
    radius: 7,
    baseSpeed: 430,
    maxSpeed: 720,
    speedPerHit: 3,
    maxStep: 3.5,
    launchSpread: 0.3,
    relaunchDelaySeconds: 0,
    armorCharge: 0,
  },
  rebound: {
    maxTan: TRIG.tan60,
    offsetGain: 1,
  },
  energy: {
    max: 100,
    start: 0,
    perDamage: 1,
    perDestroy: 3,
    comboEvery: 5,
    comboBonus: 5,
    gainMultiplier: 1,
  },
  sabotage: {
    minPaddleWidth: 60,
    safetyZone: 140,
    maxDeferSeconds: 2,
    frostMinClearance: 260,
  },
  safeguards: {
    minVerticalSin: TRIG.sin15,
    minVerticalCos: TRIG.cos15,
    stuckSeconds: 10,
    nudgeRepeatSeconds: 2,
    nudgeSin: TRIG.sin10,
    nudgeCos: TRIG.cos10,
  },
  scoring: {
    destroyPoints: {
      standard: 50,
      reinforced: 90,
      explosive: 60,
      powerup: 50,
      moving: 70,
      indestructible: 0,
      frost: 0,
    },
    hitPoints: 10,
    comboStep: 0.25,
    comboMaxMultiplier: 4,
    lifeBonus: 1000,
    timeBonusPerSecond: 25,
  },
  explosive: {
    damage: 99,
  },
  powerUps: {
    fallSpeed: 150,
    capsuleWidth: 32,
    capsuleHeight: 14,
    collectPoints: 25,
    powerDownBonus: 250,
    netY: 782,
    maxPickups: 6,
    maxBalls: 6,
    multiballSin: TRIG.sin25,
    multiballCos: TRIG.cos25,
    laserBoltSpeed: 900,
    definitions: {
      multiball: { durationSeconds: 0, strength: 2, dropWeight: 18, cooldownSeconds: 0 },
      wide: { durationSeconds: 12, strength: 1.5, dropWeight: 20, cooldownSeconds: 0 },
      heavy: { durationSeconds: 7, strength: 99, dropWeight: 12, cooldownSeconds: 0 },
      magnet: { durationSeconds: 15, strength: 2.5, dropWeight: 16, cooldownSeconds: 0 },
      laser: { durationSeconds: 10, strength: 1, dropWeight: 14, cooldownSeconds: 0.3 },
      bomb: { durationSeconds: 12, strength: 1, dropWeight: 14, cooldownSeconds: 0 },
      // Opt-in per board (`powerUpPool` / `powerDownChance`); boards that don't opt in never drop these.
      net: { durationSeconds: 20, strength: 1, dropWeight: 12, cooldownSeconds: 0 },
      nuke: { durationSeconds: 12, strength: 2, dropWeight: 4, cooldownSeconds: 0 },
      // 88 x 0.7 = 61.6 u, just above the 60 u minimum paddle width.
      mini: { durationSeconds: 8, strength: 0.7, dropWeight: 10, cooldownSeconds: 0 },
      invert: { durationSeconds: 6, strength: 0.75, dropWeight: 8, cooldownSeconds: 0 },
      fast: { durationSeconds: 8, strength: 1.35, dropWeight: 10, cooldownSeconds: 0 },
    },
  },
};
