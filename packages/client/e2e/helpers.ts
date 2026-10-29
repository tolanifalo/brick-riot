import { expect, type Page } from '@playwright/test';
import type { E2ESnapshot } from '../src/game/e2eHooks';

export const score = (page: Page) => page.getByTestId('hud-score');

export async function snapshot(page: Page): Promise<E2ESnapshot> {
  return page.evaluate(() => {
    const hooks = window.__BRICK_RIOT_E2E__;
    if (!hooks) throw new Error('e2e hooks missing: build with --mode e2e');
    return hooks.snapshot();
  });
}

export async function setAutopilot(page: Page, mode: 'win' | 'lose' | 'off', speed = 1): Promise<void> {
  await page.evaluate(
    ([m, s]) => window.__BRICK_RIOT_E2E__?.setAutopilot(m as 'win' | 'lose' | 'off', s as number),
    [mode, speed] as const,
  );
}

/** Menu -> campaign -> select board -> PLAY. */
export async function startBoard(page: Page, boardId = 'classic-01'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /PLAY SOLO/ }).click();
  await page.getByTestId(`level-card-${boardId}`).click();
  await page.getByTestId('play-board').click();
  await waitForGame(page);
}

export async function waitForGame(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('launch-hint')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.__BRICK_RIOT_E2E__)).toBe(true);
}

/** World X that a client X maps to, using the canvas's on-screen rect. */
export async function worldXAt(page: Page, fraction: number): Promise<{ clientX: number; worldX: number }> {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  return { clientX: box.x + box.width * fraction, worldX: 480 * fraction };
}
