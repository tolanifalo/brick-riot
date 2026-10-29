import type {
  AbilityEventMessage,
  AbilityResultMessage,
  ExtMessage,
  LobbyView,
  MatchResult,
  MatchStartInfo,
  StateMessage,
  SyncMessage,
} from '@brick-riot/shared';
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app';
import { createRoom, joinByCode, keepPlaying, Probe, sleep, startServer } from './net';

/**
 * Abilities over REAL sockets. The test server starts everyone with 100
 * energy (TEST_START_ENERGY) so attacks are affordable immediately after the
 * opening lockout; the clock runs at 4x (5 s lockout = 1.25 s real time).
 */
let server: GameServer & { url: string };

beforeAll(async () => {
  server = await startServer({ testStartEnergy: 100, matchSeconds: 40 });
});

afterAll(async () => {
  await server.close();
});

const lobby = (p: Probe, pred: (l: LobbyView) => boolean = () => true) => p.wait<LobbyView>('lobby', pred);

async function room(options: { hostLoadout?: object; guestLoadout?: object; devMode?: boolean; xp?: number } = {}) {
  const host = await createRoom(server.url, { devMode: options.devMode ?? true, loadout: options.hostLoadout as never, xp: options.xp ?? 0 });
  const { roomCode } = await host.wait<{ roomCode: string }>('welcome');
  const guest = await joinByCode(server.url, roomCode, { loadout: options.guestLoadout as never });
  await lobby(host, (l) => l.players.length === 2);
  return { host, guest };
}

async function start(host: Probe, guest: Probe, boards = ['classic-05', 'classic-08']) {
  host.send('selectBoard', { boardId: boards[0] });
  guest.send('selectBoard', { boardId: boards[1] });
  const l = await lobby(host, (v) => v.players.every((p) => p.boardId));
  if (l.needsUnrankedAcceptance) {
    host.send('acceptUnranked', { accept: true });
    guest.send('acceptUnranked', { accept: true });
    await lobby(host, (v) => v.players.every((p) => p.acceptsUnranked));
  }
  host.send('setReady', { ready: true });
  guest.send('setReady', { ready: true });
  const [a, b] = await Promise.all([host.wait<MatchStartInfo>('matchStart'), guest.wait<MatchStartInfo>('matchStart')]);
  await lobby(host, (v) => v.phase === 'playing');
  return { a, b };
}

/** Both players launch and keep their balls in play; resolves when the lockout has passed. */
async function pastLockout(host: Probe, guest: Probe, a: MatchStartInfo, b: MatchStartInfo) {
  void keepPlaying(host, a, 20_000, () => host.all('result').length > 0);
  void keepPlaying(guest, b, 20_000, () => guest.all('result').length > 0);
  // 5 s of match time at 4x = 1.25 s, plus margin; both must be past their serve.
  await host.waitNext<SyncMessage>('sync', (s) => s.tick > 700 && s.players.every((p) => p.status === 'playing'), 8000);
}

/** Refusals that depend on the moment (the sweeping test paddle sometimes loses a ball). */
const TRANSIENT = new Set(['target_awaiting_launch', 'target_immune', 'target_debuffed', 'not_playing']);
const seqs = new WeakMap<Probe, number>();

/** Activates an ability, retrying transient refusals; returns the accepted result. */
async function activate(p: Probe, ability: string): Promise<AbilityResultMessage> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const seq = (seqs.get(p) ?? 10) + 1;
    seqs.set(p, seq);
    const reply = p.waitNext<AbilityResultMessage>('abilityResult', (r) => r.ability === ability);
    p.send('ability', { ability, seq, tick: 900 + seq });
    const r = await reply;
    if (r.accepted) return r;
    if (!TRANSIENT.has(r.reason ?? '')) throw new Error(`${ability} refused: ${r.reason}`);
    await sleep(80);
  }
  throw new Error(`${ability} never accepted`);
}

const refusal = (p: Probe, reason: string) => p.wait<AbilityResultMessage>('abilityResult', (r) => !r.accepted && r.reason === reason);

describe('loadouts in the lobby', { timeout: 20_000 }, () => {
  it('shows both loadouts and Equipment Power Ratings; defaults when none is sent', async () => {
    const { host, guest } = await room({ hostLoadout: { offensive: 'shrink', defensive: 'cleanse', passive: 'precision' } });
    const l = await lobby(guest, (v) => v.players.length === 2);
    expect(l.players[0]?.loadout).toEqual({ offensive: 'shrink', defensive: 'cleanse', passive: 'precision' });
    expect(l.players[1]?.loadout).toEqual({ offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' });
    expect(l.players[0]?.equipment.power).toBe(35 + 20 + 20);
    expect(l.players[0]?.equipment.verified).toBe(false);
    expect(l.equipmentMode).toBe('casual');
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('validates loadout changes: unlocks (outside dev rooms), budget, and readiness', async () => {
    const { host, guest } = await room({ devMode: false });
    host.send('setLoadout', { loadout: { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' } });
    expect(await host.wait('rejected', (r: { type: string }) => r.type === 'setLoadout')).toMatchObject({ reason: 'locked' });
    host.send('setLoadout', { loadout: { offensive: 'emp', defensive: 'shield', passive: 'garbage' } });
    expect(await host.waitNext('rejected')).toMatchObject({ reason: 'wrong_slot' });
    host.send('setLoadout', { loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' } });
    await sleep(150);
    await Promise.all([host.room.leave(), guest.room.leave()]);

    const dev = await room({ devMode: true });
    dev.host.send('setLoadout', { loadout: { offensive: 'frost', defensive: 'shield', passive: 'accelerator' } });
    expect(await dev.host.wait('rejected', (r: { type: string }) => r.type === 'setLoadout')).toMatchObject({ reason: 'over_budget' });
    dev.host.send('setLoadout', { loadout: { offensive: 'frost', defensive: 'cleanse', passive: 'quickRelaunch' } });
    await lobby(dev.guest, (v) => v.players[0]?.loadout.offensive === 'frost');
    // Once ready, the loadout cannot change.
    dev.host.send('selectBoard', { boardId: 'classic-05' });
    await lobby(dev.host, (v) => v.players[0]?.boardId === 'classic-05');
    dev.host.send('setReady', { ready: true });
    await lobby(dev.guest, (v) => v.players[0]?.ready === true);
    dev.host.send('setLoadout', { loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' } });
    expect(await dev.host.waitNext('rejected')).toMatchObject({ type: 'setLoadout', reason: 'unready_first' });
    await Promise.all([dev.host.room.leave(), dev.guest.room.leave()]);
  });

  it('locks loadouts at the countdown and hands both players the locked equipment', async () => {
    const { host, guest } = await room({ hostLoadout: { offensive: 'shrink', defensive: 'shield', passive: 'quickRelaunch' } });
    const { a, b } = await start(host, guest);
    expect(a.loadouts).toEqual(b.loadouts);
    expect(a.loadouts.A.offensive).toBe('shrink');
    expect(a.equipment.loadout?.offensive).toBe('shrink');
    host.send('setLoadout', { loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' } });
    expect(await host.wait('rejected', (r: { type: string }) => r.type === 'setLoadout')).toMatchObject({ reason: 'locked' });
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('upgrade rooms: host-only switch; guests’ claimed upgrade levels are ignored (Phase 5)', async () => {
    // A guest claims maxed upgrades; the server never trusts client upgrade claims.
    const host = await createRoom(server.url, { devMode: true, upgrades: { paddleWidth: 5, paddleControl: 5, ballPower: 3, magnetDuration: 3, startingEnergy: 4 } });
    const { roomCode } = await host.wait<{ roomCode: string }>('welcome');
    const guest = await joinByCode(server.url, roomCode);
    await lobby(host, (l) => l.players.length === 2);
    guest.send('setEquipmentMode', { mode: 'casualUpgrades' });
    expect(await guest.wait('rejected', (r: { type: string }) => r.type === 'setEquipmentMode')).toMatchObject({ reason: 'host_only' });
    host.send('setEquipmentMode', { mode: 'casualUpgrades' });
    const l = await lobby(guest, (v) => v.equipmentMode === 'casualUpgrades');
    expect(l.players[0]?.equipment.power).toBe(l.players[1]?.equipment.power);
    expect(l.players[0]?.equipment.components.some((c) => c.source.includes('paddleWidth'))).toBe(false);
    expect(l.equipmentCompatibility?.even).toBe(true);
    // (Uneven, server-verified upgrades are covered in matches.db.test.ts.)
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});

describe('multiplayer board variants', { timeout: 20_000 }, () => {
  it('versioned variants can be chosen and raced; the match start carries id and version', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest, ['classic-07-mp', 'classic-10-mp']);
    expect(a.boards).toEqual({ A: { boardId: 'classic-07-mp', boardVersion: 1 }, B: { boardId: 'classic-10-mp', boardVersion: 1 } });
    expect(b.boards).toEqual(a.boards);
    const l = await lobby(host, (v) => v.phase === 'playing');
    expect(l.compatibility?.compatible).toBe(true);
    expect(l.needsUnrankedAcceptance).toBe(false);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});

describe('abilities over real sockets', { timeout: 30_000 }, () => {
  it('refuses attacks during the opening lockout, then lands an EMP on the opponent', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    host.send('ability', { ability: 'emp', seq: 1, tick: 1 });
    expect(await host.wait<AbilityResultMessage>('abilityResult')).toMatchObject({ accepted: false });

    await pastLockout(host, guest, a, b);
    const result = await activate(host, 'emp');
    expect(result).toMatchObject({ ability: 'emp', accepted: true, blocked: false });
    const event = await guest.wait<AbilityEventMessage>('abilityEvent');
    expect(event).toMatchObject({ by: 'A', ability: 'emp', target: 'B', blocked: false, applyTick: result.applyTick });
    const ext = await guest.wait<ExtMessage>('ext');
    expect(ext.upcoming.some((u) => u.tick === result.applyTick && u.commands.some((c) => c.k === 'debuff'))).toBe(true);
    const attackerExt = await host.wait<ExtMessage>('ext');
    expect(attackerExt.upcoming.some((u) => u.commands.some((c) => c.k === 'spend'))).toBe(true);
    // The authoritative state shows the debuff and the attacker's energy spent.
    const sync = await host.waitNext<SyncMessage>('sync', (s) => s.players[1]?.debuff === 'emp', 6000);
    expect(sync.players[0]?.energy).toBeLessThanOrEqual(60 + 10);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('rejects forged and abusive ability messages', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    await pastLockout(host, guest, a, b);
    host.send('ability', { ability: 'frost', seq: 1, tick: 800 }); // not equipped (decided by the arbiter)
    host.send('ability', { ability: 'emp', seq: 1, tick: 800 }); // replayed seq
    host.send('ability', { ability: 'emp' }); // malformed
    host.send('ability', { ability: 'emp', seq: 2.5, tick: 'x' }); // malformed types
    await refusal(host, 'not_equipped');
    await refusal(host, 'duplicate_seq');
    await refusal(host, 'malformed');
    // Cooldown bypass: a second activation right after an accepted one.
    seqs.set(host, 10);
    await activate(host, 'emp');
    host.send('ability', { ability: 'emp', seq: 500, tick: 2000 });
    const second = await host.waitNext<AbilityResultMessage>('abilityResult', (r) => r.ability === 'emp');
    expect(second.accepted).toBe(false);
    expect(['already_pending', 'cooldown']).toContain(second.reason);
    // Rate limit: a flood of requests is cut off.
    for (let i = 0; i < 10; i++) host.send('ability', { ability: 'shield', seq: 600 + i, tick: 2000 });
    await refusal(host, 'rate_limited');
    // Server-to-client message types are unknown when sent by a client.
    // Rejection notices are throttled to one per second, so repeat until one is reported.
    const extRejected = host.wait('rejected', (r: { type: string }) => r.type === 'ext');
    const resend = setInterval(() => host.send('ext', { upcoming: [] }), 300);
    host.send('ext', { upcoming: [] });
    try {
      expect(await extRejected).toMatchObject({ reason: 'unknown_message' });
    } finally {
      clearInterval(resend);
    }
    // Extra fields on inputs are ignored: a forged "spend" with negative cost
    // cannot raise energy. (Sent last: its high seq makes later inputs stale.)
    const offset = a.serverTime - Date.now();
    const nearTick = Math.floor(((Date.now() + offset - a.goAt) * a.ticksPerSecond) / 1000) + 4;
    host.send('input', { seq: 999_999, inputs: [[nearTick, 240, 0, 0]], ext: [{ k: 'spend', ability: 'emp', cost10: -9999, readyTick: 0 }] });
    await sleep(400);
    const sync = host.last<SyncMessage>('sync');
    expect(sync?.players[0]?.energy).toBeGreaterThanOrEqual(0);
    expect(sync?.players[0]?.energy).toBeLessThanOrEqual(100);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('Shield blocks an incoming attack; both players see it', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    await pastLockout(host, guest, a, b);
    await activate(guest, 'shield');
    await guest.waitNext<SyncMessage>('sync', (s) => s.players[1]?.shielded === true, 6000);
    const blocked = await activate(host, 'emp');
    expect(blocked).toMatchObject({ accepted: true, blocked: true });
    expect(await guest.wait<AbilityEventMessage>('abilityEvent', (e) => e.by === 'A')).toMatchObject({ blocked: true });
    const after = await guest.waitNext<SyncMessage>('sync', (s) => s.players[1]?.shielded === false, 6000);
    expect(after.players[1]?.debuff).toBeNull();
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('simultaneous attacks resolve independently and deterministically', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    await pastLockout(host, guest, a, b);
    const [ra, rb] = await Promise.all([activate(host, 'emp'), activate(guest, 'emp')]);
    expect(ra.accepted && rb.accepted).toBe(true);
    // Each lands on the other's simulation; both are visible in the authoritative state.
    const seen = { A: false, B: false };
    await host.waitNext<SyncMessage>(
      'sync',
      (s) => {
        if (s.players[0]?.debuff === 'emp') seen.A = true;
        if (s.players[1]?.debuff === 'emp') seen.B = true;
        return seen.A && seen.B;
      },
      8000,
    );
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });

  it('a reconnecting player gets the authoritative state including the active effect and upcoming commands', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    await pastLockout(host, guest, a, b);
    await activate(host, 'emp');
    const token = guest.room.reconnectionToken;
    await guest.room.leave(false);
    const back = new Probe(await new Client(server.url).reconnect(token));
    await back.wait<MatchStartInfo>('matchStart');
    back.send('resync');
    const state = await back.wait<StateMessage>('state');
    const debuffed = state.state.debuff !== null || state.upcoming.some((u) => u.commands.some((c) => c.k === 'debuff'));
    expect(debuffed).toBe(true);
    await Promise.all([host.room.leave(), back.room.leave()]);
  });

  it('a match with sabotage finalizes once, with replay verification passing', async () => {
    const { host, guest } = await room();
    const { a, b } = await start(host, guest);
    await pastLockout(host, guest, a, b);
    await activate(guest, 'shield');
    await activate(host, 'emp');
    const result = await host.wait<MatchResult>('result', () => true, 25_000);
    expect(result.verification.replayVerified).toBe(true);
    const record = await server.services.results.get(result.matchId);
    expect(record?.equipment?.A.loadout?.offensive).toBe('emp');
    expect(record?.inputs.A.some((i) => (i.ext ?? []).length > 0)).toBe(true);
    expect(record?.inputs.B.some((i) => (i.ext ?? []).length > 0)).toBe(true);
    await sleep(300);
    expect(host.all('result')).toHaveLength(1);
    await Promise.all([host.room.leave(), guest.room.leave()]);
  });
});
