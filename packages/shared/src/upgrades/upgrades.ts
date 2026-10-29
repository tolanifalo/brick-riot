import type { PlayerProgress } from '../progress/types';

/**
 * Permanent upgrades bought with campaign coins (never real money).
 * `effects[n-1]` is the CUMULATIVE effect at level n: each level adds less
 * than the one before (diminishing returns), and the last value is the cap.
 * `power[n-1]` is the cumulative Equipment Power Rating contribution.
 */
export const UPGRADE_IDS = ['paddleControl', 'paddleWidth', 'ballPower', 'magnetDuration', 'startingEnergy'] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export type UpgradeLevels = Record<UpgradeId, number>;

export interface UpgradeDefinition {
  id: UpgradeId;
  label: string;
  description: string;
  /** How to print an effect value. */
  format: (value: number) => string;
  costs: readonly number[];
  effects: readonly number[];
  power: readonly number[];
}

const pct = (v: number) => `+${Math.round(v * 1000) / 10}%`;

export const UPGRADES: Record<UpgradeId, UpgradeDefinition> = {
  paddleControl: {
    id: 'paddleControl',
    label: 'Paddle Control',
    description: 'Faster paddle response to keyboard and pointer.',
    format: (v) => `${pct(v)} paddle speed`,
    costs: [120, 220, 360, 550, 800],
    effects: [0.06, 0.11, 0.15, 0.18, 0.2],
    power: [2, 4, 5, 6, 7],
  },
  paddleWidth: {
    id: 'paddleWidth',
    label: 'Paddle Width',
    description: 'A wider paddle (capped at +10%).',
    format: (v) => `${pct(v)} width`,
    costs: [150, 280, 450, 700, 1000],
    effects: [0.03, 0.055, 0.075, 0.09, 0.1],
    power: [3, 5, 7, 8, 9],
  },
  ballPower: {
    id: 'ballPower',
    label: 'Ball Power',
    description: 'Hits on multi-hit bricks build charge; a full charge deals +1 damage.',
    format: (v) => `${Math.round(v * 100)}% charge per hit`,
    costs: [200, 400, 700],
    effects: [0.15, 0.27, 0.36],
    power: [3, 5, 7],
  },
  magnetDuration: {
    id: 'magnetDuration',
    label: 'Magnet Duration',
    description: 'The Magnet power-up lasts longer.',
    format: (v) => `+${v}s magnet`,
    costs: [100, 200, 350],
    effects: [2, 3.5, 4.5],
    power: [1, 2, 3],
  },
  startingEnergy: {
    id: 'startingEnergy',
    label: 'Starting Energy',
    description: 'Start multiplayer matches with more ability energy.',
    format: (v) => `+${v} energy`,
    costs: [150, 300, 500, 750],
    effects: [5, 9, 12, 14],
    power: [2, 4, 5, 6],
  },
};

export const NO_UPGRADES: UpgradeLevels = { paddleControl: 0, paddleWidth: 0, ballPower: 0, magnetDuration: 0, startingEnergy: 0 };

export function maxLevel(id: UpgradeId): number {
  return UPGRADES[id].costs.length;
}

/** Effect value at `level` (0 at level 0). */
export function upgradeEffect(id: UpgradeId, level: number): number {
  return level <= 0 ? 0 : (UPGRADES[id].effects[Math.min(level, maxLevel(id)) - 1] ?? 0);
}

export function upgradePower(id: UpgradeId, level: number): number {
  return level <= 0 ? 0 : (UPGRADES[id].power[Math.min(level, maxLevel(id)) - 1] ?? 0);
}

/** Cost of buying the NEXT level, or null at max level. */
export function nextLevelCost(id: UpgradeId, currentLevel: number): number | null {
  return UPGRADES[id].costs[currentLevel] ?? null;
}

/** Coerces untrusted levels into valid integers within each upgrade's range. */
export function sanitizeUpgradeLevels(raw: unknown): UpgradeLevels {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = { ...NO_UPGRADES };
  for (const id of UPGRADE_IDS) {
    const v = r[id];
    out[id] = typeof v === 'number' && Number.isFinite(v) ? Math.min(maxLevel(id), Math.max(0, Math.floor(v))) : 0;
  }
  return out;
}

export type PurchaseError = 'unknown_upgrade' | 'max_level' | 'insufficient_coins' | 'stale_level';

/**
 * Buys one level. Pure and atomic: returns a new progress object with coins
 * deducted and the level raised together, or an error with nothing changed.
 * `expectedLevel` guards against double-submits (buying the same level twice).
 */
export function purchaseUpgrade(
  progress: PlayerProgress,
  id: string,
  expectedLevel: number,
): { ok: true; progress: PlayerProgress; cost: number; level: number } | { ok: false; error: PurchaseError } {
  if (!(UPGRADE_IDS as readonly string[]).includes(id)) return { ok: false, error: 'unknown_upgrade' };
  const upgradeId = id as UpgradeId;
  const current = progress.upgrades[upgradeId];
  if (current !== expectedLevel) return { ok: false, error: 'stale_level' };
  const cost = nextLevelCost(upgradeId, current);
  if (cost === null) return { ok: false, error: 'max_level' };
  if (progress.coins < cost) return { ok: false, error: 'insufficient_coins' };
  const next: PlayerProgress = {
    ...progress,
    coins: progress.coins - cost,
    upgrades: { ...progress.upgrades, [upgradeId]: current + 1 },
  };
  return { ok: true, progress: next, cost, level: current + 1 };
}
