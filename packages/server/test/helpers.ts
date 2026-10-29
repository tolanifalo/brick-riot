import {
  createAutoplayer,
  encodeInput,
  type AutoplayMode,
  type BoardDefinition,
  type Seat,
  type Simulation,
  type TickInput,
} from '@brick-riot/shared';
import { MatchEngine } from '../src/match/MatchEngine';

/** A single-row board the autoplayer clears in well under a minute. */
export function quickBoard(id = 'quick', layout = ['SSSSSSSSSS']): BoardDefinition {
  return {
    id,
    version: 1,
    name: id,
    collection: 'classic',
    theme: 'classic',
    difficulty: { designerRating: 1 },
    unlock: { kind: 'none' },
    mastery: [],
    multiplayerEligible: true,
    parTimeSeconds: 60,
    grid: { cols: 10, brickHeight: 20, gap: 4, top: 120, sideMargin: 16 },
    legend: { S: { type: 'standard', color: 'cyan' }, R: { type: 'reinforced', color: 'red' } },
    layout,
  };
}

export type Policy = AutoplayMode | 'idle' | ((sim: Simulation, tick: number) => TickInput);

/** Drives an engine tick by tick, submitting each seat's next input like a client would. */
export function play(engine: MatchEngine, policies: Record<Seat, Policy>, maxTicks: number): void {
  const bots: Partial<Record<Seat, (sim: Simulation) => TickInput>> = {};
  const seqs: Record<Seat, number> = { A: 0, B: 0 };
  for (const seat of ['A', 'B'] as const) {
    const p = policies[seat];
    if (p === 'win' || p === 'lose') bots[seat] = createAutoplayer(p);
  }
  while (!engine.isOver && engine.tick < maxTicks) {
    const next = engine.tick + 1;
    for (const seat of ['A', 'B'] as const) {
      const p = policies[seat];
      if (p === 'idle') continue;
      const sim = engine.sim(seat);
      const input = typeof p === 'function' ? p(sim, next) : (bots[seat]?.(sim) ?? { targetX: null, axis: 0, launch: false });
      engine.submitInputs(seat, { seq: seqs[seat]++, inputs: [encodeInput(next, input)] });
    }
    engine.advanceTo(next);
  }
}

export function engineFor(boardA: BoardDefinition, boardB: BoardDefinition, durationTicks = 120 * 120, seeds = [11, 22]) {
  return new MatchEngine(
    [
      { seat: 'A', board: boardA, seed: seeds[0] ?? 1 },
      { seat: 'B', board: boardB, seed: seeds[1] ?? 2 },
    ],
    { durationTicks },
  );
}
