import {
  applyRunResult,
  buildPlayerConfig,
  CAMPAIGN_BOARDS,
  createEmptyBoardProgress,
  createEmptyProgress,
  encodeInputLog,
  getCampaignBoard,
  type BoardDefinition,
  type FinishRunResponse,
  type ProfileView,
  type PurchaseResponse,
  isBoardUnlocked,
  levelForXp,
  purchaseUpgrade,
  replayMatches,
  validateLoadout,
  type BalanceConfig,
  type Loadout,
  type PlayerProgress,
  type PurchaseError,
  type RunOutcome,
  type RunSummary,
  type TickInput,
  type UpgradeId,
  type UpgradeLevels,
} from '@brick-riot/shared';
import { create } from 'zustand';
import { useAccount } from '../account/accountStore';
import { api, ApiRequestError, newIdempotencyKey } from '../net/api';
import { createDefaultRepository, type ProgressRepository } from './repository';

/** Everything needed to re-simulate and verify a finished run. */
export interface FinishedRun {
  runId: string;
  seed: number;
  inputs: readonly TickInput[];
  summary: RunSummary;
  /** Upgrade levels the run was played with (they change the simulation config). */
  upgrades: UpgradeLevels;
  /** Signed-in runs: the server-issued run id (the server picked the seed). */
  serverRunId?: string;
}

/** The simulation config for a solo run with these upgrades. */
export function soloConfig(upgrades: UpgradeLevels): BalanceConfig {
  return buildPlayerConfig({ loadout: null, upgrades }, 'solo');
}

export type PurchaseOutcome =
  | { ok: true; cost: number; level: number }
  | { ok: false; error: PurchaseError | 'save_failed' | string };

interface ProgressState {
  ready: boolean;
  /** 'account' = server-authoritative progression; 'guest' = this browser's local save. */
  mode: 'guest' | 'account';
  progress: PlayerProgress;
  /** The local (guest) save, kept intact while signed in. */
  guestProgress: PlayerProgress;
  /** Signed in: the server profile behind `progress`. */
  server: ProfileView | null;
  /** Switches between the server profile (signed in) and the local save (guest). */
  useServerProfile(profile: ProfileView | null): void;
  /** False when storage is blocked and progress lives in memory only. */
  persistent: boolean;
  notice: string | null;
  saveError: string | null;
  init(repository?: ProgressRepository): Promise<void>;
  /** Verifies, applies and saves a finished run. Returns null for unknown boards. */
  recordRun(run: FinishedRun): Promise<RunOutcome | null>;
  /**
   * Buys one upgrade level. Atomic: coins and level change together, and only
   * once the save succeeded. `expectedLevel` rejects double-submits.
   */
  purchase(id: UpgradeId, expectedLevel: number): Promise<PurchaseOutcome>;
  /** Saves the preferred multiplayer loadout (validated against unlocks and budget). */
  saveLoadout(loadout: Loadout): Promise<{ ok: true } | { ok: false; error: string }>;
  setReducedEffects(on: boolean): Promise<void>;
  dismissNotice(): void;
}

let repository: ProgressRepository | null = null;
/** Serialises saves so a slow write can never be overtaken by an older state. */
let saveChain: Promise<void> = Promise.resolve();

export const useProgress = create<ProgressState>((set, get) => ({
  ready: false,
  mode: 'guest',
  progress: createEmptyProgress(new Date().toISOString()),
  guestProgress: createEmptyProgress(new Date().toISOString()),
  server: null,
  persistent: true,
  notice: null,
  saveError: null,

  useServerProfile(profile) {
    if (profile) set({ mode: 'account', server: profile, progress: progressFromProfile(profile) });
    else set({ mode: 'guest', server: null, progress: get().guestProgress });
  },

  async init(injected) {
    let persistent = true;
    if (injected) repository = injected;
    else {
      const created = createDefaultRepository();
      repository = created.repository;
      persistent = created.persistent;
    }
    const loaded = await repository.load();
    set({
      ready: true,
      guestProgress: loaded.progress,
      ...(get().mode === 'guest' ? { progress: loaded.progress } : {}),
      persistent,
      notice: !persistent
        ? 'Storage is unavailable in this browser, so progress will not be kept after you close the game.'
        : loaded.notice,
    });
  },

  async recordRun(run) {
    const board = getCampaignBoard(run.summary.boardId);
    if (!board) return null;
    if (get().mode === 'account') return recordServerRun(run, board);
    // Local integrity check: the input log must replay to the reported result.
    // This guards against engine/recording bugs. It is not anti-cheat: local
    // progress is never trusted for competitive results.
    const verified = replayMatches(board, run.seed, run.inputs, run.summary, soloConfig(run.upgrades));
    const { progress, outcome } = applyRunResult(get().progress, board, CAMPAIGN_BOARDS, {
      runId: run.runId,
      summary: run.summary,
      verified,
      finishedAt: new Date().toISOString(),
    });
    if (outcome.duplicate) return outcome;
    set({ progress, guestProgress: progress });
    const repo = repository;
    if (repo) {
      saveChain = saveChain
        .then(() => repo.save(progress))
        .then(() => set({ saveError: null }))
        .catch(() => set({ saveError: 'Progress could not be saved on this device.' }));
      await saveChain;
    }
    return outcome;
  },

  purchase(id, expectedLevel) {
    if (get().mode === 'account') return purchaseOnServer(id, expectedLevel);
    // Runs inside the save chain, so it sees every earlier change and nothing
    // can interleave between the check, the save and the state update.
    const run = saveChain.then(async (): Promise<PurchaseOutcome> => {
      const result = purchaseUpgrade(get().progress, id, expectedLevel);
      if (!result.ok) return result;
      if (repository) {
        try {
          await repository.save(result.progress);
        } catch {
          set({ saveError: 'Progress could not be saved on this device.' });
          return { ok: false, error: 'save_failed' };
        }
      }
      set({ progress: result.progress, guestProgress: result.progress, saveError: null });
      return { ok: true, cost: result.cost, level: result.level };
    });
    saveChain = run.then(() => undefined);
    return run;
  },

  async saveLoadout(loadout) {
    if (get().mode === 'account') {
      try {
        await api('PUT', '/api/loadout', { loadout });
        await useAccount.getState().refresh();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof ApiRequestError ? err.code : 'network' };
      }
    }
    const level = levelForXp(get().progress.xp).level;
    const check = validateLoadout(loadout, level);
    if (!check.ok) return { ok: false, error: check.error };
    await commit({ ...get().progress, loadout: check.loadout });
    return { ok: true };
  },

  async setReducedEffects(on) {
    if (get().mode === 'account') {
      set({ progress: { ...get().progress, settings: { ...get().progress.settings, reducedEffects: on } } });
      await api('PUT', '/api/me/settings', { reducedEffects: on }).catch(() => undefined);
      await useAccount.getState().refresh();
      return;
    }
    const progress = get().progress;
    await commit({ ...progress, settings: { ...progress.settings, reducedEffects: on } });
  },

  dismissNotice() {
    set({ notice: null });
  },
}));

/** Applies a (guest) progress change and queues its local save. */
async function commit(progress: PlayerProgress): Promise<void> {
  useProgress.setState({ progress, guestProgress: progress });
  const repo = repository;
  if (!repo) return;
  saveChain = saveChain
    .then(() => repo.save(progress))
    .then(() => useProgress.setState({ saveError: null }))
    .catch(() => useProgress.setState({ saveError: 'Progress could not be saved on this device.' }));
  await saveChain;
}

/** The only way a board can be started: locked boards are refused. */
export function canStartBoard(boardId: string): boolean {
  const board = getCampaignBoard(boardId);
  const { mode, server, progress } = useProgress.getState();
  if (!board) return false;
  if (mode === 'account' && server) return server.unlockedBoardIds.includes(boardId);
  return isBoardUnlocked(board, progress);
}

/**
 * Server profile in the shape the campaign and Workshop screens already use.
 * Verified records come first; imported (unverified) local records fill in
 * boards that have no verified record yet, for display only.
 */
export function progressFromProfile(profile: ProfileView): PlayerProgress {
  const p = createEmptyProgress(profile.account.createdAt);
  p.xp = profile.progress.xp;
  p.coins = profile.progress.coins;
  p.upgrades = { ...profile.equipment.upgrades };
  p.loadout = { ...profile.equipment.loadout };
  p.settings = { ...profile.settings };
  for (const r of profile.importedRecords) {
    p.boards[r.boardId] = { ...createEmptyBoardProgress(r.boardId), attempts: r.completions, completions: r.completions, bestScore: r.bestScore ?? 0, bestTimeMs: r.bestTimeMs, bestStars: r.bestStars };
  }
  for (const b of profile.boards) {
    p.boards[b.boardId] = {
      ...createEmptyBoardProgress(b.boardId),
      attempts: b.attempts,
      completions: b.completions,
      bestScore: b.bestScore ?? 0,
      bestTimeMs: b.bestTimeMs,
      bestStars: b.bestStars,
      mastery: [...b.mastery],
    };
  }
  return p;
}

/** Signed-in run: the server replays it and decides the rewards (exactly once). */
async function recordServerRun(run: FinishedRun, board: BoardDefinition): Promise<RunOutcome | null> {
  if (!run.serverRunId) {
    // Started without a server run (offline): nothing can be verified or rewarded.
    const { outcome } = applyRunResult(useProgress.getState().progress, board, CAMPAIGN_BOARDS, {
      runId: run.runId,
      summary: run.summary,
      verified: false,
      finishedAt: new Date().toISOString(),
    });
    return outcome;
  }
  const inputs = encodeInputLog(run.inputs);
  let lastErr: unknown = null;
  // Retrying is safe: the server records a run at most once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await api<FinishRunResponse>('POST', `/api/solo/runs/${run.serverRunId}/finish`, { inputs });
      await useAccount.getState().refresh();
      return res.outcome;
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiRequestError && err.status > 0 && err.status < 500) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  useProgress.setState({ saveError: lastErr instanceof ApiRequestError ? 'The server could not record that run.' : 'Cannot reach the game server; the run was not recorded.' });
  return null;
}

/** Signed-in purchase: one idempotency key per purchase, reused on retries, so nothing is charged twice. */
async function purchaseOnServer(id: UpgradeId, expectedLevel: number): Promise<PurchaseOutcome> {
  const key = newIdempotencyKey();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await api<PurchaseResponse>('POST', '/api/workshop/purchase', { upgradeId: id, expectedLevel }, { 'Idempotency-Key': key });
      await useAccount.getState().refresh();
      return { ok: true, cost: res.cost, level: res.level };
    } catch (err) {
      if (err instanceof ApiRequestError && err.status > 0) return { ok: false, error: err.code };
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { ok: false, error: 'network' };
}

// Keep progression in step with the signed-in account.
useAccount.subscribe((state, prev) => {
  if (state.profile !== prev.profile) useProgress.getState().useServerProfile(state.profile);
});
