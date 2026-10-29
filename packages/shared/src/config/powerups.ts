import type { BrickColor } from '../levels/schema';

export const POWER_UP_KINDS = ['multiball', 'wide', 'heavy', 'magnet', 'laser', 'bomb'] as const;
export type PowerUpKind = (typeof POWER_UP_KINDS)[number];

/** Power-ups with a duration; multiball is instant. */
export type TimedPowerUp = Exclude<PowerUpKind, 'multiball'>;
export const TIMED_POWER_UPS: readonly TimedPowerUp[] = ['wide', 'heavy', 'magnet', 'laser', 'bomb'];

/** Simulation tunables per power-up (part of BalanceConfig, so they affect replays). */
export interface PowerUpDefinition {
  /** 0 = instant effect. Collecting an active timed power-up refreshes it to full. */
  durationSeconds: number;
  /**
   * Effect strength, by kind:
   * multiball: extra balls spawned · wide: width multiplier · heavy: damage per contact ·
   * magnet: max seconds a ball is held · laser: damage per bolt · bomb: blast radius in cells
   */
  strength: number;
  /** Relative chance among random drops. */
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
  activation: string;
  expiration: string;
}

export const POWER_UP_INFO: Record<PowerUpKind, PowerUpInfo> = {
  multiball: {
    label: 'Multiball',
    glyph: 'M',
    color: 'cyan',
    activation: 'Instantly splits the lead ball into three.',
    expiration: 'Extra balls last until they fall. Losing them costs no life while another ball is in play.',
  },
  wide: {
    label: 'Wide Paddle',
    glyph: 'W',
    color: 'lime',
    activation: 'Widens the paddle.',
    expiration: 'Timed. Ends early if you lose a ball.',
  },
  heavy: {
    label: 'Heavy Ball',
    glyph: 'H',
    color: 'orange',
    activation: 'Balls smash through breakable bricks without bouncing.',
    expiration: 'Timed. Steel still deflects.',
  },
  magnet: {
    label: 'Magnet',
    glyph: 'G',
    color: 'violet',
    activation: 'The paddle catches balls. Launch to release, or they auto-release.',
    expiration: 'Timed. Held balls are released when it ends.',
  },
  laser: {
    label: 'Laser',
    glyph: 'L',
    color: 'red',
    activation: 'Launch input fires twin bolts.',
    expiration: 'Timed, with a short cooldown between shots.',
  },
  bomb: {
    label: 'Bomb',
    glyph: 'B',
    color: 'yellow',
    activation: 'The next brick a ball touches detonates.',
    expiration: 'One use, or expires if unused.',
  },
};
