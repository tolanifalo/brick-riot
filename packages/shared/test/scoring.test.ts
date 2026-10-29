import { describe, expect, it } from 'vitest';
import { BALANCE, SIM } from '../src/config/balance';
import { clearBonus, comboMultiplier, destroyScore, ticksToMs } from '../src/sim/scoring';

const scoring = BALANCE.scoring;

describe('scoring', () => {
  it('has no multiplier for the first brick', () => {
    expect(comboMultiplier(0, scoring)).toBe(1);
    expect(comboMultiplier(1, scoring)).toBe(1);
  });

  it('grows the multiplier per combo step up to the cap', () => {
    expect(comboMultiplier(2, scoring)).toBe(1.25);
    expect(comboMultiplier(5, scoring)).toBe(2);
    expect(comboMultiplier(100, scoring)).toBe(scoring.comboMaxMultiplier);
  });

  it('rounds destroy scores', () => {
    expect(destroyScore(50, 2, scoring)).toBe(63);
    expect(destroyScore(50, 1, scoring)).toBe(50);
  });

  it('awards life and under-par time bonuses', () => {
    const ticks = 30 * SIM.tickRate;
    expect(clearBonus(2, ticks, 60, scoring)).toBe(2 * scoring.lifeBonus + 30 * scoring.timeBonusPerSecond);
    expect(clearBonus(1, 90 * SIM.tickRate, 60, scoring)).toBe(scoring.lifeBonus);
  });

  it('converts ticks to milliseconds', () => {
    expect(ticksToMs(SIM.tickRate)).toBe(1000);
    expect(ticksToMs(60)).toBe(500);
  });
});
