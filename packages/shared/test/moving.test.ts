import { describe, expect, it } from 'vitest';
import { SIM } from '../src/config/balance';
import { gridPitch, type BrickLegendEntry } from '../src/levels/schema';
import { Simulation } from '../src/sim/simulation';
import { idle, placeBall, stepN, testBoard } from './helpers';

const legend: Record<string, BrickLegendEntry> = {
  S: { type: 'standard', color: 'cyan' },
  M: { type: 'moving', color: 'lime', move: { cells: 4, speed: 90 } },
  K: { type: 'indestructible', color: 'steel', move: { cells: 3, speed: 60 } },
  X: { type: 'explosive', color: 'magenta' },
};
const board = (layout: string[]) => testBoard(layout, { legend });

describe('moving bricks', () => {
  it('oscillate between their start cell and the end of their path, as a pure function of tick', () => {
    const sim = new Simulation(board(['M.........', '.........S']));
    const brick = sim.state.bricks[0];
    if (!brick) throw new Error('brick');
    const range = 4 * gridPitch(sim.board, SIM.worldWidth).x;
    let min = Infinity;
    let max = -Infinity;
    const xs: number[] = [];
    for (let t = 0; t < 30 * SIM.tickRate; t++) {
      sim.step(idle());
      xs.push(brick.x);
      min = Math.min(min, brick.x);
      max = Math.max(max, brick.x);
    }
    expect(min).toBeGreaterThanOrEqual(brick.baseX - 1e-9);
    expect(max).toBeLessThanOrEqual(brick.baseX + range + 1e-9);
    expect(max - min).toBeGreaterThan(range * 0.95);
    // Same tick, same position: run a second simulation and compare.
    const again = new Simulation(board(['M.........', '.........S']));
    for (let t = 0; t < 30 * SIM.tickRate; t++) {
      again.step(idle());
      expect(again.state.bricks[0]?.x).toBe(xs[t]);
    }
  });

  it('report velocity matching their direction of travel', () => {
    const sim = new Simulation(board(['M.........', '.........S']));
    const brick = sim.state.bricks[0];
    if (!brick) throw new Error('brick');
    sim.step(idle());
    expect(brick.vx).toBe(90);
    const range = 4 * gridPitch(sim.board, SIM.worldWidth).x;
    stepN(sim, Math.ceil((range / 90) * SIM.tickRate) + 5);
    expect(brick.vx).toBe(-90);
  });

  it('can be hit and destroyed; required count includes them', () => {
    const sim = new Simulation(board(['M.........', '.........S']));
    expect(sim.state.requiredTotal).toBe(2);
    const brick = sim.state.bricks[0];
    if (!brick) throw new Error('brick');
    sim.step(idle());
    placeBall(sim, brick.x + brick.width / 2 + 3, brick.y + 60, 0, -430);
    const events = stepN(sim, 30);
    expect(events.some((e) => e.type === 'brickHit' && e.brickId === brick.id && e.destroyed)).toBe(true);
    expect(sim.state.requiredRemaining).toBe(1);
  });

  it('never leave a ball inside them, from any approach', () => {
    // Sweep many starting positions and angles; check every tick.
    for (let i = 0; i < 60; i++) {
      const sim = new Simulation(board(['..........', 'M....K....', '..........', 'S.........']));
      const angle = ((i * 37) % 160) - 80;
      const vx = 430 * (angle / 90);
      const vy = -Math.sqrt(Math.max(1, 430 * 430 - vx * vx));
      placeBall(sim, 30 + ((i * 53) % 420), 260, vx, vy);
      for (let t = 0; t < 4 * SIM.tickRate; t++) {
        sim.step({ targetX: sim.state.balls[0]?.x ?? 240, axis: 0, launch: false });
        for (const ball of sim.state.balls) {
          for (const b of sim.state.bricks) {
            if (!b.alive || b.moveRange === 0) continue;
            const inside = ball.x > b.x && ball.x < b.x + b.width && ball.y > b.y && ball.y < b.y + b.height;
            expect(inside).toBe(false);
          }
        }
      }
    }
  });

  it('a brick sliding into a slower ball pushes it away instead of swallowing it', () => {
    const sim = new Simulation(board(['M.........', '.........S']));
    const brick = sim.state.bricks[0];
    if (!brick) throw new Error('brick');
    sim.step(idle());
    // Ball just right of the brick, drifting right slower than the brick moves.
    const ball = placeBall(sim, brick.x + brick.width + 7.5, brick.y + brick.height / 2, 20, -1);
    ball.speed = Math.hypot(20, 1);
    stepN(sim, 30);
    expect(ball.x).toBeGreaterThan(brick.x + brick.width);
    expect(ball.vx).toBeGreaterThan(brick.vx);
  });

  it('moving steel obstacles deflect, never break and are not required', () => {
    const sim = new Simulation(board(['K.........', '.........S']));
    expect(sim.state.requiredTotal).toBe(1);
    const steel = sim.state.bricks[0];
    if (!steel) throw new Error('steel');
    sim.step(idle());
    placeBall(sim, steel.x + steel.width / 2 + 2, steel.y + 60, 0, -430);
    const events = stepN(sim, 30);
    expect(events.some((e) => e.type === 'brickDeflect')).toBe(true);
    expect(steel.alive).toBe(true);
  });

  it('explosions catch moving bricks by their current position', () => {
    const sim = new Simulation(board(['M.........', '.X........']));
    const mover = sim.state.bricks[0];
    const bomb = sim.state.bricks[1];
    if (!mover || !bomb) throw new Error('bricks');
    // Wait until the mover has slid far from the explosive, then detonate it.
    stepN(sim, Math.round((4 * gridPitch(sim.board, SIM.worldWidth).x / 90) * SIM.tickRate));
    placeBall(sim, bomb.x + bomb.width / 2, bomb.y + 50, 0, -430);
    stepN(sim, 20);
    expect(bomb.alive).toBe(false);
    expect(mover.alive).toBe(true);
  });
});
