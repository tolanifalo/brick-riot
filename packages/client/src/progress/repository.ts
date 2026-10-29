import {
  createEmptyProgress,
  parseSave,
  serializeProgress,
  type ParseResult,
  type PlayerProgress,
} from '@brick-riot/shared';

export type LoadSource = 'fresh' | 'saved' | 'migrated' | 'backup' | 'reset';

export interface LoadOutcome {
  progress: PlayerProgress;
  source: LoadSource;
  /** Player-facing message when something unusual happened; null otherwise. */
  notice: string | null;
}

/**
 * Persistence boundary for player progress. Phase 2 stores locally; Phase 5
 * adds a server-backed implementation of the same interface.
 */
export interface ProgressRepository {
  load(): Promise<LoadOutcome>;
  save(progress: PlayerProgress): Promise<void>;
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const SAVE_KEYS = {
  main: 'brick-riot:save',
  backup: 'brick-riot:save:backup',
  quarantine: 'brick-riot:save:quarantine',
} as const;

export class LocalStorageProgressRepository implements ProgressRepository {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(): Promise<LoadOutcome> {
    const now = this.now();
    const mainRaw = this.read(SAVE_KEYS.main);
    const main = parseSave(mainRaw, { now });
    if (main.kind === 'ok') return fromParsed(main, 'saved');

    if (main.kind === 'corrupt' || main.kind === 'unsupported') {
      // Keep the unreadable save for manual recovery instead of destroying it.
      if (mainRaw) this.write(SAVE_KEYS.quarantine, mainRaw);
    }

    const backup = parseSave(this.read(SAVE_KEYS.backup), { now });
    if (backup.kind === 'ok') {
      return {
        progress: backup.progress,
        source: 'backup',
        notice:
          main.kind === 'empty'
            ? 'Your save was missing, so the most recent backup was restored.'
            : 'Your save was damaged, so the most recent backup was restored.',
      };
    }

    if (main.kind === 'empty') return { progress: createEmptyProgress(now), source: 'fresh', notice: null };
    return {
      progress: createEmptyProgress(now),
      source: 'reset',
      notice:
        main.kind === 'unsupported'
          ? 'This save comes from a newer version of the game. Starting fresh; the original was kept.'
          : 'Your save could not be read and progress was reset. A copy of the damaged save was kept.',
    };
  }

  async save(progress: PlayerProgress): Promise<void> {
    const now = this.now();
    const previous = this.read(SAVE_KEYS.main);
    if (previous && parseSave(previous, { now }).kind === 'ok') {
      this.storage.setItem(SAVE_KEYS.backup, previous);
    }
    this.storage.setItem(SAVE_KEYS.main, serializeProgress({ ...progress, updatedAt: now }, now));
  }

  private read(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // Storage full or blocked: nothing more we can do for a diagnostic copy.
    }
  }
}

function fromParsed(result: Extract<ParseResult, { kind: 'ok' }>, source: LoadSource): LoadOutcome {
  if (result.migratedFrom !== null) {
    return { progress: result.progress, source: 'migrated', notice: null };
  }
  return {
    progress: result.progress,
    source,
    notice: result.repairs.length > 0 ? 'Some save data was invalid and has been repaired.' : null,
  };
}

/** Used when localStorage is unavailable (e.g. blocked in private mode) and in tests. */
export class InMemoryProgressRepository implements ProgressRepository {
  private stored: PlayerProgress | null = null;

  async load(): Promise<LoadOutcome> {
    return this.stored
      ? { progress: structuredClone(this.stored), source: 'saved', notice: null }
      : { progress: createEmptyProgress(new Date().toISOString()), source: 'fresh', notice: null };
  }

  async save(progress: PlayerProgress): Promise<void> {
    this.stored = structuredClone(progress);
  }
}

export function createDefaultRepository(): { repository: ProgressRepository; persistent: boolean } {
  try {
    const probe = '__brick-riot-probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return { repository: new LocalStorageProgressRepository(window.localStorage), persistent: true };
  } catch {
    return { repository: new InMemoryProgressRepository(), persistent: false };
  }
}
