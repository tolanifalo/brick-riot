import { DEFAULT_LOADOUT, NO_UPGRADES, type ExternalCommand, type MatchStartInfo, type SyncMessage } from '@brick-riot/shared';
import { describe, expect, it } from 'vitest';
import { ServerClock } from '../src/net/clock';
import { MatchNet } from '../src/net/matchNet';

describe('ServerClock', () => {
  it('estimates the offset from the lowest-latency sample', () => {
    let now = 1_000;
    const clock = new ServerClock(() => now);
    // Server is 5000 ms ahead. Sample 1: 200 ms RTT; sample 2: 40 ms RTT.
    now = 1_200;
    clock.onPong(1_000, 6_100);
    now = 2_040;
    clock.onPong(2_000, 7_020);
    expect(clock.offset).toBe(5_000);
    expect(clock.serverNow()).toBe(7_040);
  });
});

function start(overrides: Partial<MatchStartInfo> = {}): MatchStartInfo {
  return {
    matchId: 'm1',
    seat: 'A',
    seed: 5,
    boards: { A: { boardId: 'classic-05', boardVersion: 1 }, B: { boardId: 'classic-08', boardVersion: 1 } },
    names: { A: 'a', B: 'b' },
    goAt: 10_000,
    serverTime: 9_000,
    ticksPerSecond: 120,
    durationTicks: 14_400,
    equipmentMode: 'casual',
    loadouts: { A: DEFAULT_LOADOUT, B: DEFAULT_LOADOUT },
    equipment: { loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES },
    startEnergyOverride: null,
    ...overrides,
  };
}

function harness(now = { t: 9_000 }) {
  const clock = new ServerClock(() => now.t);
  const sent: { type: string; payload: unknown }[] = [];
  const net = new MatchNet(start(), clock, (type, payload) => sent.push({ type, payload }));
  return { net, sent, now, clock };
}

const input = { targetX: 100, axis: 0, launch: false };

describe('MatchNet', () => {
  it('reports the countdown and a positive lead once the match runs', () => {
    const { net, now } = harness();
    expect(net.msUntilStart()).toBe(1_000);
    expect(net.predictedTickFloat()).toBeLessThan(0);
    now.t = 11_000;
    expect(net.serverTickFloat()).toBe(120);
    expect(net.predictedTickFloat()).toBeGreaterThan(120);
  });

  it('batches inputs with strictly increasing sequence numbers; launches flush immediately', () => {
    const { net, sent } = harness();
    for (let t = 1; t <= 3; t++) net.recordInput(t, input);
    net.flush(true);
    net.recordInput(4, { ...input, launch: true });
    expect(sent.map((s) => s.type)).toEqual(['input', 'input']);
    const [first, second] = sent.map((s) => s.payload as { seq: number; inputs: unknown[] });
    expect(first?.seq).toBe(0);
    expect(first?.inputs).toEqual([
      [1, 100, 0, 0],
      [2, 100, 0, 0],
      [3, 100, 0, 0],
    ]);
    expect(second).toEqual({ seq: 1, inputs: [[4, 100, 0, 1]] });
    expect(net.inputAt(2)).toEqual(input);
  });

  it('requests the authoritative state when a checksum disagrees, and not when it agrees', () => {
    const { net, sent } = harness();
    net.recordHash(6, 'aaaa0000');
    net.recordHash(12, 'bbbb0000');
    const sync = (hashTick: number, hash: string): SyncMessage => ({ tick: hashTick, hashTick, hash, timeLeftTicks: 0, players: [] });
    net.onSync(sync(6, 'aaaa0000'));
    expect(sent).toHaveLength(0);
    net.onSync(sync(12, 'ffff0000'));
    expect(sent.map((s) => s.type)).toEqual(['resync']);
    expect(net.stats).toMatchObject({ checks: 2, mismatches: 1 });
  });

  it('checks server hashes for ticks it has not simulated yet once it gets there', () => {
    const { net, sent } = harness();
    net.onSync({ tick: 18, hashTick: 18, hash: 'cccc0000', timeLeftTicks: 0, players: [] });
    expect(net.stats.checks).toBe(0);
    net.recordHash(18, 'dddd0000');
    expect(net.stats.mismatches).toBe(1);
    expect(sent.at(-1)?.type).toBe('resync');
  });

  it('hands over a received state once and forgets predictions after it', () => {
    const { net } = harness();
    net.recordHash(6, 'a');
    net.recordHash(12, 'b');
    net.onState({ tick: 6, state: {} as never, upcoming: [] });
    expect(net.takeResync()?.tick).toBe(6);
    expect(net.takeResync()).toBeNull();
    expect(net.stats.resyncs).toBe(1);
  });
});

describe('MatchNet scheduled ability commands', () => {
  const shield: ExternalCommand = { k: 'shield', untilTick: 2000 };

  it('hands each command over on exactly its tick, once', () => {
    const { net } = harness();
    net.onExt({ upcoming: [{ tick: 50, commands: [shield] }] });
    expect(net.extAt(49)).toBeUndefined();
    expect(net.extAt(50)).toEqual([shield]);
    expect(net.extAt(50)).toBeUndefined();
  });

  it('requests a resync when a command arrives for a tick already simulated without it', () => {
    const { net, sent } = harness();
    for (let t = 1; t <= 60; t++) net.recordInput(t, input);
    net.onExt({ upcoming: [{ tick: 55, commands: [shield] }] });
    expect(sent.at(-1)?.type).toBe('resync');
    expect(net.stats.lateCommands).toBe(1);
  });

  it('does not resync when the late command was already applied identically', () => {
    const { net, sent } = harness();
    net.onExt({ upcoming: [{ tick: 5, commands: [shield] }] });
    for (let t = 1; t <= 10; t++) {
      const ext = net.extAt(t);
      net.recordInput(t, ext ? { ...input, ext } : input);
    }
    net.onExt({ upcoming: [{ tick: 5, commands: [shield] }] });
    expect(sent.some((s) => s.type === 'resync')).toBe(false);
  });

  it('replays with the authoritative schedule after a resync', () => {
    const { net } = harness();
    for (let t = 1; t <= 20; t++) net.recordInput(t, input);
    net.onState({ tick: 10, state: {} as never, upcoming: [{ tick: 15, commands: [shield] }] });
    net.takeResync();
    expect(net.replayInput(14, input).ext).toBeUndefined();
    expect(net.replayInput(15, input).ext).toEqual([shield]);
    expect(net.inputAt(15)?.ext).toEqual([shield]);
  });

  it('sends ability requests with increasing sequence numbers', () => {
    const { net, sent } = harness();
    net.requestAbility('emp');
    net.requestAbility('shield');
    const requests = sent.filter((s) => s.type === 'ability').map((s) => s.payload as { seq: number; ability: string });
    expect(requests.map((r) => [r.seq, r.ability])).toEqual([
      [1, 'emp'],
      [2, 'shield'],
    ]);
  });
});
