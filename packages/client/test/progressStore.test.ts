import {
  CLASSIC_01,
  CLASSIC_02,
  createAutoplayer,
  createEmptyProgress,
  NO_UPGRADES,
  SIM,
  Simulation,
  summarizeRun,
  type TickInput,
  type UpgradeLevels,
} from '@brick-riot/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { canStartBoard, soloConfig, useProgress, type FinishedRun } from '../src/progress/progressStore';
import { InMemoryProgressRepository, type ProgressRepository } from '../src/progress/repository';

function playLevelOne(seed: number, upgrades: UpgradeLevels = NO_UPGRADES): FinishedRun {
  const sim = new Simulation(CLASSIC_01, { seed, config: soloConfig(upgrades) });
  const bot = createAutoplayer('win');
  const inputs: TickInput[] = [];
  while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) {
    const input = bot(sim);
    inputs.push(input);
    sim.step(input);
  }
  return { runId: `run-${seed}`, seed, inputs, summary: summarizeRun(sim.state), upgrades };
}

describe('progress store', () => {
  let repo: InMemoryProgressRepository;

  beforeEach(async () => {
    repo = new InMemoryProgressRepository();
    await useProgress.getState().init(repo);
  });

  it('locks boards until their requirement is met', async () => {
    expect(canStartBoard(CLASSIC_01.id)).toBe(true);
    expect(canStartBoard(CLASSIC_02.id)).toBe(false);
    expect(canStartBoard('not-a-board')).toBe(false);
  });

  it('verifies, rewards and persists a real run exactly once', async () => {
    const run = playLevelOne(5);
    expect(run.summary.status).toBe('won');
    const outcome = await useProgress.getState().recordRun(run);
    expect(outcome?.verified).toBe(true);
    expect(outcome?.xp).toBeGreaterThan(0);
    expect(canStartBoard(CLASSIC_02.id)).toBe(true);

    const saved = await repo.load();
    expect(saved.progress.xp).toBe(outcome?.xp);
    expect(saved.progress.boards[CLASSIC_01.id]?.completions).toBe(1);

    // The same finished run reported again (e.g. a duplicated event) earns nothing.
    const again = await useProgress.getState().recordRun(run);
    expect(again?.duplicate).toBe(true);
    expect(useProgress.getState().progress.xp).toBe(outcome?.xp);
    expect(useProgress.getState().progress.boards[CLASSIC_01.id]?.completions).toBe(1);
  });

  it('refuses rewards for a summary that does not match its input log', async () => {
    const run = playLevelOne(6);
    const forged: FinishedRun = { ...run, runId: 'forged', summary: { ...run.summary, score: run.summary.score + 5000 } };
    const outcome = await useProgress.getState().recordRun(forged);
    expect(outcome?.verified).toBe(false);
    expect(outcome?.xp).toBe(0);
    expect(useProgress.getState().progress.boards[CLASSIC_01.id]?.bestScore ?? 0).toBe(0);
    expect(canStartBoard(CLASSIC_02.id)).toBe(false);
  });

  it('verifies an upgraded solo run with the upgrades it was played with', async () => {
    const upgrades = { ...NO_UPGRADES, paddleWidth: 5, paddleControl: 5 };
    const run = playLevelOne(7, upgrades);
    expect((await useProgress.getState().recordRun(run))?.verified).toBe(true);
    // Claiming different upgrades than were played does not verify.
    const mismatched = { ...playLevelOne(8, upgrades), upgrades: NO_UPGRADES };
    expect((await useProgress.getState().recordRun(mismatched))?.verified).toBe(false);
  });
});

describe('workshop purchases', () => {
  let repo: InMemoryProgressRepository;

  async function withCoins(coins: number) {
    repo = new InMemoryProgressRepository();
    await repo.save({ ...createEmptyProgress('2026-01-01T00:00:00.000Z'), coins });
    await useProgress.getState().init(repo);
  }

  it('deducts coins and raises the level together, and persists both', async () => {
    await withCoins(500);
    const result = await useProgress.getState().purchase('paddleWidth', 0);
    expect(result).toEqual({ ok: true, cost: 150, level: 1 });
    expect(useProgress.getState().progress.coins).toBe(350);
    expect(useProgress.getState().progress.upgrades.paddleWidth).toBe(1);
    const saved = (await repo.load()).progress;
    expect(saved.coins).toBe(350);
    expect(saved.upgrades.paddleWidth).toBe(1);
  });

  it('a double-submitted purchase buys only one level', async () => {
    await withCoins(1000);
    const [a, b] = await Promise.all([useProgress.getState().purchase('paddleWidth', 0), useProgress.getState().purchase('paddleWidth', 0)]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: 'stale_level' });
    expect(useProgress.getState().progress.coins).toBe(850);
  });

  it('refuses insufficient funds and max level without changing anything', async () => {
    await withCoins(100);
    expect(await useProgress.getState().purchase('ballPower', 0)).toEqual({ ok: false, error: 'insufficient_coins' });
    expect(useProgress.getState().progress.coins).toBe(100);
    await withCoins(100_000);
    for (let level = 0; level < 3; level++) expect((await useProgress.getState().purchase('ballPower', level)).ok).toBe(true);
    const coins = useProgress.getState().progress.coins;
    expect(await useProgress.getState().purchase('ballPower', 3)).toEqual({ ok: false, error: 'max_level' });
    expect(useProgress.getState().progress.coins).toBe(coins);
  });

  it('a failed save leaves coins and levels untouched', async () => {
    await withCoins(500);
    const failing: ProgressRepository = { load: () => repo.load(), save: () => Promise.reject(new Error('quota')) };
    await useProgress.getState().init(failing);
    expect(await useProgress.getState().purchase('paddleWidth', 0)).toEqual({ ok: false, error: 'save_failed' });
    expect(useProgress.getState().progress.coins).toBe(500);
    expect(useProgress.getState().progress.upgrades.paddleWidth).toBe(0);
  });

  it('saves only loadouts that are unlocked and within budget', async () => {
    await withCoins(0);
    const frost = { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' } as const;
    expect(await useProgress.getState().saveLoadout(frost)).toEqual({ ok: false, error: 'locked' });
    const ok = { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' } as const;
    expect(await useProgress.getState().saveLoadout(ok)).toEqual({ ok: true });
    expect((await repo.load()).progress.loadout).toEqual(ok);
  });
});
