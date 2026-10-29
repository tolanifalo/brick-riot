import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { applyMigrations, createDb, type Db } from '../../src/db/client';

/**
 * A fresh, fully migrated PostgreSQL database for one test file, created on
 * the server provided by the global setup (an embedded-postgres instance, or
 * TEST_DATABASE_URL when set). Dropped again on close.
 */
export interface TestDatabase {
  url: string;
  db: Db;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const name = `brickriot_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await applyMigrations(url.toString());
  const db = createDb(url.toString(), 5);
  return {
    url: url.toString(),
    db,
    close: async () => {
      await db.$disconnect();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}
