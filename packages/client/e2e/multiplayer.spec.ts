import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { setAutopilot, snapshot } from './helpers';

/**
 * Two REAL browser contexts (desktop + phone) connected to the real game
 * server started by playwright.config.ts. No mocked opponent.
 */

async function openMultiplayer(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('menu-multiplayer').click();
  await page.getByTestId('mp-name').fill(name);
  await page.getByTestId('mp-name').blur();
}

async function twoPlayers(browser: Browser) {
  const ctxA = await browser.newContext({ ...devices['Desktop Chrome'] });
  const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await openMultiplayer(a, 'ALPHA');
  await a.getByTestId('mp-dev').check();
  await a.getByTestId('mp-create').click();
  await expect(a.getByTestId('mp-lobby')).toBeVisible();
  await expect(a.getByTestId('dev-badge')).toBeVisible();
  const code = ((await a.getByTestId('room-code').textContent()) ?? '').trim();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  await openMultiplayer(b, 'BRAVO');
  await b.getByTestId('mp-join').click();
  await b.getByTestId('mp-code').fill(code);
  await b.getByTestId('mp-join-submit').click();
  await expect(b.getByTestId('mp-lobby')).toBeVisible();
  await expect(a.getByTestId('slot-B')).toContainText('BRAVO');
  await expect(b.getByTestId('slot-A')).toContainText('ALPHA');
  return { a, b, ctxA, ctxB, code };
}

async function pickBoardsAndReady(a: Page, b: Page, boardA: string, boardB: string) {
  await a.getByTestId(`mp-board-${boardA}`).click();
  await b.getByTestId(`mp-board-${boardB}`).click();
  await expect(a.getByTestId('slot-board-B')).not.toHaveText('No board yet');
  await expect(b.getByTestId('slot-board-A')).not.toHaveText('No board yet');
  await expect(a.getByTestId('compatibility')).toBeVisible();
  await expect(b.getByTestId('compatibility')).toBeVisible();
  await b.screenshot({ path: `test-results/mp-phone-lobby-${boardA}-${boardB}.png`, fullPage: true });
  for (const p of [a, b]) {
    const accept = p.getByTestId('accept-unranked');
    if (await accept.isVisible()) {
      // Server-controlled checkbox: it turns checked once the server confirms.
      await accept.click();
      await expect(accept).toBeChecked();
    }
  }
  await a.getByTestId('ready-button').click();
  await b.getByTestId('ready-button').click();
}

async function waitForStart(p: Page) {
  await expect(p.getByTestId('countdown')).toBeVisible();
  await expect(p.getByTestId('stage').locator('canvas')).toBeVisible();
  await expect.poll(() => p.evaluate(() => !!window.__BRICK_RIOT_E2E__), { timeout: 20_000 }).toBe(true);
  await expect(p.getByTestId('countdown')).toBeHidden({ timeout: 20_000 });
}

test('two browsers: create, join by code, different boards, synchronized start, independent control, opponent progress, same verified result, rematch @mp', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { a, b, ctxA, ctxB } = await twoPlayers(browser);

  // Different boards: Chevron for A, Lattice for B (an uneven, explicitly accepted match-up).
  await pickBoardsAndReady(a, b, 'classic-03', 'classic-05');
  await Promise.all([waitForStart(a), waitForStart(b)]);
  expect((await snapshot(a)).boardId).toBe('classic-03');
  expect((await snapshot(b)).boardId).toBe('classic-05');

  // Independent paddle control: A uses the keyboard, B drags on the phone.
  const ax0 = (await snapshot(a)).paddleX;
  const bx0 = (await snapshot(b)).paddleX;
  await a.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await snapshot(a)).paddleX).toBeLessThan(ax0 - 100);
  await a.keyboard.up('ArrowLeft');
  expect((await snapshot(b)).paddleX).toBe(bx0);

  const box = await b.getByTestId('stage').locator('canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const cdp = await ctxB.newCDPSession(b);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: box.y + box.height * 0.9 }] });
  await touch('touchStart', box.x + box.width * 0.5);
  for (let i = 1; i <= 6; i++) await touch('touchMove', box.x + box.width * (0.5 + i * 0.06));
  await touch('touchEnd', 0);
  await expect.poll(async () => (await snapshot(b)).paddleX, { timeout: 20_000 }).toBeGreaterThan(bx0 + 80);

  // Both now play through the real input path: A tries to win, B burns its balls.
  await setAutopilot(a, 'win');
  await setAutopilot(b, 'lose');

  // B sees A's progress from authoritative server state.
  await expect.poll(async () => Number(((await b.getByTestId('opponent-cleared').textContent()) ?? '0').replace('%', '')), {
    timeout: 60_000,
  }).toBeGreaterThan(0);
  // A sees that B ran out of balls while A keeps playing.
  await expect(a.getByTestId('opponent-strip')).toContainText('OUT OF BALLS', { timeout: 90_000 });
  await a.screenshot({ path: 'test-results/mp-desktop-playing.png' });
  await b.screenshot({ path: 'test-results/mp-phone-playing.png' });

  // A verified result, identical on both clients.
  await expect(a.getByTestId('match-result')).toBeVisible({ timeout: 120_000 });
  await expect(b.getByTestId('match-result')).toBeVisible({ timeout: 10_000 });
  const reasonA = await a.getByTestId('result-reason').textContent();
  expect(await b.getByTestId('result-reason').textContent()).toBe(reasonA);
  await expect(a.getByTestId('result-verified')).toContainText('SERVER VERIFIED');
  await expect(b.getByTestId('result-verified')).toContainText('SERVER VERIFIED');
  const titleA = await a.getByTestId('result-title').textContent();
  const titleB = await b.getByTestId('result-title').textContent();
  if (reasonA === 'First to clear their board') {
    expect([titleA, titleB]).toEqual(['YOU WIN', 'YOU LOSE']);
  } else {
    // A did not clear within the timer: B had already run out, so the clock decides.
    expect(reasonA).toBe('Time ran out');
    expect([titleA, titleB]).toEqual(['DRAW', 'DRAW']);
  }
  // The client predictions were checked against the server throughout.
  expect((await snapshot(a)).net?.checks ?? 0).toBeGreaterThan(20);
  expect((await snapshot(b)).net?.checks ?? 0).toBeGreaterThan(20);
  await a.screenshot({ path: 'test-results/mp-desktop-result.png' });
  await b.screenshot({ path: 'test-results/mp-phone-result.png' });

  // Rematch: A asks, B accepts, both return to the lobby and start a fresh match.
  await a.getByTestId('rematch-request').click();
  await b.getByTestId('rematch-accept').click();
  await expect(a.getByTestId('mp-lobby')).toBeVisible();
  await expect(b.getByTestId('mp-lobby')).toBeVisible();
  await b.getByTestId('mp-board-classic-08').click();
  await expect(a.getByTestId('slot-board-B')).toHaveText('Slipstream');
  for (const p of [a, b]) {
    const accept = p.getByTestId('accept-unranked');
    if (await accept.isVisible()) {
      // Server-controlled checkbox: it turns checked once the server confirms.
      await accept.click();
      await expect(accept).toBeChecked();
    }
  }
  await a.getByTestId('ready-button').click();
  await b.getByTestId('ready-button').click();
  await Promise.all([waitForStart(a), waitForStart(b)]);
  expect((await snapshot(b)).boardId).toBe('classic-08');
  expect((await snapshot(b)).tick).toBeLessThan(2000);

  await ctxA.close();
  await ctxB.close();
});

test('reload rejoins the running match; abandoning forfeits after the grace period @mp', async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, b, ctxA, ctxB } = await twoPlayers(browser);
  await pickBoardsAndReady(a, b, 'classic-05', 'classic-08');
  await Promise.all([waitForStart(a), waitForStart(b)]);
  await b.keyboard.press('Space');
  await expect.poll(async () => (await snapshot(b)).score, { timeout: 30_000 }).toBeGreaterThan(0);

  // B reloads the page: the seat is held and B rejoins the same running match.
  await b.reload();
  await expect(a.getByTestId('opponent-offline')).toBeVisible({ timeout: 15_000 });
  await b.getByTestId('menu-multiplayer').click();
  await b.getByTestId('mp-rejoin').click();
  await expect(b.getByTestId('stage').locator('canvas')).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId('opponent-offline')).toBeHidden({ timeout: 15_000 });
  // The rejoined client adopted the authoritative state instead of starting over:
  // its earlier score is there (a fresh simulation would show 0).
  await expect.poll(async () => (await snapshot(b)).net?.resyncs ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await snapshot(b)).score, { timeout: 20_000 }).toBeGreaterThan(0);
  expect((await snapshot(b)).tick).toBeGreaterThan(120);

  // B disappears for good: after the grace period A wins by forfeit.
  await ctxB.close();
  await expect(a.getByTestId('opponent-offline')).toBeVisible({ timeout: 15_000 });
  await expect(a.getByTestId('match-result')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('result-title')).toHaveText('YOU WIN');
  await expect(a.getByTestId('result-reason')).toHaveText('Forfeit');
  await a.screenshot({ path: 'test-results/mp-forfeit.png' });
  await ctxA.close();
});

test('loadouts in the lobby; abilities with energy, shield block, sabotage, prediction checks across two browsers @mp', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, b, ctxA, ctxB } = await twoPlayers(browser);

  // Loadouts and Equipment Power Ratings are visible to both players.
  await expect(b.getByTestId('slot-loadout-A')).toContainText('EMP Pulse');
  await expect(a.getByTestId('slot-epr-B')).toContainText('EPR');
  // Dev room: unlocks skipped, the budget still applies (Frost 40 + Shield 25 + Accelerator 25 = 90 > 80).
  await a.getByTestId('loadout-frost').click();
  await expect(b.getByTestId('slot-loadout-A')).toContainText('Frost Brick');
  await expect(a.getByTestId('loadout-accelerator')).toBeDisabled();
  await a.getByTestId('loadout-emp').click();
  await expect(b.getByTestId('slot-loadout-A')).toContainText('EMP Pulse');

  // Equipment mode is host-only.
  await expect(b.getByTestId('equipment-mode-casualUpgrades')).toBeDisabled();

  await a.getByTestId('mp-board-classic-05').click();
  await b.getByTestId('mp-board-classic-08').click();
  await expect(a.getByTestId('slot-board-B')).not.toHaveText('No board yet');
  // Loadouts lock once ready (A readies first; B is still choosing).
  await a.getByTestId('ready-button').click();
  await expect(a.getByTestId('loadout-shrink')).toBeDisabled();
  await expect(b.getByTestId('loadout-cleanse')).toBeEnabled();
  await b.getByTestId('ready-button').click();
  await Promise.all([waitForStart(a), waitForStart(b)]);
  // Opening lockout: an attack in the first 5 s is refused, free of charge.
  // (Pressed straight after the countdown; the tick proves it was in the window.)
  await a.keyboard.press('1');
  expect((await snapshot(a)).tick).toBeLessThan(4 * 120);
  await expect(a.getByTestId('ability-feed')).toContainText('unlock', { timeout: 5_000 });
  expect((await snapshot(a)).energy).toBeGreaterThanOrEqual(100);

  await expect(a.getByTestId('ability-bar')).toBeVisible();
  await expect(b.getByTestId('ability-shield')).toBeVisible();
  await expect(a.getByTestId('energy')).toHaveText('100');

  await setAutopilot(a, 'win');
  await setAutopilot(b, 'win');

  // B raises a Shield with a TAP on the phone button.
  await expect.poll(async () => (await snapshot(b)).tick, { timeout: 20_000 }).toBeGreaterThan(6 * 120);
  await b.getByTestId('ability-shield').tap();
  await expect(b.getByTestId('own-shield')).toBeVisible({ timeout: 5_000 });
  await expect(a.getByTestId('opponent-effects')).toContainText('SHIELD', { timeout: 5_000 });

  // A's EMP (key 1) is blocked: A pays, B's shield is consumed, both are told.
  await expect.poll(async () => (await snapshot(a)).status, { timeout: 20_000 }).toBe('playing');
  await a.keyboard.press('1');
  await expect(a.getByTestId('ability-feed')).toContainText('blocked by Shield', { timeout: 10_000 });
  await expect(b.getByTestId('ability-feed')).toContainText('Shield blocked', { timeout: 10_000 });
  await expect(b.getByTestId('own-shield')).toBeHidden({ timeout: 5_000 });
  await expect(a.getByTestId('ability-emp')).toHaveAttribute('aria-disabled', 'true');
  await a.screenshot({ path: 'test-results/mp-ability-blocked-desktop.png' });
  await b.screenshot({ path: 'test-results/mp-ability-blocked-phone.png' });

  // After the 12 s cooldown, the next EMP lands: B's prediction shows the debuff.
  await expect(a.getByTestId('ability-emp')).toHaveAttribute('aria-disabled', 'false', { timeout: 20_000 });
  let landed = false;
  for (let attempt = 0; attempt < 20 && !landed; attempt++) {
    await expect.poll(async () => (await snapshot(b)).status, { timeout: 20_000 }).toBe('playing');
    await a.getByTestId('ability-emp').click();
    landed = await expect
      .poll(async () => (await snapshot(b)).debuff, { timeout: 3_000 })
      .toBe('emp')
      .then(() => true, () => false);
  }
  expect(landed).toBe(true);
  await expect(b.getByTestId('own-debuff')).toBeVisible();
  await b.screenshot({ path: 'test-results/mp-ability-emp-phone.png' });
  await expect.poll(async () => (await snapshot(b)).debuff, { timeout: 10_000 }).toBeNull();

  // Prediction was checked against the server throughout. Exact-tick command
  // delivery is unit-tested (net.test.ts); here, two software-rendered browsers
  // share one CPU, so some inputs reach the server late and the checksum/resync
  // fallback corrects them (measured ~20% late inputs in this environment).
  // Here we require that checking continues after the effects.
  const netB = (await snapshot(b)).net;
  expect(netB?.checks ?? 0).toBeGreaterThan(20);
  const before = (await snapshot(b)).net?.checks ?? 0;
  await expect.poll(async () => (await snapshot(b)).net?.checks ?? 0, { timeout: 10_000 }).toBeGreaterThan(before + 5);
  await a.screenshot({ path: 'test-results/mp-ability-desktop.png' });

  await ctxA.close();
  await ctxB.close();
});

test('workshop: confirmed purchase is atomic and persists; reduce-effects setting @desktop', async ({ page }) => {
  await page.goto('/');
  // Seed a save with coins (v2 format) through the real repository key.
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
          xp: 0,
          coins: 400,
          upgrades: { paddleControl: 0, paddleWidth: 0, ballPower: 0, magnetDuration: 0, startingEnergy: 0 },
          loadout: { offensive: 'emp', defensive: 'shield', passive: 'quickRelaunch' },
          settings: { reducedEffects: false },
          boards: {},
          history: [],
          appliedRunIds: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  });
  await page.reload();
  await page.getByTestId('menu-workshop').click();
  await expect(page.getByTestId('workshop-coins')).toHaveText('400 C');
  await page.getByTestId('buy-paddleWidth').click();
  await page.getByTestId('confirm-buy').click();
  await expect(page.getByTestId('workshop-message')).toContainText('upgraded to level 1');
  await expect(page.getByTestId('workshop-coins')).toHaveText('250 C');
  // Cannot afford the next level (280): the button is disabled.
  await expect(page.getByTestId('buy-paddleWidth')).toBeDisabled();
  await page.getByTestId('reduced-effects').check();
  await page.screenshot({ path: 'test-results/workshop.png', fullPage: true });

  await page.reload();
  await page.getByTestId('menu-workshop').click();
  await expect(page.getByTestId('workshop-coins')).toHaveText('250 C');
  await expect(page.getByTestId('upgrade-paddleWidth')).toContainText('+3% width');
  await expect(page.getByTestId('reduced-effects')).toBeChecked();
});

test('invalid codes are reported and do not join @mp', async ({ page }) => {
  await openMultiplayer(page, 'GAMMA');
  await page.getByTestId('mp-join').click();
  await page.getByTestId('mp-code').fill('ZZZZZZ');
  await page.getByTestId('mp-join-submit').click();
  await expect(page.getByTestId('mp-error')).toHaveText('No room with that code.');
  await expect(page.getByTestId('mp-lobby')).toHaveCount(0);
});
