import { Client } from '@colyseus/sdk';
import type { LobbyView, MatchResult, MatchStartInfo, SyncMessage } from '@brick-riot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app';
import { createRoom, joinByCode, joinOptions, Probe, resolveCode, sleep, startServer } from './net';

let server: GameServer & { url: string };

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

const lobby = (p: Probe, pred: (l: LobbyView) => boolean = () => true) => p.wait<LobbyView>('lobby', pred);
const nextLobby = (p: Probe, pred: (l: LobbyView) => boolean) => p.waitNext<LobbyView>('lobby', pred);

async function pairedRoom(devMode = true) {
  const host = await createRoom(server.url, { devMode, name: 'Host' });
  const welcome = await host.wait<{ roomCode: string; seat: string }>('welcome');
  const guest = await joinByCode(server.url, welcome.roomCode, { name: 'Guest' });
  await lobby(host, (l) => l.players.length === 2);
  return { host, guest, code: welcome.roomCode };
}

/** Pairs two players on the given boards and waits until the match is running. */
async function startedMatch(boardA = 'classic-08', boardB = 'classic-05') {
  const { host, guest, code } = await pairedRoom();
  host.send('selectBoard', { boardId: boardA });
  guest.send('selectBoard', { boardId: boardB });
  const l = await lobby(host, (v) => v.players.every((p) => p.boardId !== null));
  if (l.needsUnrankedAcceptance) {
    host.send('acceptUnranked', { accept: true });
    guest.send('acceptUnranked', { accept: true });
    await lobby(host, (v) => v.players.every((p) => p.acceptsUnranked));
  }
  host.send('setReady', { ready: true });
  guest.send('setReady', { ready: true });
  const [ha, gb] = await Promise.all([host.wait<MatchStartInfo>('matchStart'), guest.wait<MatchStartInfo>('matchStart')]);
  await lobby(host, (v) => v.phase === 'playing');
  return { host, guest, code, startA: ha, startB: gb };
}

/** Sends a stream of inputs for `seconds` of wall time, tick-stamped from the server clock. */
async function drive(p: Probe, start: MatchStartInfo, seconds: number, targetX: (tick: number) => number, launchEvery = 0) {
  let seq = 0;
  let lastTick = 0;
  const end = Date.now() + seconds * 1000;
  const offset = start.serverTime - Date.now();
  while (Date.now() < end) {
    const tick = Math.floor(((Date.now() + offset - start.goAt) * start.ticksPerSecond) / 1000) + 6;
    if (tick > lastTick) {
      const inputs: [number, number, number, number][] = [];
      for (let t = Math.max(1, lastTick + 1); t <= tick && inputs.length < 32; t++) {
        inputs.push([t, targetX(t), 0, launchEvery > 0 && t % launchEvery === 0 ? 1 : 0]);
        lastTick = t;
      }
      if (inputs.length > 0) p.send('input', { seq: seq++, inputs });
    }
    await sleep(25);
  }
}

describe('room creation and joining', () => {
  it('creates a private room with a short code; the creator is host on seat A', async () => {
    const host = await createRoom(server.url);
    const welcome = await host.wait<{ roomCode: string; seat: string }>('welcome');
    expect(welcome.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(welcome.seat).toBe('A');
    const l = await lobby(host);
    expect(l).toMatchObject({ phase: 'lobby', roomCode: welcome.roomCode, devMode: false });
    expect(l.players).toHaveLength(1);
    expect(l.players[0]).toMatchObject({ seat: 'A', isHost: true, ready: false });
    await host.room.leave();
  });

  it('joins by code onto seat B', async () => {
    const { host, guest } = await pairedRoom(false);
    const l = await lobby(guest, (v) => v.players.length === 2);
    expect(l.players.map((p) => [p.seat, p.name, p.isHost])).toEqual([
      ['A', 'Host', true],
      ['B', 'Guest', false],
    ]);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('rejects invalid and malformed codes', async () => {
    expect(await resolveCode(server.url, 'ZZZZZZ')).toMatchObject({ status: 404, body: { error: 'invalid_code' } });
    expect(await resolveCode(server.url, 'abc')).toMatchObject({ status: 404 });
    expect(await resolveCode(server.url, '00OOII')).toMatchObject({ status: 404 });
  });

  it('refuses a join by room id with the wrong code', async () => {
    const host = await createRoom(server.url);
    const welcome = await host.wait<{ roomCode: string }>('welcome');
    const resolved = await resolveCode(server.url, welcome.roomCode);
    const roomId = resolved.body.roomId ?? '';
    await expect(new Client(server.url).joinById(roomId, joinOptions({ code: 'AAAAAA' }))).rejects.toThrow(/invalid_code/);
    await expect(new Client(server.url).joinById(roomId, joinOptions())).rejects.toThrow(/invalid_code/);
    await host.room.leave();
  });

  it('enforces capacity: a third player cannot join', async () => {
    const { host, guest, code } = await pairedRoom();
    expect(await resolveCode(server.url, code)).toMatchObject({ status: 409, body: { error: 'room_full' } });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('prevents one browser profile from taking two seats', async () => {
    const opts = joinOptions();
    const host = new Probe(await new Client(server.url).create('match', opts));
    const welcome = await host.wait<{ roomCode: string }>('welcome');
    const resolved = await resolveCode(server.url, welcome.roomCode);
    await expect(
      new Client(server.url).joinById(resolved.body.roomId ?? '', { ...opts, code: welcome.roomCode }),
    ).rejects.toThrow(/already_in_room/);
    await host.room.leave();
  });

  it('host cancelling closes the room and expires its code', async () => {
    const host = await createRoom(server.url);
    const welcome = await host.wait<{ roomCode: string }>('welcome');
    host.send('cancel');
    await host.wait('closed');
    await sleep(100);
    expect(await resolveCode(server.url, welcome.roomCode)).toMatchObject({ status: 410, body: { error: 'expired' } });
  });

  it('a player leaving before the start frees the seat and the host can be reassigned', async () => {
    const { host, guest, code } = await pairedRoom();
    await host.room.leave();
    // The guest has only ever seen 2-player lobbies, so any 1-player lobby is the new one.
    const l = await lobby(guest, (v) => v.players.length === 1);
    expect(l.players[0]).toMatchObject({ seat: 'B', isHost: true });
    // The room is joinable again with the same code.
    const third = await joinByCode(server.url, code);
    await lobby(third, (v) => v.players.length === 2);
    await Promise.all([guest.room.leave(), third.room.leave()]);
  });
});

describe('board selection, compatibility and readiness', () => {
  it('rejects boards that are not multiplayer-eligible', async () => {
    const { host, guest } = await pairedRoom();
    host.send('selectBoard', { boardId: 'classic-01' });
    expect(await host.wait('rejected')).toEqual({ type: 'selectBoard', reason: 'not_multiplayer_eligible' });
    host.send('selectBoard', { boardId: 'nope' });
    expect(await host.waitNext('rejected')).toEqual({ type: 'selectBoard', reason: 'unknown_board' });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('enforces unlocks in normal rooms but not in dev rooms', async () => {
    const normal = await pairedRoom(false);
    normal.host.send('selectBoard', { boardId: 'classic-08' });
    expect(await normal.host.wait('rejected')).toEqual({ type: 'selectBoard', reason: 'locked' });
    await Promise.all([normal.host.room.leave(), normal.guest.room.leave()]);

    // Claimed local progress (untrusted, private rooms only) unlocks boards.
    const host = await createRoom(server.url, { clearedBoardIds: ['classic-01', 'classic-02', 'classic-03', 'classic-04'] });
    const w = await host.wait<{ roomCode: string }>('welcome');
    host.send('selectBoard', { boardId: 'classic-05' });
    await lobby(host, (v) => v.players[0]?.boardId === 'classic-05');
    host.send('selectBoard', { boardId: 'classic-07' });
    expect(await host.wait('rejected')).toEqual({ type: 'selectBoard', reason: 'locked' });
    expect(w.roomCode).toBeTruthy();
    await host.room.leave();

    const dev = await pairedRoom(true);
    dev.host.send('selectBoard', { boardId: 'classic-10' });
    await lobby(dev.host, (v) => v.devMode && v.players[0]?.boardId === 'classic-10');
    await Promise.all([dev.host.room.leave(), dev.guest.room.leave()]);
  });

  it('lets players pick different boards and reports compatibility', async () => {
    const { host, guest } = await pairedRoom();
    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-08' });
    const l = await lobby(guest, (v) => v.players.every((p) => p.boardId));
    expect(l.players.map((p) => p.boardId)).toEqual(['classic-05', 'classic-08']);
    expect(l.compatibility).toMatchObject({ compatible: true, rankedEligible: false, calibration: 'estimated' });
    expect(l.needsUnrankedAcceptance).toBe(false);

    guest.send('selectBoard', { boardId: 'classic-03' });
    const mismatch = await lobby(guest, (v) => v.players[1]?.boardId === 'classic-03');
    expect(mismatch.compatibility?.compatible).toBe(false);
    expect(mismatch.needsUnrankedAcceptance).toBe(true);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('handles ready/unready, requires a board, and requires both to accept an unranked mismatch', async () => {
    const { host, guest } = await pairedRoom();
    host.send('setReady', { ready: true });
    expect(await host.wait('rejected')).toEqual({ type: 'setReady', reason: 'choose_board_first' });

    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-03' });
    await lobby(host, (v) => v.needsUnrankedAcceptance);
    host.send('setReady', { ready: true });
    expect(await host.waitNext('rejected')).toEqual({ type: 'setReady', reason: 'accept_unranked_first' });

    host.send('acceptUnranked', { accept: true });
    host.send('setReady', { ready: true });
    await lobby(guest, (v) => v.players[0]?.ready === true);
    host.send('setReady', { ready: false });
    await nextLobby(guest, (v) => v.players[0]?.ready === false);
    host.send('setReady', { ready: true });
    guest.send('acceptUnranked', { accept: true });
    guest.send('setReady', { ready: true });
    const start = await guest.wait<MatchStartInfo>('matchStart');
    expect(start.boards).toEqual({
      A: { boardId: 'classic-05', boardVersion: 1 },
      B: { boardId: 'classic-03', boardVersion: 1 },
    });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('changing board resets everyone\'s readiness', async () => {
    const { host, guest } = await pairedRoom();
    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-08' });
    await lobby(host, (v) => v.players.every((p) => p.boardId));
    host.send('setReady', { ready: true });
    await lobby(guest, (v) => v.players[0]?.ready === true);
    guest.send('selectBoard', { boardId: 'classic-02' });
    const l = await nextLobby(host, (v) => v.players[1]?.boardId === 'classic-02');
    expect(l.players.every((p) => !p.ready)).toBe(true);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});

describe('countdown and match', () => {
  it('starts both players from the same server-chosen moment with their own seeds', async () => {
    const { host, guest, startA, startB } = await startedMatch();
    expect(startA.matchId).toBe(startB.matchId);
    expect(startA.goAt).toBe(startB.goAt);
    expect(startA.seat).toBe('A');
    expect(startB.seat).toBe('B');
    expect(startA.boards.A.boardId).toBe('classic-08');
    expect(startB.boards.B.boardId).toBe('classic-05');
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('rejects inputs during the countdown (controls are locked)', async () => {
    const { host, guest } = await pairedRoom();
    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-08' });
    await lobby(host, (v) => v.players.every((p) => p.boardId));
    host.send('setReady', { ready: true });
    guest.send('setReady', { ready: true });
    await lobby(host, (v) => v.phase === 'countdown');
    host.send('input', { seq: 1, inputs: [[1, 100, 0, 1]] });
    expect(await host.wait('rejected')).toEqual({ type: 'input', reason: 'not_started' });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('runs both boards independently, streams authoritative progress, and both see the same verified result', async () => {
    const { host, guest, startA, startB } = await startedMatch('classic-08', 'classic-05');
    // A launches and moves; B stays idle on the serve.
    await drive(host, startA, 1.2, (t) => 120 + ((t * 3) % 240), 30);
    const syncB = await guest.waitNext<SyncMessage>('sync', (s) => (s.players[0]?.score ?? 0) > 0, 6000);
    expect(syncB.players[0]?.seat).toBe('A');
    expect(syncB.players[1]).toMatchObject({ seat: 'B', score: 0, status: 'playing' });
    expect(syncB.hash).toMatch(/^[0-9a-f]{8}$/);
    const preview = await guest.wait<{ seat: string; bricks: string }>('preview');
    expect(preview.seat).toBe('A');

    // Forged messages are ignored: there is no message that can set a result.
    host.send('complete', { winner: 'A' });
    host.send('result', { outcome: 'win', winnerSeat: 'A' });
    guest.send('score', { score: 999999 });
    expect(await host.wait('rejected', (r: { type: string }) => r.type === 'complete')).toMatchObject({ reason: 'unknown_message' });

    const [ra, rb] = await Promise.all([host.wait<MatchResult>('result'), guest.wait<MatchResult>('result')]);
    expect(ra).toEqual(rb);
    expect(ra.matchId).toBe(startB.matchId);
    // A 10 s match where nobody clears: the timer decides.
    expect(ra).toMatchObject({ outcome: 'draw', reason: 'time_expired', winnerSeat: null, endTick: 1200 });
    expect(ra.verification.replayVerified).toBe(true);
    expect(ra.players[1]?.score).toBe(0);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});

describe('resilience', () => {
  it('a dropped player reconnects with their token and the match continues where it was', async () => {
    const { host, guest, startB } = await startedMatch();
    const token = guest.room.reconnectionToken;
    await guest.room.leave(false);
    const offline = await lobby(host, (v) => v.players[1]?.connected === false);
    expect(offline.players[1]?.reconnectDeadline).toBeGreaterThan(Date.now());
    const tickBefore = (await host.waitNext<SyncMessage>('sync')).tick;

    const back = new Probe(await new Client(server.url).reconnect(token));
    const again = await back.wait<MatchStartInfo>('matchStart');
    expect(again.matchId).toBe(startB.matchId);
    expect(again.seat).toBe('B');
    back.send('resync');
    const state = await back.wait<{ tick: number; state: { boardId: string; tick: number } }>('state');
    expect(state.state.boardId).toBe('classic-05');
    expect(state.tick).toBeGreaterThan(tickBefore - 1);
    await lobby(host, (v) => v.players[1]?.connected === true);

    // The used token cannot be replayed to grab a second seat.
    await expect(new Client(server.url).reconnect(token)).rejects.toThrow();
    await Promise.all([host.room.leave(), back.room.leave()]);
  });

  it('missing the reconnection deadline forfeits', async () => {
    const { host, guest } = await startedMatch();
    await guest.room.leave(false);
    const result = await host.wait<MatchResult>('result', () => true, 6000);
    expect(result).toMatchObject({ outcome: 'win', winnerSeat: 'A', reason: 'forfeit' });
    expect(result.players[1]).toMatchObject({ forfeited: true, disconnectedAtEnd: true });
    await host.room.leave();
  });

  it('expired reconnection tokens cannot be used', async () => {
    const { host, guest } = await startedMatch();
    const token = guest.room.reconnectionToken;
    await guest.room.leave(false);
    await host.wait('result', () => true, 6000);
    await expect(new Client(server.url).reconnect(token)).rejects.toThrow();
    await host.room.leave();
  });

  it('leaving deliberately during a match forfeits immediately', async () => {
    const { host, guest } = await startedMatch();
    await guest.room.leave(true);
    const result = await host.wait<MatchResult>('result', () => true, 3000);
    expect(result).toMatchObject({ outcome: 'win', winnerSeat: 'A', reason: 'forfeit' });
    await host.room.leave();
  });

  it('if both players are gone when a deadline passes, the match is cancelled with no winner', async () => {
    const { host, guest } = await startedMatch();
    const matchId = host.last<MatchStartInfo>('matchStart')?.matchId ?? '';
    await host.room.leave(false);
    await guest.room.leave(false);
    await sleep(2500);
    const record = await server.services.results.get(matchId);
    expect(record?.result).toMatchObject({ outcome: 'cancelled', reason: 'both_disconnected', winnerSeat: null });
  });

  it('a drop during the countdown cancels the start and returns to the lobby', async () => {
    const { host, guest } = await pairedRoom();
    host.send('selectBoard', { boardId: 'classic-05' });
    guest.send('selectBoard', { boardId: 'classic-08' });
    await lobby(host, (v) => v.players.every((p) => p.boardId));
    host.send('setReady', { ready: true });
    guest.send('setReady', { ready: true });
    const start = await host.wait<MatchStartInfo>('matchStart');
    await lobby(guest, (v) => v.phase === 'countdown');
    host.send('cancel');
    const l = await nextLobby(guest, (v) => v.phase === 'lobby');
    expect(l.players.every((p) => !p.ready)).toBe(true);
    const record = await server.services.results.get(start.matchId);
    expect(record?.result).toMatchObject({ outcome: 'cancelled', reason: 'match_cancelled' });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});

describe('results and rematches', () => {
  it('finalizes exactly once, stores the record, and rematches start a fresh match', async () => {
    const { host, guest, startA } = await startedMatch();
    const first = await host.wait<MatchResult>('result', () => true, 8000);
    await guest.wait('result');
    // Spamming messages after the result does not create or change results.
    for (let i = 0; i < 5; i++) host.send('input', { seq: 1000 + i, inputs: [[2000 + i, 100, 0, 1]] });
    await sleep(200);
    expect(host.all('result')).toHaveLength(1);
    const stored = await server.services.results.get(startA.matchId);
    expect(stored?.result).toEqual(first);
    expect(stored?.inputs.A.length).toBeGreaterThan(0);

    // Decline first, then accept.
    host.send('rematch', { action: 'request' });
    await lobby(guest, (v) => v.players[0]?.rematch === 'requested');
    guest.send('rematch', { action: 'decline' });
    await lobby(host, (v) => v.players[1]?.rematch === 'declined');
    host.send('rematch', { action: 'request' });
    await nextLobby(guest, (v) => v.players[0]?.rematch === 'requested');
    guest.send('rematch', { action: 'accept' });
    const reset = await nextLobby(host, (v) => v.phase === 'lobby');
    expect(reset.players.map((p) => p.boardId)).toEqual(['classic-08', 'classic-05']);
    expect(reset.players.every((p) => !p.ready)).toBe(true);
    expect(reset.result).toBeNull();

    // Keep A's board, change B's, ready up: a brand-new match id.
    guest.send('selectBoard', { boardId: 'classic-02' });
    await lobby(host, (v) => v.players[1]?.boardId === 'classic-02' && v.phase === 'lobby');
    const l = await lobby(host, (v) => v.players[1]?.boardId === 'classic-02');
    if (l.needsUnrankedAcceptance) {
      host.send('acceptUnranked', { accept: true });
      guest.send('acceptUnranked', { accept: true });
    }
    host.send('setReady', { ready: true });
    guest.send('setReady', { ready: true });
    const second = await host.waitNext<MatchStartInfo>('matchStart');
    expect(second.matchId).not.toBe(startA.matchId);
    expect(second.boards.B.boardId).toBe('classic-02');
    // The earlier result is unchanged in the repository.
    expect((await server.services.results.get(startA.matchId))?.result).toEqual(first);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('pause is refused in multiplayer', async () => {
    const { host, guest } = await startedMatch();
    host.send('pause');
    expect(await host.wait('rejected', (r: { type: string }) => r.type === 'pause')).toMatchObject({ reason: 'pause_not_allowed' });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});
