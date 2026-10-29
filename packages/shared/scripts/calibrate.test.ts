/**
 * Board calibration report: runs the scripted autoplayer on every campaign
 * board with several seeds and prints clear times and suggested par / star
 * thresholds. Not part of `npm test`; run with `npm run calibrate`.
 *
 * Suggestions: par = median, 2 stars = median x 1.15, 3 stars = lower quartile,
 * rounded up to 5 s. The bot never loses balls but aims worse than a skilled
 * human, so treat these as a starting point for human playtesting.
 */
import { it } from 'vitest';
import { SIM } from '../src/config/balance';
import { CAMPAIGN_BOARDS } from '../src/levels/classic';
import { Simulation } from '../src/sim/simulation';
import { createAutoplayer } from '../src/tools/autoplayer';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Multiplayer profile data: median and interquartile range over 16 seeds, for the
 * boards considered for multiplayer. Copy into MULTIPLAYER_BOARD_PROFILES.
 */
it('multiplayer completion statistics', () => {
  const candidates = ['classic-02', 'classic-03', 'classic-05', 'classic-07', 'classic-08', 'classic-10', 'classic-11'];
  for (const id of candidates) {
    const board = CAMPAIGN_BOARDS.find((b) => b.id === id);
    if (!board) continue;
    const times: number[] = [];
    for (let seed = 101; seed <= 116; seed++) {
      const sim = new Simulation(board, { seed });
      const bot = createAutoplayer('win');
      while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) sim.step(bot(sim));
      if (sim.state.status === 'won') times.push(sim.state.elapsedTicks / SIM.tickRate);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    console.log(`MP ${id} n=${times.length} median=${at(0.5).toFixed(0)} q1=${at(0.25).toFixed(0)} q3=${at(0.75).toFixed(0)}`);
  }
});

it('calibration report', () => {
  const c5 = (v: number) => Math.ceil(v / 5) * 5;
  for (const board of CAMPAIGN_BOARDS) {
    const runs: string[] = [];
    const times: number[] = [];
    for (const seed of SEEDS) {
      const sim = new Simulation(board, { seed });
      const bot = createAutoplayer('win');
      while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) sim.step(bot(sim));
      const secs = sim.state.elapsedTicks / SIM.tickRate;
      if (sim.state.status === 'won') times.push(secs);
      const s = sim.state;
      runs.push(`${s.status === 'won' ? secs.toFixed(0) + 's' : 'DNF'}/combo${s.bestCombo}/pu${s.powerUpsCollected}`);
    }
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)] ?? 0;
    const q1 = times[Math.floor(times.length / 4)] ?? 0;
    console.log(
      `${board.id} cleared ${times.length}/${SEEDS.length} median ${med.toFixed(0)}s` +
        ` -> suggest par ${c5(med)} two ${c5(med * 1.15)} three ${c5(q1)}` +
        ` (current par ${board.parTimeSeconds} two ${board.stars?.twoStarSeconds} three ${board.stars?.threeStarSeconds})\n  ${runs.join(' ')}`,
    );
  }
});
