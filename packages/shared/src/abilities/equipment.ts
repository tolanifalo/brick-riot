import { BALANCE, type BalanceConfig } from '../config/balance';
import {
  UPGRADE_IDS,
  upgradeEffect,
  upgradePower,
  type UpgradeId,
  type UpgradeLevels,
} from '../upgrades/upgrades';
import { ABILITY_DEFINITIONS, ABILITY_RULES } from './definitions';
import type { Loadout } from './loadout';

/**
 * Equipment policies by game mode:
 * - solo: permanent upgrades apply normally; no abilities or energy.
 * - casual: private multiplayer with loadouts only (default; upgrades off).
 * - casualUpgrades: private multiplayer where the room enabled Workshop
 *   upgrades, capped by CASUAL_UPGRADE_POWER_CAP; uneven equipment needs both
 *   players to accept.
 * - ranked: future. Loadouts only, no permanent-upgrade advantages, and
 *   server-verified ownership (not available until accounts exist).
 */
export type EquipmentMode = 'solo' | 'casual' | 'casualUpgrades' | 'ranked';

export interface Equipment {
  loadout: Loadout | null;
  upgrades: UpgradeLevels;
}

/** Max Equipment Power from upgrades in a casual upgrades room. */
export const CASUAL_UPGRADE_POWER_CAP = 20;
/** Order in which upgrade levels are kept when trimming to the cap. */
const TRIM_ORDER: readonly UpgradeId[] = ['startingEnergy', 'magnetDuration', 'paddleControl', 'ballPower', 'paddleWidth'];

/** Upgrade levels that actually apply in `mode` (trimmed to the casual cap). */
export function effectiveUpgrades(upgrades: UpgradeLevels, mode: EquipmentMode): UpgradeLevels {
  const none: UpgradeLevels = { paddleControl: 0, paddleWidth: 0, ballPower: 0, magnetDuration: 0, startingEnergy: 0 };
  if (mode === 'solo') return { ...upgrades };
  if (mode !== 'casualUpgrades') return none;
  // Grant levels round-robin in a fixed order until the cap is reached.
  const out = { ...none };
  let power = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of TRIM_ORDER) {
      if (out[id] >= upgrades[id]) continue;
      const delta = upgradePower(id, out[id] + 1) - upgradePower(id, out[id]);
      if (power + delta > CASUAL_UPGRADE_POWER_CAP) continue;
      out[id]++;
      power += delta;
      progressed = true;
    }
  }
  return out;
}

function hasAny(upgrades: UpgradeLevels): boolean {
  return UPGRADE_IDS.some((id) => upgrades[id] > 0);
}

/**
 * Builds a player's simulation config from equipment. Deterministic and pure:
 * the server and the client build the identical config from the same inputs.
 * Solo with no upgrades returns BALANCE itself (golden replays unchanged).
 */
export function buildPlayerConfig(equipment: Equipment, mode: EquipmentMode, base: BalanceConfig = BALANCE): BalanceConfig {
  const upgrades = effectiveUpgrades(equipment.upgrades, mode);
  const multiplayer = mode !== 'solo';
  if (!multiplayer && !hasAny(upgrades)) return base;
  const cfg: BalanceConfig = structuredClone(base);

  if (multiplayer) {
    cfg.ball.relaunchDelaySeconds = ABILITY_RULES.relaunchDelaySeconds;
    cfg.energy.start = ABILITY_RULES.startEnergy;
    cfg.energy.max = ABILITY_RULES.maxEnergy;
    const passive = equipment.loadout?.passive;
    if (passive === 'precision') cfg.rebound.offsetGain = ABILITY_RULES.precisionOffsetGain;
    if (passive === 'accelerator') cfg.energy.gainMultiplier = ABILITY_RULES.acceleratorMultiplier;
    if (passive === 'quickRelaunch') cfg.ball.relaunchDelaySeconds = ABILITY_RULES.quickRelaunchSeconds;
  }

  const control = upgradeEffect('paddleControl', upgrades.paddleControl);
  cfg.paddle.pointerMaxSpeed *= 1 + control;
  cfg.paddle.keyboardSpeed *= 1 + control;
  cfg.paddle.width *= 1 + upgradeEffect('paddleWidth', upgrades.paddleWidth);
  cfg.ball.armorCharge = upgradeEffect('ballPower', upgrades.ballPower);
  cfg.powerUps.definitions.magnet.durationSeconds += upgradeEffect('magnetDuration', upgrades.magnetDuration);
  if (multiplayer) {
    cfg.energy.start = Math.min(cfg.energy.max, cfg.energy.start + upgradeEffect('startingEnergy', upgrades.startingEnergy));
  }
  return cfg;
}

// ---- Equipment Power Rating --------------------------------------------------

export interface EquipmentRating {
  /** Comparable across players; computed only from server-known definitions. */
  power: number;
  band: number;
  components: { source: string; power: number }[];
  /**
   * True only when ownership was verified server-side. Always false in
   * Phase 4: equipment comes from local saves.
   */
  verified: boolean;
}

export const EQUIPMENT_BAND_SIZE = 20;

/** Rates the equipment that would APPLY in `mode` (trimmed upgrades included). XP is never an input. */
export function rateEquipment(equipment: Equipment, mode: EquipmentMode): EquipmentRating {
  const components: { source: string; power: number }[] = [];
  if (equipment.loadout && mode !== 'solo') {
    for (const id of [equipment.loadout.offensive, equipment.loadout.defensive, equipment.loadout.passive]) {
      components.push({ source: ABILITY_DEFINITIONS[id].label, power: ABILITY_DEFINITIONS[id].power });
    }
  }
  const upgrades = effectiveUpgrades(equipment.upgrades, mode);
  for (const id of UPGRADE_IDS) {
    const p = upgradePower(id, upgrades[id]);
    if (p > 0) components.push({ source: `${id} L${upgrades[id]}`, power: p });
  }
  const power = components.reduce((n, c) => n + c.power, 0);
  return { power, band: Math.floor(power / EQUIPMENT_BAND_SIZE), components, verified: false };
}

export interface EquipmentCompatibilityPolicy {
  /** Max power difference before a match counts as uneven. */
  maxPowerGap: number;
}

export const DEFAULT_EQUIPMENT_POLICY: EquipmentCompatibilityPolicy = { maxPowerGap: 15 };

export interface EquipmentCompatibility {
  even: boolean;
  gap: number;
  /** Ranked additionally needs verified ownership on both sides. */
  rankedEligible: boolean;
  warnings: string[];
}

export function compareEquipment(
  a: EquipmentRating,
  b: EquipmentRating,
  policy: EquipmentCompatibilityPolicy = DEFAULT_EQUIPMENT_POLICY,
): EquipmentCompatibility {
  const gap = Math.abs(a.power - b.power);
  const even = gap <= policy.maxPowerGap;
  const warnings: string[] = [];
  if (!even) warnings.push(`Equipment power differs by ${gap} (limit ${policy.maxPowerGap}).`);
  if (!a.verified || !b.verified) warnings.push('Equipment ownership is not verified (local saves).');
  return { even, gap, rankedEligible: even && a.verified && b.verified, warnings };
}
