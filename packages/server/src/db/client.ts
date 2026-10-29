import { PrismaPg } from '@prisma/adapter-pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client';

export type Db = PrismaClient;
export { Prisma } from '../generated/prisma/client';

/** Prisma client over node-postgres. One per process; close it on shutdown. */
export function createDb(databaseUrl: string, maxConnections = 10): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: maxConnections }) });
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations');

/** Committed migration folders, oldest first. */
export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8') }));
}

/**
 * Applies the committed migrations to an EMPTY database (tests and the e2e
 * server). Real deployments use `prisma migrate deploy`, which runs the same
 * SQL files and records them in _prisma_migrations.
 */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const m of migrationFiles()) await client.query(m.sql);
  } finally {
    await client.end();
  }
}
