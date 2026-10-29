import { ECONOMY, levelForXp, type EconomyConfig, type Reward } from '../config/economy';
import type { BoardDefinition, MasteryObjective } from '../levels/schema';
import type { RunSummary } from '../sim/replay';
import { createEmptyBoardProgress } from './save';
import { isBoardUnlocked } from './unlocks';
import { PROGRESS_LIMITS, type PlayerProgress, type RunHistoryEntry, type StarRating } from './types';

/** A finished run as reported by the game client. */
export interface RunResult {
  runId: string;
  summary: RunSummary;
  /** Whether the input log replayed to the same summary on this device. */
  verified: boolean;
  finishedAt: string;
}

export interface RewardLine {
  label: string;
  xp: number;
  coins: number;
}

export interface RunOutcome {
  /** True when this run id was already applied; nothing changed. */
  duplicate: boolean;
  won: boolean;
  verified: boolean;
  stars: StarRating;
  previousBestStars: StarRating;
  newBestScore: boolean;
  newBestTime: boolean;
  rewards: RewardLine[];
  xp: number;
  coins: number;
  masteryCompleted: MasteryObjective[];
  /** Boards that became unlocked because of this run. */
  unlocked: string[];
  levelBefore: number;
  levelAfter: number;
}

export function computeStars(board: BoardDefinition, won: boolean, elapsedMs: number): StarRating {
  if (!won) return 0;
  const stars = board.stars;
  if (!stars) return 1;
  if (elapsedMs <= stars.threeStarSeconds * 1000) return 3;
  if (elapsedMs <= stars.twoStarSeconds * 1000) return 2;
  return 1;
}

export function isObjectiveMet(objective: MasteryObjective, summary: RunSummary): boolean {
  if (summary.status !== 'won') return false;
  switch (objective.kind) {
    case 'clear':
      return true;
    case 'clearUnderSeconds':
      return summary.elapsedMs <= objective.seconds * 1000;
    case 'noBallLost':
      return summary.ballsLost === 0;
    case 'minBallsRemaining':
      return summary.livesRemaining >= objective.balls;
    case 'minCombo':
      return summary.bestCombo >= objective.combo;
    case 'minScore':
      return summary.score >= objective.score;
  }
}

export function describeObjective(objective: MasteryObjective): string {
  switch (objective.kind) {
    case 'clear':
      return 'Clear the board';
    case 'clearUnderSeconds':
      return `Clear in under ${formatSeconds(objective.seconds)}`;
    case 'noBallLost':
      return 'Clear without losing a ball';
    case 'minBallsRemaining':
      return `Clear with ${objective.balls}+ balls left`;
    case 'minCombo':
      return `Reach a ×${objective.combo} combo and clear`;
    case 'minScore':
      return `Score ${objective.score.toLocaleString('en-US')}+ and clear`;
  }
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

const scale = (r: Reward, k: number): Reward => ({ xp: r.xp * k, coins: r.coins * k });

/** Completion-reward multiplier for the (priorCompletions + 1)th clear. */
export function repeatMultiplier(priorCompletions: number, economy: EconomyConfig = ECONOMY): number {
  if (priorCompletions <= 0) return economy.repeat.firstClearMultiplier;
  return Math.max(economy.repeat.floor, economy.repeat.decay ** priorCompletions);
}

/**
 * Applies a finished run to progress. Pure and idempotent: the same run id
 * is never rewarded twice. Unverified runs are logged in history but earn no
 * rewards and set no records.
 */
export function applyRunResult(
  progress: PlayerProgress,
  board: BoardDefinition,
  boards: readonly BoardDefinition[],
  result: RunResult,
  economy: EconomyConfig = ECONOMY,
): { progress: PlayerProgress; outcome: RunOutcome } {
  const { summary } = result;
  const prevBoard = progress.boards[board.id] ?? createEmptyBoardProgress(board.id);
  const levelBefore = levelForXp(progress.xp).level;
  const won = summary.status === 'won';
  const stars = computeStars(board, won, summary.elapsedMs);
  const base: RunOutcome = {
    duplicate: false,
    won,
    verified: result.verified,
    stars,
    previousBestStars: prevBoard.bestStars,
    newBestScore: false,
    newBestTime: false,
    rewards: [],
    xp: 0,
    coins: 0,
    masteryCompleted: [],
    unlocked: [],
    levelBefore,
    levelAfter: levelBefore,
  };

  if (progress.appliedRunIds.includes(result.runId)) {
    return { progress, outcome: { ...base, duplicate: true, stars: 0 } };
  }
  if (summary.boardId !== board.id || summary.boardVersion !== board.version) {
    throw new Error(`run is for ${summary.boardId}@${summary.boardVersion}, not ${board.id}@${board.version}`);
  }

  const next: PlayerProgress = structuredCloneProgress(progress);
  const record = { ...prevBoard, mastery: [...prevBoard.mastery] };
  record.attempts++;
  record.lastPlayedAt = result.finishedAt;
  const rewards: RewardLine[] = [];
  const masteryCompleted: MasteryObjective[] = [];
  const counts = result.verified;

  if (won && counts) {
    const c = economy.completion;
    const prior = record.completions;
    const k = repeatMultiplier(prior, economy);
    const rating = board.difficulty.designerRating;
    const add = (label: string, r: Reward) => {
      const line = { label, xp: Math.round(r.xp), coins: Math.round(r.coins) };
      if (line.xp > 0 || line.coins > 0) rewards.push(line);
    };
    const clearLabel = prior === 0 ? `First clear (×${k})` : `Replay clear (×${k.toFixed(2)})`;
    add(clearLabel, scale({ xp: c.base.xp + c.perDifficulty.xp * rating, coins: c.base.coins + c.perDifficulty.coins * rating }, k));
    add(`${stars}-star time`, scale(scale(c.perStar, stars), k));
    add(`${summary.livesRemaining} ball${summary.livesRemaining === 1 ? '' : 's'} left`, scale(scale(c.perBallRemaining, summary.livesRemaining), k));
    add(`Best combo ×${summary.bestCombo}`, scale({ xp: Math.min(c.comboXpCap, c.comboXp * summary.bestCombo), coins: 0 }, k));
    if (stars > record.bestStars) {
      add(`New star record (+${stars - record.bestStars})`, scale(economy.starImprovement, stars - record.bestStars));
    }
    for (const objective of board.mastery) {
      if (record.mastery.includes(objective.id) || !isObjectiveMet(objective, summary)) continue;
      record.mastery.push(objective.id);
      masteryCompleted.push(objective);
      add(`Mastery: ${describeObjective(objective)}`, economy.mastery[objective.kind]);
    }

    record.completions++;
    if (!record.firstClearedAt) record.firstClearedAt = result.finishedAt;
    if (stars > record.bestStars) record.bestStars = stars;
    if (summary.score > record.bestScore) {
      record.bestScore = summary.score;
      base.newBestScore = true;
    }
    if (record.bestTimeMs === null || summary.elapsedMs < record.bestTimeMs) {
      record.bestTimeMs = summary.elapsedMs;
      base.newBestTime = true;
    }
  }

  const xp = rewards.reduce((n, r) => n + r.xp, 0);
  const coins = rewards.reduce((n, r) => n + r.coins, 0);
  const unlockedBefore = new Set(boards.filter((b) => isBoardUnlocked(b, next)).map((b) => b.id));
  next.boards[board.id] = record;
  next.xp = Math.min(PROGRESS_LIMITS.maxXp, next.xp + xp);
  next.coins = Math.min(PROGRESS_LIMITS.maxCoins, next.coins + coins);
  next.appliedRunIds = [result.runId, ...next.appliedRunIds].slice(0, PROGRESS_LIMITS.appliedRunIds);
  const entry: RunHistoryEntry = {
    runId: result.runId,
    boardId: board.id,
    boardVersion: board.version,
    outcome: won ? 'won' : 'lost',
    score: summary.score,
    elapsedMs: summary.elapsedMs,
    stars: counts ? stars : 0,
    ballsLost: summary.ballsLost,
    bestCombo: summary.bestCombo,
    xpEarned: xp,
    coinsEarned: coins,
    verified: result.verified,
    finishedAt: result.finishedAt,
  };
  next.history = [entry, ...next.history].slice(0, PROGRESS_LIMITS.history);
  next.updatedAt = result.finishedAt;
  const unlocked = boards.filter((b) => !unlockedBefore.has(b.id) && isBoardUnlocked(b, next)).map((b) => b.id);

  return {
    progress: next,
    outcome: {
      ...base,
      stars: counts ? stars : 0,
      rewards,
      xp,
      coins,
      masteryCompleted,
      unlocked,
      levelAfter: levelForXp(next.xp).level,
    },
  };
}

function structuredCloneProgress(p: PlayerProgress): PlayerProgress {
  return {
    ...p,
    boards: Object.fromEntries(Object.entries(p.boards).map(([id, b]) => [id, { ...b, mastery: [...b.mastery] }])),
    history: [...p.history],
    appliedRunIds: [...p.appliedRunIds],
  };
}
