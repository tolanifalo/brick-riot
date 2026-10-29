import { matchMaker, Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import {
  findQuickPairs,
  QUICK_POLICY,
  rateEquipment,
  QUEUE_ROOM_NAME,
  ROOM_NAME,
  type QueueMatchedMessage,
  type QueueStatusMessage,
  type QuickCandidate,
  type QuickPreferences,
  type Seat,
} from '@brick-riot/shared';
import { CASUAL_QUEUE, PRESEASON } from '../progression/provision';
import { getServices, type Services } from '../services';
import { QUICK_ROOM_SECRET, type JoinAuth, type QuickRoomOptions } from './MatchRoom';
import { loadSeatAccount, type SeatAccount } from './seatAccount';

export const QUEUE_ROOM = QUEUE_ROOM_NAME;

interface QueueJoinOptions {
  ticket?: unknown;
  preferences?: unknown;
}

interface QueueAuth extends JoinAuth {
  account: SeatAccount;
  candidate: Omit<QuickCandidate, 'enqueuedAt'>;
}

interface Entry {
  client: Client;
  account: SeatAccount;
  ip: string;
  candidate: QuickCandidate;
}

function parsePreferences(raw: unknown): QuickPreferences | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { boards, allowAlternatives } = raw as { boards?: unknown; allowAlternatives?: unknown };
  if (!Array.isArray(boards) || boards.length < 1 || boards.length > 3) return null;
  if (!boards.every((b): b is string => typeof b === 'string' && b.length <= 40)) return null;
  return { boards: [...new Set(boards)], allowAlternatives: allowAlternatives === true };
}

/**
 * Public casual matchmaking queue. Signed-in players only (game ticket).
 * Every second the queue is paired with the pure rules in
 * shared/competitive/quickmatch.ts. A pair gets a fresh Quick Match room with
 * seats reserved for exactly those two accounts. There are no bots and no fake
 * opponents: with nobody suitable the player simply keeps waiting (and can
 * cancel), until the queue timeout.
 */
export class QueueRoom extends Room {
  override maxClients = 2000;

  private services!: Services;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<string>();

  override onCreate(): void {
    this.services = getServices();
    this.patchRate = null;
    this.clock.setInterval(() => void this.pairQueue(), 1000);
    this.clock.setInterval(() => this.sendStatus(), 2000);
  }

  override async onAuth(_client: Client, options: QueueJoinOptions, context: AuthContext): Promise<QueueAuth> {
    if (!this.services.db) throw new ServerError(503, 'accounts_unavailable');
    const userId = this.services.tickets.redeem(options?.ticket);
    if (!userId) throw new ServerError(401, 'account_required');
    if ([...this.entries.values()].some((e) => e.account.userId === userId) || this.pending.has(userId)) {
      throw new ServerError(409, 'already_queued');
    }
    const preferences = parsePreferences(options?.preferences);
    if (!preferences) throw new ServerError(400, 'bad_preferences');
    const account = await loadSeatAccount(this.services, userId);
    if (!account) throw new ServerError(401, 'account_required');
    const rating = await this.services.db.rating.findUnique({
      where: { userId_queue_seasonId: { userId, queue: CASUAL_QUEUE, seasonId: PRESEASON } },
    });
    return {
      ip: context.ip ?? 'unknown',
      account,
      candidate: {
        id: userId,
        rating: rating?.rating ?? 1500,
        deviation: rating?.deviation ?? 350,
        gamesPlayed: rating?.gamesPlayed ?? 0,
        // Quick Match is loadout-only: Workshop upgrades never apply.
        equipment: rateEquipment({ loadout: account.loadout, upgrades: account.upgrades }, 'casual'),
        unlockedBoardIds: account.unlockedBoardIds,
        preferences,
      },
    };
  }

  override onJoin(client: Client, _options: QueueJoinOptions, auth: QueueAuth): void {
    this.entries.set(client.sessionId, {
      client,
      account: auth.account,
      ip: auth.ip,
      candidate: { ...auth.candidate, enqueuedAt: Date.now() },
    });
    this.sendStatus();
  }

  override onLeave(client: Client): void {
    this.entries.delete(client.sessionId);
  }

  private sendStatus(): void {
    const now = Date.now();
    for (const e of this.entries.values()) {
      const status: QueueStatusMessage = {
        waitedSeconds: Math.floor((now - e.candidate.enqueuedAt) / 1000),
        playersSearching: this.entries.size,
        timeoutSeconds: QUICK_POLICY.queueTimeoutSeconds,
      };
      e.client.send('queue', status);
    }
  }

  private async pairQueue(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, e] of this.entries) {
      if (now - e.candidate.enqueuedAt > QUICK_POLICY.queueTimeoutSeconds * 1000) {
        this.entries.delete(sessionId);
        e.client.send('timeout', { waitedSeconds: QUICK_POLICY.queueTimeoutSeconds });
        e.client.leave(4000);
      }
    }
    const bySession = new Map([...this.entries].map(([sid, e]) => [e.candidate.id, sid] as const));
    const pairs = findQuickPairs(
      [...this.entries.values()].map((e) => e.candidate),
      now,
    );
    for (const pair of pairs) {
      const sidA = bySession.get(pair.a.id);
      const sidB = bySession.get(pair.b.id);
      const a = sidA ? this.entries.get(sidA) : undefined;
      const b = sidB ? this.entries.get(sidB) : undefined;
      if (!a || !b || !sidA || !sidB) continue;
      this.entries.delete(sidA);
      this.entries.delete(sidB);
      this.pending.add(a.account.userId);
      this.pending.add(b.account.userId);
      try {
        await this.startMatch(a, b, pair.assignment);
      } catch (err) {
        // Room creation failed: put both back (keeping their place) and keep searching.
        console.error('[quickmatch] could not create a match room:', err instanceof Error ? err.message : 'unknown');
        if (this.clients.includes(a.client)) this.entries.set(sidA, a);
        if (this.clients.includes(b.client)) this.entries.set(sidB, b);
        a.client.send('retrying', {});
        b.client.send('retrying', {});
      } finally {
        this.pending.delete(a.account.userId);
        this.pending.delete(b.account.userId);
      }
    }
  }

  private async startMatch(a: Entry, b: Entry, assignment: NonNullable<ReturnType<typeof findQuickPairs>[number]['assignment']>): Promise<void> {
    const quick: QuickRoomOptions = {
      secret: QUICK_ROOM_SECRET,
      seats: {
        A: { userId: a.account.userId, boardId: assignment.boardA, note: assignment.noteA },
        B: { userId: b.account.userId, boardId: assignment.boardB, note: assignment.noteB },
      },
      readySeconds: this.services.config.quickReadySeconds,
    };
    const room = await matchMaker.createRoom(ROOM_NAME, { quick });
    const reserve = (e: Entry) =>
      matchMaker.reserveSeatFor(room, { loadout: e.account.loadout }, { ip: e.ip, account: e.account } satisfies JoinAuth);
    const [resA, resB] = await Promise.all([reserve(a), reserve(b)]);
    const tell = (e: Entry, seat: Seat, reservation: unknown, mine: string, theirs: string, opponent: Entry, note: string) => {
      const msg: QueueMatchedMessage = {
        reservation,
        seat,
        myBoardId: mine,
        opponentBoardId: theirs,
        opponentName: opponent.account.name,
        note,
        readySeconds: this.services.config.quickReadySeconds,
      };
      e.client.send('matched', msg);
    };
    tell(a, 'A', resA, assignment.boardA, assignment.boardB, b, assignment.noteA);
    tell(b, 'B', resB, assignment.boardB, assignment.boardA, a, assignment.noteB);
  }
}
