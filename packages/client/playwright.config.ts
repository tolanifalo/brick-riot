import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against `vite build --mode e2e` (dist-e2e), which includes the
 * window.__BRICK_RIOT_E2E__ hooks. Production builds do not.
 * Multiplayer tests (@mp) also start the real game server on port 2599.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  // Headless Chromium renders WebGL in software; parallel game instances starve each other.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', grep: /@desktop/, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', grep: /@mobile/, use: { ...devices['Pixel 7'] } },
    {
      name: 'mobile-hires',
      grep: /@hires/,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
      },
    },
    // Two-browser tests create their own desktop + phone contexts.
    { name: 'multiplayer', grep: /@mp/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npx vite preview --outDir dist-e2e --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Game server + throwaway embedded PostgreSQL (accounts, persistence, Quick Match).
      command: 'npx tsx ../server/scripts/e2eServer.ts',
      url: 'http://localhost:2599/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        PORT: '2599',
        HOST: '0.0.0.0',
        NODE_ENV: 'test',
        MATCH_SECONDS: '90',
        COUNTDOWN_MS: '2000',
        RECONNECT_SECONDS: '8',
        ALLOW_DEV_ROOMS: '1',
        // Test-only (refused in production): players start with full energy so
        // ability tests need not grind energy first. Earning is unit-tested.
        TEST_START_ENERGY: '100',
        // Accounts: links point back at the e2e client; emails go to the dev outbox.
        PUBLIC_URL: 'http://localhost:2599',
        APP_URL: 'http://localhost:4174',
        DEV_MAIL_OUTBOX: '1',
        RELAXED_AUTH_LIMITS: '1',
        QUICK_READY_SECONDS: '20',
      } as Record<string, string>,
    },
  ],
});
