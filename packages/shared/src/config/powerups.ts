import type { BrickColor } from '../levels/schema';

/**
 * Every capsule kind. ORDER MATTERS for replays only through drop pools (see
 * LEGACY_DROP_POOL); appending kinds here never changes an existing board.
 */
export const POWER_UP_KINDS = ['multiball', 'wide', 'heavy', 'magnet', 'laser', 'bomb', 'net', 'nuke', 'mini', 'invert', 'fast'] as const;
export type PowerUpKind = (typeof POWER_UP_KINDS)[number];

/** Capsules that hurt the catcher. They only ever come from random drops, never from power-up bricks. */
export const POWER_DOWN_KINDS = ['mini', 'invert', 'fast'] as const;
export type PowerDownKind = (typeof POWER_DOWN_KINDS)[number];
export type PositivePowerUp = Exclude<PowerUpKind, PowerDownKind>;

export function isPowerDown(kind: PowerUpKind): kind is PowerDownKind {
  return (POWER_DOWN_KINDS as readonly string[]).includes(kind);
}

/**
 * The Phase 2 random-drop pool, in its Phase 2 order. Boards that do not set
 * `powerUpPool` use it, so their drops (and replays) are unchanged.
 */
export const LEGACY_DROP_POOL: readonly PositivePowerUp[] = ['multiball', 'wide', 'heavy', 'magnet', 'laser', 'bomb'];

/** Power-ups with a duration; multiball is instant. */
export type TimedPowerUp = Exclude<PowerUpKind, 'multiball'>;
export const TIMED_POWER_UPS: readonly TimedPowerUp[] = ['wide', 'heavy', 'magnet', 'laser', 'bomb', 'net', 'nuke', 'mini', 'invert', 'fast'];

/** Simulation tunables per power-up (part of BalanceConfig, so they affect replays). */
export interface PowerUpDefinition {
  /** 0 = instant effect. Collecting an active timed power-up refreshes it to full. */
  durationSeconds: number;
  /**
   * Effect strength, by kind:
   * multiball: extra balls spawned · wide: width multiplier · heavy: damage per contact ·
   * magnet: max seconds a ball is held · laser: damage per bolt · bomb: blast radius in cells ·
   * net: saves (always 1) · nuke: blast radius in cells · mini: width multiplier ·
   * invert: warning seconds before the controls flip · fast: ball speed multiplier
   */
  strength: number;
  /** Relative chance among random drops of the same family (power-ups or power-downs). */
  dropWeight: number;
  /** Minimum seconds between activations (laser shots). */
  cooldownSeconds: number;
}

/** Presentation data. Never read by the simulation. */
export interface PowerUpInfo {
  label: string;
  /** Single character printed on the capsule. */
  glyph: string;
  color: BrickColor;
  /** Power-downs get the hazard capsule so they can be told apart and dodged. */
  negative: boolean;
  activation: string;
  expiration: string;
}

export const POWER_UP_INFO: Record<PowerUpKind, PowerUpInfo> = {
  multiball: {
    label: 'Multiball',
    glyph: 'M',
    color: 'cyan',
    negative: false,
    activation: 'Instantly splits the lead ball into three.',
    expiration: 'Extra balls last until they fall. Losing them costs no life while another ball is in play.',
  },
  wide: {
    label: 'Wide Paddle',
    glyph: 'W',
    color: 'lime',
    negative: false,
    activation: 'Widens the paddle. Cancels Mini Paddle.',
    expiration: 'Timed. Ends early if you lose a ball.',
  },
  heavy: {
    label: 'Heavy Ball',
    glyph: 'H',
    color: 'orange',
    negative: false,
    activation: 'Balls smash through breakable bricks without bouncing.',
    expiration: 'Timed. Steel still deflects.',
  },
  magnet: {
    label: 'Magnet',
    glyph: 'G',
    color: 'violet',
    negative: false,
    activation: 'The paddle catches balls. Launch to release, or they auto-release.',
    expiration: 'Timed. Held balls are released when it ends.',
  },
  laser: {
    label: 'Laser',
    glyph: 'L',
    color: 'red',
    negative: false,
    activation: 'Launch input fires twin bolts.',
    expiration: 'Timed, with a short cooldown between shots.',
  },
  bomb: {
    label: 'Bomb',
    glyph: 'B',
    color: 'yellow',
    negative: false,
    activation: 'The next brick a ball touches detonates.',
    expiration: 'One use, or expires if unused.',
  },
  net: {
    label: 'Safety Net',
    glyph: 'S',
    color: 'blue',
    negative: false,
    activation: 'A barrier under the paddle bounces the next falling ball back up.',
    expiration: 'Breaks after one save, or expires.',
  },
  nuke: {
    label: 'Nuke',
    glyph: 'N',
    color: 'magenta',
    negative: false,
    activation: 'The next brick a ball touches sets off a huge blast. Steel survives.',
    expiration: 'One use, or expires if unused.',
  },
  mini: {
    label: 'Mini Paddle',
    glyph: '-',
    color: 'red',
    negative: true,
    activation: 'Shrinks the paddle (waits until no ball is about to land). Cancels Wide Paddle.',
    expiration: 'Timed. Ends if you lose a ball.',
  },
  invert: {
    label: 'Reversed',
    glyph: 'R',
    color: 'red',
    negative: true,
    activation: 'After a short warning, left and right swap.',
    expiration: 'Timed. Ends if you lose a ball.',
  },
  fast: {
    label: 'Fast Ball',
    glyph: 'F',
    color: 'red',
    negative: true,
    activation: 'Every ball speeds up.',
    expiration: 'Timed. Ends if you lose a ball.',
  },
};
