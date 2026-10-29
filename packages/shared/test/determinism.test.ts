import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { CLASSIC_01 } from '../src/levels/classic';
import { replayRun } from '../src/sim/replay';
import { Simulation } from '../src/sim/simulation';
import type { TickInput } from '../src/sim/types';

/** Scripted bot: tracks the ball with a slowly drifting aim offset. */
function playBot(sim: Simulation, maxTicks: number): TickInput[] {
  const log: TickInput[] = [];
  for (let t = 0; t < maxTicks && !sim.isOver; t++) {
    const ball = sim.state.balls[0];
    const aim = ((t % 997) / 997 - 0.5) * 60;
    const input: TickInput = {
      targetX: ball ? ball.x + aim : null,
      axis: 0,
      launch: sim.state.status === 'ready',
    };
    log.push(input);
    sim.step(input);
  }
  return log;
}

describe('determinism', () => {
  it('produces identical state for identical seed and inputs', () => {
    const a = new Simulation(CLASSIC_01, { seed: 42 });
    const log = playBot(a, 20 * SIM.tickRate);
    const b = replayRun(CLASSIC_01, 42, log);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a.state));
  });

  it('uses the seed for launch variation', () => {
    const a = new Simulation(CLASSIC_01, { seed: 1 });
    const b = new Simulation(CLASSIC_01, { seed: 2 });
    const launch = { targetX: null, axis: 0, launch: true };
    a.step(launch);
    b.step(launch);
    expect(a.state.balls[0]?.vx).not.toBe(b.state.balls[0]?.vx);
  });

  it('lets a competent bot clear the Phase 1 board', () => {
    const sim = new Simulation(CLASSIC_01, { seed: 7 });
    playBot(sim, 10 * 60 * SIM.tickRate);
    expect(sim.state.status).toBe('won');
    expect(sim.state.requiredRemaining).toBe(0);
  });
});
