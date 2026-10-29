import { MATCH_CONFIG } from '@brick-riot/shared';
import { Client } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app';
import { KeyedLimiter } from '../src/security/rateLimit';
import { CODE_ALPHABET, CODE_LENGTH, RoomCodeRegistry } from '../src/security/roomCodes';
import { createRoom, joinOptions, resolveCode, startServer } from './net';

/** Uses the production join limiter (all requests come from one IP). */
let server: GameServer & { url: string };

beforeAll(async () => {
  server = await startServer({}, true);
});

afterAll(async () => {
  await server.close();
});

describe('join-code abuse protection', () => {
  it('blocks an IP after repeated wrong codes, even for valid codes afterwards', async () => {
    const host = await createRoom(server.url);
    const { roomCode } = await host.wait<{ roomCode: string }>('welcome');
    const statuses: number[] = [];
    for (let i = 0; i < MATCH_CONFIG.maxFailedCodeGuesses + 2; i++) {
      statuses.push((await resolveCode(server.url, `ZZZZZ${CODE_ALPHABET.charAt(i)}`)).status);
    }
    expect(statuses.slice(0, MATCH_CONFIG.maxFailedCodeGuesses)).toEqual(new Array(MATCH_CONFIG.maxFailedCodeGuesses).fill(404));
    expect(statuses.at(-1)).toBe(429);
    expect((await resolveCode(server.url, roomCode)).status).toBe(429);
    await host.room.leave();
  });

  it('also counts wrong codes presented directly to a room', async () => {
    // The IP is already blocked by the previous test: direct joins are refused too.
    const host = await createRoom(server.url);
    await host.wait('welcome');
    await expect(new Client(server.url).joinById(host.room.roomId, joinOptions({ code: 'ABCDEF' }))).rejects.toThrow(
      /too_many_attempts/,
    );
    await host.room.leave();
  });
});

describe('room codes', () => {
  it('are 6 characters from an unambiguous 32-character alphabet, unique among active rooms', () => {
    const registry = new RoomCodeRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = registry.generate();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
      registry.register(code, { roomId: `r${i}`, status: () => 'joinable' });
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
    expect(CODE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it('report expired codes after release, and normalise case and whitespace', () => {
    const registry = new RoomCodeRegistry();
    const code = registry.generate();
    registry.register(code, { roomId: 'r1', status: () => 'joinable' });
    expect(registry.lookup(` ${code.toLowerCase()} `)).toEqual({ status: 'ok', roomId: 'r1' });
    registry.release(code);
    expect(registry.lookup(code)).toEqual({ status: 'expired' });
  });
});

describe('rate limiter', () => {
  it('limits per window and blocks after repeated failures', () => {
    const limiter = new KeyedLimiter(3, 1000, 2, 5000);
    expect([1, 2, 3, 4].map(() => limiter.attempt('ip', 0))).toEqual([true, true, true, false]);
    expect(limiter.attempt('ip', 1500)).toBe(true);
    limiter.fail('ip', 1500);
    limiter.fail('ip', 1500);
    expect(limiter.isBlocked('ip', 2000)).toBe(true);
    expect(limiter.attempt('ip', 2000)).toBe(false);
    expect(limiter.isBlocked('ip', 7000)).toBe(false);
  });
});
