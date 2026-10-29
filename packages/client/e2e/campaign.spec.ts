import { expect, test } from '@playwright/test';
import { setAutopilot, snapshot, startBoard } from './helpers';

test('campaign lists 12 levels; only level 1 starts unlocked @desktop @mobile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /PLAY SOLO/ }).click();
  const cards = page.locator('[data-testid^="level-card-"]');
  await expect(cards).toHaveCount(12);
  await expect(page.getByTestId('level-card-classic-01')).toHaveAttribute('data-locked', 'false');
  await expect(page.getByTestId('level-card-classic-01')).toContainText('CURRENT');
  for (let n = 2; n <= 12; n++) {
    const id = `classic-${String(n).padStart(2, '0')}`;
    await expect(page.getByTestId(`level-card-${id}`)).toHaveAttribute('data-locked', 'true');
  }
  await expect(page.getByTestId('next-unlock')).toContainText('2. Twin Pillars');

  // A locked level shows its requirement and cannot be started.
  await page.getByTestId('level-card-classic-05').click();
  const play = page.getByTestId('play-board');
  await expect(play).toBeDisabled();
  await expect(play).toContainText('Clear 4. Corridor');
  await play.click({ force: true });
  await expect(page.locator('canvas')).toHaveCount(0);

  // Mastery objectives and rewards are visible for the selected board.
  await page.getByTestId('level-card-classic-01').click();
  await expect(page.getByTestId('mastery-list').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('mastery-list')).toContainText('XP');

  await page.getByTestId('back-to-menu').click();
  await expect(page.getByRole('heading', { name: /BRICK\s*RIOT/ })).toBeVisible();
});

test('clearing level 1 records the result, rewards XP and coins, unlocks level 2, and survives a reload @desktop', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await startBoard(page, 'classic-01');
  // The scripted autoplayer plays through the real input path, faster than real time.
  await setAutopilot(page, 'win', 32);
  const result = page.getByRole('dialog', { name: 'BOARD CLEAR' });
  await expect(result).toBeVisible({ timeout: 150_000 });
  expect((await snapshot(page)).status).toBe('won');

  await expect(page.getByTestId('rewards')).toBeVisible();
  const xpText = (await page.getByTestId('reward-xp').textContent()) ?? '';
  const xp = Number(xpText.replace(/\D/g, ''));
  expect(xp).toBeGreaterThan(0);
  await expect(page.getByTestId('unlock-notice')).toContainText('2. Twin Pillars');
  await expect(page.getByTestId('next-level')).toBeVisible();
  // After the reward animations, every action must be reachable without scrolling.
  await page.waitForTimeout(2500);
  const viewport = page.viewportSize();
  for (const name of [/NEXT: TWIN PILLARS/, /PLAY AGAIN/, /LEVELS/]) {
    const box = await result.getByRole('button', { name }).boundingBox();
    expect(box && viewport && box.y + box.height <= viewport.height).toBe(true);
  }
  await page.screenshot({ path: 'test-results/campaign-clear.png' });

  // Restarting the browser page must keep the progress.
  await page.reload();
  await page.getByRole('button', { name: /PLAY SOLO/ }).click();
  await expect(page.getByTestId('campaign-cleared')).toHaveText('1/12 cleared');
  await expect(page.getByTestId('level-card-classic-02')).toHaveAttribute('data-locked', 'false');
  await expect(page.getByTestId('level-card-classic-02')).toContainText('CURRENT');
  await expect(page.getByTestId('level-card-classic-01')).not.toContainText('Not cleared');
  const savedXp = await page.evaluate(() => {
    const raw = window.localStorage.getItem('brick-riot:save');
    return raw ? (JSON.parse(raw) as { data: { xp: number } }).data.xp : -1;
  });
  expect(savedXp).toBe(xp);
  await page.screenshot({ path: 'test-results/campaign-after-reload.png', fullPage: true });

  // Level 2 is now playable from the campaign screen.
  await page.getByTestId('level-card-classic-02').click();
  await page.getByTestId('play-board').click();
  await expect(page.locator('canvas')).toBeVisible();
  expect((await snapshot(page)).boardId).toBe('classic-02');
});

test('a corrupted save is recovered without crashing @desktop', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('brick-riot:save', '{"format":"brick-riot-save","version":1,"da');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('could not be read');
  await expect(page.getByRole('button', { name: /PLAY SOLO/ })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('brick-riot:save:quarantine'))).toContain('brick-riot-save');
  await startBoard(page, 'classic-01');
  expect((await snapshot(page)).status).toBe('ready');
});

/** A well-formed save in which boards 1-11 are cleared, so later boards can be opened. */
function seededSave(): string {
  const boards: Record<string, unknown> = {};
  for (let n = 1; n <= 11; n++) {
    const id = `classic-${String(n).padStart(2, '0')}`;
    boards[id] = { boardId: id, attempts: 1, completions: 1, bestScore: 1000, bestTimeMs: 100_000, bestStars: 1, mastery: [] };
  }
  return JSON.stringify({
    format: 'brick-riot-save',
    version: 1,
    savedAt: '2026-10-24T00:00:00.000Z',
    data: { xp: 5000, coins: 300, boards, history: [], appliedRunIds: [] },
  });
}

test('late boards render moving bricks, capsules and active power-ups @desktop', async ({ page }) => {
  await page.addInitScript((save) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('brick-riot:save', save);
      sessionStorage.setItem('seeded', '1');
    }
  }, seededSave());
  await startBoard(page, 'classic-12');
  const before = await page.evaluate(() => window.__BRICK_RIOT_E2E__?.snapshot().boardId);
  expect(before).toBe('classic-12');
  await setAutopilot(page, 'win', 4);
  // Let the bot play until a power-up chip appears (or give up after a while).
  await page.getByTestId('effect-chips').waitFor({ timeout: 60_000 }).catch(() => undefined);
  await page.screenshot({ path: 'test-results/late-board.png' });
  await setAutopilot(page, 'off');
  expect((await snapshot(page)).status).not.toBe('lost');
  // Paused, transient hit flashes must have cleared.
  await page.keyboard.press('p');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/late-board-paused.png' });
});

test('campaign is usable on a phone @mobile', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /PLAY SOLO/ }).click();
  await expect(page.getByTestId('level-card-classic-01')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/campaign-mobile.png', fullPage: true });
  await page.getByTestId('level-card-classic-01').tap();
  await page.getByTestId('play-board').tap();
  await expect(page.locator('canvas')).toBeVisible();
});
