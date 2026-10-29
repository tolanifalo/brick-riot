import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { setAutopilot, snapshot, waitForGame } from './helpers';

/**
 * Accounts against the REAL game server and PostgreSQL started by
 * playwright.config.ts (scripts/e2eServer.ts). Emails go to the server's
 * development outbox, which these tests read like a mailbox.
 */
const SERVER = 'http://localhost:2599';
const PASSWORD = 'arcade password 77';

let counter = 0;
const uniqueEmail = (p: string) => `${p}${Date.now().toString(36)}${counter++}@example.test`;

async function outboxLink(page: Page, to: string, kind: 'verify-email' | 'reset-password'): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const res = await page.request.get(`${SERVER}/api/dev/outbox?to=${encodeURIComponent(to)}&kind=${kind}`);
      if (!res.ok()) return '';
      link = ((await res.json()) as { link: string }).link;
      return link;
    })
    .not.toBe('');
  return link;
}

async function registerViaUi(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('menu-signin').click();
  await page.getByTestId('tab-register').click();
  await page.getByTestId('account-name').fill(name);
  await page.getByTestId('account-email').fill(email);
  await page.getByTestId('account-password').fill(PASSWORD);
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('profile-screen')).toBeVisible();
}

/** Clears level 1 (Kickoff) signed in (server-verified run) with the autopilot. */
async function clearFirstBoard(page: Page): Promise<void> {
  await page.getByTestId('profile-back').click();
  await page.getByRole('button', { name: /PLAY SOLO/ }).click();
  await page.getByTestId('level-card-classic-01').click();
  await page.getByTestId('play-board').click();
  await waitForGame(page);
  await setAutopilot(page, 'win', 32);
  await expect(page.getByRole('dialog', { name: 'BOARD CLEAR' })).toBeVisible({ timeout: 150_000 });
  expect((await snapshot(page)).status).toBe('won');
  await expect(page.getByTestId('rewards')).toBeVisible({ timeout: 20_000 });
}

test('register, import guest progress (unverified), verify email, server-verified solo clear, profile and leaderboard @desktop', async ({ page }) => {
  test.setTimeout(240_000);
  // A guest save with coins and XP that must NOT be imported.
  await page.goto('/');
  await page.evaluate(() => {
    const now = new Date().toISOString();
    localStorage.setItem(
      'brick-riot:save',
      JSON.stringify({
        format: 'brick-riot-save',
        version: 2,
        savedAt: now,
        data: {
          version: 2,
          xp: 5000,
          coins: 9999,
          upgrades: { paddleControl: 5, paddleWidth: 0, ballPower: 0, magnetDuration: 0, startingEnergy: 0 },
          loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' },
          settings: { reducedEffects: false },
          boards: { 'classic-01': { boardId: 'classic-01', attempts: 2, completions: 1, bestScore: 4321, bestTimeMs: 99000, bestStars: 1, mastery: [], firstClearedAt: now, lastPlayedAt: now } },
          history: [],
          appliedRunIds: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  });
  const email = uniqueEmail('ace');
  await registerViaUi(page, 'ACE', email);
  await expect(page.getByTestId('profile-level')).toHaveText('LEVEL 1');
  await expect(page.getByTestId('profile-coins')).toHaveText('0 C');
  await expect(page.getByTestId('verify-banner')).toBeVisible();

  // Guest import: unlocks and records only.
  await page.getByTestId('profile-tab-account').click();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-result')).toContainText('9,999 coins');
  await expect(page.getByTestId('profile-coins')).toHaveText('0 C');
  await page.getByTestId('profile-tab-overview').click();
  await expect(page.getByTestId('imported-records')).toContainText('Kickoff');

  // Email verification through the emailed link (the app reports it and refreshes).
  await page.goto(await outboxLink(page, email, 'verify-email'));
  await expect(page.getByText('Email verified. Thanks!')).toBeVisible({ timeout: 15_000 });
  // Signed in: the app returns to the profile, now verified.
  await expect(page.getByTestId('profile-screen')).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toBeHidden();

  // A server-verified run: the server picked the seed and replays the inputs.
  await clearFirstBoard(page);
  const xpText = (await page.getByTestId('reward-xp').textContent()) ?? '';
  expect(Number(xpText.replace(/\D/g, ''))).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/account-verified-clear.png' });

  // Balances, records and the leaderboard come from the server.
  await page.reload();
  await page.getByTestId('menu-profile').click();
  await expect(page.getByTestId('profile-coins')).not.toHaveText('0 C');
  await expect(page.getByTestId('records-table')).toContainText('Kickoff');
  await page.getByTestId('profile-tab-equipment').click();
  await expect(page.getByTestId('inventory-emp')).toContainText('EQUIPPED');
  await page.getByTestId('profile-back').click();
  await page.getByTestId('menu-leaderboards').click();
  await expect(page.getByTestId('lb-rows')).toContainText('ACE');
  await page.getByTestId('lb-tab-ranked').click();
  await expect(page.getByTestId('lb-ranked')).toContainText('switched off');
  await page.screenshot({ path: 'test-results/leaderboards.png', fullPage: true });
});

test('password reset through the emailed link; the old password stops working @desktop', async ({ page }) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('reset');
  await registerViaUi(page, 'RESETTER', email);
  await page.getByTestId('profile-tab-account').click();
  await page.getByTestId('sign-out').click();
  await page.getByTestId('menu-signin').click();
  await page.getByTestId('forgot-link').click();
  await page.getByTestId('account-email').fill(email);
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-info')).toContainText('If an account exists');

  await page.goto(await outboxLink(page, email, 'reset-password'));
  await expect(page.getByRole('heading', { name: 'NEW PASSWORD' })).toBeVisible({ timeout: 15_000 });
  expect(page.url()).not.toContain('token=');
  await page.getByTestId('account-password').fill('a different password 9');
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-info')).toContainText('Password changed');

  await page.getByTestId('account-email').fill(email);
  await page.getByTestId('account-password').fill(PASSWORD);
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('account-error')).toHaveText('Wrong email or password.');
  await page.getByTestId('account-password').fill('a different password 9');
  await page.getByTestId('account-submit').click();
  await expect(page.getByTestId('profile-screen')).toBeVisible();
});

async function quickPlayer(browser: Browser, device: 'Desktop Chrome' | 'Pixel 7', name: string) {
  const ctx = await browser.newContext({ ...devices[device] });
  const page = await ctx.newPage();
  await registerViaUi(page, name, uniqueEmail(name.toLowerCase()));
  await clearFirstBoard(page);
  return { ctx, page };
}

test('Quick Match: two real accounts are paired, confirm, race and get a persisted, server-verified result @mp', async ({ browser }) => {
  test.setTimeout(420_000);
  const a = await quickPlayer(browser, 'Desktop Chrome', 'QUICKA');
  const b = await quickPlayer(browser, 'Pixel 7', 'QUICKB');
  for (const p of [a.page, b.page]) {
    await p.goto('/');
    await p.getByTestId('menu-quickmatch').click();
    await expect(p.getByTestId('quick-board-classic-02')).toBeVisible();
  }
  // Nobody else is searching: A sees an honest waiting state (no bot opponent).
  await a.page.getByTestId('quick-search').click();
  await expect(a.page.getByTestId('quick-searching')).toBeVisible();
  await expect(a.page.getByTestId('quick-wait')).toContainText('1 player searching', { timeout: 10_000 });
  await a.page.screenshot({ path: 'test-results/quick-searching.png' });
  await b.page.getByTestId('quick-search').click();

  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId('quick-lobby')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('quick-note')).toContainText('choice');
  }
  await expect(a.page.getByTestId('quick-slot-opponent')).toContainText('QUICKB');
  await b.page.screenshot({ path: 'test-results/quick-lobby-phone.png' });
  await a.page.getByTestId('quick-ready').click();
  await b.page.getByTestId('quick-ready').click();
  // The 2 s countdown is too short to assert on both pages in turn; wait for the race itself.
  for (const p of [a.page, b.page]) {
    await expect.poll(() => p.evaluate(() => !!window.__BRICK_RIOT_E2E__), { timeout: 30_000 }).toBe(true);
    await expect(p.getByTestId('countdown')).toBeHidden({ timeout: 20_000 });
  }
  await setAutopilot(a.page, 'win');
  await setAutopilot(b.page, 'lose');
  await expect(a.page.getByTestId('match-result')).toBeVisible({ timeout: 150_000 });
  await expect(b.page.getByTestId('match-result')).toBeVisible({ timeout: 15_000 });
  await expect(a.page.getByTestId('result-verified')).toContainText('SERVER VERIFIED');

  // The result is in both players' persistent match history.
  for (const p of [a.page, b.page]) {
    await p.goto('/');
    await p.getByTestId('menu-profile').click();
    await p.getByTestId('profile-tab-history').click();
    await expect(p.getByTestId('history-item').first()).toContainText('Quick Match');
  }
  await a.page.screenshot({ path: 'test-results/quick-history.png', fullPage: true });
  await a.ctx.close();
  await b.ctx.close();
});
