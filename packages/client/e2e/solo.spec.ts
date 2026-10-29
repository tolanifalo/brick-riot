import { expect, test, type Page } from '@playwright/test';
import { score, setAutopilot, snapshot, startBoard, worldXAt } from './helpers';

const startSolo = (page: Page) => startBoard(page, 'classic-01');

test('main menu offers solo, multiplayer and the workshop and labels unbuilt modes as unavailable @desktop @mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /BRICK\s*RIOT/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /PLAY SOLO/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^MULTIPLAYER\b/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^WORKSHOP\b/ })).toBeEnabled();
  // Phase 5: the e2e server has accounts, so Quick Match and Leaderboards are live.
  await expect(page.getByTestId('menu-quickmatch')).toBeEnabled();
  await expect(page.getByTestId('menu-leaderboards')).toBeEnabled();
  const boards = page.getByRole('button', { name: /^BOARDS\b/ });
  await expect(boards).toBeDisabled();
  await expect(boards).toContainText('Unavailable');
});

test('launch, break bricks, pause freezes time, restart resets @desktop', async ({ page }) => {
  await startSolo(page);
  await expect(score(page)).toHaveText('0');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('launch-hint')).toBeHidden();
  await expect(score(page)).not.toHaveText('0', { timeout: 8_000 });

  await page.keyboard.press('p');
  await expect(page.getByRole('dialog', { name: 'PAUSED' })).toBeVisible();
  const frozen = await snapshot(page);
  const frozenTime = await page.getByTestId('hud-time').textContent();
  await page.waitForTimeout(600);
  const later = await snapshot(page);
  expect(later.balls).toEqual(frozen.balls);
  await expect(page.getByTestId('hud-time')).toHaveText(frozenTime ?? '');
  await page.getByRole('button', { name: 'RESUME', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'PAUSED' })).toBeHidden();

  await page.keyboard.press('r');
  await expect(score(page)).toHaveText('0');
  await expect(page.getByTestId('launch-hint')).toBeVisible();
  expect((await snapshot(page)).status).toBe('ready');
});

test('keyboard moves the paddle @desktop', async ({ page }) => {
  await startSolo(page);
  const start = (await snapshot(page)).paddleX;
  await page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await snapshot(page)).paddleX).toBeGreaterThan(start + 100);
  await page.keyboard.up('ArrowRight');
});

test('losing every ball ends the run deterministically; retry restarts @desktop', async ({ page }) => {
  await startSolo(page);
  // The 'lose' autopilot keeps the paddle on the opposite side from the ball, so
  // every ball is missed; the outcome does not depend on timing or luck.
  await setAutopilot(page, 'lose', 8);
  await expect(page.getByRole('dialog', { name: 'OUT OF BALLS' })).toBeVisible({ timeout: 60_000 });
  const end = await snapshot(page);
  expect(end.status).toBe('lost');
  expect(end.lives).toBe(0);
  await setAutopilot(page, 'off');
  await page.getByRole('button', { name: 'RETRY' }).click();
  await expect(score(page)).toHaveText('0');
  await expect(page.getByTestId('hud-lives').locator('.life.on')).toHaveCount(3);
});

test('touch drag moves the paddle to the finger, tap launches @mobile', async ({ page }) => {
  await startSolo(page);
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

  // Drag in the thumb zone below the playfield, from the centre to 20% across.
  const y = Math.min(box.y + box.height + 16, (page.viewportSize()?.height ?? 800) - 4);
  const from = await worldXAt(page, 0.5);
  const to = await worldXAt(page, 0.2);
  await touch('touchStart', from.clientX, y);
  for (let i = 1; i <= 8; i++) await touch('touchMove', from.clientX + ((to.clientX - from.clientX) * i) / 8, y);
  await expect.poll(async () => (await snapshot(page)).paddleX, { timeout: 20_000 }).toBeCloseTo(to.worldX, 0);
  // The ball rides on the paddle while waiting to launch.
  const s = await snapshot(page);
  expect(s.balls[0]?.attached).toBe(true);
  expect(s.balls[0]?.x).toBeCloseTo(s.paddleX, 5);

  // Drag to the right edge: the paddle clamps inside the field.
  const right = await worldXAt(page, 0.98);
  for (let i = 1; i <= 8; i++) await touch('touchMove', to.clientX + ((right.clientX - to.clientX) * i) / 8, y);
  await expect.poll(async () => (await snapshot(page)).paddleX, { timeout: 20_000 }).toBeCloseTo(480 - s.paddleWidth / 2, 0);
  await touch('touchEnd', 0, 0);

  // A short tap launches.
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.8);
  await expect(page.getByTestId('launch-hint')).toBeHidden();
  await expect.poll(async () => (await snapshot(page)).status).toBe('playing');
});

test('high-DPI phone renders a 2x canvas that fits portrait and landscape @hires', async ({ page }) => {
  await startSolo(page);
  const canvas = page.locator('canvas');
  expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([960, 1600]);

  const fits = async () => {
    const box = await canvas.boundingBox();
    const vp = page.viewportSize();
    if (!box || !vp) throw new Error('no layout');
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.y).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
    expect(box.width / box.height).toBeCloseTo(0.6, 2);
    return box;
  };
  const portrait = await fits();
  expect(portrait.width).toBeGreaterThan(400);
  await page.screenshot({ path: 'test-results/hires-portrait.png' });

  // Rotate to landscape: the field shrinks to fit the height without overflow.
  await page.setViewportSize({ width: 932, height: 430 });
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 9999).toBeLessThan(430);
  await fits();
  // HUD readouts must not collide when the field column is narrow.
  const time = await page.getByTestId('hud-time').boundingBox();
  const lives = await page.getByTestId('hud-lives').boundingBox();
  const scoreBox = await page.getByTestId('hud-score').boundingBox();
  if (!time || !lives || !scoreBox) throw new Error('HUD not laid out');
  expect(scoreBox.x + scoreBox.width).toBeLessThanOrEqual(time.x);
  expect(time.x + time.width).toBeLessThanOrEqual(lives.x);
  await page.screenshot({ path: 'test-results/hires-landscape.png' });
});
