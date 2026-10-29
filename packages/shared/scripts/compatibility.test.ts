/**
 * Board compatibility analysis (Phase 4). Not part of `npm test`; run with
 * `npm run compat -w @brick-riot/shared`. Feeds BOARD_COMPATIBILITY.md.
 *
 * For each candidate board it runs the autoplayer under the MULTIPLAYER
 * config (default loadout; and a capped-upgrades config) over many seeds and
 * reports the clear-time distribution. For each pair it estimates how often
 * board A clears before board B for independent runs (P(A first)), which
 * captures variance as well as the median: two boards with equal medians but
 * very different spreads are not a fair race. All numbers are BOT ESTIMATES.
 */
import { it } from 'vitest';
import { DEFAULT_LOADOUT } from '../src/abilities/loadout';
import { buildPlayerConfig } from '../src/abilities/equipment';
import { SIM, type BalanceConfig } from '../src/config/balance';
import { getMatchBoard, MULTIPLAYER_VARIANTS } from '../src/multiplayer/boards';
import { CAMPAIGN_BOARDS } from '../src/levels/classic';
import type { BoardDefinition } from '../src/levels/schema';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

const SEEDS = Array.from({ length: 48 }, (_, i) => 1001 + i);
const LIMIT_TICKS = 6 * 60 * SIM.tickRate;

function clearTimes(board: BoardDefinition, config: BalanceConfig): { times: number[]; dnf: number } {
  const times: number[] = [];
  let dnf = 0;
  for (const seed of SEEDS) {
    const sim = new Simulation(board, { seed, config });
    const bot = createAutoplayer('win');
    while (!sim.isOver && sim.state.tick < LIMIT_TICKS) sim.step(bot(sim));
    if (sim.state.status === 'won') times.push(sim.state.elapsedTicks / SIM.tickRate);
    else dnf++;
  }
  return { times: times.sort((a, b) => a - b), dnf };
}

const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;

/** P(a < b) over independent samples, ties counted half; DNFs count as never finishing. */
function firstProbability(a: { times: number[]; dnf: number }, b: { times: number[]; dnf: number }): number {
  const ta = [...a.times, ...Array<number>(a.dnf).fill(Number.POSITIVE_INFINITY)];
  const tb = [...b.times, ...Array<number>(b.dnf).fill(Number.POSITIVE_INFINITY)];
  let wins = 0;
  for (const x of ta) for (const y of tb) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (ta.length * tb.length);
}

it('multiplayer board distributions and pairwise fairness', () => {
  const casual = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: { paddleControl: 0, paddleWidth: 0, ballPower: 0, magnetDuration: 0, startingEnergy: 0 } }, 'casual');
  const capped = buildPlayerConfig({ loadout: DEFAULT_LOADOUT, upgrades: { paddleControl: 5, paddleWidth: 5, ballPower: 3, magnetDuration: 3, startingEnergy: 4 } }, 'casualUpgrades');
  const ids = ['classic-02', 'classic-03', 'classic-05', 'classic-07', 'classic-08', 'classic-10', 'classic-11', ...MULTIPLAYER_VARIANTS.map((v) => v.id)];
  const results = new Map<string, { times: number[]; dnf: number }>();
  for (const id of ids) {
    const board = getMatchBoard(id) ?? CAMPAIGN_BOARDS.find((b) => b.id === id);
    if (!board) continue;
    const r = clearTimes(board, casual);
    results.set(id, r);
    const t = r.times;
    const mean = t.reduce((s, v) => s + v, 0) / Math.max(1, t.length);
    const sd = Math.sqrt(t.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, t.length - 1));
    const up = clearTimes(board, capped);
    console.log(
      `DIST ${id} n=${t.length}/${SEEDS.length} p10=${q(t, 0.1).toFixed(0)} q1=${q(t, 0.25).toFixed(0)} median=${q(t, 0.5).toFixed(0)}` +
        ` q3=${q(t, 0.75).toFixed(0)} p90=${q(t, 0.9).toFixed(0)} mean=${mean.toFixed(1)} sd=${sd.toFixed(1)} cv=${(sd / mean).toFixed(2)}` +
        ` iqr/med=${((q(t, 0.75) - q(t, 0.25)) / q(t, 0.5)).toFixed(2)} under120=${t.filter((v) => v <= 120).length}` +
        ` | cappedUpgrades median=${q(up.times, 0.5).toFixed(0)} (${((q(up.times, 0.5) / q(t, 0.5) - 1) * 100).toFixed(0)}%)`,
    );
    // Profile data (copy into SPECS in src/multiplayer/boards.ts).
    const deciles = Array.from({ length: 10 }, (_, k) => Math.round(q(t, 0.05 + 0.1 * k)));
    const withinTimer = (t.filter((v) => v <= 120).length / SEEDS.length).toFixed(2);
    console.log(`SPEC '${id}': stats [${Math.round(q(t, 0.5))}, ${Math.round(q(t, 0.25))}, ${Math.round(q(t, 0.75))}], deciles [${deciles.join(', ')}], withinTimer ${withinTimer}`);
  }
  const keys = [...results.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string;
      const b = keys[j] as string;
      const p = firstProbability(results.get(a) as { times: number[]; dnf: number }, results.get(b) as { times: number[]; dnf: number });
      console.log(`PAIR ${a} vs ${b} P(first)=${p.toFixed(2)}`);
    }
  }
});
