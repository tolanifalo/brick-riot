import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// packages/server/.env (git-ignored; written by `npm run db:start`). Real
// environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Prisma 7 configuration. DATABASE_URL is read from the environment (or
 * packages/server/.env). Migrations are committed SQL.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx --env-file-if-exists=.env prisma/seed.ts' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://invalid:invalid@127.0.0.1:1/unset' },
});
