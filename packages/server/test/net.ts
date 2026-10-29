import { Client, type Room } from '@colyseus/sdk';
import { ROOM_NAME, type JoinOptions } from '@brick-riot/shared';
import { createGameServer, type GameServer } from '../src/app';
import { loadConfig, type ServerConfig } from '../src/config';
import { KeyedLimiter } from '../src/security/rateLimit';

export const TEST_CONFIG: Partial<ServerConfig> = {
  port: 0,
  host: '127.0.0.1',
  matchSeconds: 10,
  countdownMs: 200,
  reconnectSeconds: 1,
  lobbyIdleMinutes: 1,
  allowDevRooms: true,
  clockScale: 4,
  allowedOrigins: ['*'],
  relaxedAuthLimits: true,
};

/**
 * Starts a real server. All test traffic comes from 127.0.0.1, so functional
 * tests use a relaxed join limiter; `productionLimits` keeps the real one.
 */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  productionLimits = false,
): Promise<GameServer & { url: string }> {
  const config = loadConfig({ NODE_ENV: 'test' }, { ...TEST_CONFIG, ...overrides });
  const services = productionLimits ? {} : { joinLimiter: new KeyedLimiter(100_000, 60_000, 100_000, 1000) };
  const server = await createGameServer(config, services);
  return { ...server, url: `http://127.0.0.1:${server.port}` };
}

let profileCounter = 0;
export function joinOptions(extra: Partial<JoinOptions> = {}): JoinOptions {
  profileCounter++;
  return {
    name: `P${profileCounter}`,
    profileId: `test-profile-${profileCounter}-${Math.random().toString(36).slice(2, 10)}`,
    clearedBoardIds: [],
    xp: 0,
    ...extra,
  };
}

/** Wraps an SDK room and records every message so tests can await them. */
export class Probe {
  readonly messages: { type: string; payload: unknown }[] = [];
  private waiters: { type: string; pred: (p: unknown) => boolean; resolve: (p: unknown) => void }[] = [];

  constructor(readonly room: Room) {
    room.reconnection.enabled = false;
    room.onMessage('*', (type, payload) => this.push(String(type), payload));
  }

  private push(type: string, payload: unknown): void {
    this.messages.push({ type, payload });
    this.waiters = this.waiters.filter((w) => {
      if (w.type === type && w.pred(payload)) {
        w.resolve(payload);
        return false;
      }
      return true;
    });
  }

  last<T>(type: string): T | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m?.type === type) return m.payload as T;
    }
    return undefined;
  }

  all<T>(type: string): T[] {
    return this.messages.filter((m) => m.type === type).map((m) => m.payload as T);
  }

  /** Resolves with the first matching message (including ones already received). */
  wait<T>(type: string, pred: (p: T) => boolean = () => true, timeoutMs = 8000): Promise<T> {
    const existing = this.messages.find((m) => m.type === type && pred(m.payload as T));
    if (existing) return Promise.resolve(existing.payload as T);
    return this.waitNext(type, pred, timeoutMs);
  }

  /** Resolves with the next matching message received from now on. */
  waitNext<T>(type: string, pred: (p: T) => boolean = () => true, timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeoutMs);
      this.waiters.push({
        type,
        pred: (p) => pred(p as T),
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p as T);
        },
      });
    });
  }

  send(type: string, payload: unknown = {}): void {
    this.room.send(type as never, payload as never);
  }
}

export async function createRoom(url: string, options: Partial<JoinOptions> = {}): Promise<Probe> {
  const client = new Client(url);
  return new Probe(await client.create(ROOM_NAME, joinOptions(options)));
}

export async function resolveCode(url: string, code: string): Promise<{ status: number; body: { roomId?: string; error?: string } }> {
  const res = await fetch(`${url}/api/rooms/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, body: (await res.json()) as { roomId?: string; error?: string } };
}

export async function joinByCode(url: string, code: string, options: Partial<JoinOptions> = {}): Promise<Probe> {
  const resolved = await resolveCode(url, code);
  if (!resolved.body.roomId) throw new Error(`resolve failed: ${resolved.status} ${resolved.body.error}`);
  const client = new Client(url);
  return new Probe(await client.joinById(resolved.body.roomId, joinOptions({ code, ...options })));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Estimated server tick for a match, from the matchStart info. */
export function serverTick(start: { goAt: number; serverTime: number; ticksPerSecond: number }, offset: number): number {
  return Math.floor(((Date.now() + offset - start.goAt) * start.ticksPerSecond) / 1000);
}

/**
 * Keeps sending tick-stamped inputs (paddle under the ball isn't known here,
 * so it sweeps) until `until()` is true or `ms` passes. Launches regularly.
 */
export async function keepPlaying(
  p: Probe,
  start: { goAt: number; serverTime: number; ticksPerSecond: number },
  ms: number,
  until: () => boolean = () => false,
): Promise<void> {
  const offset = start.serverTime - Date.now();
  let seq = 100_000;
  let last = 0;
  const end = Date.now() + ms;
  while (Date.now() < end && !until()) {
    const tick = serverTick(start, offset) + 6;
    const inputs: [number, number, number, number][] = [];
    for (let t = Math.max(1, last + 1); t <= tick && inputs.length < 32; t++) {
      inputs.push([t, 240, 0, t % 24 === 0 ? 1 : 0]);
      last = t;
    }
    if (inputs.length > 0) {
      try {
        p.send('input', { seq: seq++, inputs });
      } catch {
        return; // the room was left
      }
    }
    await sleep(25);
  }
}
