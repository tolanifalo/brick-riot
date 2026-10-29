import { describe, expect, it } from 'vitest';
import { BALANCE, SIM } from '../src/config/balance';
import type { PowerUpKind } from '../src/config/powerups';
import { replayRun } from '../src/sim/replay';
import { Simulation } from '../src/sim/simulation';
import type { TickInput } from '../src/sim/types';
import { createAutoplayer } from '../src/tools/autoplayer';
import { placeBall, stepN, testBoard } from './helpers';

const defs = BALANCE.powerUps.definitions;
const ticks = (seconds: number) => Math.round(seconds * SIM.tickRate);
const action: TickInput = { targetX: null, axis: 0, launch: true };

/** Drops a capsule straight onto the paddle and steps once so it is collected. */
function give(sim: Simulation, kind: PowerUpKind) {
  if (sim.state.status !== 'playing') throw new Error('capsules only fall during play: place a ball first');
  const p = sim.state.paddle;
  sim.state.pickups.push({ id: 900 + sim.state.pickups.length, kind, x: p.x, y: p.y });
  const events = sim.step({ targetX: null, axis: 0, launch: false });
  if (!events.some((e) => e.type === 'powerUp' && e.kind === kind)) throw new Error(`${kind} was not collected`);
  return events;
}

/** Steps with the paddle under the first free ball, so the ball is never lost. */
function stepTracking(sim: Simulation, n: number, launch = false) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const ball = sim.state.balls.find((b) => !b.attached) ?? sim.state.balls[0];
    events.push(...sim.step({ targetX: ball ? ball.x : null, axis: 0, launch }));
  }
  return events;
}

const openBoard = () =>
  testBoard(['S.........'], { grid: { cols: 10, brickHeight: 20, gap: 0, top: 20, sideMargin: 0 } });

describe('pickups', () => {
  it('a powerup brick drops its capsule, which falls and is collected by the paddle', () => {
    const board = testBoard(['SSSSSSSSSS', '....P.....'], {
      legend: {
        S: { type: 'standard', color: 'cyan' },
        P: { type: 'powerup', color: 'violet', powerUp: 'wide' },
      },
    });
    const sim = new Simulation(board);
    const brick = sim.state.bricks.find((b) => b.type === 'powerup');
    if (!brick) throw new Error('no powerup brick');
    placeBall(sim, brick.x + brick.width / 2, brick.y + 60, 0, -430);
    const events = stepN(sim, 20);
    expect(events.find((e) => e.type === 'pickupSpawned')).toMatchObject({ kind: 'wide' });
    expect(sim.state.pickups).toHaveLength(1);

    // Park the paddle under the capsule, with the ball bouncing straight above it.
    const pickupX = sim.state.pickups[0]?.x ?? 0;
    placeBall(sim, pickupX, 300, 0, -430);
    const scoreBefore = sim.state.score;
    const later = stepN(sim, 6 * SIM.tickRate, { targetX: pickupX, axis: 0, launch: false });
    expect(sim.state.status).toBe('playing');
    expect(later.find((e) => e.type === 'powerUp')).toMatchObject({ kind: 'wide' });
    expect(sim.state.powerUpsCollected).toBe(1);
    expect(sim.state.score).toBeGreaterThanOrEqual(scoreBefore + BALANCE.powerUps.collectPoints);
  });

  it('removes capsules that fall past the paddle without applying them', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 400, 300, 0, -430);
    sim.state.pickups.push({ id: 1, kind: 'laser', x: 20, y: 700 });
    const events = stepN(sim, 2 * SIM.tickRate, { targetX: 400, axis: 0, launch: false });
    expect(events.some((e) => e.type === 'pickupMissed')).toBe(true);
    expect(sim.state.pickups).toHaveLength(0);
    expect(sim.state.effects.laser).toBe(0);
  });

  it('random drops come from the seeded drop stream and do not disturb launch angles', () => {
    const board = testBoard(['PPPPPPPPPP'], {
      legend: { P: { type: 'powerup', color: 'violet' } },
    });
    const kindsFor = (seed: number) => {
      const sim = new Simulation(board, { seed });
      const launchRng = sim.state.rngState;
      for (const b of sim.state.bricks) {
        placeBall(sim, b.x + b.width / 2, b.y + 40, 0, -430);
        stepN(sim, 12);
      }
      expect(sim.state.rngState).toBe(launchRng);
      return sim.state.pickups.map((p) => p.kind).join(',');
    };
    expect(kindsFor(11)).toBe(kindsFor(11));
    const variety = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => kindsFor(s)));
    expect(variety.size).toBeGreaterThan(1);
  });

  it('caps capsules in flight', () => {
    const board = testBoard(['SSSSSSSSSS'], { dropChance: 1 });
    const sim = new Simulation(board);
    for (const b of sim.state.bricks) {
      placeBall(sim, b.x + b.width / 2, b.y + 40, 0, -430);
      stepN(sim, 12);
    }
    expect(sim.state.pickups.length).toBe(BALANCE.powerUps.maxPickups);
  });
});

describe('timed effects', () => {
  it('wide paddle widens, refreshes on re-collect, and expires', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 300, 0, -430);
    give(sim, 'wide');
    stepTracking(sim, 1);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width * defs.wide.strength);
    stepTracking(sim, ticks(defs.wide.durationSeconds) - 100);
    expect(sim.state.effects.wide).toBeGreaterThan(0);
    give(sim, 'wide');
    // Refreshed to full (minus the collection tick), not stacked.
    expect(sim.state.effects.wide).toBe(ticks(defs.wide.durationSeconds) - 1);
    const events = stepTracking(sim, ticks(defs.wide.durationSeconds) + 2);
    expect(sim.state.status).toBe('playing');
    expect(events.some((e) => e.type === 'effectEnded' && e.kind === 'wide')).toBe(true);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);
  });

  it('heavy ball smashes through breakable bricks but still bounces off steel', () => {
    const board = testBoard(['##########', 'RRRRRRRRRR', 'RRRRRRRRRR']);
    const sim = new Simulation(board);
    const ball = placeBall(sim, 72, 400, 0, 0.001);
    give(sim, 'heavy');
    placeBall(sim, 72, 200, 0, -430);
    const events = stepN(sim, 40);
    const destroyed = events.filter((e) => e.type === 'brickHit' && e.destroyed);
    expect(destroyed).toHaveLength(2);
    expect(events.some((e) => e.type === 'brickDeflect')).toBe(true);
    expect(ball.vy).toBeGreaterThan(0);
  });

  it('magnet catches the ball; action releases it at an offset-dependent angle', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 300, 0, -1);
    give(sim, 'magnet');
    const p = sim.state.paddle;
    const ball = placeBall(sim, p.x + 20, p.y - 40, 0, 430);
    const events = stepN(sim, 30);
    expect(events.some((e) => e.type === 'magnetCatch')).toBe(true);
    expect(ball.attached).toBe(true);
    expect(sim.state.status).toBe('playing');

    stepN(sim, 10, { targetX: 100, axis: 0, launch: false });
    expect(ball.x).toBeCloseTo(sim.state.paddle.x + ball.attachOffset, 9);

    const release = sim.step(action);
    expect(release.some((e) => e.type === 'magnetRelease')).toBe(true);
    expect(ball.attached).toBe(false);
    expect(ball.vy).toBeLessThan(0);
    expect(ball.vx).toBeGreaterThan(0);
  });

  it('magnet auto-releases after its hold time and when it expires', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 300, 0, -1);
    give(sim, 'magnet');
    const p = sim.state.paddle;
    const ball = placeBall(sim, p.x, p.y - 40, 0, 430);
    stepN(sim, 20);
    expect(ball.attached).toBe(true);
    stepN(sim, ticks(defs.magnet.strength) + 1);
    expect(ball.attached).toBe(false);

    const sim2 = new Simulation(openBoard());
    placeBall(sim2, 240, 300, 0, -1);
    give(sim2, 'magnet');
    sim2.state.effects.magnet = 25;
    const p2 = sim2.state.paddle;
    const ball2 = placeBall(sim2, p2.x, p2.y - 40, 0, 430);
    stepN(sim2, 20);
    expect(ball2.attached).toBe(true);
    stepN(sim2, 10);
    expect(sim2.state.effects.magnet).toBe(0);
    expect(ball2.attached).toBe(false);
  });

  it('laser fires twin bolts on action, respects cooldown, damages bricks and is absorbed by steel', () => {
    const board = testBoard(['RRRRRRRRRR', '..........', '.......#..']);
    const sim = new Simulation(board);
    // Keep the ball out of the bolts' path, hovering slowly mid-field.
    const ball = placeBall(sim, 20, 500, 0, -1);
    give(sim, 'laser');
    const first = sim.step({ targetX: null, axis: 0, launch: true });
    expect(first.filter((e) => e.type === 'laserFired')).toHaveLength(1);
    expect(sim.state.lasers).toHaveLength(2);
    // Holding the action does not fire again until the cooldown has elapsed.
    const held = stepN(sim, ticks(defs.laser.cooldownSeconds) - 2, action);
    expect(held.filter((e) => e.type === 'laserFired')).toHaveLength(0);
    const again = stepN(sim, 3, action);
    expect(again.filter((e) => e.type === 'laserFired')).toHaveLength(1);
    ball.y = 500;
    stepN(sim, 120);
    expect(sim.state.lasers).toHaveLength(0);
    // Two volleys from the same spot: the two reinforced bricks above the cannons
    // took two hits each and broke; every other brick is untouched.
    const under = (x: number) => sim.state.bricks.find((b) => b.type === 'reinforced' && x >= b.x && x <= b.x + b.width);
    const p = sim.state.paddle;
    expect(under(p.x - p.width / 2 + 8)?.alive).toBe(false);
    expect(under(p.x + p.width / 2 - 8)?.alive).toBe(false);
    expect(sim.state.bricks.filter((b) => b.type === 'reinforced' && b.alive && b.hp === 2)).toHaveLength(8);

    // Steel absorbs bolts: put the paddle's left cannon under the steel brick.
    const steel = sim.state.bricks.find((b) => b.type === 'indestructible');
    if (!steel) throw new Error('no steel');
    ball.y = 500;
    stepN(sim, 30, { targetX: steel.x + steel.width / 2 + sim.state.paddle.width / 2 - 8, axis: 0, launch: false });
    ball.y = 500;
    const shot = stepN(sim, 100, action);
    expect(shot.some((e) => e.type === 'brickDeflect' && e.brickId === steel.id)).toBe(true);
    expect(steel.alive).toBe(true);
  });

  it('bomb detonates on the next brick contact, once', () => {
    const board = testBoard(['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS']);
    const sim = new Simulation(board);
    placeBall(sim, 240, 400, 0, -1);
    give(sim, 'bomb');
    const target = sim.state.bricks.find((b) => b.row === 3 && b.col === 5);
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, target.y + 50, 0, -430);
    const events = stepN(sim, 30);
    expect(events.filter((e) => e.type === 'explosion' && e.source === 'bomb')).toHaveLength(1);
    // Struck brick plus its 3x3 neighbourhood (rows 2-3 below the top).
    expect(sim.state.bricks.filter((b) => !b.alive)).toHaveLength(6);
    expect(sim.state.effects.bomb).toBe(0);
  });

  it('heavy and bomb combine: the smashed brick also detonates', () => {
    const board = testBoard(['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSSSSSSS']);
    const sim = new Simulation(board);
    placeBall(sim, 240, 400, 0, -1);
    give(sim, 'heavy');
    give(sim, 'bomb');
    const target = sim.state.bricks.find((b) => b.row === 2 && b.col === 5);
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, target.y + 50, 0, -430);
    const events = stepN(sim, 10);
    expect(events.some((e) => e.type === 'explosion' && e.source === 'bomb')).toBe(true);
  });
});

describe('multiball', () => {
  it('splits into three balls at symmetric angles, capped at maxBalls', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 400, 0, -430);
    give(sim, 'multiball');
    expect(sim.state.balls).toHaveLength(3);
    const [a, b, c] = sim.state.balls;
    expect(b?.vx).toBeCloseTo(-(c?.vx ?? 0), 9);
    expect(a?.vx).toBeCloseTo(0, 9);
    give(sim, 'multiball');
    give(sim, 'multiball');
    expect(sim.state.balls).toHaveLength(BALANCE.powerUps.maxBalls);
  });

  it('losing extra balls costs no life; losing the last one does', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 400, 0, -430);
    give(sim, 'multiball');
    expect(sim.state.balls).toHaveLength(3);
    // Send two balls straight into the drain, keep one high.
    const [keep, d1, d2] = sim.state.balls;
    if (!keep || !d1 || !d2) throw new Error('balls');
    for (const b of [d1, d2]) {
      b.x = 30;
      b.y = SIM.worldHeight - 4;
      b.vx = 0;
      b.vy = 430;
    }
    keep.x = 400;
    keep.y = 300;
    keep.vy = -430;
    keep.vx = 0;
    const events = stepN(sim, 5, { targetX: 400, axis: 0, launch: false });
    expect(events.filter((e) => e.type === 'ballDrained')).toHaveLength(2);
    expect(events.some((e) => e.type === 'ballLost')).toBe(false);
    expect(sim.state.lives).toBe(BALANCE.lives);
    expect(sim.state.balls).toHaveLength(1);

    keep.x = 30;
    keep.y = SIM.worldHeight - 4;
    keep.vy = 430;
    const final = stepN(sim, 5, { targetX: 400, axis: 0, launch: false });
    expect(final.some((e) => e.type === 'ballLost')).toBe(true);
    expect(sim.state.lives).toBe(BALANCE.lives - 1);
  });

  it('two balls draining on the same tick cost exactly one life when they are the last', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 400, 0, -430);
    give(sim, 'multiball');
    for (const b of sim.state.balls) {
      b.x = 30;
      b.y = SIM.worldHeight - 2;
      b.vx = 0;
      b.vy = 430;
    }
    stepN(sim, 3, { targetX: 400, axis: 0, launch: false });
    expect(sim.state.lives).toBe(BALANCE.lives - 1);
  });
});

describe('life loss resets power-ups', () => {
  it('clears effects, capsules and bolts and restores the paddle', () => {
    const sim = new Simulation(openBoard());
    placeBall(sim, 240, 400, 0, -430);
    give(sim, 'wide');
    give(sim, 'laser');
    sim.step(action);
    sim.state.pickups.push({ id: 77, kind: 'bomb', x: 100, y: 100 });
    const ball = sim.state.balls[0];
    if (!ball) throw new Error('ball');
    ball.x = 30;
    ball.y = SIM.worldHeight - 2;
    ball.vy = 430;
    stepN(sim, 3, { targetX: 400, axis: 0, launch: false });
    expect(sim.state.status).toBe('ready');
    expect(Object.values(sim.state.effects).every((t) => t === 0)).toBe(true);
    expect(sim.state.pickups).toHaveLength(0);
    expect(sim.state.lasers).toHaveLength(0);
    expect(sim.state.paddle.width).toBe(BALANCE.paddle.width);
  });
});

describe('deterministic replay with power-ups', () => {
  it('reproduces drops, activations and the final state exactly', () => {
    const board = testBoard(
      ['SRSRSRSRSR', 'SSSSSSSSSS', 'XS#SPSS#SX', 'M....SSSSS', 'ABCD..EFAB'],
      {
        dropChance: 0.3,
        legend: {
          S: { type: 'standard', color: 'cyan' },
          R: { type: 'reinforced', color: 'red' },
          X: { type: 'explosive', color: 'magenta' },
          P: { type: 'powerup', color: 'violet' },
          A: { type: 'powerup', color: 'violet', powerUp: 'multiball' },
          B: { type: 'powerup', color: 'violet', powerUp: 'laser' },
          C: { type: 'powerup', color: 'violet', powerUp: 'magnet' },
          D: { type: 'powerup', color: 'violet', powerUp: 'wide' },
          E: { type: 'powerup', color: 'violet', powerUp: 'heavy' },
          F: { type: 'powerup', color: 'violet', powerUp: 'bomb' },
          '#': { type: 'indestructible', color: 'steel' },
          M: { type: 'moving', color: 'lime', move: { cells: 4, speed: 80 } },
        },
      },
    );
    const sim = new Simulation(board, { seed: 1234 });
    const bot = createAutoplayer('win');
    const log: TickInput[] = [];
    const collected = new Set<string>();
    for (let t = 0; t < 5 * 60 * SIM.tickRate && !sim.isOver; t++) {
      const input = bot(sim);
      log.push(input);
      for (const e of sim.step(input)) if (e.type === 'powerUp') collected.add(e.kind);
    }
    expect(collected.size).toBeGreaterThan(1);
    const replayed = replayRun(board, 1234, log);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(sim.state));
  });
});
