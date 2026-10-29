import type { MultiplayerBoardProfile } from './boards';

/**
 * Board Compatibility Service: decides whether two (possibly different) boards
 * make a fair race. Thresholds are PROVISIONAL and must be tuned from human
 * playtests. There are no handicaps or hidden bonuses: first to clear wins.
 */
export interface CompatibilityPolicy {
  /** Max ratio between the two expected completion times (slower / faster). */
  maxExpectedTimeRatio: number;
  /** Max gap between designer difficulty ratings. */
  maxDifficultyGap: number;
  /** IQR / median above this is reported as a high-variance warning. */
  highVarianceRatio: number;
  /** Expected time above this fraction of the match timer is reported. */
  timerPressureFraction: number;
  /**
   * Max distance of the estimated first-to-clear probability from 0.5. This
   * accounts for the whole distribution, not just the medians: two boards with
   * similar medians but very different spreads still fail.
   */
  maxFirstClearSkew: number;
  /** A board clearing within the timer less often than this gets a warning. */
  minTimerCompletionRate: number;
  /** Ranked play requires human-playtest calibration on both boards. */
  rankedRequiresHumanCalibration: boolean;
}

export const DEFAULT_COMPATIBILITY_POLICY: CompatibilityPolicy = {
  maxExpectedTimeRatio: 1.15,
  maxDifficultyGap: 2,
  highVarianceRatio: 0.6,
  timerPressureFraction: 0.9,
  maxFirstClearSkew: 0.1,
  minTimerCompletionRate: 0.85,
  rankedRequiresHumanCalibration: true,
};

/**
 * Estimated probability that a run on board A clears before an independent run
 * on board B, from their decile distributions (ties count half).
 */
export function firstClearProbability(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0.5;
  let wins = 0;
  for (const x of a) for (const y of b) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

export type CalibrationStatus = 'calibrated' | 'estimated' | 'uncalibrated';

export interface CompatibilityReport {
  /** Fair enough for an unranked private race without explicit acceptance. */
  compatible: boolean;
  /** Fair and calibrated enough for ranked play. */
  rankedEligible: boolean;
  calibration: CalibrationStatus;
  /** slower / faster expected time, when both are known. */
  expectedTimeRatio: number | null;
  /** Estimated chance that player A (first board) clears first; null without distributions. */
  firstClearProbability: number | null;
  difficultyGap: number;
  /** Blocking problems (make `compatible` false). */
  problems: string[];
  /** Non-blocking information for players. */
  warnings: string[];
}

export function evaluateCompatibility(
  a: MultiplayerBoardProfile,
  b: MultiplayerBoardProfile,
  matchSeconds: number,
  policy: CompatibilityPolicy = DEFAULT_COMPATIBILITY_POLICY,
): CompatibilityReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const difficultyGap = Math.abs(a.difficulty - b.difficulty);
  let ratio: number | null = null;

  const same = a.boardId === b.boardId && a.boardVersion === b.boardVersion;
  const ta = a.expectedCompletionSeconds;
  const tb = b.expectedCompletionSeconds;
  if (ta !== null && tb !== null && ta > 0 && tb > 0) {
    ratio = Math.max(ta, tb) / Math.min(ta, tb);
    if (!same && ratio > policy.maxExpectedTimeRatio) {
      problems.push(
        `Expected clear times differ by ${Math.round((ratio - 1) * 100)}% (limit ${Math.round((policy.maxExpectedTimeRatio - 1) * 100)}%).`,
      );
    }
  } else if (!same) {
    problems.push('No completion-time data for at least one board; balance is unknown.');
  }
  let first: number | null = null;
  if (a.completionDeciles && b.completionDeciles) {
    first = same ? 0.5 : firstClearProbability(a.completionDeciles, b.completionDeciles);
    if (!same && Math.abs(first - 0.5) > policy.maxFirstClearSkew) {
      problems.push(
        `One board clears first in about ${Math.round(Math.max(first, 1 - first) * 100)}% of estimated races (limit ${Math.round((0.5 + policy.maxFirstClearSkew) * 100)}%).`,
      );
    }
  }
  if (!same && difficultyGap > policy.maxDifficultyGap) {
    problems.push(`Difficulty ratings differ by ${difficultyGap.toFixed(1)} (limit ${policy.maxDifficultyGap}).`);
  }

  for (const p of [a, b]) {
    if (p.expectedCompletionSeconds !== null && p.completionIqrSeconds !== null) {
      if (p.completionIqrSeconds / p.expectedCompletionSeconds > policy.highVarianceRatio) {
        warnings.push(`${p.boardId} has high clear-time variance.`);
      }
      if (p.expectedCompletionSeconds > matchSeconds * policy.timerPressureFraction) {
        warnings.push(`${p.boardId} usually needs about ${p.expectedCompletionSeconds}s; the timer is ${matchSeconds}s.`);
      }
    }
    if (p.timerCompletionRate !== null && p.timerCompletionRate < policy.minTimerCompletionRate) {
      warnings.push(
        `${p.boardId} beat the 120 s timer in only ${Math.round(p.timerCompletionRate * 100)}% of test runs; expect time-outs.`,
      );
    }
  }
  const mechA = a.mechanics.join(',');
  const mechB = b.mechanics.join(',');
  if (!same && mechA !== mechB) warnings.push('The boards use different special bricks.');

  const levels = [a.calibration, b.calibration];
  const calibration: CalibrationStatus = levels.every((l) => l === 'human-playtest')
    ? 'calibrated'
    : levels.every((l) => l !== 'none')
      ? 'estimated'
      : 'uncalibrated';
  if (calibration !== 'calibrated') {
    warnings.push(
      calibration === 'estimated'
        ? 'Balance is a bot estimate, not yet confirmed by human playtests.'
        : 'Balance is uncalibrated.',
    );
  }

  const compatible = problems.length === 0;
  const rankedEligible =
    compatible && (!policy.rankedRequiresHumanCalibration || calibration === 'calibrated');
  return {
    compatible,
    rankedEligible,
    calibration,
    expectedTimeRatio: ratio,
    firstClearProbability: first,
    difficultyGap,
    problems,
    warnings: [...new Set(warnings)],
  };
}
