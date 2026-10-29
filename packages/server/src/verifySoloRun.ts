import {
  replayRun,
  summarizeRun,
  type BoardDefinition,
  type RunSummary,
  type TickInput,
} from '@brick-riot/shared';

export interface SoloRunSubmission {
  boardId: string;
  boardVersion: number;
  seed: number;
  inputs: readonly TickInput[];
  claimed: Pick<RunSummary, 'status' | 'score' | 'elapsedMs'>;
}

export type VerificationResult =
  | { ok: true; summary: RunSummary }
  | { ok: false; reason: 'unknown-board' | 'version-mismatch' | 'result-mismatch'; summary?: RunSummary };

/**
 * Re-simulates a submitted solo run and accepts it only if the authoritative
 * replay reproduces the claimed outcome. The client's claim is never trusted.
 */
export function verifySoloRun(
  submission: SoloRunSubmission,
  boards: ReadonlyMap<string, BoardDefinition>,
): VerificationResult {
  const board = boards.get(submission.boardId);
  if (!board) return { ok: false, reason: 'unknown-board' };
  if (board.version !== submission.boardVersion) return { ok: false, reason: 'version-mismatch' };

  const summary = summarizeRun(replayRun(board, submission.seed, submission.inputs));
  const { claimed } = submission;
  const matches =
    summary.status === claimed.status && summary.score === claimed.score && summary.elapsedMs === claimed.elapsedMs;
  return matches ? { ok: true, summary } : { ok: false, reason: 'result-mismatch', summary };
}
