import type { GameTicketResponse, LobbyView, MatchResult, MatchStartInfo, ProfileView } from '@brick-riot/shared';
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueueMatchedMessage } from '@brick-riot/shared';
import { QUEUE_ROOM } from '../src/rooms/QueueRoom';
import { keepPlaying, Probe, sleep } from './net';
import { register, startAccountServer, type AccountServer, type Browser } from './support/accounts';

/** Public casual matchmaking with real accounts, sockets and PostgreSQL. */
let t: AccountServer;

beforeAll(async () => {
  t = await startAccountServer({ matchSeconds: 10, quickReadySeconds: 2, testStartEnergy: 100 });
});

afterAll(async () => {
  await t.close();
});

async function player(name: string): Promise<{ browser: Browser; id: string }> {
  const { browser } = await register(t.url, name);
  const id = ((await browser.get('/api/me')).body as ProfileView).account.id;
  for (const boardId of ['classic-02', 'classic-03', 'classic-05', 'classic-07', 'classic-08', 'classic-10']) {
    await t.database.db.boardUnlock.create({ data: { userId: id, boardId, boardVersion: 1, source: 'progression' } });
  }
  return { browser, id };
}

async function ticket(browser: Browser): Promise<string> {
  return ((await browser.post('/api/game/ticket', {})).body as GameTicketResponse).ticket;
}

async function queue(browser: Browser, boards: string[], allowAlternatives = false): Promise<Probe> {
  return new Probe(await new Client(t.url).joinOrCreate(QUEUE_ROOM, { ticket: await ticket(browser), preferences: { boards, allowAlternatives } }));
}

describe('Quick Match', { timeout: 45_000 }, () => {
  it('requires an account; one queue entry per account', async () => {
    await expect(new Client(t.url).joinOrCreate(QUEUE_ROOM, { preferences: { boards: ['classic-05'] } })).rejects.toThrow(/account_required/);
    const { browser } = await player('Solo');
    const q = await queue(browser, ['classic-05']);
    await expect(queue(browser, ['classic-05'])).rejects.toThrow(/already_queued/);
    await expect(new Client(t.url).joinOrCreate(QUEUE_ROOM, { ticket: await ticket(browser), preferences: { boards: [] } })).rejects.toThrow();
    await q.room.leave();
  });

  it('pairs two real players on DIFFERENT compatible boards; the finished match is persisted and rewarded', async () => {
    const a = await player('QuickA');
    const b = await player('QuickB');
    const qa = await queue(a.browser, ['classic-05']);
    const status = await qa.wait<{ playersSearching: number }>('queue');
    expect(status.playersSearching).toBeGreaterThanOrEqual(1);
    const qb = await queue(b.browser, ['classic-08']);
    const [ma, mb] = await Promise.all([qa.wait<QueueMatchedMessage>('matched'), qb.wait<QueueMatchedMessage>('matched')]);
    expect([ma.myBoardId, mb.myBoardId].sort()).toEqual(['classic-05', 'classic-08']);
    expect(ma.opponentName).toBe(mb.seat === 'A' ? 'QuickB' : 'QuickB');
    expect(ma.note).toBe('Your 1st choice.');

    // A third account cannot take a reserved seat by knowing the room id (even with a valid ticket).
    const intruder = await player('Intruder');
    const roomId = (ma.reservation as { roomId?: string; room?: { roomId?: string } }).roomId ?? (ma.reservation as { room?: { roomId?: string } }).room?.roomId ?? '';
    await expect(new Client(t.url).joinById(roomId, { ticket: await ticket(intruder.browser), profileId: 'intruder-profile-1' })).rejects.toThrow(/reserved_room|is locked/);

    const ra = new Probe(await new Client(t.url).consumeSeatReservation(ma.reservation as never));
    const rb = new Probe(await new Client(t.url).consumeSeatReservation(mb.reservation as never));
    await qa.room.leave();
    await qb.room.leave();
    const lobby = await ra.wait<LobbyView>('lobby', (l) => l.players.length === 2);
    expect(lobby.matchmaking?.notes).toBeDefined();
    expect(lobby.players.map((p) => p.name).sort()).toEqual(['QuickA', 'QuickB']);
    expect(lobby.players.every((p) => p.boardId !== null)).toBe(true);
    expect(lobby.compatibility?.compatible).toBe(true);
    // Boards are assigned by matchmaking (transparently) and cannot be swapped.
    ra.send('selectBoard', { boardId: 'classic-03' });
    expect(await ra.wait('rejected', (r: { type: string }) => r.type === 'selectBoard')).toMatchObject({ reason: 'assigned_by_matchmaking' });

    ra.send('setReady', { ready: true });
    rb.send('setReady', { ready: true });
    const [sa, sb] = await Promise.all([ra.wait<MatchStartInfo>('matchStart'), rb.wait<MatchStartInfo>('matchStart')]);
    void keepPlaying(ra, sa, 20_000, () => ra.all('result').length > 0);
    void keepPlaying(rb, sb, 20_000, () => rb.all('result').length > 0);
    const result = await ra.wait<MatchResult>('result', () => true, 25_000);
    expect(result.verification.replayVerified).toBe(true);
    await sleep(600);

    const row = await t.database.db.match.findUniqueOrThrow({ where: { id: result.matchId }, include: { participants: true } });
    expect(row.mode).toBe('quick');
    expect(row.participants.map((p) => p.boardId).sort()).toEqual(['classic-05', 'classic-08']);
    // Both players were rewarded exactly once (nobody forfeited), with ledger entries.
    for (const id of [a.id, b.id]) {
      expect(await t.database.db.ledgerEntry.count({ where: { userId: id, type: 'match_reward', currency: 'xp' } })).toBe(1);
      const rating = await t.database.db.rating.findFirstOrThrow({ where: { userId: id, queue: 'casual' } });
      expect(rating.gamesPlayed).toBe(1);
      // Ranked ratings are never written: ranked is disabled.
      expect(await t.database.db.rating.count({ where: { userId: id, queue: 'ranked' } })).toBe(0);
    }
    if (result.winnerSeat) {
      const winnerId = row.participants.find((p) => p.seat === result.winnerSeat)?.userId ?? '';
      expect(await t.database.db.leaderboardEntry.findFirst({ where: { category: 'casual_wins', userId: winnerId } })).toMatchObject({ value: 1 });
    }
    // Saving the same match again pays nothing more.
    const record = await t.server.services.results.get(result.matchId);
    if (record) expect(await t.server.services.results.save(record)).toBe('duplicate');
    expect(await t.database.db.ledgerEntry.count({ where: { userId: a.id, type: 'match_reward' } })).toBe(2);
    await Promise.all([ra.room.leave(), rb.room.leave()]);
  });

  it('calls the match off when a player does not confirm in time, telling everyone who', async () => {
    const a = await player('ReadyA');
    const b = await player('IdleB');
    const qa = await queue(a.browser, ['classic-05']);
    const qb = await queue(b.browser, ['classic-08']);
    const [ma, mb] = await Promise.all([qa.wait<QueueMatchedMessage>('matched'), qb.wait<QueueMatchedMessage>('matched')]);
    const ra = new Probe(await new Client(t.url).consumeSeatReservation(ma.reservation as never));
    const rb = new Probe(await new Client(t.url).consumeSeatReservation(mb.reservation as never));
    await Promise.all([qa.room.leave(), qb.room.leave()]);
    await ra.wait<LobbyView>('lobby', (l) => l.players.length === 2);
    ra.send('setReady', { ready: true });
    const closed = await ra.wait<{ reason: string; seats: string[] }>('closed', () => true, 8000);
    expect(closed.reason).toBe('ready_timeout');
    expect(closed.seats).toEqual([mb.seat]);
    await Promise.all([ra.room.leave().catch(() => undefined), rb.room.leave().catch(() => undefined)]);
  });

  it('never pairs incompatible preferences; an allowed alternative is suggested and explained', async () => {
    const a = await player('Chevron');
    const b = await player('Gate');
    const qa = await queue(a.browser, ['classic-03']);
    const qb = await queue(b.browser, ['classic-10']);
    await sleep(2500);
    expect(qa.all('matched')).toHaveLength(0);
    await qb.room.leave();
    // B comes back allowing alternatives: matched, with an explanation.
    const qb2 = await queue(b.browser, ['classic-10'], true);
    const mb = await qb2.wait<QueueMatchedMessage>('matched', () => true, 8000);
    expect(mb.note).toMatch(/Suggested alternative/);
    expect(mb.opponentBoardId).toBe('classic-03');
    await Promise.all([qa.room.leave().catch(() => undefined), qb2.room.leave().catch(() => undefined)]);
  });

  it('a cancelled search leaves the queue; nobody is matched with an absent player', async () => {
    const a = await player('Leaver');
    const b = await player('Stayer');
    const qa = await queue(a.browser, ['classic-05']);
    await qa.room.leave();
    const qb = await queue(b.browser, ['classic-08']);
    await sleep(2500);
    expect(qb.all('matched')).toHaveLength(0);
    await qb.room.leave();
  });
});
