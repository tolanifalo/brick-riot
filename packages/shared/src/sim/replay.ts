import type { BalanceConfig } from '../config/balance';
import type { BoardDefinition } from '../levels/schema';
import { ticksToMs } from './scoring';
import { Simulation } from './simulation';
import type { SimState, SimStatus, TickInput } from './types';

export interface RunSummary {
  boardId: string;
  boardVersion: number;
  status: SimStatus;
  score: number;
  elapsedMs: number;
  bestCombo: number;
  ballsLost: number;
  livesRemaining: number;
  powerUpsCollected: number;
  ticks: number;
}

export function summarizeRun(state: SimState): RunSummary {
  return {
    boardId: state.boardId,
    boardVersion: state.boardVersion,
    status: state.status,
    score: state.score,
    elapsedMs: ticksToMs(state.elapsedTicks),
    bestCombo: state.bestCombo,
    ballsLost: state.ballsLost,
    livesRemaining: state.lives,
    powerUpsCollected: state.powerUpsCollected,
    ticks: state.tick,
  };
}

/** True when replaying `inputs` from scratch reproduces every field of `claimed`. */
export function replayMatches(
  board: BoardDefinition,
  seed: number,
  inputs: readonly TickInput[],
  claimed: RunSummary,
  config?: BalanceConfig,
): boolean {
  const actual = summarizeRun(replayRun(board, seed, inputs, config));
  return (Object.keys(claimed) as (keyof RunSummary)[]).every((k) => actual[k] === claimed[k]);
}

/** Re-runs a recorded input log from scratch and returns the resulting state. */
export function replayRun(
  board: BoardDefinition,
  seed: number,
  inputs: readonly TickInput[],
  config?: BalanceConfig,
): SimState {
  const sim = new Simulation(board, config ? { seed, config } : { seed });
  for (const input of inputs) {
    if (sim.isOver) break;
    sim.step(input);
  }
  return sim.state;
}
