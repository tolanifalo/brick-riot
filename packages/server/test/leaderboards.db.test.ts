import type { LeaderboardPage, ProfileView, RankedStatus } from '@brick-riot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, register, startAccountServer, type AccountServer } from './support/accounts';

let t: AccountServer;
const ids: string[] = [];

beforeAll(async () => {
  t = await startAccountServer();
  // 25 verified players with solo_time entries 1000..3400 ticks (in shuffled insert order),
  // plus one unverified player with the best time of all.
  const order = Array.from({ length: 25 }, (_, i) => i).sort((a, b) => ((a * 7) % 25) - ((b * 7) % 25));
  for (const i of order) {
    const { browser, email } = await register(t.url, `Runner${String(i).padStart(2, '0')}`);
    const id = ((await browser.get('/api/me')).body as ProfileView).account.id;
    ids[i] = id;
    await t.database.db.user.update({ where: { email }, data: { emailVerified: true } });
    await t.database.db.leaderboardEntry.create({
      data: { category: 'solo_time', boardId: 'classic-02', seasonId: 'preseason', userId: id, value: 1000 + i * 100, evidenceId: `run-${i}` },
    });
  }
  const { browser } = await register(t.url, 'Unverified');
  const id = ((await browser.get('/api/me')).body as ProfileView).account.id;
  await t.database.db.leaderboardEntry.create({
    data: { category: 'solo_time', boardId: 'classic-02', seasonId: 'preseason', userId: id, value: 1, evidenceId: 'run-x' },
  });
});

afterAll(async () => {
  await t.close();
});

describe('leaderboards', () => {
  it('sorts (fastest first), paginates and counts; unverified emails are not listed', async () => {
    const anon = new Browser(t.url);
    const p1 = (await anon.get('/api/leaderboards/solo_time?board=classic-02&pageSize=10')).body as LeaderboardPage;
    expect(p1.total).toBe(25);
    expect(p1.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p1.rows[0]).toMatchObject({ name: 'Runner00', value: 1000 });
    expect(p1.rows.every((r, i, all) => i === 0 || (all[i - 1]?.value ?? 0) <= r.value)).toBe(true);
    const p3 = (await anon.get('/api/leaderboards/solo_time?board=classic-02&pageSize=10&page=3')).body as LeaderboardPage;
    expect(p3.rows.map((r) => r.rank)).toEqual([21, 22, 23, 24, 25]);
    expect(p3.rows.map((r) => r.name)).not.toContain('Unverified');
    expect(p1.me).toBeNull();
  });

  it('one row per player and category: a duplicate entry is impossible', async () => {
    await expect(
      t.database.db.leaderboardEntry.create({
        data: { category: 'solo_time', boardId: 'classic-02', seasonId: 'preseason', userId: ids[3] ?? '', value: 5, evidenceId: 'dup' },
      }),
    ).rejects.toThrow();
  });

  it('validates categories and boards; caps page size', async () => {
    const anon = new Browser(t.url);
    expect((await anon.get('/api/leaderboards/ranked_rating')).status).toBe(400);
    expect((await anon.get('/api/leaderboards/solo_time')).status).toBe(400);
    expect((await anon.get('/api/leaderboards/solo_time?board=nope')).status).toBe(400);
    const big = (await anon.get('/api/leaderboards/solo_time?board=classic-02&pageSize=5000')).body as LeaderboardPage;
    expect(big.pageSize).toBe(50);
  });

  it('ranked play reports itself disabled with its blockers', async () => {
    const status = (await new Browser(t.url).get('/api/ranked/status')).body as RankedStatus;
    expect(status.enabled).toBe(false);
    expect(status.blockers.length).toBeGreaterThan(0);
  });

  it('board telemetry aggregates without player data', async () => {
    const res = await new Browser(t.url).get('/api/telemetry/boards');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ boards: [], pairings: [], equipmentGap: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.test/);
  });
});
