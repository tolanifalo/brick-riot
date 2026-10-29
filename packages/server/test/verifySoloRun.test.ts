import {
  CAMPAIGN_BOARDS,
  CLASSIC_01,
  createAutoplayer,
  SIM,
  Simulation,
  summarizeRun,
  type TickInput,
} from '@brick-riot/shared';
import { describe, expect, it } from 'vitest';
import { verifySoloRun } from '../src/verifySoloRun';

const boards = new Map([[CLASSIC_01.id, CLASSIC_01]]);

function recordRun(seed: number, ticks: number) {
  const sim = new Simulation(CLASSIC_01, { seed });
  const inputs: TickInput[] = [];
  for (let t = 0; t < ticks && !sim.isOver; t++) {
    const ball = sim.state.balls[0];
    const input = { targetX: ball ? ball.x + 12 : null, axis: 0, launch: sim.state.status === 'ready' };
    inputs.push(input);
    sim.step(input);
  }
  return { inputs, summary: summarizeRun(sim.state) };
}

describe('verifySoloRun', () => {
  const { inputs, summary } = recordRun(99, 15 * SIM.tickRate);
  const base = { boardId: CLASSIC_01.id, boardVersion: CLASSIC_01.version, seed: 99, inputs };

  it('accepts an honest submission', () => {
    const result = verifySoloRun({ ...base, claimed: summary }, boards);
    expect(result.ok).toBe(true);
  });

  it('rejects an inflated score', () => {
    const result = verifySoloRun({ ...base, claimed: { ...summary, score: summary.score + 1 } }, boards);
    expect(result).toMatchObject({ ok: false, reason: 'result-mismatch' });
  });

  it('rejects a claimed win the replay does not reproduce', () => {
    const result = verifySoloRun({ ...base, claimed: { ...summary, status: 'won' } }, boards);
    expect(result.ok).toBe(false);
  });

  it.each(['classic-08', 'classic-10', 'classic-12'])(
    'verifies complete runs on Phase 2 boards with power-ups and moving bricks (%s)',
    (boardId) => {
      const board = CAMPAIGN_BOARDS.find((b) => b.id === boardId);
      if (!board) throw new Error('missing board');
      const sim = new Simulation(board, { seed: 2024 });
      const bot = createAutoplayer('win');
      const inputs: TickInput[] = [];
      while (!sim.isOver && sim.state.tick < 15 * 60 * SIM.tickRate) {
        const input = bot(sim);
        inputs.push(input);
        sim.step(input);
      }
      expect(sim.state.status).toBe('won');
      expect(sim.state.powerUpsCollected).toBeGreaterThan(0);
      const all = new Map(CAMPAIGN_BOARDS.map((b) => [b.id, b]));
      const claimed = summarizeRun(sim.state);
      const ok = verifySoloRun({ boardId, boardVersion: board.version, seed: 2024, inputs, claimed }, all);
      expect(ok.ok).toBe(true);
      // Dropping a single input changes the outcome and is caught.
      const tampered = verifySoloRun(
        { boardId, boardVersion: board.version, seed: 2024, inputs: inputs.slice(0, -1), claimed },
        all,
      );
      expect(tampered.ok).toBe(false);
    },
  );

  it('rejects unknown boards and stale versions', () => {
    expect(verifySoloRun({ ...base, boardId: 'nope', claimed: summary }, boards)).toMatchObject({
      reason: 'unknown-board',
    });
    expect(verifySoloRun({ ...base, boardVersion: 0, claimed: summary }, boards)).toMatchObject({
      reason: 'version-mismatch',
    });
  });
});
