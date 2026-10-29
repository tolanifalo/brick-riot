import type { GameTicketResponse, LobbyView, MatchHistoryEntry, MatchResult, MatchStartInfo, Page, ProfileView } from '@brick-riot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort } from '../src/db/embedded';
import { createRoom, joinByCode, keepPlaying, sleep, startServer, type Probe } from './net';
import { ORIGIN, register, type Browser } from './support/accounts';
import { createTestDatabase, type TestDatabase } from './support/testDb';

/**
 * Signed-in multiplayer over real sockets with PostgreSQL persistence.
 * One database for the file; servers come and go (restart test).
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

async function server(overrides = {}) {
  const port = await freePort();
  return startServer({ port, databaseUrl: database.url, publicUrl: `http://127.0.0.1:${port}`, appUrl: ORIGIN, matchSeconds: 10, ...overrides });
}

async function ticket(browser: Browser): Promise<string> {
  const res = await browser.post('/api/game/ticket', {});
  expect(res.status).toBe(200);
  return (res.body as GameTicketResponse).ticket;
}

async function unlockAll(userId: string) {
  for (const boardId of ['classic-02', 'classic-03', 'classic-05', 'classic-07', 'classic-08', 'classic-10']) {
    await database.db.boardUnlock.upsert({
      where: { userId_boardId: { userId, boardId } },
      create: { userId, boardId, boardVersion: 1, source: 'progression' },
      update: {},
    });
  }
}

async function me(browser: Browser): Promise<ProfileView> {
  return (await browser.get('/api/me')).body as ProfileView;
}

const lobby = (p: Probe, pred: (l: LobbyView) => boolean = () => true) => p.wait<LobbyView>('lobby', pred);

describe('signed-in private rooms', { timeout: 30_000 }, () => {
  it('uses the verified account name, unlocks and equipment; claims are ignored; forged tickets are refused', async () => {
    const s = await server();
    try {
      const { browser: alice } = await register(s.url, 'Alice');
      const { browser: bob } = await register(s.url, 'Bob');
      const aliceId = (await me(alice)).account.id;
      // Bob has real (server-recorded) upgrades; Alice has none.
      const bobId = (await me(bob)).account.id;
      for (const [upgradeId, level] of [['paddleWidth', 5], ['paddleControl', 5], ['ballPower', 3]] as const) {
        await database.db.upgradeLevel.create({ data: { userId: bobId, upgradeId, level } });
      }

      // Forged and reused tickets.
      await expect(createRoom(s.url, { ticket: 'forged-ticket' })).rejects.toThrow(/invalid_ticket/);
      const t1 = await ticket(alice);
      const host = await createRoom(s.url, { ticket: t1, name: 'NotAlice', clearedBoardIds: ['classic-04', 'classic-07'], xp: 9_999_999, loadout: { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' } });
      await expect(createRoom(s.url, { ticket: t1 })).rejects.toThrow(/invalid_ticket/);
      const { roomCode } = await host.wait<{ roomCode: string }>('welcome');
      const guest = await joinByCode(s.url, roomCode, { ticket: await ticket(bob) });
      const l = await lobby(host, (v) => v.players.length === 2);
      expect(l.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
      // Alice claimed frost (not owned at level 1): she gets her server loadout instead.
      expect(l.players[0]?.loadout.offensive).toBe('emp');

      // Claimed cleared boards mean nothing for an account: only server unlocks count.
      host.send('selectBoard', { boardId: 'classic-07' });
      expect(await host.wait('rejected', (r: { type: string }) => r.type === 'selectBoard')).toMatchObject({ reason: 'locked' });
      host.send('setLoadout', { loadout: { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' } });
      expect(await host.waitNext('rejected', (r: { type: string }) => r.type === 'setLoadout')).toMatchObject({ reason: 'locked' });

      // Upgrades on: Bob's VERIFIED upgrades make the race uneven and require acceptance.
      host.send('setEquipmentMode', { mode: 'casualUpgrades' });
      const up = await lobby(guest, (v) => v.equipmentMode === 'casualUpgrades');
      expect((up.players[1]?.equipment.power ?? 0) - (up.players[0]?.equipment.power ?? 0)).toBeGreaterThan(15);
      expect(up.equipmentCompatibility?.even).toBe(false);
      expect(up.needsUnrankedAcceptance).toBe(true);
      void aliceId;
      await Promise.all([host.room.leave(), guest.room.leave()]);
    } finally {
      await s.close();
    }
  });

  it('persists the finished match to PostgreSQL; history survives a server restart; details are participant-only', async () => {
    let s = await server({ testStartEnergy: 100 });
    const { browser: alice } = await register(s.url, 'Alpha');
    const { browser: bob } = await register(s.url, 'Bravo');
    const { browser: eve } = await register(s.url, 'Eve');
    const aliceId = (await me(alice)).account.id;
    const bobId = (await me(bob)).account.id;
    await unlockAll(aliceId);
    await unlockAll(bobId);

    const host = await createRoom(s.url, { ticket: await ticket(alice) });
    const { roomCode } = await host.wait<{ roomCode: string }>('welcome');
    const guest = await joinByCode(s.url, roomCode, { ticket: await ticket(bob) });
    await lobby(host, (v) => v.players.length === 2);
    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-08' });
    await lobby(host, (v) => v.players.every((p) => p.boardId));
    host.send('setReady', { ready: true });
    guest.send('setReady', { ready: true });
    const [startA, startB] = await Promise.all([host.wait<MatchStartInfo>('matchStart'), guest.wait<MatchStartInfo>('matchStart')]);
    // The equipment snapshot is locked: changing the saved loadout now cannot affect this match.
    await alice.put('/api/loadout', { loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' } });
    void keepPlaying(host, startA, 20_000, () => host.all('result').length > 0);
    void keepPlaying(guest, startB, 20_000, () => guest.all('result').length > 0);
    const result = await host.wait<MatchResult>('result', () => true, 25_000);
    expect(result.verification.replayVerified).toBe(true);
    await sleep(500);

    const row = await database.db.match.findUnique({ where: { id: result.matchId }, include: { participants: true } });
    expect(row).toMatchObject({ mode: 'private', replayVerified: true, outcome: result.outcome, reason: result.reason });
    expect(row?.participants.map((p) => p.userId).sort()).toEqual([aliceId, bobId].sort());
    expect(row?.participants.find((p) => p.seat === 'A')).toMatchObject({ boardId: 'classic-05', boardVersion: 1, displayName: 'Alpha' });
    // Private rooms never pay rewards.
    expect(await database.db.ledgerEntry.count({ where: { userId: { in: [aliceId, bobId] }, type: 'match_reward' } })).toBe(0);
    // The stored record cannot be edited.
    await expect(database.db.match.update({ where: { id: result.matchId }, data: { outcome: 'win' } })).rejects.toThrow();

    await Promise.all([host.room.leave(), guest.room.leave()]);
    await s.close();

    // A brand-new server process on the same database still has the history.
    s = await server();
    try {
      // Same cookies, new process: sessions live in PostgreSQL, so nobody has to sign in again.
      const alice2 = alice.withBase(s.url);
      const eve2 = eve.withBase(s.url);
      const historyA = (await alice2.get('/api/me/matches')).body as Page<MatchHistoryEntry>;
      expect(historyA.items[0]).toMatchObject({ matchId: result.matchId, mode: 'private', myBoardId: 'classic-05', opponentName: 'Bravo', opponentBoardId: 'classic-08' });
      expect((await alice2.get(`/api/matches/${result.matchId}`)).status).toBe(200);
      // Non-participants cannot see it (and cannot tell it exists).
      expect((await eve2.get(`/api/matches/${result.matchId}`)).status).toBe(404);
      expect((await eve2.get('/api/me/matches')).body).toMatchObject({ items: [] });
      // Saving the same match again changes nothing.
      const record = await s.services.results.get(result.matchId);
      expect(record).not.toBeNull();
      if (record) expect(await s.services.results.save(record)).toBe('duplicate');
      expect(await database.db.match.count({ where: { id: result.matchId } })).toBe(1);
    } finally {
      await s.close();
    }
  });
});
