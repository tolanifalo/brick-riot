import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local PostgreSQL for DEVELOPMENT and TESTS only, via the `embedded-postgres`
 * devDependency (real PostgreSQL binaries, no system install, no admin rights).
 * Production always connects to a normal PostgreSQL server through DATABASE_URL.
 */
export interface EmbeddedDatabase {
  /** Connection string for the `postgres` superuser and database. */
  adminUrl: string;
  port: number;
  stop(): Promise<void>;
}

export interface EmbeddedOptions {
  /** Data directory; omitted = a throwaway temp directory deleted on stop. */
  dataDir?: string;
  port?: number;
  password?: string;
  log?: boolean;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startEmbeddedPostgres(options: EmbeddedOptions = {}): Promise<EmbeddedDatabase> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const temporary = !options.dataDir;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'brickriot-pg-'));
  const port = options.port ?? (await freePort());
  const password = options.password ?? 'brickriot-local';
  const quiet = () => undefined;
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: 'postgres',
    password,
    authMethod: 'scram-sha-256',
    persistent: !temporary,
    // Listen on localhost only: this database is never reachable from the network.
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=200'],
    onLog: options.log ? console.log : quiet,
    onError: options.log ? console.error : quiet,
  });
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  return {
    adminUrl: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
    port,
    stop: async () => {
      await pg.stop();
      if (temporary) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
