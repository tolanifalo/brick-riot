import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Starts one throwaway PostgreSQL (embedded-postgres) for the run.
    globalSetup: ['test/support/globalSetup.ts'],
    hookTimeout: 60_000,
  },
});
