import {
  ABILITY_DEFINITIONS,
  ABILITY_RULES,
  DEFENSIVE_ABILITIES,
  OFFENSIVE_ABILITIES,
  PASSIVE_ABILITIES,
  type AbilityId,
  type DefensiveAbility,
  type LoadoutSlot,
  type OffensiveAbility,
  type PassiveAbility,
} from './definitions';

export interface Loadout {
  offensive: OffensiveAbility;
  defensive: DefensiveAbility;
  passive: PassiveAbility;
}

/** Available to every new player (all level 1). Power 70 of 80. */
export const DEFAULT_LOADOUT: Loadout = { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' };

export const SLOT_OPTIONS: Record<LoadoutSlot, readonly AbilityId[]> = {
  offensive: OFFENSIVE_ABILITIES,
  defensive: DEFENSIVE_ABILITIES,
  passive: PASSIVE_ABILITIES,
};

export function loadoutPower(loadout: Loadout): number {
  return (
    ABILITY_DEFINITIONS[loadout.offensive].power +
    ABILITY_DEFINITIONS[loadout.defensive].power +
    ABILITY_DEFINITIONS[loadout.passive].power
  );
}

export function isAbilityUnlocked(id: AbilityId, playerLevel: number): boolean {
  return playerLevel >= ABILITY_DEFINITIONS[id].unlockLevel;
}

export type LoadoutError = 'malformed' | 'wrong_slot' | 'locked' | 'over_budget';

export interface LoadoutCheckOptions {
  budget?: number;
  /** Dev rooms skip unlock checks (never the budget). */
  ignoreUnlocks?: boolean;
}

/**
 * Validates an untrusted loadout. Structure, slot membership and the power
 * budget are always enforced; unlocks are checked against `playerLevel`
 * (which in Phase 4 still comes from the client's local save, so this is
 * only meaningful for unranked play).
 */
export function validateLoadout(
  raw: unknown,
  playerLevel: number,
  options: LoadoutCheckOptions = {},
): { ok: true; loadout: Loadout } | { ok: false; error: LoadoutError } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'malformed' };
  const r = raw as Record<string, unknown>;
  const offensive = r['offensive'];
  const defensive = r['defensive'];
  const passive = r['passive'];
  if (typeof offensive !== 'string' || typeof defensive !== 'string' || typeof passive !== 'string') {
    return { ok: false, error: 'malformed' };
  }
  if (
    !(OFFENSIVE_ABILITIES as readonly string[]).includes(offensive) ||
    !(DEFENSIVE_ABILITIES as readonly string[]).includes(defensive) ||
    !(PASSIVE_ABILITIES as readonly string[]).includes(passive)
  ) {
    return { ok: false, error: 'wrong_slot' };
  }
  const loadout: Loadout = {
    offensive: offensive as OffensiveAbility,
    defensive: defensive as DefensiveAbility,
    passive: passive as PassiveAbility,
  };
  if (!options.ignoreUnlocks) {
    for (const id of [loadout.offensive, loadout.defensive, loadout.passive]) {
      if (!isAbilityUnlocked(id, playerLevel)) return { ok: false, error: 'locked' };
    }
  }
  if (loadoutPower(loadout) > (options.budget ?? ABILITY_RULES.loadoutBudget)) return { ok: false, error: 'over_budget' };
  return { ok: true, loadout };
}
