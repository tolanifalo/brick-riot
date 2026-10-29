import { describe, expect, it } from 'vitest';
import { BALANCE, SIM, TRIG } from '../src/config/balance';
import { Simulation } from '../src/sim/simulation';
import { placeBall, stepN, testBoard } from './helpers';

const farBoard = () => testBoard(['S.........'], { grid: { cols: 10, brickHeight: 20, gap: 0, top: 20, sideMargin: 0 } });

describe('wall collisions', () => {
  it('reflects off the left wall', () => {
    const sim = new Simulation(farBoard());
    const ball = placeBall(sim, 10, 400, -300, -300);
    stepN(sim, 5);
    expect(ball.vx).toBeGreaterThan(0);
    expect(ball.x).toBeGreaterThanOrEqual(ball.radius);
  });

  it('reflects off the right wall', () => {
    const sim = new Simulation(farBoard());
    const ball = placeBall(sim, SIM.worldWidth - 10, 400, 300, -300);
    stepN(sim, 5);
    expect(ball.vx).toBeLessThan(0);
    expect(ball.x).toBeLessThanOrEqual(SIM.worldWidth - ball.radius);
  });

  it('reflects off the top wall', () => {
    const sim = new Simulation(farBoard());
    const ball = placeBall(sim, 300, 10, 100, -400);
    stepN(sim, 5);
    expect(ball.vy).toBeGreaterThan(0);
  });

  it('never lets the ball travel near-horizontally after a bounce', () => {
    const sim = new Simulation(farBoard());
    const ball = placeBall(sim, 20, 400, -430, -1);
    stepN(sim, 4);
    expect(Math.abs(ball.vy)).toBeGreaterThanOrEqual(ball.speed * TRIG.sin15 - 1e-9);
    expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(ball.speed, 6);
  });
});

describe('paddle collisions', () => {
  const dropOnto = (offsetX: number) => {
    const sim = new Simulation(farBoard());
    const p = sim.state.paddle;
    const ball = placeBall(sim, p.x + offsetX, p.y - 40, 0, 430);
    const events = stepN(sim, 20);
    return { ball, events };
  };

  it('sends a centre hit straight up', () => {
    const { ball, events } = dropOnto(0);
    expect(events.some((e) => e.type === 'paddle')).toBe(true);
    expect(ball.vy).toBeLessThan(0);
    expect(Math.abs(ball.vx)).toBeLessThan(1e-9);
  });

  it('angles rebounds by contact offset', () => {
    const right = dropOnto(30).ball;
    const left = dropOnto(-30).ball;
    expect(right.vx).toBeGreaterThan(0);
    expect(left.vx).toBeLessThan(0);
    expect(right.vx).toBeCloseTo(-left.vx, 9);
  });

  it('caps the rebound at 60 degrees from vertical at the edge', () => {
    const { ball } = dropOnto(BALANCE.paddle.width / 2 + 2);
    const tan = Math.abs(ball.vx / ball.vy);
    expect(tan).toBeLessThanOrEqual(TRIG.tan60 + 1e-9);
    expect(tan).toBeGreaterThan(1.5);
  });

  it('ignores balls moving upward through the paddle area', () => {
    const sim = new Simulation(farBoard());
    const p = sim.state.paddle;
    placeBall(sim, p.x, p.y + 4, 0, -430);
    const events = stepN(sim, 2);
    expect(events.some((e) => e.type === 'paddle')).toBe(false);
  });

  it('keeps ball speed after a rebound', () => {
    const { ball } = dropOnto(25);
    expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(430, 6);
  });
});

describe('paddle movement', () => {
  it('clamps to the playfield', () => {
    const sim = new Simulation(farBoard());
    stepN(sim, 200, { targetX: -1000, axis: 0, launch: false });
    expect(sim.state.paddle.x).toBe(BALANCE.paddle.width / 2);
    stepN(sim, 200, { targetX: 5000, axis: 0, launch: false });
    expect(sim.state.paddle.x).toBe(SIM.worldWidth - BALANCE.paddle.width / 2);
  });

  it('limits pointer-driven speed per tick', () => {
    const sim = new Simulation(farBoard());
    const start = sim.state.paddle.x;
    sim.step({ targetX: start + 200, axis: 0, launch: false });
    expect(sim.state.paddle.x - start).toBeCloseTo(BALANCE.paddle.pointerMaxSpeed * SIM.dt, 9);
  });

  it('moves at keyboard speed with the axis', () => {
    const sim = new Simulation(farBoard());
    const start = sim.state.paddle.x;
    stepN(sim, 12, { targetX: null, axis: -1, launch: false });
    expect(start - sim.state.paddle.x).toBeCloseTo(BALANCE.paddle.keyboardSpeed * SIM.dt * 12, 6);
  });

  it('rejects non-finite input', () => {
    const sim = new Simulation(farBoard());
    const start = sim.state.paddle.x;
    sim.step({ targetX: Number.NaN, axis: Number.POSITIVE_INFINITY, launch: false });
    expect(sim.state.paddle.x).toBe(start);
  });
});

describe('tunnelling', () => {
  it('always hits a thin brick row at max speed', () => {
    for (let x = 12; x < SIM.worldWidth - 12; x += 7) {
      const sim = new Simulation(
        testBoard(['SSSSSSSSSS'], { grid: { cols: 10, brickHeight: 6, gap: 0, top: 200, sideMargin: 0 } }),
      );
      const s = BALANCE.ball.maxSpeed;
      placeBall(sim, x, 400, s * 0.3, -s * 0.95);
      const events = stepN(sim, 120);
      expect(events.some((e) => e.type === 'brickHit')).toBe(true);
    }
  });
});
