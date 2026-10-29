import type { MatchResult } from '@brick-riot/shared';

/**
 * Balance telemetry hook: per-board outcomes feed future Board Difficulty
 * Rating calibration. Phase 3 aggregates in memory only.
 */
export interface BalanceTelemetry {
  recordMatch(result: MatchResult): void;
}

export interface BoardStats {
  matches: number;
  clears: number;
  /** Completion ticks of clears, for median/variance estimates. */
  clearTicks: number[];
  exhausted: number;
}

export class InMemoryBalanceTelemetry implements BalanceTelemetry {
  readonly boards = new Map<string, BoardStats>();

  recordMatch(result: MatchResult): void {
    if (result.outcome === 'cancelled') return;
    for (const p of result.players) {
      const key = `${p.boardId}@${p.boardVersion}`;
      const s = this.boards.get(key) ?? { matches: 0, clears: 0, clearTicks: [], exhausted: 0 };
      s.matches++;
      if (p.completionTick !== null) {
        s.clears++;
        s.clearTicks.push(p.completionTick);
      }
      if (p.exhaustedTick !== null) s.exhausted++;
      this.boards.set(key, s);
    }
  }
}
