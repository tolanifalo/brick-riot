import type { Equipment, EquipmentMode, MatchResult, Seat, TickInput } from '@brick-riot/shared';

/** Everything needed to re-verify a match later. */
export interface MatchRecord {
  result: MatchResult;
  /** 'quick' = public matchmaking; 'private' = room code (Phase 3). Default 'private'. */
  mode?: 'private' | 'quick';
  /** Verified account behind each seat (null = guest). Set only from game tickets. */
  accounts?: Record<Seat, string | null>;
  /** Epoch ms when the match started (goAt). */
  startedAt?: number;
  seeds: Record<Seat, number>;
  /** Locked equipment: needed (with the mode) to rebuild each player's config for replay. */
  equipmentMode?: EquipmentMode;
  equipment?: Record<Seat, Equipment>;
  /** Applied (authoritative) input logs. */
  inputs: Record<Seat, readonly TickInput[]>;
  events: MatchLogEntry[];
}

export interface MatchLogEntry {
  at: number;
  tick: number;
  type: string;
  seat?: Seat;
  detail?: string;
}

/**
 * Persistence boundary for match results. Phase 3 ships an in-memory
 * implementation; Phase 5 adds PostgreSQL behind the same interface.
 * Results are immutable: saving an existing match id is refused.
 */
export interface MatchResultRepository {
  /**
   * Stores a finalised match (and, for persistent repositories, applies any
   * rewards and rating updates) atomically. A second save of the same match id
   * changes nothing and returns 'duplicate'.
   */
  save(record: MatchRecord): Promise<'saved' | 'duplicate'>;
  get(matchId: string): Promise<MatchRecord | null>;
  listRecent(limit: number): Promise<MatchResult[]>;
}

export class InMemoryMatchResultRepository implements MatchResultRepository {
  private readonly records = new Map<string, MatchRecord>();

  constructor(private readonly capacity = 1000) {}

  async save(record: MatchRecord): Promise<'saved' | 'duplicate'> {
    if (this.records.has(record.result.matchId)) return 'duplicate';
    this.records.set(record.result.matchId, structuredClone(record));
    if (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return 'saved';
  }

  async get(matchId: string): Promise<MatchRecord | null> {
    const r = this.records.get(matchId);
    return r ? structuredClone(r) : null;
  }

  async listRecent(limit: number): Promise<MatchResult[]> {
    return [...this.records.values()].slice(-limit).reverse().map((r) => structuredClone(r.result));
  }
}
