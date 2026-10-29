/**
 * Endless-level calibration report (not part of `npm test`):
 * `npm run calibrate:endless -w @brick-riot/shared`.
 *
 * Plays a sample of generated levels with the autoplayer and prints, per
 * level, the work it needs (hit points, steel, lanes), the bot's median clear
 * time and the generator's estimate, plus a least-squares fit of
 * time ~ base + perHp*hp + perSteel*steel + perLane*lanes. Use it to refit
 * ESTIMATE in levels/endless.ts (and bump ENDLESS_GENERATOR_VERSION).
 */
import { it } from 'vitest';
import { SIM } from '../src/config/balance';
import { ESTIMATE, generateLevel, levelTag } from '../src/levels/endless';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

const LEVELS = [13, 14, 15, 16, 17, 18, 19, 20, 21, 25, 26, 30, 33, 37, 40, 41, 45, 50, 55, 60, 70, 75, 80, 90, 100, 120, 150, 200, 250, 300];
const SEEDS = [1, 2, 3, 4, 5];

it('endless calibration report', () => {
  const rows: { n: number; hp: number; steel: number; lanes: number; median: number }[] = [];
  for (const n of LEVELS) {
    const board = generateLevel(n);
    const sim0 = new Simulation(board);
    const hp = sim0.state.bricks.filter((b) => b.required).reduce((s, b) => s + b.hp, 0);
    const steel = sim0.state.bricks.filter((b) => b.type === 'indestructible' && b.moveRange === 0).length;
    const lanes = new Set(sim0.state.bricks.filter((b) => b.moveRange > 0).map((b) => b.row)).size;
    const times: number[] = [];
    let losses = 0;
    for (const seed of SEEDS) {
      const sim = new Simulation(board, { seed });
      const bot = createAutoplayer('win');
      while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) sim.step(bot(sim));
      if (sim.state.status === 'won') times.push(sim.state.elapsedTicks / SIM.tickRate);
      else losses++;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? NaN;
    rows.push({ n, hp, steel, lanes, median });
    console.log(
      `L${n} ${levelTag(n).padEnd(8)} rating ${board.difficulty.designerRating} hp ${hp} steel ${steel} lanes ${lanes}` +
        ` | bot median ${median.toFixed(0)}s (${times.length}/${SEEDS.length} won, ${losses} lost)` +
        ` times ${times.map((t) => t.toFixed(0)).join(',')} | par ${board.parTimeSeconds} 3* ${board.stars?.threeStarSeconds}` +
        ` powerDown ${board.powerDownChance} "${board.name}"\n   ${board.layout.join('|')}`,
    );
  }
  // Least squares (normal equations, 4 unknowns) over levels the bot cleared.
  const data = rows.filter((r) => Number.isFinite(r.median));
  const X = data.map((r) => [1, r.hp, r.steel, r.lanes]);
  const y = data.map((r) => r.median);
  const k = 4;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, x) => s + (x[i] ?? 0) * (x[j] ?? 0), 0)));
  const b = Array.from({ length: k }, (_, i) => X.reduce((s, x, row) => s + (x[i] ?? 0) * (y[row] ?? 0), 0));
  // Gaussian elimination.
  for (let i = 0; i < k; i++) {
    const rowI = A[i] ?? [];
    const pivot = rowI[i] || 1e-9;
    for (let j = i + 1; j < k; j++) {
      const rowJ = A[j] ?? [];
      const f = (rowJ[i] ?? 0) / pivot;
      for (let c = i; c < k; c++) rowJ[c] = (rowJ[c] ?? 0) - f * (rowI[c] ?? 0);
      b[j] = (b[j] ?? 0) - f * (b[i] ?? 0);
    }
  }
  const coef = new Array<number>(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    const rowI = A[i] ?? [];
    let s = b[i] ?? 0;
    for (let c = i + 1; c < k; c++) s -= (rowI[c] ?? 0) * (coef[c] ?? 0);
    coef[i] = s / (rowI[i] || 1e-9);
  }
  console.log(`FIT base ${coef[0]?.toFixed(2)} perHp ${coef[1]?.toFixed(3)} perSteel ${coef[2]?.toFixed(2)} perLane ${coef[3]?.toFixed(2)}`);
  console.log(`CURRENT ${JSON.stringify(ESTIMATE)}`);
}, 900_000);
