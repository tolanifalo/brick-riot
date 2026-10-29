const NAME_KEY = 'brick-riot:mp-name';
const PROFILE_KEY = 'brick-riot:profile-id';

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the value lives for this session only.
  }
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

let sessionProfile: string | null = null;

/**
 * Per-browser id that stops one browser taking both seats of a room. It is
 * NOT an authentication credential (accounts arrive in Phase 5).
 */
export function profileId(): string {
  const stored = safeGet(PROFILE_KEY);
  if (stored) return stored;
  sessionProfile ??= randomId();
  safeSet(PROFILE_KEY, sessionProfile);
  return sessionProfile;
}

export function loadName(): string {
  return safeGet(NAME_KEY) ?? `RIOTER-${profileId().replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()}`;
}

export function saveName(name: string): void {
  safeSet(NAME_KEY, name);
}

const TOKEN_KEY = 'brick-riot:mp-reconnect';

/** Remembers the reconnection token (session-scoped) so a reloaded tab can rejoin. */
export function saveReconnectToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, at: Date.now() }));
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function loadReconnectToken(maxAgeMs: number): string | null {
  try {
    const raw = window.sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (typeof parsed.token !== 'string' || typeof parsed.at !== 'number') return null;
    return Date.now() - parsed.at <= maxAgeMs ? parsed.token : null;
  } catch {
    return null;
  }
}
