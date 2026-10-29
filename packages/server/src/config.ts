import { MATCH_CONFIG } from '@brick-riot/shared';

export interface ServerConfig {
  port: number;
  host: string;
  /** Match length in seconds (default 120). */
  matchSeconds: number;
  countdownMs: number;
  reconnectSeconds: number;
  lobbyIdleMinutes: number;
  /** Allows "DEV ROOM" creation where unlock checks are skipped. Off in production. */
  allowDevRooms: boolean;
  /**
   * Test-only: multiplies the match clock speed. Never set in production; the
   * server refuses values other than 1 when NODE_ENV=production.
   */
  clockScale: number;
  /**
   * Test-only: every player starts matches with this much ability energy
   * (null = normal rules). Refused in production.
   */
  testStartEnergy: number | null;
  /** Origins allowed to call the HTTP API ('*' for local development). */
  allowedOrigins: string[];
  /** Trust X-Forwarded-For (only behind a known reverse proxy). */
  trustProxy: boolean;
  /**
   * PostgreSQL connection string. Null = guest-only mode: solo and private
   * rooms work as in Phase 4, account features answer 503.
   */
  databaseUrl: string | null;
  /** Secret for signing auth cookies/tokens (BETTER_AUTH_SECRET). Required in production. */
  authSecret: string;
  /** Public base URL of THIS server (auth callbacks), e.g. https://api.example.com. */
  publicUrl: string;
  /** Public URL of the web client (links in emails), e.g. https://play.example.com. */
  appUrl: string;
  /** 'outbox' keeps emails in memory for development/tests; 'smtp' sends them. */
  mailMode: 'outbox' | 'smtp';
  smtpUrl: string | null;
  mailFrom: string;
  /** Expose the dev email outbox at GET /api/dev/outbox (never in production). */
  devMailOutbox: boolean;
  /** Development network diagnostics in sync messages (never in production). */
  netDiagnostics: boolean;
  /**
   * Test-only: auth rate limits raised 100x so test suites (one IP) are not
   * throttled. Refused in production.
   */
  relaxedAuthLimits: boolean;
  /** Seconds matched Quick Match players get to confirm READY (default 20). */
  quickReadySeconds: number;
}

/** Origins that may call the API with credentials in development (localhost and private LANs). */
export function isDevOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Whether `origin` may make credentialed requests (CORS + CSRF origin check). */
export function isAllowedOrigin(config: Pick<ServerConfig, 'allowedOrigins'>, origin: string | undefined): boolean {
  if (!origin) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  // '*' only exists outside production and means "this machine and the local network".
  return config.allowedOrigins.includes('*') && isDevOrigin(origin);
}

const DEV_AUTH_SECRET = 'brick-riot-development-secret-not-for-production-use';

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const config: ServerConfig = {
    port: num(env.PORT, 2567),
    host: env.HOST ?? '0.0.0.0',
    matchSeconds: num(env.MATCH_SECONDS, MATCH_CONFIG.durationSeconds),
    countdownMs: num(env.COUNTDOWN_MS, MATCH_CONFIG.countdownMs),
    reconnectSeconds: num(env.RECONNECT_SECONDS, MATCH_CONFIG.reconnectSeconds),
    lobbyIdleMinutes: num(env.LOBBY_IDLE_MINUTES, MATCH_CONFIG.lobbyIdleMinutes),
    allowDevRooms: env.ALLOW_DEV_ROOMS !== undefined ? env.ALLOW_DEV_ROOMS === '1' : !production,
    clockScale: num(env.CLOCK_SCALE, 1),
    testStartEnergy: env.TEST_START_ENERGY !== undefined ? num(env.TEST_START_ENERGY, 0) : null,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? (production ? '' : '*')).split(',').filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1',
    databaseUrl: env.DATABASE_URL || null,
    authSecret: env.BETTER_AUTH_SECRET ?? (production ? '' : DEV_AUTH_SECRET),
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${num(env.PORT, 2567)}`,
    appUrl: env.APP_URL ?? 'http://localhost:5173',
    mailMode: env.MAIL_MODE === 'smtp' ? 'smtp' : 'outbox',
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM ?? 'BRICK RIOT <no-reply@localhost>',
    devMailOutbox: env.DEV_MAIL_OUTBOX !== undefined ? env.DEV_MAIL_OUTBOX === '1' : !production,
    netDiagnostics: env.NET_DIAGNOSTICS === '1',
    relaxedAuthLimits: env.RELAXED_AUTH_LIMITS === '1',
    quickReadySeconds: num(env.QUICK_READY_SECONDS, 20),
    ...overrides,
  };
  if (production && config.clockScale !== 1) throw new Error('CLOCK_SCALE must be 1 in production');
  if (production && config.testStartEnergy !== null) throw new Error('TEST_START_ENERGY is not allowed in production');
  if (production) {
    if (config.authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET (32+ characters) is required in production');
    if (config.devMailOutbox) throw new Error('DEV_MAIL_OUTBOX is not allowed in production');
    if (config.netDiagnostics) throw new Error('NET_DIAGNOSTICS is not allowed in production');
    if (config.relaxedAuthLimits) throw new Error('RELAXED_AUTH_LIMITS is not allowed in production');
    if (config.allowedOrigins.includes('*')) throw new Error('ALLOWED_ORIGINS must list explicit origins in production');
    if (config.databaseUrl && config.mailMode !== 'smtp') throw new Error('MAIL_MODE=smtp (with SMTP_URL) is required in production');
    if (config.databaseUrl && !config.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must be https:// in production');
  }
  if (config.mailMode === 'smtp' && !config.smtpUrl) throw new Error('SMTP_URL is required when MAIL_MODE=smtp');
  if (config.matchSeconds < 10 || config.matchSeconds > 600) throw new Error('MATCH_SECONDS must be 10-600');
  if (config.reconnectSeconds < 1 || config.reconnectSeconds > 120) throw new Error('RECONNECT_SECONDS must be 1-120');
  return config;
}
