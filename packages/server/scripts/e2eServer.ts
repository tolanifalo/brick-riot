/**
 * Browser-test server (Playwright): a throwaway embedded PostgreSQL with the
 * committed migrations applied, then the real game server on PORT.
 * TEST ONLY: uses development settings (dev mail outbox, relaxed auth limits)
 * that production refuses.
 */
import pg from 'pg';
import { createGameServer } from '../src/app';
import { loadConfig } from '../src/config';
import { applyMigrations } from '../src/db/client';
import { startEmbeddedPostgres } from '../src/db/embedded';

const database = await startEmbeddedPostgres();
const admin = new pg.Client({ connectionString: database.adminUrl });
await admin.connect();
await admin.query('CREATE DATABASE "brickriot_e2e"');
await admin.end();
const url = new URL(database.adminUrl);
url.pathname = '/brickriot_e2e';
await applyMigrations(url.toString());

const config = loadConfig({ ...process.env, DATABASE_URL: url.toString() });
const server = await createGameServer(config);
console.log(`e2e game server on :${server.port} (PostgreSQL ${database.port})`);

const shutdown = () => {
  void server
    .close()
    .then(() => server.services.db?.$disconnect())
    .then(() => database.stop())
    .then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
