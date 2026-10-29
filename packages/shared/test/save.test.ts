import { describe, expect, it } from 'vitest';
import {
  createEmptyProgress,
  parseSave,
  SAVE_FORMAT,
  SAVE_VERSION,
  serializeProgress,
  type MigrationRegistry,
} from '../src/progress/save';
import type { PlayerProgress } from '../src/progress/types';

const NOW = '2026-10-24T12:00:00.000Z';

function sample(): PlayerProgress {
  const p = createEmptyProgress(NOW);
  p.xp = 1234;
  p.coins = 56;
  p.boards['classic-01'] = {
    boardId: 'classic-01',
    attempts: 4,
    completions: 2,
    bestScore: 9000,
    bestTimeMs: 81_500,
    bestStars: 2,
    mastery: ['classic-01-clear'],
    firstClearedAt: NOW,
    lastPlayedAt: NOW,
  };
  return p;
}

const envelope = (version: number, data: unknown) => JSON.stringify({ format: SAVE_FORMAT, version, savedAt: NOW, data });

describe('save round trip', () => {
  it('restores exactly what was saved', () => {
    const progress = sample();
    const result = parseSave(serializeProgress(progress, NOW), { now: NOW });
    expect(result).toEqual({ kind: 'ok', progress, migratedFrom: null, repairs: [] });
  });

  it('reports an empty slot', () => {
    expect(parseSave(null).kind).toBe('empty');
    expect(parseSave('').kind).toBe('empty');
  });
});

describe('corrupted saves', () => {
  it.each([
    ['truncated JSON', '{"format":"brick-riot-save","vers'],
    ['not an object', '42'],
    ['wrong format tag', JSON.stringify({ format: 'other', version: 1, data: {} })],
    ['bad version', JSON.stringify({ format: SAVE_FORMAT, version: 'one', data: {} })],
    ['data not an object', envelope(SAVE_VERSION, [1, 2, 3])],
  ])('rejects %s without throwing', (_label, raw) => {
    expect(parseSave(raw).kind).toBe('corrupt');
  });

  it('repairs invalid fields instead of discarding the save', () => {
    const raw = envelope(SAVE_VERSION, {
      xp: -50,
      coins: 'lots',
      boards: {
        'classic-01': { attempts: 1, completions: 3, bestScore: 1e15, bestTimeMs: -4, bestStars: 7, mastery: ['a', 'a', 5] },
        'classic-02': 'garbage',
        'classic-03': { completions: 0, bestStars: 3, bestTimeMs: 1000 },
      },
      history: [{ runId: 'r1', boardId: 'classic-01', outcome: 'won', score: 10 }, { nonsense: true }],
      appliedRunIds: ['r1', 7],
    });
    const result = parseSave(raw, { now: NOW });
    if (result.kind !== 'ok') throw new Error(result.kind);
    const p = result.progress;
    expect(p.xp).toBe(0);
    expect(p.coins).toBe(0);
    expect(p.boards['classic-01']).toMatchObject({
      attempts: 3,
      completions: 3,
      bestScore: 100_000_000,
      bestTimeMs: null,
      bestStars: 0,
      mastery: ['a'],
    });
    expect(p.boards['classic-02']).toBeUndefined();
    // Stars or times without a completion are impossible, so they are cleared.
    expect(p.boards['classic-03']).toMatchObject({ bestStars: 0, bestTimeMs: null });
    expect(p.history).toHaveLength(1);
    expect(p.appliedRunIds).toEqual(['r1']);
    expect(result.repairs.length).toBeGreaterThan(0);
  });
});

describe('migrations', () => {
  // Synthetic history used to exercise the migration chain: version 0 stored a
  // flat map of best scores, version 1 renamed "exp" to "xp".
  const registry: MigrationRegistry = {
    0: (data) => {
      const d = data as { exp: number; bestScores: Record<string, number> };
      const boards = Object.fromEntries(
        Object.entries(d.bestScores).map(([id, score]) => [id, { boardId: id, completions: 1, attempts: 1, bestScore: score }]),
      );
      return { exp: d.exp, boards };
    },
    1: (data) => {
      const { exp, ...rest } = data as { exp: number };
      return { ...rest, xp: exp };
    },
  };

  it('upgrades through every intermediate version', () => {
    const raw = envelope(0, { exp: 900, bestScores: { 'classic-01': 4200 } });
    const result = parseSave(raw, { currentVersion: 2, migrations: registry, now: NOW });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.migratedFrom).toBe(0);
    expect(result.progress.version).toBe(2);
    expect(result.progress.xp).toBe(900);
    expect(result.progress.boards['classic-01']?.bestScore).toBe(4200);
  });

  it('starts from the matching step for newer saves', () => {
    const raw = envelope(1, { exp: 5, boards: {} });
    const result = parseSave(raw, { currentVersion: 2, migrations: registry, now: NOW });
    expect(result.kind === 'ok' && result.progress.xp).toBe(5);
  });

  it('flags a missing migration step as corrupt', () => {
    const result = parseSave(envelope(0, {}), { currentVersion: 2, migrations: { 1: (d: unknown) => d }, now: NOW });
    expect(result).toMatchObject({ kind: 'corrupt' });
  });

  it('flags a throwing migration as corrupt', () => {
    const result = parseSave(envelope(0, null), { currentVersion: 1, migrations: { 0: () => { throw new Error('boom'); } } });
    expect(result).toMatchObject({ kind: 'corrupt' });
  });

  it('refuses saves from a newer game version', () => {
    expect(parseSave(envelope(SAVE_VERSION + 1, {}))).toEqual({ kind: 'unsupported', version: SAVE_VERSION + 1 });
  });
});
