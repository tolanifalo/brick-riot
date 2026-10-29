import type { GameServer } from '../../src/app';
import type { ServerConfig } from '../../src/config';
import type { OutboxMailer } from '../../src/auth/mailer';
import { freePort } from '../../src/db/embedded';
import { startServer } from '../net';
import { createTestDatabase, type TestDatabase } from './testDb';

export const ORIGIN = 'http://localhost:5173';

/** A real game server backed by its own fresh PostgreSQL database. */
export interface AccountServer {
  url: string;
  server: GameServer & { url: string };
  database: TestDatabase;
  outbox: OutboxMailer;
  close(): Promise<void>;
}

export async function startAccountServer(overrides: Partial<ServerConfig> = {}): Promise<AccountServer> {
  const database = await createTestDatabase();
  const port = await freePort();
  const server = await startServer({ port, databaseUrl: database.url, publicUrl: `http://127.0.0.1:${port}`, appUrl: ORIGIN, ...overrides });
  return {
    url: server.url,
    server,
    database,
    outbox: server.services.mailer as OutboxMailer,
    close: async () => {
      await server.close();
      await server.services.db?.$disconnect();
      await database.close();
    },
  };
}

/** A browser-like HTTP client: keeps cookies, sends an Origin, speaks JSON. */
export class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(
    readonly base: string,
    readonly origin: string | null = ORIGIN,
  ) {}

  /** The same signed-in browser talking to another server (e.g. after a restart). */
  withBase(base: string, origin: string | null = this.origin): Browser {
    const copy = new Browser(base, origin);
    for (const [k, v] of this.cookies) copy.cookies.set(k, v);
    return copy;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  hasSession(): boolean {
    return [...this.cookies.keys()].some((k) => k.includes('session_token'));
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; location: string | null }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.origin ? { Origin: this.origin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed, location: res.headers.get('location') };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.request('POST', path, body, headers);
  }
  put(path: string, body: unknown = {}) {
    return this.request('PUT', path, body);
  }
}

let counter = 0;
export function uniqueEmail(prefix = 'player'): string {
  counter++;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

export const PASSWORD = 'correct horse battery 9';

/** Registers a new account and returns a signed-in browser. */
export async function register(base: string, name = 'Player', email = uniqueEmail()): Promise<{ browser: Browser; email: string }> {
  const browser = new Browser(base);
  const res = await browser.post('/api/auth/sign-up/email', { email, password: PASSWORD, name });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { browser, email };
}
