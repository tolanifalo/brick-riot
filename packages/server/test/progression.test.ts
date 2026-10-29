import {
  buildPlayerConfig,
  createAutoplayer,
  createEmptyProgress,
  encodeInputLog,
  getCampaignBoard,
  serializeProgress,
  Simulation,
  type FinishRunResponse,
  type ImportSummary,
  type IssueRunResponse,
  type LeaderboardPage,
  type ProfileView,
  type PurchaseResponse,
  type TickInput,
} from '@brick-riot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { register, startAccountServer, type AccountServer, type Browser } from './support/accounts';

let t: AccountServer;

beforeAll(async () => {
  t = await startAccountServer();
});

afterAll(async () => {
  await t.close();
});

/** Plays a server-issued run with the autoplayer, exactly as the client would. */
function play(run: IssueRunResponse, mode: 'win' | 'lose' = 'win'): TickInput[] {
  const board = getCampaignBoard(run.boardId);
  if (!board) throw new Error('board');
  const sim = new Simulation(board, { seed: run.seed, config: buildPlayerConfig({ loadout: null, upgrades: run.upgrades }, 'solo') });
  const bot = createAutoplayer(mode);
  const inputs: TickInput[] = [];
  while (!sim.isOver && sim.state.tick < 15 * 60 * 120) {
    const input = bot(sim);
    inputs.push(input);
    sim.step(input);
  }
  return inputs;
}

async function userId(browser: Browser): Promise<string> {
  return ((await browser.get('/api/me')).body as ProfileView).account.id;
}

async function issue(browser: Browser, boardId = 'classic-01'): Promise<IssueRunResponse> {
  const res = await browser.post('/api/solo/runs', { boardId });
  expect(res.status).toBe(200);
  return res.body as IssueRunResponse;
}

describe('verified solo runs', () => {
  it('replays the run on the server, then awards XP, coins, records and unlocks exactly once', async () => {
    const { browser } = await register(t.url, 'Solo');
    const id = await userId(browser);
    expect((await browser.post('/api/solo/runs', { boardId: 'classic-02' })).status).toBe(403);

    const run = await issue(browser);
    const inputs = encodeInputLog(play(run));
    const res = await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs });
    expect(res.status).toBe(200);
    const body = res.body as FinishRunResponse;
    expect(body.duplicate).toBe(false);
    expect(body.summary.status).toBe('won');
    expect(body.outcome.verified).toBe(true);
    expect(body.outcome.xp).toBeGreaterThan(0);
    expect(body.outcome.coins).toBeGreaterThan(0);
    expect(body.progress).toMatchObject({ xp: body.outcome.xp, coins: body.outcome.coins });

    const profile = (await browser.get('/api/me')).body as ProfileView;
    expect(profile.unlockedBoardIds).toContain('classic-02');
    const record = profile.boards.find((b) => b.boardId === 'classic-01');
    expect(record).toMatchObject({ attempts: 1, completions: 1, bestScore: body.summary.score });
    expect(record?.bestTimeMs).toBeCloseTo(body.summary.elapsedMs, -1);

    const ledger = await t.database.db.ledgerEntry.findMany({ where: { userId: id } });
    expect(ledger.map((l) => [l.currency, l.amount]).sort()).toEqual(
      [
        ['coins', body.outcome.coins],
        ['xp', body.outcome.xp],
      ].sort(),
    );

    // Submitting the same run again pays nothing and returns the stored outcome.
    const again = await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs });
    expect((again.body as FinishRunResponse).duplicate).toBe(true);
    const after = (await browser.get('/api/me')).body as ProfileView;
    expect(after.progress.coins).toBe(body.outcome.coins);
    expect(await t.database.db.ledgerEntry.count({ where: { userId: id } })).toBe(2);
  });

  it('concurrent duplicate submissions are rewarded once', async () => {
    const { browser } = await register(t.url);
    const id = await userId(browser);
    const run = await issue(browser);
    const inputs = encodeInputLog(play(run));
    const results = await Promise.all(Array.from({ length: 4 }, () => browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs })));
    const fresh = results.filter((r) => r.status === 200 && !(r.body as FinishRunResponse).duplicate);
    expect(fresh).toHaveLength(1);
    const coins = (fresh[0]?.body as FinishRunResponse).outcome.coins;
    expect(((await browser.get('/api/me')).body as ProfileView).progress.coins).toBe(coins);
    expect(await t.database.db.ledgerEntry.count({ where: { userId: id, currency: 'coins' } })).toBe(1);
  });

  it('never trusts the client: unfinished, malformed, foreign and tampered logs earn nothing', async () => {
    const { browser } = await register(t.url);
    const run = await issue(browser);
    const inputs = play(run);
    // Unfinished (truncated) log.
    expect((await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs: encodeInputLog(inputs.slice(0, 200)) })).body).toEqual({ error: 'unfinished' });
    // Malformed log.
    expect((await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs: [[1, 'x', 0, 0]] })).body).toEqual({ error: 'malformed' });
    // Someone else's run id.
    const { browser: other } = await register(t.url);
    expect((await other.post(`/api/solo/runs/${run.runId}/finish`, { inputs: encodeInputLog(inputs) })).status).toBe(404);
    // A log that does not win (the bot loses on purpose): recorded as an attempt, no rewards.
    const lost = await issue(browser);
    const res = await browser.post(`/api/solo/runs/${lost.runId}/finish`, { inputs: encodeInputLog(play(lost, 'lose')) });
    const body = res.body as FinishRunResponse;
    expect(body.summary.status).toBe('lost');
    expect(body.outcome.xp).toBe(0);
    expect(body.outcome.coins).toBe(0);
    // There is no endpoint that accepts a client-reported score, coins or XP.
    expect((await browser.put('/api/me', { coins: 999999 })).status).toBe(404);
    expect((await browser.post('/api/me/coins', { coins: 999999 })).status).toBe(404);
    expect(((await browser.get('/api/me')).body as ProfileView).progress.coins).toBe(0);
  });

  it('verified clears feed the solo leaderboards (verified email only)', async () => {
    const { browser, email } = await register(t.url, 'Speedy');
    const run = await issue(browser);
    const done = (await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs: encodeInputLog(play(run)) })).body as FinishRunResponse;
    const hidden = (await browser.get('/api/leaderboards/solo_time?board=classic-01')).body as LeaderboardPage;
    expect(hidden.rows.some((r) => r.name === 'Speedy')).toBe(false);
    await t.database.db.user.update({ where: { email }, data: { emailVerified: true } });
    const shown = (await browser.get('/api/leaderboards/solo_time?board=classic-01')).body as LeaderboardPage;
    const row = shown.rows.find((r) => r.name === 'Speedy');
    expect(row?.value).toBe(Math.round((done.summary.elapsedMs * 120) / 1000));
    expect(shown.me?.name).toBe('Speedy');
  });
});

describe('workshop purchases', () => {
  async function richPlayer(coins: number) {
    const { browser } = await register(t.url);
    const id = await userId(browser);
    await t.database.db.playerProfile.update({ where: { userId: id }, data: { coins } });
    return { browser, id };
  }
  const buy = (browser: Browser, key: string, upgradeId = 'paddleWidth', expectedLevel = 0) =>
    browser.post('/api/workshop/purchase', { upgradeId, expectedLevel }, { 'Idempotency-Key': key });

  it('debits coins and raises the level atomically, with a ledger entry', async () => {
    const { browser, id } = await richPlayer(500);
    const res = await buy(browser, 'purchase-0001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ upgradeId: 'paddleWidth', level: 1, cost: 150, coins: 350, replayed: false });
    const profile = (await browser.get('/api/me')).body as ProfileView;
    expect(profile.progress.coins).toBe(350);
    expect(profile.equipment.upgrades.paddleWidth).toBe(1);
    expect(profile.equipment.equipmentPower).toBeGreaterThan(70);
    const ledger = await t.database.db.ledgerEntry.findMany({ where: { userId: id, type: 'upgrade_purchase' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: -150, balanceAfter: 350 });
  });

  it('a retried request with the same idempotency key never charges twice', async () => {
    const { browser } = await richPlayer(1000);
    const first = await buy(browser, 'retry-key-0001');
    const second = await buy(browser, 'retry-key-0001');
    expect((first.body as PurchaseResponse).replayed).toBe(false);
    expect(second.body).toMatchObject({ purchaseId: (first.body as PurchaseResponse).purchaseId, replayed: true });
    expect(((await browser.get('/api/me')).body as ProfileView).progress.coins).toBe(850);
  });

  it('concurrent purchases of the same level succeed exactly once', async () => {
    const { browser, id } = await richPlayer(10_000);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => buy(browser, `concurrent-${i}-xxxx`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => (r.body as { error: string }).error === 'stale_level')).toBe(true);
    expect((await t.database.db.playerProfile.findUniqueOrThrow({ where: { userId: id } })).coins).toBe(10_000 - 150);
    expect(await t.database.db.purchase.count({ where: { userId: id } })).toBe(1);
  });

  it('concurrent purchases never overdraw: coins cannot go negative', async () => {
    const { browser, id } = await richPlayer(400);
    // Three different upgrades costing 150 + 200 + 120 = 470 > 400.
    const results = await Promise.all([
      buy(browser, 'overdraw-a-0001', 'paddleWidth'),
      buy(browser, 'overdraw-b-0001', 'ballPower'),
      buy(browser, 'overdraw-c-0001', 'paddleControl'),
    ]);
    const ok = results.filter((r) => r.status === 200).map((r) => (r.body as PurchaseResponse).cost);
    const coins = (await t.database.db.playerProfile.findUniqueOrThrow({ where: { userId: id } })).coins;
    expect(coins).toBe(400 - ok.reduce((a, b) => a + b, 0));
    expect(coins).toBeGreaterThanOrEqual(0);
    expect(results.some((r) => (r.body as { error?: string }).error === 'insufficient_coins')).toBe(true);
  });

  it('refuses insufficient funds, stale levels, unknown upgrades, bad keys and max level', async () => {
    const { browser, id } = await richPlayer(100);
    expect((await buy(browser, 'poor-player-0001')).body).toEqual({ error: 'insufficient_coins' });
    expect((await buy(browser, 'stale-level-0001', 'paddleWidth', 3)).body).toEqual({ error: 'stale_level' });
    expect((await buy(browser, 'unknown-upg-0001', 'laserEyes')).body).toEqual({ error: 'unknown_upgrade' });
    expect((await buy(browser, 'x')).body).toEqual({ error: 'bad_idempotency_key' });
    await t.database.db.playerProfile.update({ where: { userId: id }, data: { coins: 100_000 } });
    for (let level = 0; level < 3; level++) expect((await buy(browser, `max-level-${level}-01`, 'ballPower', level)).status).toBe(200);
    expect((await buy(browser, 'max-level-3-0001', 'ballPower', 3)).body).toEqual({ error: 'max_level' });
  });
});

describe('verified loadouts', () => {
  it('rejects abilities the account does not own, even if the client claims them', async () => {
    const { browser } = await register(t.url);
    const frost = { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' };
    expect((await browser.put('/api/loadout', { loadout: frost })).status).toBe(400);
    const over = { offensive: 'emp', defensive: 'shield', passive: 'accelerator' };
    expect((await browser.put('/api/loadout', { loadout: over })).status).toBeGreaterThanOrEqual(400);
  });

  it('levelling up grants abilities, which can then be equipped and persist', async () => {
    const { browser } = await register(t.url);
    const id = await userId(browser);
    await t.database.db.playerProfile.update({ where: { userId: id }, data: { xp: 50_000 } });
    // Level-ups are granted by verified events; play one run to trigger the grant.
    const run = await issue(browser);
    await browser.post(`/api/solo/runs/${run.runId}/finish`, { inputs: encodeInputLog(play(run)) });
    const owned = ((await browser.get('/api/me')).body as ProfileView).equipment.ownedAbilities;
    expect(owned).toContain('frost');
    const frost = { offensive: 'frost', defensive: 'cleanse', passive: 'quickRelaunch' };
    const res = await browser.put('/api/loadout', { loadout: frost });
    expect(res.status).toBe(200);
    expect(((await browser.get('/api/me')).body as ProfileView).equipment.loadout).toEqual(frost);
  });
});

describe('guest progress import', () => {
  function localSave(): string {
    const p = createEmptyProgress('2026-10-01T00:00:00.000Z');
    p.xp = 99_999;
    p.coins = 77_777;
    p.upgrades = { paddleControl: 5, paddleWidth: 5, ballPower: 3, magnetDuration: 3, startingEnergy: 4 };
    p.settings.reducedEffects = true;
    p.boards['classic-01'] = { boardId: 'classic-01', attempts: 3, completions: 2, bestScore: 12_345, bestTimeMs: 90_000, bestStars: 2, mastery: ['classic-01-clear'], firstClearedAt: null, lastPlayedAt: null };
    p.boards['classic-02'] = { boardId: 'classic-02', attempts: 1, completions: 1, bestScore: 5_000, bestTimeMs: 80_000, bestStars: 1, mastery: [], firstClearedAt: null, lastPlayedAt: null };
    return serializeProgress(p, '2026-10-01T00:00:00.000Z');
  }

  it('imports unlocks, unverified records and settings, but never coins, XP or upgrades; once only', async () => {
    const { browser } = await register(t.url);
    const res = await browser.post('/api/account/import-local', { save: localSave() });
    expect(res.status).toBe(200);
    const summary = res.body as ImportSummary;
    expect(summary.boardsUnlocked).toEqual(expect.arrayContaining(['classic-02', 'classic-03']));
    expect(summary.recordsImported).toBe(2);
    expect(summary.notImported).toMatchObject({ xp: 99_999, coins: 77_777, upgradeLevels: 20, masteryObjectives: 1 });

    const profile = (await browser.get('/api/me')).body as ProfileView;
    expect(profile.progress).toMatchObject({ xp: 0, coins: 0, level: 1 });
    expect(profile.equipment.upgrades.paddleWidth).toBe(0);
    expect(profile.settings.reducedEffects).toBe(true);
    expect(profile.importedRecords.find((r) => r.boardId === 'classic-01')).toMatchObject({ completions: 2, bestScore: 12_345, bestStars: 2 });
    expect(profile.boards).toEqual([]);
    expect(profile.unlockedBoardIds).toEqual(expect.arrayContaining(['classic-01', 'classic-02', 'classic-03']));

    expect((await browser.post('/api/account/import-local', { save: localSave() })).body).toEqual({ error: 'already_imported' });
  });

  it('rejects corrupt and empty saves without changing anything', async () => {
    const { browser } = await register(t.url);
    expect((await browser.post('/api/account/import-local', { save: '{"not":"a save"' })).body).toEqual({ error: 'invalid_save' });
    expect((await browser.post('/api/account/import-local', { save: '' })).body).toEqual({ error: 'empty_save' });
    expect((await browser.post('/api/account/import-local', { save: 42 })).body).toEqual({ error: 'empty_save' });
    expect(((await browser.get('/api/me')).body as ProfileView).localImport).toBeNull();
  });
});
