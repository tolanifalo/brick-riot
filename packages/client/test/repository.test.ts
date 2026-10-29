import { createEmptyProgress, SAVE_FORMAT } from '@brick-riot/shared';
import { describe, expect, it } from 'vitest';
import { LocalStorageProgressRepository, SAVE_KEYS, type KeyValueStorage } from '../src/progress/repository';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const NOW = '2026-10-24T12:00:00.000Z';

function progressWithXp(xp: number) {
  const p = createEmptyProgress(NOW);
  p.xp = xp;
  return p;
}

describe('LocalStorageProgressRepository', () => {
  it('starts fresh with no save', async () => {
    const repo = new LocalStorageProgressRepository(new MemoryStorage(), () => NOW);
    const out = await repo.load();
    expect(out.source).toBe('fresh');
    expect(out.notice).toBeNull();
    expect(out.progress.xp).toBe(0);
  });

  it('persists across repository instances (browser restart)', async () => {
    const storage = new MemoryStorage();
    await new LocalStorageProgressRepository(storage, () => NOW).save(progressWithXp(777));
    const out = await new LocalStorageProgressRepository(storage, () => NOW).load();
    expect(out.source).toBe('saved');
    expect(out.progress.xp).toBe(777);
  });

  it('keeps the previous good save as a backup', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageProgressRepository(storage, () => NOW);
    await repo.save(progressWithXp(1));
    await repo.save(progressWithXp(2));
    expect(storage.getItem(SAVE_KEYS.backup)).toContain('"xp":1');
    expect(storage.getItem(SAVE_KEYS.main)).toContain('"xp":2');
  });

  it('restores the backup when the main save is corrupted, and quarantines the damage', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageProgressRepository(storage, () => NOW);
    await repo.save(progressWithXp(10));
    await repo.save(progressWithXp(20));
    storage.setItem(SAVE_KEYS.main, '{"format":"brick-riot-sa');
    const out = await repo.load();
    expect(out.source).toBe('backup');
    expect(out.progress.xp).toBe(10);
    expect(out.notice).toMatch(/damaged/);
    expect(storage.getItem(SAVE_KEYS.quarantine)).toBe('{"format":"brick-riot-sa');
  });

  it('resets safely when both copies are unreadable', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SAVE_KEYS.main, 'not json');
    storage.setItem(SAVE_KEYS.backup, '[]');
    const out = await new LocalStorageProgressRepository(storage, () => NOW).load();
    expect(out.source).toBe('reset');
    expect(out.progress.xp).toBe(0);
    expect(out.notice).toMatch(/reset/);
  });

  it('never overwrites the backup with a corrupted main save', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalStorageProgressRepository(storage, () => NOW);
    await repo.save(progressWithXp(5));
    await repo.save(progressWithXp(6));
    storage.setItem(SAVE_KEYS.main, 'garbage');
    await repo.save(progressWithXp(7));
    expect(storage.getItem(SAVE_KEYS.backup)).toContain('"xp":5');
  });

  it('preserves saves from a newer game version', async () => {
    const storage = new MemoryStorage();
    const future = JSON.stringify({ format: SAVE_FORMAT, version: 99, savedAt: NOW, data: {} });
    storage.setItem(SAVE_KEYS.main, future);
    const out = await new LocalStorageProgressRepository(storage, () => NOW).load();
    expect(out.source).toBe('reset');
    expect(storage.getItem(SAVE_KEYS.quarantine)).toBe(future);
  });

  it('survives storage that throws on read', async () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const out = await new LocalStorageProgressRepository(throwing, () => NOW).load();
    expect(out.source).toBe('fresh');
  });
});
