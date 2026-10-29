import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { isPowerDown } from '../src/config/powerups';
import { CLASSIC_01 } from '../src/levels/classic';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

/**
 * Level 1 is a first impression: quick, with power-ups you can see, and no
 * power-downs. (The old level 1 took the bot ~256 s; see levels/legacy.ts.)
 */
describe('level 1 (Kickoff)', () => {
  it('shows at least three fixed power-up bricks and can never drop a power-down', () => {
    const fixed = CLASSIC_01.layout.join('').split('').filter((ch) => {
      const entry = CLASSIC_01.legend[ch];
      return entry?.type === 'powerup' && entry.powerUp !== undefined && entry.powerUp !== 'random';
    });
    expect(fixed.length).toBeGreaterThanOrEqual(3);
    expect(CLASSIC_01.powerDownChance ?? 0).toBe(0);
    expect((CLASSIC_01.powerUpPool ?? []).some(isPowerDown)).toBe(false);
    expect(CLASSIC_01.dropChance ?? 0).toBeGreaterThanOrEqual(0.1);
  });

  it('is short: the bot clears it in well under 90 s on every seed, collecting power-ups', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = new Simulation(CLASSIC_01, { seed });
      const bot = createAutoplayer('win');
      while (!sim.isOver && sim.state.tick < 5 * 60 * SIM.tickRate) sim.step(bot(sim));
      expect(sim.state.status).toBe('won');
      expect(sim.state.elapsedTicks / SIM.tickRate).toBeLessThan(90);
      expect(sim.state.powerUpsCollected).toBeGreaterThanOrEqual(2);
    }
  });
});
