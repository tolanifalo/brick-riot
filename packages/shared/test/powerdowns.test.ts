import { describe, expect, it } from 'vitest';
import { BALANCE, SIM } from '../src/config/balance';
import { isPowerDown, LEGACY_DROP_POOL, type PositivePowerUp, type PowerUpKind } from '../src/config/powerups';
import { validateBoard } from '../src/levels/schema';
import { replayRun } from '../src/sim/replay';
import { Simulation } from '../src/sim/simulation';
import type { TickInput } from '../src/sim/types';
import { createAutoplayer } from '../src/tools/autoplayer';
import { placeBall, stepN, testBoard } from './helpers';

/**
 * Safety Net, Nuke, and the power-downs (Mini Paddle, Reversed, Fast Ball).
 * Boards opt in through `powerUpPool` / `powerDownChance`; existing boards are
 * covered by golden.test.ts, campaign.test.ts and multiplayer.test.ts, which
 * must keep passing unchanged.
 */
const defs = BALANCE.powerUps.definitions;
const ticks = (seconds: number) => Math.round(seconds * SIM.tickRate);
const keys = (axis: number): TickInput => ({ targetX: null, axis, launch: false });

function give(sim: Simulation, kind: PowerUpKind) {
  const p = sim.state.paddle;
  sim.state.pickups.push({ id: 900 + sim.state.pickups.length, kind, x: p.x, y: p.y });
  const events = sim.step({ targetX: null, axis: 0, launch: false });
  if (!events.some((e) => e.type === 'powerUp' && e.kind === kind)) throw new Error(`${kind} was not collected`);
  return events;
}

const openBoard = () => testBoard(['S.........'], { grid: { cols: 10, brickHeight: 20, gap: 0, top: 20, sideMargin: 0 } });

function firstBall(sim: Simulation) {
  const ball = sim.state.balls[0];
  if (!ball) throw new Error('no ball');
  return ball;
}

/** A ball heading up from mid-field: nothing is about to land on the paddle. */
const flyingUp = (sim: Simulation) => placeBall(sim, 240, 300, 0, -430);

describe('Safety Net', () => {
  it('bounces the first falling ball back up, then breaks; the next miss costs a life', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'net');
    expect(sim.state.effects.net).toBeGreaterThan(0);

    // The paddle is far away: without the net this ball is lost.
    const ball = placeBall(sim, 30, 700, 0, 430);
    const events = stepN(sim, 40, { targetX: 420, axis: 0, launch: false });
    const save = events.find((e) => e.type === 'netSave');
    expect(save).toMatchObject({ ballId: ball.id, y: BALANCE.powerUps.netY });
    expect(events.some((e) => e.type === 'ballLost')).toBe(false);
    expect(ball.vy).toBeLessThan(0);
    expect(sim.state.effects.net).toBe(0);
    expect(sim.state.lives).toBe(BALANCE.lives);

    placeBall(sim, 30, 760, 0, 430);
    const again = stepN(sim, 30, { targetX: 420, axis: 0, launch: false });
    expect(again.some((e) => e.type === 'netSave')).toBe(false);
    expect(sim.state.lives).toBe(BALANCE.lives - 1);
  });

  it('expires unused', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'net');
    sim.state.effects.net = 3;
    const events = stepN(sim, 4, { targetX: 240, axis: 0, launch: false });
    expect(events.some((e) => e.type === 'effectEnded' && e.kind === 'net')).toBe(true);
  });
});

describe('Nuke', () => {
  const board = () => testBoard(['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSS#SSSS', 'SSSSSSSSSS']);

  it('the next brick contact sets off a 5x5 blast; steel survives', () => {
    const sim = new Simulation(board());
    flyingUp(sim);
    firstBall(sim).y = 600;
    give(sim, 'nuke');
    const target = sim.state.bricks.find((b) => b.row === 5 && b.col === 5);
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, target.y + 50, 0, -430);
    const events = stepN(sim, 30);
    expect(events.filter((e) => e.type === 'explosion' && e.source === 'nuke')).toHaveLength(1);
    // Rows 3-5 (the grid ends at row 5) x columns 3-7 = 15 cells, minus the steel brick.
    expect(sim.state.bricks.filter((b) => !b.alive)).toHaveLength(14);
    expect(sim.state.bricks.find((b) => b.type === 'indestructible')?.alive).toBe(true);
    expect(sim.state.effects.nuke).toBe(0);
  });

  it('goes off before an armed Bomb, which then waits for the next contact', () => {
    const sim = new Simulation(board());
    flyingUp(sim);
    firstBall(sim).y = 600;
    give(sim, 'bomb');
    give(sim, 'nuke');
    const target = sim.state.bricks.find((b) => b.row === 5 && b.col === 1);
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, target.y + 50, 0, -430);
    const events = stepN(sim, 20);
    expect(events.filter((e) => e.type === 'explosion').map((e) => e.type === 'explosion' && e.source)).toEqual(['nuke']);
    expect(sim.state.effects.nuke).toBe(0);
    expect(sim.state.effects.bomb).toBeGreaterThan(0);
  });
});

describe('Mini Paddle', () => {
  it('shrinks the paddle once nothing is about to land, then expires', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'mini');
    const events = stepN(sim, 1, { targetX: 240, axis: 0, launch: false });
    expect(events.some((e) => e.type === 'effectStarted' && e.kind === 'mini')).toBe(true);
    const expected = Math.max(BALANCE.sabotage.minPaddleWidth, BALANCE.paddle.width * defs.mini.strength);
    expect(expected).toBeLessThan(BALANCE.paddle.width * 0.75);
    expect(sim.state.paddle.width).toBeCloseTo(expected, 9);
    sim.state.effects.mini = 2;
    const end = stepN(sim, 3, { targetX: 240, axis: 0, launch: false });
    expect(end.some((e) => e.type === 'effectEnded' && e.kind === 'mini')).toBe(true);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);
    expect(sim.state.miniActive).toBe(false);
  });

  it('waits while a ball is descending onto the paddle, so it can never cause an unavoidable miss', () => {
    const sim = new Simulation(openBoard());
    const p = sim.state.paddle;
    placeBall(sim, p.x, p.y - 40, 0, 430);
    give(sim, 'mini');
    expect(sim.state.miniActive).toBe(false);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);
    const full = sim.state.effects.mini;
    stepN(sim, 30, { targetX: p.x, axis: 0, launch: false });
    expect(sim.state.lives).toBe(BALANCE.lives);
    expect(sim.state.miniActive).toBe(true);
    // The timer only ran once it took hold.
    expect(sim.state.effects.mini).toBeGreaterThan(full - 30);
  });

  it('cancels Wide Paddle (and is cancelled by it): the paddle returns to normal', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'wide');
    give(sim, 'mini');
    stepN(sim, 1, { targetX: 240, axis: 0, launch: false });
    expect(sim.state.effects.wide).toBe(0);
    expect(sim.state.effects.mini).toBe(0);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);

    give(sim, 'mini');
    give(sim, 'wide');
    stepN(sim, 1, { targetX: 240, axis: 0, launch: false });
    expect(sim.state.effects.mini).toBe(0);
    expect(sim.state.effects.wide).toBe(0);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);
  });
});

describe('Reversed', () => {
  it('warns first, then swaps keyboard and pointer directions, then ends', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'invert');
    expect(sim.inverted).toBe(false);
    expect(sim.state.invertDelay).toBe(ticks(defs.invert.strength) - 1);

    // During the warning the controls are still normal.
    let x = sim.state.paddle.x;
    stepN(sim, 10, keys(1));
    expect(sim.state.paddle.x).toBeGreaterThan(x);

    const started = stepN(sim, ticks(defs.invert.strength), keys(0));
    expect(started.some((e) => e.type === 'effectStarted' && e.kind === 'invert')).toBe(true);
    expect(sim.inverted).toBe(true);

    x = sim.state.paddle.x;
    stepN(sim, 10, keys(1));
    expect(sim.state.paddle.x).toBeLessThan(x);
    stepN(sim, 60, { targetX: 100, axis: 0, launch: false });
    expect(sim.state.paddle.x).toBeCloseTo(SIM.worldWidth - 100, 6);

    sim.state.effects.invert = 2;
    const end = stepN(sim, 3, keys(0));
    expect(end.some((e) => e.type === 'effectEnded' && e.kind === 'invert')).toBe(true);
    expect(sim.inverted).toBe(false);
  });
});

describe('Fast Ball', () => {
  it('speeds every ball up once (refreshing does not stack), keeps the boost on brick hits, and restores speed', () => {
    const board = testBoard(['SSSSSSSSSS']);
    const sim = new Simulation(board);
    const ball = placeBall(sim, 240, 600, 0, -430);
    give(sim, 'fast');
    expect(ball.speed).toBeCloseTo(430 * defs.fast.strength, 9);
    expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(ball.speed, 9);
    give(sim, 'fast');
    expect(ball.speed).toBeCloseTo(430 * defs.fast.strength, 9);

    const hit = stepN(sim, 120, { targetX: 240, axis: 0, launch: false });
    expect(hit.some((e) => e.type === 'brickHit')).toBe(true);
    const nominal = Math.min(BALANCE.ball.maxSpeed, BALANCE.ball.baseSpeed + sim.state.speedHits * BALANCE.ball.speedPerHit);
    expect(ball.speed).toBeCloseTo(nominal * defs.fast.strength, 9);

    sim.state.effects.fast = 1;
    stepN(sim, 2, { targetX: ball.x, axis: 0, launch: false });
    expect(ball.speed).toBeCloseTo(nominal, 9);
  });
});

describe('catching power-downs', () => {
  it('pays the brave-catch bonus and counts separately', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    const before = sim.state.score;
    give(sim, 'fast');
    expect(sim.state.score).toBe(before + BALANCE.powerUps.powerDownBonus);
    expect(sim.state.powerDownsCollected).toBe(1);
    expect(sim.state.powerUpsCollected).toBe(0);
  });

  it('losing a ball clears power-downs too', () => {
    const sim = new Simulation(openBoard());
    flyingUp(sim);
    give(sim, 'mini');
    give(sim, 'invert');
    give(sim, 'fast');
    const ball = firstBall(sim);
    ball.x = 30;
    ball.y = SIM.worldHeight - 2;
    ball.vy = 430;
    stepN(sim, 3, { targetX: 400, axis: 0, launch: false });
    expect(sim.state.status).toBe('ready');
    expect(Object.values(sim.state.effects).every((t) => t === 0)).toBe(true);
    expect(sim.state.miniActive).toBe(false);
    expect(sim.state.invertDelay).toBe(0);
    expect(sim.inverted).toBe(false);
    expect(sim.state.balls[0]?.speed).toBe(BALANCE.ball.baseSpeed);
  });
});

describe('drops', () => {
  /** Breaks every brick in order and returns the capsules that fell. */
  function dropsFor(layout: string[], overrides: Parameters<typeof testBoard>[1], seed = 5): PowerUpKind[] {
    const sim = new Simulation(testBoard(layout, overrides), { seed });
    const kinds: PowerUpKind[] = [];
    for (const b of [...sim.state.bricks]) {
      placeBall(sim, b.x + b.width / 2, b.y + 40, 0, -430);
      for (const e of stepN(sim, 12)) if (e.type === 'pickupSpawned') kinds.push(e.kind);
      sim.state.pickups = [];
    }
    return kinds;
  }

  it('boards that do not opt in drop exactly what they always did', () => {
    const plain = dropsFor(['SSSSSSSSSS', 'SSSSSSSSSS'], { dropChance: 0.5 });
    const explicit = dropsFor(['SSSSSSSSSS', 'SSSSSSSSSS'], { dropChance: 0.5, powerUpPool: [...LEGACY_DROP_POOL], powerDownChance: 0 });
    expect(plain.length).toBeGreaterThan(3);
    expect(explicit).toEqual(plain);
    expect(plain.every((k) => LEGACY_DROP_POOL.includes(k as never))).toBe(true);
  });

  it('powerDownChance turns ordinary drops into power-downs', () => {
    const kinds = dropsFor(['SSSSSSSSSS'], { dropChance: 1, powerDownChance: 1 });
    expect(kinds).toHaveLength(10);
    expect(kinds.every(isPowerDown)).toBe(true);
    expect(new Set(kinds).size).toBeGreaterThan(1);
  });

  it('power-up bricks never drop power-downs, even on boards full of them', () => {
    const kinds = dropsFor(['PPPPPPPPPP', 'PPPPPPPPPP'], {
      powerDownChance: 1,
      legend: { P: { type: 'powerup', color: 'violet' } },
    });
    expect(kinds).toHaveLength(20);
    expect(kinds.some(isPowerDown)).toBe(false);
  });

  it('powerUpPool limits which power-ups fall', () => {
    const kinds = dropsFor(['SSSSSSSSSS', 'SSSSSSSSSS'], { dropChance: 1, powerUpPool: ['net', 'nuke'] });
    expect(kinds).toHaveLength(20);
    expect(kinds.every((k) => k === 'net' || k === 'nuke')).toBe(true);
  });

  it('validation refuses power-downs in pools and on power-up bricks, and bad chances', () => {
    const errors = validateBoard(
      testBoard(['P.........'], {
        // Deliberately invalid data (a power-down in the pool), as a hand-edited board could contain.
        powerUpPool: ['wide', 'mini'] as unknown as PositivePowerUp[],
        powerDownChance: 2,
        legend: { P: { type: 'powerup', color: 'violet', powerUp: 'invert' } },
      }),
    );
    expect(errors.some((e) => e.includes('powerUpPool may not contain the power-down "mini"'))).toBe(true);
    expect(errors.some((e) => e.includes('never drop power-downs'))).toBe(true);
    expect(errors.some((e) => e.includes('powerDownChance'))).toBe(true);
  });
});

describe('deterministic replay with every new kind', () => {
  it('reproduces drops, delayed effects, mirrored controls and the final state exactly', () => {
    const board = testBoard(['SRSRSRSRSR', 'SSSSSSSSSS', 'XSNSPSKS#S', 'SSSSSSSSSS'], {
      dropChance: 0.45,
      powerDownChance: 0.5,
      powerUpPool: ['multiball', 'wide', 'laser', 'net', 'nuke'],
      legend: {
        S: { type: 'standard', color: 'cyan' },
        R: { type: 'reinforced', color: 'red' },
        X: { type: 'explosive', color: 'magenta' },
        P: { type: 'powerup', color: 'violet' },
        N: { type: 'powerup', color: 'violet', powerUp: 'net' },
        K: { type: 'powerup', color: 'violet', powerUp: 'nuke' },
        '#': { type: 'indestructible', color: 'steel' },
      },
    });
    for (const seed of [21, 4242]) {
      const sim = new Simulation(board, { seed });
      const bot = createAutoplayer('win');
      const log: TickInput[] = [];
      const spawned = new Set<PowerUpKind>();
      for (let t = 0; t < 5 * 60 * SIM.tickRate && !sim.isOver; t++) {
        const input = bot(sim);
        log.push(input);
        for (const e of sim.step(input)) if (e.type === 'pickupSpawned') spawned.add(e.kind);
      }
      expect([...spawned].some(isPowerDown)).toBe(true);
      const replayed = replayRun(board, seed, log);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(sim.state));
    }
  });
});
