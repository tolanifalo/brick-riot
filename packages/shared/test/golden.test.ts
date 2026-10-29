import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { CLASSIC_01 } from '../src/levels/classic';
import { Simulation } from '../src/sim/simulation';
import type { SimState } from '../src/sim/types';

/**
 * Golden replay fingerprints recorded with the Phase 1 engine. Opening Riot uses no
 * Phase 2 features, so these must never change: a change means old replays would
 * no longer verify. Do not update these snapshots to make a test pass; fix the engine.
 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function fingerprint(s: SimState) {
  const balls = s.balls.map((b) => [b.x, b.y, b.vx, b.vy, b.speed].join(',')).join('|');
  const bricks = s.bricks.map((b) => `${b.hp}${b.alive ? 'a' : 'd'}`).join('');
  return {
    status: s.status,
    tick: s.tick,
    elapsedTicks: s.elapsedTicks,
    score: s.score,
    lives: s.lives,
    bestCombo: s.bestCombo,
    rngState: s.rngState,
    requiredRemaining: s.requiredRemaining,
    paddleX: s.paddle.x,
    hash: fnv1a(`${balls}#${bricks}`),
  };
}

/** Frozen copy of the Phase 1 test bot. Do not edit. */
function runFrozenBot(seed: number, maxTicks: number): SimState {
  const sim = new Simulation(CLASSIC_01, { seed });
  for (let t = 0; t < maxTicks && !sim.isOver; t++) {
    const ball = sim.state.balls[0];
    const aim = ((t % 997) / 997 - 0.5) * 60;
    sim.step({ targetX: ball ? ball.x + aim : null, axis: 0, launch: sim.state.status === 'ready' });
  }
  return sim.state;
}

describe('golden replays (Phase 1 compatibility)', () => {
  it('seed 42, 30 seconds', () => {
    expect(fingerprint(runFrozenBot(42, 30 * SIM.tickRate))).toMatchInlineSnapshot(`
      {
        "bestCombo": 2,
        "elapsedTicks": 3599,
        "hash": "fe68c98c",
        "lives": 3,
        "paddleX": 343.63346892060423,
        "requiredRemaining": 57,
        "rngState": 1831565855,
        "score": 776,
        "status": "playing",
        "tick": 3600,
      }
    `);
  });

  it('seed 7, full clear', () => {
    expect(fingerprint(runFrozenBot(7, 10 * 60 * SIM.tickRate))).toMatchInlineSnapshot(`
      {
        "bestCombo": 5,
        "elapsedTicks": 16224,
        "hash": "8d01c0f8",
        "lives": 3,
        "paddleX": 44,
        "requiredRemaining": 0,
        "rngState": 1831565820,
        "score": 8433,
        "status": "won",
        "tick": 16225,
      }
    `);
  });

  it('seed 3, keyboard-only play until game over', () => {
    const sim = new Simulation(CLASSIC_01, { seed: 3 });
    for (let t = 0; t < 5 * 60 * SIM.tickRate && !sim.isOver; t++) {
      const axis = Math.floor(t / 90) % 3 - 1;
      sim.step({ targetX: null, axis, launch: t % 200 === 0 });
    }
    expect(fingerprint(sim.state)).toMatchInlineSnapshot(`
      {
        "bestCombo": 1,
        "elapsedTicks": 1761,
        "hash": "a0c159c",
        "lives": 0,
        "paddleX": 44,
        "requiredRemaining": 67,
        "rngState": 1199730146,
        "score": 250,
        "status": "lost",
        "tick": 1762,
      }
    `);
  });
});
