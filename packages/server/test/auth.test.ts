import type { ProfileView } from '@brick-riot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, ORIGIN, PASSWORD, register, startAccountServer, uniqueEmail, type AccountServer } from './support/accounts';

/** Accounts over real HTTP against a real PostgreSQL database. */
let t: AccountServer;

beforeAll(async () => {
  t = await startAccountServer();
});

afterAll(async () => {
  await t.close();
});

describe('registration and login', () => {
  it('registers, provisions the player server-side, and signs in with an HTTP-only cookie', async () => {
    const browser = new Browser(t.url);
    const email = uniqueEmail();
    const res = await browser.post('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Ace' });
    expect(res.status).toBe(200);
    expect(browser.hasSession()).toBe(true);

    const me = await browser.get('/api/me');
    expect(me.status).toBe(200);
    const profile = me.body as ProfileView;
    expect(profile.account).toMatchObject({ name: 'Ace', email, emailVerified: false });
    expect(profile.progress).toMatchObject({ xp: 0, level: 1, coins: 0 });
    expect(profile.unlockedBoardIds).toEqual(['classic-01']);
    expect(profile.equipment.loadout).toEqual({ offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' });
    expect(profile.equipment.ownedAbilities.sort()).toEqual(['emp', 'quickRelaunch', 'shield']);
  });

  it('stores only a password hash and sets the session cookie HttpOnly', async () => {
    const email = uniqueEmail();
    const res = await fetch(`${t.url}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Hash' }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const user = await t.database.db.user.findUniqueOrThrow({ where: { email }, include: { accounts: true } });
    const stored = user.accounts[0]?.password ?? '';
    expect(stored).not.toContain(PASSWORD);
    expect(stored.length).toBeGreaterThan(40);
  });

  it('logs in and out; a logged-out browser cannot read the profile', async () => {
    const { email } = await register(t.url, 'Bo');
    const browser = new Browser(t.url);
    expect((await browser.post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(200);
    expect((await browser.get('/api/me')).status).toBe(200);
    expect((await browser.post('/api/auth/sign-out', {})).status).toBe(200);
    expect((await browser.get('/api/me')).status).toBe(401);
    const user = await t.database.db.user.findUniqueOrThrow({ where: { email } });
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('gives the same answer for a wrong password and an unknown email (no enumeration)', async () => {
    const { email } = await register(t.url);
    const wrong = await new Browser(t.url).post('/api/auth/sign-in/email', { email, password: 'not the password!!' });
    const unknown = await new Browser(t.url).post('/api/auth/sign-in/email', { email: uniqueEmail('ghost'), password: 'not the password!!' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects short passwords', async () => {
    const res = await new Browser(t.url).post('/api/auth/sign-up/email', { email: uniqueEmail(), password: 'short', name: 'X' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('email verification and password reset', () => {
  it('verifies an email through the emailed link', async () => {
    const { browser, email } = await register(t.url, 'Vera');
    const mail = t.outbox.latest(email, 'verify-email');
    expect(mail?.link).toContain('/api/auth/verify-email?token=');
    const path = new URL(mail?.link ?? '').pathname + new URL(mail?.link ?? '').search;
    const res = await browser.get(path);
    expect([200, 302]).toContain(res.status);
    const me = (await browser.get('/api/me')).body as ProfileView;
    expect(me.account.emailVerified).toBe(true);
  });

  it('a forged verification token does nothing', async () => {
    const { browser } = await register(t.url);
    await browser.get('/api/auth/verify-email?token=forged.token.value');
    expect(((await browser.get('/api/me')).body as ProfileView).account.emailVerified).toBe(false);
  });

  it('resets a password with the emailed token, revokes old sessions, and answers the same for unknown emails', async () => {
    const { browser: oldSession, email } = await register(t.url, 'Rex');
    const anon = new Browser(t.url);
    const known = await anon.post('/api/auth/request-password-reset', { email, redirectTo: `${ORIGIN}/reset` });
    const unknown = await anon.post('/api/auth/request-password-reset', { email: uniqueEmail('nobody'), redirectTo: `${ORIGIN}/reset` });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);

    const link = t.outbox.latest(email, 'reset-password')?.link ?? '';
    expect(link).toContain('/api/auth/reset-password/');
    const token = new URL(link).pathname.split('/').pop() ?? '';
    const bad = await anon.post('/api/auth/reset-password', { newPassword: 'a brand new password 1', token: 'not-a-token' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ok = await anon.post('/api/auth/reset-password', { newPassword: 'a brand new password 1', token });
    expect(ok.status).toBe(200);
    // The token is single-use.
    expect((await anon.post('/api/auth/reset-password', { newPassword: 'another new password 2', token })).status).toBeGreaterThanOrEqual(400);

    expect((await oldSession.get('/api/me')).status).toBe(401);
    expect((await new Browser(t.url).post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(401);
    expect((await new Browser(t.url).post('/api/auth/sign-in/email', { email, password: 'a brand new password 1' })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('expired sessions are refused', async () => {
    const { browser, email } = await register(t.url);
    const user = await t.database.db.user.findUniqueOrThrow({ where: { email } });
    await t.database.db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await browser.get('/api/me')).status).toBe(401);
  });

  it('lists and revokes sessions (sign out other devices)', async () => {
    const { browser: phone, email } = await register(t.url);
    const laptop = new Browser(t.url);
    await laptop.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    const list = await laptop.get('/api/auth/list-sessions');
    expect((list.body as unknown[]).length).toBe(2);
    expect((await laptop.post('/api/auth/revoke-other-sessions', {})).status).toBe(200);
    expect((await phone.get('/api/me')).status).toBe(401);
    expect((await laptop.get('/api/me')).status).toBe(200);
  });

  it('a suspended account cannot sign in', async () => {
    const { email } = await register(t.url);
    await t.database.db.user.update({ where: { email }, data: { status: 'suspended' } });
    expect((await new Browser(t.url).post('/api/auth/sign-in/email', { email, password: PASSWORD })).status).not.toBe(200);
  });

  it('deletes an account and all its private data', async () => {
    const { browser, email } = await register(t.url, 'Gone');
    const user = await t.database.db.user.findUniqueOrThrow({ where: { email } });
    const res = await browser.post('/api/auth/delete-user', { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await t.database.db.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await t.database.db.playerProfile.findUnique({ where: { userId: user.id } })).toBeNull();
    expect(await t.database.db.loadout.findUnique({ where: { userId: user.id } })).toBeNull();
    expect((await browser.get('/api/me')).status).toBe(401);
  });
});

describe('request security', () => {
  it('rejects state-changing requests from foreign origins (CSRF) and non-JSON bodies', async () => {
    const { browser } = await register(t.url);
    const evil = new Browser(t.url, 'https://evil.example');
    // Same cookies, foreign origin:
    (evil as unknown as { cookies: Map<string, string> }).cookies = (browser as unknown as { cookies: Map<string, string> }).cookies;
    expect((await evil.post('/api/workshop/purchase', { upgradeId: 'paddleWidth', expectedLevel: 0 }, { 'Idempotency-Key': 'evil-request-1' })).status).toBe(403);
    const form = await browser.request('POST', '/api/solo/runs', 'boardId=classic-01', { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
  });

  it('does not grant credentialed CORS to unknown origins', async () => {
    const res = await fetch(`${t.url}/api/me`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await fetch(`${t.url}/api/me`, { headers: { Origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('requires a session for private data', async () => {
    const anon = new Browser(t.url);
    expect((await anon.get('/api/me')).status).toBe(401);
    expect((await anon.get('/api/me/matches')).status).toBe(401);
    expect((await anon.post('/api/solo/runs', { boardId: 'classic-01' })).status).toBe(401);
  });

  it('public profiles expose no email or private fields', async () => {
    const { browser, email } = await register(t.url, 'Pub');
    const id = ((await browser.get('/api/me')).body as ProfileView).account.id;
    const pub = await new Browser(t.url).get(`/api/players/${id}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain(email);
    expect(Object.keys(pub.body as object).sort()).toEqual(['boardsCleared', 'id', 'level', 'masteryCount', 'memberSince', 'name', 'stats']);
  });

  it('answers CORS preflights only for allowed origins (Colyseus defaults overridden)', async () => {
    const evil = await fetch(`${t.url}/api/me`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(evil.headers.get('access-control-allow-credentials')).toBeNull();
    const good = await fetch(`${t.url}/api/me`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
    expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('production rate limits', () => {
  it('rate-limits repeated failed logins per IP', async () => {
    const strict = await startAccountServer({ relaxedAuthLimits: false });
    try {
      const { email } = await register(strict.url);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await new Browser(strict.url).post('/api/auth/sign-in/email', { email, password: 'wrong password!!' })).status);
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses).toContain(429);
      // The client cannot dodge the limit by forging the internal IP header.
      const spoofed = await new Browser(strict.url).post('/api/auth/sign-in/email', { email, password: 'wrong password!!' }, { 'x-brickriot-client-ip': '203.0.113.9' });
      expect(spoofed.status).toBe(429);
    } finally {
      await strict.close();
    }
  });
});
