import { describe, expect, it } from 'vitest';
import { BALANCE, SIM } from '../src/config/balance';
import { Simulation } from '../src/sim/simulation';
import { idle, placeBall, stepN, testBoard } from './helpers';

const board = () => testBoard(['SSSSSSSSSS', 'S.........']);
const launch = { targetX: null, axis: 0, launch: true };

describe('serve and launch', () => {
  it('keeps the ball on the paddle until launch', () => {
    const sim = new Simulation(board());
    stepN(sim, 30, { targetX: 100, axis: 0, launch: false });
    const ball = sim.state.balls[0];
    expect(sim.state.status).toBe('ready');
    expect(ball?.attached).toBe(true);
    expect(ball?.x).toBe(sim.state.paddle.x);
    expect(sim.state.elapsedTicks).toBe(0);
  });

  it('launches upward and starts the clock', () => {
    const sim = new Simulation(board());
    const events = sim.step(launch);
    expect(events[0]?.type).toBe('launch');
    expect(sim.state.status).toBe('playing');
    expect(sim.state.balls[0]?.vy).toBeLessThan(0);
    stepN(sim, 10);
    expect(sim.state.elapsedTicks).toBe(10);
  });
});

describe('ball loss and game over', () => {
  it('costs a life and re-serves', () => {
    const sim = new Simulation(board());
    placeBall(sim, 20, SIM.worldHeight - 5, 0, 430);
    const events = stepN(sim, 10);
    expect(events.find((e) => e.type === 'ballLost')).toMatchObject({ livesRemaining: BALANCE.lives - 1 });
    expect(sim.state.lives).toBe(BALANCE.lives - 1);
    expect(sim.state.status).toBe('ready');
    expect(sim.state.balls).toHaveLength(1);
    expect(sim.state.balls[0]?.attached).toBe(true);
    expect(sim.state.balls[0]?.speed).toBe(BALANCE.ball.baseSpeed);
  });

  it('ends the game when the last ball is lost', () => {
    const sim = new Simulation(board());
    for (let i = 0; i < BALANCE.lives; i++) {
      placeBall(sim, 20, SIM.worldHeight - 5, 0, 430);
      stepN(sim, 10);
    }
    expect(sim.state.status).toBe('lost');
    expect(sim.state.lives).toBe(0);
    expect(sim.isOver).toBe(true);
    const tick = sim.state.tick;
    expect(sim.step(launch)).toHaveLength(0);
    expect(sim.state.tick).toBe(tick);
  });

  it('resets the combo when a ball is lost', () => {
    const sim = new Simulation(board());
    sim.state.combo = 4;
    placeBall(sim, 20, SIM.worldHeight - 5, 0, 430);
    stepN(sim, 10);
    expect(sim.state.combo).toBe(0);
  });
});

describe('level completion', () => {
  it('wins when every required brick is destroyed, ignoring indestructibles', () => {
    const sim = new Simulation(testBoard(['#S########']));
    const target = sim.state.bricks[1];
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, 200, 0, -430);
    const events = stepN(sim, 60);
    const won = events.find((e) => e.type === 'won');
    expect(sim.state.status).toBe('won');
    expect(won).toBeDefined();
    expect(sim.state.clearBonus).toBeGreaterThan(0);
    expect(sim.state.score).toBe(BALANCE.scoring.destroyPoints.standard + sim.state.clearBonus);
    expect(sim.state.bricks.filter((b) => b.alive)).toHaveLength(9);
  });
});

describe('pause', () => {
  it('freezes the simulation and the clock', () => {
    const sim = new Simulation(board());
    sim.step(launch);
    sim.setPaused(true);
    const snapshot = JSON.stringify(sim.state);
    stepN(sim, 50);
    expect(JSON.stringify(sim.state)).toBe(snapshot);
    sim.setPaused(false);
    stepN(sim, 5);
    expect(sim.state.elapsedTicks).toBe(5);
  });

  it('cannot pause a finished game', () => {
    const sim = new Simulation(board());
    sim.state.status = 'lost';
    sim.setPaused(true);
    expect(sim.state.paused).toBe(false);
  });
});

describe('stuck-ball safeguard', () => {
  it('nudges a ball trapped in a loop that makes no progress', () => {
    const sim = new Simulation(
      testBoard(['##########', '..........', '.........S'], {
        grid: { cols: 10, brickHeight: 20, gap: 0, top: 60, sideMargin: 0 },
      }),
    );
    // Vertical loop between the top wall and the indestructible ceiling.
    const ball = placeBall(sim, 240, 30, 0, -430);
    const early = stepN(sim, (BALANCE.safeguards.stuckSeconds - 1) * SIM.tickRate);
    expect(early.some((e) => e.type === 'nudge')).toBe(false);
    expect(ball.vx).toBe(0);
    const later = stepN(sim, 2 * SIM.tickRate);
    expect(later.some((e) => e.type === 'nudge')).toBe(true);
    expect(ball.vx).not.toBe(0);
  });
});

describe('idle input', () => {
  it('is a no-op for paddle position', () => {
    const sim = new Simulation(board());
    const x = sim.state.paddle.x;
    stepN(sim, 10, idle());
    expect(sim.state.paddle.x).toBe(x);
  });
});
