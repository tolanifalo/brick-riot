import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'] } },
      // Long-running board calibration report; `npm run calibrate`.
      { test: { name: 'calibrate', include: ['scripts/**/*.test.ts'], testTimeout: 600_000 } },
    ],
  },
});
