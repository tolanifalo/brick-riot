import type { ServerConfig } from './config';
import { createAuth, type AuthInstance } from './auth/auth';
import { createMailer, type Mailer } from './auth/mailer';
import { GameTickets } from './auth/tickets';
import { createDb, type Db } from './db/client';
import { InMemoryMatchResultRepository, type MatchResultRepository } from './persistence/matchResults';
import { PrismaMatchResultRepository } from './persistence/prismaMatchResults';
import { ProgressionService } from './progression/service';
import { provisionPlayer } from './progression/provision';
import { KeyedLimiter } from './security/rateLimit';
import { RoomCodeRegistry } from './security/roomCodes';
import { InMemoryBalanceTelemetry, type BalanceTelemetry } from './telemetry';
import { MATCH_CONFIG } from '@brick-riot/shared';

/** Process-wide services shared by the HTTP API and all match rooms. */
export interface Services {
  config: ServerConfig;
  codes: RoomCodeRegistry;
  /** Join-code lookups and failed guesses, per client IP. */
  joinLimiter: KeyedLimiter;
  results: MatchResultRepository;
  telemetry: BalanceTelemetry;
  mailer: Mailer;
  tickets: GameTickets;
  /** Null in guest-only mode (no DATABASE_URL). */
  db: Db | null;
  auth: AuthInstance | null;
  progression: ProgressionService | null;
}

let current: Services | null = null;

export function createServices(config: ServerConfig, overrides: Partial<Services> = {}): Services {
  const mailer = overrides.mailer ?? createMailer(config);
  const db = overrides.db !== undefined ? overrides.db : config.databaseUrl ? createDb(config.databaseUrl) : null;
  const auth = db ? createAuth({ db, config, mailer, provisionPlayer: (userId) => provisionPlayer(db, userId) }) : null;
  const progression = overrides.progression !== undefined ? overrides.progression : db ? new ProgressionService(db) : null;
  return {
    config,
    codes: new RoomCodeRegistry(),
    joinLimiter: new KeyedLimiter(MATCH_CONFIG.codeLookupsPerMinute, 60_000, MATCH_CONFIG.maxFailedCodeGuesses, 10 * 60_000),
    results: db ? new PrismaMatchResultRepository(db, progression) : new InMemoryMatchResultRepository(),
    telemetry: new InMemoryBalanceTelemetry(),
    tickets: new GameTickets(),
    progression,
    ...overrides,
    mailer,
    db,
    auth,
  };
}

export function setServices(services: Services): void {
  current = services;
}

export function getServices(): Services {
  if (!current) throw new Error('services not initialised');
  return current;
}
