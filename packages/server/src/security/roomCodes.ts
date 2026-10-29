import { randomInt } from 'node:crypto';

/** 32 unambiguous characters (no 0/O, 1/I). 6 characters ≈ 1.07 billion codes. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export type CodeLookup =
  | { status: 'ok'; roomId: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'full' }
  | { status: 'in_progress' };

export interface RoomCodeEntry {
  roomId: string;
  /** Live room status, queried at lookup time. */
  status(): 'joinable' | 'full' | 'in_progress';
}

/**
 * Maps public join codes to internal room ids. Codes come from a CSPRNG and
 * are not derived from room ids or session secrets. Released codes are kept
 * as tombstones for a while so players get "expired" rather than "invalid".
 */
export class RoomCodeRegistry {
  private readonly active = new Map<string, RoomCodeEntry>();
  private readonly tombstones = new Map<string, number>();

  constructor(private readonly tombstoneMs = 30 * 60 * 1000) {}

  generate(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
      if (!this.active.has(code) && !this.tombstones.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  register(code: string, entry: RoomCodeEntry): void {
    this.active.set(code, entry);
    this.tombstones.delete(code);
  }

  release(code: string, now = Date.now()): void {
    if (this.active.delete(code)) this.tombstones.set(code, now);
    for (const [c, at] of this.tombstones) if (now - at > this.tombstoneMs) this.tombstones.delete(c);
  }

  static normalize(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const code = raw.trim().toUpperCase();
    if (code.length !== CODE_LENGTH) return null;
    for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
    return code;
  }

  lookup(raw: unknown): CodeLookup {
    const code = RoomCodeRegistry.normalize(raw);
    if (!code) return { status: 'invalid' };
    const entry = this.active.get(code);
    if (!entry) return this.tombstones.has(code) ? { status: 'expired' } : { status: 'invalid' };
    const status = entry.status();
    if (status === 'full') return { status: 'full' };
    if (status === 'in_progress') return { status: 'in_progress' };
    return { status: 'ok', roomId: entry.roomId };
  }

  get size(): number {
    return this.active.size;
  }
}
