import type { BoardDefinition, BrickLegendEntry } from '../src/levels/schema';
import type { Simulation } from '../src/sim/simulation';
import type { BallState, SimEvent, TickInput } from '../src/sim/types';

export const DEFAULT_LEGEND: Record<string, BrickLegendEntry> = {
  S: { type: 'standard', color: 'cyan' },
  R: { type: 'reinforced', color: 'red' },
  X: { type: 'explosive', color: 'magenta' },
  '#': { type: 'indestructible', color: 'steel' },
};

export function testBoard(layout: string[], overrides: Partial<BoardDefinition> = {}): BoardDefinition {
  const cols = layout[0]?.length ?? 1;
  return {
    id: 'test-board',
    version: 1,
    name: 'Test Board',
    collection: 'classic',
    theme: 'classic',
    difficulty: { designerRating: 1 },
    unlock: { kind: 'none' },
    mastery: [],
    multiplayerEligible: false,
    parTimeSeconds: 60,
    grid: { cols, brickHeight: 20, gap: 0, top: 100, sideMargin: 0 },
    legend: DEFAULT_LEGEND,
    layout,
    ...overrides,
  };
}

/** Puts the first ball in free flight at the given position and velocity. */
export function placeBall(sim: Simulation, x: number, y: number, vx: number, vy: number): BallState {
  const ball = sim.state.balls[0];
  if (!ball) throw new Error('no ball');
  ball.attached = false;
  ball.x = x;
  ball.y = y;
  ball.vx = vx;
  ball.vy = vy;
  ball.speed = Math.hypot(vx, vy);
  sim.state.status = 'playing';
  sim.state.started = true;
  return ball;
}

export const idle = (): TickInput => ({ targetX: null, axis: 0, launch: false });

export function stepN(sim: Simulation, n: number, input: TickInput = idle()): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...sim.step(input));
  return events;
}
