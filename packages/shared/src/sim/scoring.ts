import type { BalanceConfig } from '../config/balance';
import { SIM } from '../config/balance';

/** Score multiplier for the Nth consecutive brick destroyed without a paddle touch. */
export function comboMultiplier(combo: number, scoring: BalanceConfig['scoring']): number {
  if (combo <= 1) return 1;
  return Math.min(scoring.comboMaxMultiplier, 1 + scoring.comboStep * (combo - 1));
}

export function destroyScore(basePoints: number, combo: number, scoring: BalanceConfig['scoring']): number {
  return Math.round(basePoints * comboMultiplier(combo, scoring));
}

export function clearBonus(
  livesRemaining: number,
  elapsedTicks: number,
  parTimeSeconds: number,
  scoring: BalanceConfig['scoring'],
): number {
  const elapsedSeconds = Math.floor(elapsedTicks / SIM.tickRate);
  const underPar = Math.max(0, parTimeSeconds - elapsedSeconds);
  return livesRemaining * scoring.lifeBonus + underPar * scoring.timeBonusPerSecond;
}

export function ticksToMs(ticks: number): number {
  return Math.round((ticks * 1000) / SIM.tickRate);
}
