import { serverHttpUrl } from './serverUrl';

/**
 * HTTP client for the game server's account API. Sessions are HTTP-only
 * cookies set by the server (never readable from JavaScript); every request
 * sends them (`credentials: 'include'`) and speaks JSON, which the server's
 * CSRF guard requires for state-changing calls.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const MESSAGES: Record<string, string> = {
  network: 'Cannot reach the game server.',
  accounts_unavailable: 'Accounts are not available on this server.',
  not_signed_in: 'Please sign in.',
  INVALID_EMAIL_OR_PASSWORD: 'Wrong email or password.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with this email already exists.',
  PASSWORD_TOO_SHORT: 'Use at least 10 characters for your password.',
  PASSWORD_TOO_LONG: 'That password is too long.',
  INVALID_EMAIL: 'That email address does not look right.',
  INVALID_TOKEN: 'This link is invalid or has expired. Ask for a new one.',
  INVALID_PASSWORD: 'Wrong password.',
  SESSION_EXPIRED: 'Please sign in again to do this.',
  too_many_requests: 'Too many attempts. Wait a minute and try again.',
  insufficient_coins: 'Not enough coins.',
  max_level: 'Already at max level.',
  stale_level: 'That upgrade changed in the meantime. Refresh and try again.',
  not_owned: 'You have not unlocked that ability yet.',
  locked: 'That is not unlocked yet.',
  over_budget: 'That loadout is over the power budget.',
  board_locked: 'That board is locked.',
  invalid_save: 'The local save could not be read.',
  already_imported: 'Local progress was already imported into this account.',
  empty_save: 'There is no local progress to import.',
  too_large: 'That is too large to upload.',
  internal: 'Something went wrong on the server.',
};

export function describeApiError(err: unknown): string {
  if (err instanceof ApiRequestError) return MESSAGES[err.code] ?? `Request failed (${err.code}).`;
  return MESSAGES.network ?? 'Network error.';
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverHttpUrl()}${path}`, {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'network');
  }
  const text = await res.text();
  const data = parseJson(text);
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    const code = res.status === 429 ? 'too_many_requests' : (d?.error ?? d?.code ?? `http_${res.status}`);
    throw new ApiRequestError(res.status, code);
  }
  return data as T;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A fresh idempotency key: reuse the SAME key when retrying the same purchase. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
}
