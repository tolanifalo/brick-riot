import type { TestProject } from 'vitest/node';
import { startEmbeddedPostgres, type EmbeddedDatabase } from '../../src/db/embedded';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser connection to the test PostgreSQL server. */
    pgAdminUrl: string;
  }
}

let embedded: EmbeddedDatabase | null = null;

/**
 * One PostgreSQL server for the whole test run: TEST_DATABASE_URL if given
 * (needs CREATEDB), otherwise a throwaway embedded-postgres instance.
 */
export async function setup(project: TestProject): Promise<void> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    project.provide('pgAdminUrl', external);
    return;
  }
  embedded = await startEmbeddedPostgres();
  project.provide('pgAdminUrl', embedded.adminUrl);
}

export async function teardown(): Promise<void> {
  await embedded?.stop();
  embedded = null;
}
