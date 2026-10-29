import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { Simulation } from '../src/sim/simulation';
import { placeBall, stepN, testBoard } from './helpers';

/** Fires the ball straight up into the lowest brick of column `col`. */
function fireAtColumn(sim: Simulation, col: number) {
  const column = sim.state.bricks.filter((b) => b.col === col);
  const brick = column[column.length - 1];
  if (!brick) throw new Error('missing brick');
  return placeBall(sim, brick.x + brick.width / 2, brick.y + brick.height + 30, 0, -430);
}

describe('brick damage and destruction', () => {
  it('destroys a standard brick in one hit', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', '.S........']));
    fireAtColumn(sim, 1);
    const events = stepN(sim, 30);
    const hits = events.filter((e) => e.type === 'brickHit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ destroyed: true, points: BALANCE.scoring.destroyPoints.standard });
    expect(sim.state.requiredRemaining).toBe(sim.state.requiredTotal - 1);
    expect(sim.state.score).toBe(BALANCE.scoring.destroyPoints.standard);
  });

  it('needs two hits for a reinforced brick', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', '..R.......']));
    const ball = fireAtColumn(sim, 2);
    stepN(sim, 30);
    const brick = sim.state.bricks.find((b) => b.type === 'reinforced');
    expect(brick).toMatchObject({ alive: true, hp: 1, maxHp: 2 });
    expect(sim.state.score).toBe(BALANCE.scoring.hitPoints);
    expect(ball.vy).toBeGreaterThan(0);

    placeBall(sim, ball.x, ball.y + 40, 0, -430);
    stepN(sim, 60);
    expect(brick?.alive).toBe(false);
  });

  it('never damages indestructible bricks and does not require them', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', '...#......']));
    expect(sim.state.requiredTotal).toBe(10);
    const ball = fireAtColumn(sim, 3);
    const events = stepN(sim, 30);
    expect(events.some((e) => e.type === 'brickDeflect')).toBe(true);
    expect(events.some((e) => e.type === 'brickHit')).toBe(false);
    expect(sim.state.bricks.find((b) => b.type === 'indestructible')?.alive).toBe(true);
    expect(ball.vy).toBeGreaterThan(0);
  });

  it('explodes into the surrounding 3x3 cells, chaining explosives', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', 'SSSSSSSSSS', 'SSSSXXSSSS', 'S#S#......']));
    const target = sim.state.bricks.find((b) => b.row === 2 && b.col === 4);
    if (!target) throw new Error('missing brick');
    placeBall(sim, target.x + target.width / 2, target.y + target.height + 30, 0, -430);
    const events = stepN(sim, 30);
    expect(events.filter((e) => e.type === 'explosion')).toHaveLength(2);
    const destroyed = sim.state.bricks.filter((b) => !b.alive).map((b) => `${b.row},${b.col}`);
    // Both explosives plus every neighbour of either one.
    expect(destroyed.sort()).toEqual(['1,3', '1,4', '1,5', '1,6', '2,3', '2,4', '2,5', '2,6']);
    expect(sim.state.combo).toBe(8);
    expect(sim.state.bricks.find((b) => b.type === 'indestructible')?.alive).toBe(true);
  });

  it('hits only one brick per contact', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', 'SSSSSSSSSS']));
    const seam = sim.state.bricks.find((b) => b.row === 1 && b.col === 5);
    if (!seam) throw new Error('missing brick');
    placeBall(sim, seam.x, seam.y + seam.height + 20, 0, -430);
    const events = stepN(sim, 10);
    expect(events.filter((e) => e.type === 'brickHit')).toHaveLength(1);
  });
});

describe('combo tracking', () => {
  it('counts consecutive destroys and resets on paddle contact', () => {
    const sim = new Simulation(testBoard(['SSSSSSSSSS', 'S.S.......']));
    fireAtColumn(sim, 0);
    stepN(sim, 30);
    expect(sim.state.combo).toBe(1);
    fireAtColumn(sim, 2);
    stepN(sim, 30);
    expect(sim.state.combo).toBe(2);
    expect(sim.state.bestCombo).toBe(2);

    const p = sim.state.paddle;
    placeBall(sim, p.x, p.y - 40, 0, 430);
    stepN(sim, 20);
    expect(sim.state.combo).toBe(0);
    expect(sim.state.bestCombo).toBe(2);
  });
});
