import { randomBytes } from 'node:crypto';

/**
 * Short-lived, single-use game tickets. A signed-in browser asks the HTTP API
 * (cookie session) for a ticket and passes it in its room join options; the
 * room redeems it to learn the verified account id. Tickets are random
 * 256-bit values held in server memory (one game-server process), so the
 * WebSocket join never depends on cookies and cannot be forged.
 */
export class GameTickets {
  private readonly tickets = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(userId: string): { ticket: string; expiresInSeconds: number } {
    this.prune();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { userId, expiresAt: this.now() + this.ttlMs });
    return { ticket, expiresInSeconds: Math.floor(this.ttlMs / 1000) };
  }

  /** Returns the account id once; a ticket can never be reused. */
  redeem(ticket: unknown): string | null {
    if (typeof ticket !== 'string' || ticket.length > 100) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    return entry.expiresAt >= this.now() ? entry.userId : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [t, e] of this.tickets) if (e.expiresAt < now) this.tickets.delete(t);
  }
}
