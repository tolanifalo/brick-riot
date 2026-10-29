/**
 * `npm run db:start`: local development PostgreSQL (embedded-postgres).
 *
 * - Data lives in packages/server/.pgdata (git-ignored) and survives restarts.
 * - Listens on 127.0.0.1:5433 only (never on the network).
 * - Creates the `brickriot` database, applies migrations (`prisma migrate
 *   deploy`) and writes DATABASE_URL into packages/server/.env if missing.
 * - Keep it running while you develop; Ctrl+C stops PostgreSQL cleanly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startEmbeddedPostgres } from '../src/db/embedded';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.DB_PORT ?? 5433);
const database = 'brickriot';

const server = await startEmbeddedPostgres({ dataDir: join(root, '.pgdata'), port, password: 'brickriot-local' });
const admin = new pg.Client({ connectionString: server.adminUrl });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
await admin.end();

const url = new URL(server.adminUrl);
url.pathname = `/${database}`;
const databaseUrl = url.toString();

// Run Prisma's CLI with this Node binary directly (no shell, no argument concatenation).
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const migrate = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});
if (migrate.status !== 0) {
  console.error('Migrations failed; stopping PostgreSQL.');
  await server.stop();
  process.exit(1);
}

const envFile = join(root, '.env');
const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
if (!/^DATABASE_URL=/m.test(current)) {
  writeFileSync(envFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}DATABASE_URL=${databaseUrl}\n`);
  console.log(`Wrote DATABASE_URL to ${envFile}`);
}

console.log(`\nPostgreSQL (development) running on 127.0.0.1:${port}, database "${database}".`);
console.log('Start the game server in another terminal: npm run start:server');
console.log('Press Ctrl+C to stop.\n');

const stop = () => {
  void server.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => undefined, 1 << 30);
