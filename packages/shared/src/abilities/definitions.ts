import { SIM } from '../config/balance';

/**
 * Phase 4 abilities. Values are initial, conservative and easy to tune;
 * documented in BALANCE_CONFIG.md. None of these are sold for real money:
 * every ability unlocks through player level (campaign XP).
 */

export const OFFENSIVE_ABILITIES = ['emp', 'shrink', 'frost'] as const;
export const DEFENSIVE_ABILITIES = ['shield', 'cleanse'] as const;
export const PASSIVE_ABILITIES = ['precision', 'accelerator', 'quickRelaunch'] as const;

export type OffensiveAbility = (typeof OFFENSIVE_ABILITIES)[number];
export type DefensiveAbility = (typeof DEFENSIVE_ABILITIES)[number];
export type PassiveAbility = (typeof PASSIVE_ABILITIES)[number];
/** Abilities a player activates during a match. */
export type ActiveAbility = OffensiveAbility | DefensiveAbility;
export type AbilityId = ActiveAbility | PassiveAbility;
export type LoadoutSlot = 'offensive' | 'defensive' | 'passive';

export const ACTIVE_ABILITIES: readonly ActiveAbility[] = [...OFFENSIVE_ABILITIES, ...DEFENSIVE_ABILITIES];

export interface AbilityDefinition {
  id: AbilityId;
  slot: LoadoutSlot;
  label: string;
  /** Short text for buttons and tooltips. */
  description: string;
  /** Loadout budget cost (also feeds the Equipment Power Rating). */
  power: number;
  /** Player level that unlocks it. */
  unlockLevel: number;
  /** Active abilities only. */
  energyCost: number;
  cooldownSeconds: number;
  durationSeconds: number;
}

export const ABILITY_DEFINITIONS: Record<AbilityId, AbilityDefinition> = {
  emp: {
    id: 'emp',
    slot: 'offensive',
    label: 'EMP Pulse',
    description: "Jams the opponent's paddle power-ups (wide, magnet, laser) for 2 s. Movement, ball and launch are untouched.",
    power: 30,
    unlockLevel: 1,
    energyCost: 40,
    cooldownSeconds: 12,
    durationSeconds: 2,
  },
  shrink: {
    id: 'shrink',
    slot: 'offensive',
    label: 'Shrink Ray',
    description: "Shrinks the opponent's paddle by 15% for 3 s (never below a safe minimum).",
    power: 35,
    unlockLevel: 3,
    energyCost: 50,
    cooldownSeconds: 15,
    durationSeconds: 3,
  },
  frost: {
    id: 'frost',
    slot: 'offensive',
    label: 'Frost Brick',
    description: "Drops a 2-hit ice block into open space on the opponent's board for up to 5 s. It never counts as a required brick.",
    power: 40,
    unlockLevel: 5,
    energyCost: 60,
    cooldownSeconds: 18,
    durationSeconds: 5,
  },
  shield: {
    id: 'shield',
    slot: 'defensive',
    label: 'Shield',
    description: 'Blocks the next incoming attack within 8 s. Consumed when it blocks.',
    power: 25,
    unlockLevel: 1,
    energyCost: 35,
    cooldownSeconds: 15,
    durationSeconds: 8,
  },
  cleanse: {
    id: 'cleanse',
    slot: 'defensive',
    label: 'Cleanse',
    description: 'Removes the active negative effect. Refused (free) if nothing is active.',
    power: 20,
    unlockLevel: 2,
    energyCost: 30,
    cooldownSeconds: 12,
    durationSeconds: 0,
  },
  precision: {
    id: 'precision',
    slot: 'passive',
    label: 'Precision Aim',
    description: 'Rebound angles respond 12% more strongly to where the ball meets the paddle.',
    power: 20,
    unlockLevel: 3,
    energyCost: 0,
    cooldownSeconds: 0,
    durationSeconds: 0,
  },
  accelerator: {
    id: 'accelerator',
    slot: 'passive',
    label: 'Energy Accelerator',
    description: '+20% energy from brick hits and destructions.',
    power: 25,
    unlockLevel: 4,
    energyCost: 0,
    cooldownSeconds: 0,
    durationSeconds: 0,
  },
  quickRelaunch: {
    id: 'quickRelaunch',
    slot: 'passive',
    label: 'Quick Relaunch',
    description: 'After losing a ball, the next one can launch after 0.5 s instead of 1 s.',
    power: 15,
    unlockLevel: 1,
    energyCost: 0,
    cooldownSeconds: 0,
    durationSeconds: 0,
  },
};

/** Match-wide ability rules (server arbiter). */
export const ABILITY_RULES = {
  maxEnergy: 100,
  /** Energy every player starts a match with (Starting Energy upgrade adds to it). */
  startEnergy: 20,
  /** No offensive ability during the first seconds of a match. */
  openingLockoutSeconds: 5,
  /** Immunity to new offensive effects after one ends. */
  immunitySeconds: 5,
  /**
   * Accepted abilities take effect this many ticks after the server accepts
   * them (0.4 s). Clients learn the effect before simulating that tick, so
   * prediction stays exact; it also gives the target an "incoming" warning.
   */
  applyDelayTicks: 48,
  /** Ability requests a player may send per second (rate limit). */
  maxRequestsPerSecond: 6,
  /** Effect parameters. */
  shrinkFactor: 0.85,
  frostHp: 2,
  /** Relaunch delay after losing a ball in multiplayer (Quick Relaunch halves it). */
  relaunchDelaySeconds: 1,
  quickRelaunchSeconds: 0.5,
  precisionOffsetGain: 1.12,
  acceleratorMultiplier: 1.2,
  /** Loadout power budget. */
  loadoutBudget: 80,
} as const;

export const secondsToTicks = (s: number): number => Math.round(s * SIM.tickRate);

export function isOffensive(id: AbilityId): id is OffensiveAbility {
  return (OFFENSIVE_ABILITIES as readonly string[]).includes(id);
}

export function isDefensive(id: AbilityId): id is DefensiveAbility {
  return (DEFENSIVE_ABILITIES as readonly string[]).includes(id);
}

export function isActiveAbility(id: unknown): id is ActiveAbility {
  return typeof id === 'string' && (ACTIVE_ABILITIES as readonly string[]).includes(id);
}
