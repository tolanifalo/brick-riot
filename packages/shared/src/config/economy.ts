/**
 * Progression economy. Kept separate from BalanceConfig: these values never
 * affect the simulation, so tuning them cannot break replay verification.
 * Documented in BALANCE_CONFIG.md.
 */
import type { MasteryObjective } from '../levels/schema';

export type MasteryKind = MasteryObjective['kind'];

export interface Reward {
  xp: number;
  coins: number;
}

export interface EconomyConfig {
  levelCurve: {
    /** XP needed to go from level 1 to level 2. */
    firstLevelXp: number;
    /** Each further level needs this multiple of the previous requirement. */
    growth: number;
    maxLevel: number;
  };
  completion: {
    /** Base reward for clearing any board... */
    base: Reward;
    /** ...plus this much per point of designer difficulty rating. */
    perDifficulty: Reward;
    /** Per star earned on the run (stars encode completion time). */
    perStar: Reward;
    /** Per ball still in hand at the clear. */
    perBallRemaining: Reward;
    /** XP per point of best combo, capped. */
    comboXp: number;
    comboXpCap: number;
  };
  repeat: {
    /** Multiplier on completion rewards for a board's first clear. */
    firstClearMultiplier: number;
    /** Nth repeat clear earns decay^N of the completion reward... */
    decay: number;
    /** ...but never less than this fraction. */
    floor: number;
  };
  /** Bonus for raising a board's best star rating; per star gained, never decays. */
  starImprovement: Reward;
  /** One-time reward per mastery objective, by kind. */
  mastery: Record<MasteryKind, Reward>;
}

export const ECONOMY: EconomyConfig = {
  levelCurve: {
    firstLevelXp: 300,
    growth: 1.18,
    maxLevel: 60,
  },
  completion: {
    base: { xp: 100, coins: 20 },
    perDifficulty: { xp: 30, coins: 6 },
    perStar: { xp: 25, coins: 5 },
    perBallRemaining: { xp: 15, coins: 4 },
    comboXp: 3,
    comboXpCap: 60,
  },
  repeat: {
    firstClearMultiplier: 2,
    decay: 0.6,
    floor: 0.1,
  },
  starImprovement: { xp: 40, coins: 10 },
  mastery: {
    clear: { xp: 40, coins: 10 },
    minBallsRemaining: { xp: 60, coins: 15 },
    clearUnderSeconds: { xp: 80, coins: 20 },
    noBallLost: { xp: 100, coins: 25 },
    minCombo: { xp: 80, coins: 20 },
    minScore: { xp: 80, coins: 20 },
  },
};

/**
 * Phase 5: rewards for PUBLIC Quick Match games between signed-in players,
 * granted by the server when a replay-verified match is finalised. Private
 * rooms grant nothing (two accounts could farm each other). Players who
 * forfeit, cancelled matches and anything beyond the daily cap earn nothing.
 */
export const MATCH_REWARDS = {
  win: { xp: 40, coins: 10 },
  draw: { xp: 25, coins: 5 },
  loss: { xp: 15, coins: 3 },
  /** Rewarded Quick Matches per player per UTC day. */
  dailyCap: 20,
} as const;

export interface LevelInfo {
  level: number;
  /** XP earned inside the current level. */
  xpIntoLevel: number;
  /** XP needed to finish the current level; 0 at max level. */
  xpForNext: number;
}

/** XP required to advance from `level` to `level + 1`. */
export function xpToAdvance(level: number, curve: EconomyConfig['levelCurve'] = ECONOMY.levelCurve): number {
  let need = curve.firstLevelXp;
  for (let l = 1; l < level; l++) need *= curve.growth;
  return Math.round(need);
}

export function levelForXp(xp: number, curve: EconomyConfig['levelCurve'] = ECONOMY.levelCurve): LevelInfo {
  let level = 1;
  let remaining = Math.max(0, Math.floor(xp));
  while (level < curve.maxLevel) {
    const need = xpToAdvance(level, curve);
    if (remaining < need) return { level, xpIntoLevel: remaining, xpForNext: need };
    remaining -= need;
    level++;
  }
  return { level, xpIntoLevel: 0, xpForNext: 0 };
}
