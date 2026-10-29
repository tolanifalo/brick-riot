import { MULTIPLAYER_BOARDS, type RankedStatus } from '@brick-riot/shared';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import express, { type Application, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { CLIENT_IP_HEADER } from '../auth/auth';
import { OutboxMailer } from '../auth/mailer';
import { isAllowedOrigin } from '../config';
import { ReadModels } from '../queries/readModels';
import type { Services } from '../services';
import { ApiError } from './errors';

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Requests carrying a signed-in session have this attached by `requireUser`. */
interface AuthedRequest extends Request {
  userId?: string;
}

const RANKED_STATUS: RankedStatus = {
  enabled: false,
  blockers: [
    'Board difficulty is bot-estimated, not human-calibrated',
    'Real-device testing has not been completed',
    'Anti-cheat review is pending',
  ],
};

/**
 * HTTP API next to the WebSocket endpoint.
 *
 * - /api/auth/*: better-auth (register, login, logout, sessions, email
 *   verification, password reset, account deletion).
 * - /api/me, /api/solo, /api/workshop, /api/loadout, ...: the signed-in
 *   player's server-authoritative progression.
 * - /api/rooms/resolve: private room join codes (rate-limited per IP).
 *
 * Security: credentialed CORS only for allowed origins; every state-changing
 * route requires an allowed Origin (or none, for non-browser clients) AND a
 * JSON body, which a cross-site form cannot send (CSRF); sessions are
 * HTTP-only cookies; errors never expose internals.
 */
export function installApi(app: Application, services: Services): void {
  const { config } = services;
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(config, origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  // ---- Authentication (better-auth) ---------------------------------------------
  const auth = services.auth;
  app.all('/api/auth/{*path}', (req: Request, res: Response) => {
    if (!auth) return void res.status(503).json({ error: 'accounts_unavailable' });
    // Overwrite (never trust) the client IP header better-auth rate-limits on:
    // any client-supplied value is replaced by Express's resolved address.
    req.headers[CLIENT_IP_HEADER] = clientIp(req);
    void toNodeHandler(auth)(req, res);
  });

  const small = express.json({ limit: '4kb' });

  /** CSRF guard for state-changing requests (see above). */
  const sameOrigin: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(config, origin)) return void res.status(403).json({ error: 'bad_origin' });
    if (!req.is('application/json')) return void res.status(415).json({ error: 'json_required' });
    next();
  };

  const requireAccounts: RequestHandler = (_req, res, next) => {
    if (!auth || !services.progression || !services.db) return void res.status(503).json({ error: 'accounts_unavailable' });
    next();
  };

  const requireUser: RequestHandler = (req, res, next) => {
    if (!auth) return void res.status(503).json({ error: 'accounts_unavailable' });
    auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .then((session) => {
        if (!session) return void res.status(401).json({ error: 'not_signed_in' });
        (req as AuthedRequest).userId = session.user.id;
        next();
      })
      .catch(next);
  };

  const optionalUser = async (req: Request): Promise<string | null> => {
    if (!auth) return null;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
    return session?.user.id ?? null;
  };

  const wrap =
    (fn: (req: AuthedRequest, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      fn(req as AuthedRequest, res).then((body) => {
        if (!res.headersSent) res.json(body);
      }, next);
    };

  const me = (req: AuthedRequest): string => {
    if (!req.userId) throw new ApiError(401, 'not_signed_in');
    return req.userId;
  };
  const progression = () => {
    if (!services.progression) throw new ApiError(503, 'accounts_unavailable');
    return services.progression;
  };
  const reads = services.db ? new ReadModels(services.db) : null;
  const readModels = () => {
    if (!reads) throw new ApiError(503, 'accounts_unavailable');
    return reads;
  };

  // ---- Public ----------------------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: services.codes.size, accounts: !!auth });
  });

  app.get('/api/boards', (_req, res) => {
    res.json({ boards: MULTIPLAYER_BOARDS });
  });

  app.get('/api/ranked/status', (_req, res) => {
    res.json(RANKED_STATUS);
  });

  app.get('/api/players/:id', requireAccounts, wrap((req) => progression().publicProfile(String(req.params.id))));

  app.get(
    '/api/leaderboards/:category',
    requireAccounts,
    wrap(async (req) =>
      readModels().leaderboard(req.params.category, req.query.board, req.query.page, req.query.pageSize, await optionalUser(req)),
    ),
  );

  app.get('/api/telemetry/boards', requireAccounts, wrap(() => readModels().boardTelemetry()));

  // ---- Signed-in player ------------------------------------------------------------------
  app.get('/api/me', requireAccounts, requireUser, wrap((req) => progression().profile(me(req))));

  app.put(
    '/api/me/settings',
    requireAccounts,
    small,
    sameOrigin,
    requireUser,
    wrap(async (req) => {
      const body = req.body as { reducedEffects?: unknown };
      await progression().setSettings(me(req), { reducedEffects: body?.reducedEffects === true });
      return { ok: true };
    }),
  );

  app.get('/api/me/matches', requireAccounts, requireUser, wrap((req) => readModels().history(me(req), req.query.cursor, req.query.limit)));

  app.get('/api/matches/:id', requireAccounts, requireUser, wrap((req) => readModels().matchDetail(me(req), String(req.params.id))));

  app.post(
    '/api/solo/runs',
    requireAccounts,
    small,
    sameOrigin,
    requireUser,
    wrap((req) => progression().issueRun(me(req), (req.body as { boardId?: unknown })?.boardId)),
  );

  app.post(
    '/api/solo/runs/:id/finish',
    requireAccounts,
    express.json({ limit: '2mb' }),
    sameOrigin,
    requireUser,
    wrap((req) => progression().finishRun(me(req), String(req.params.id), (req.body as { inputs?: unknown })?.inputs)),
  );

  app.post(
    '/api/workshop/purchase',
    requireAccounts,
    small,
    sameOrigin,
    requireUser,
    wrap((req) => {
      const body = req.body as { upgradeId?: unknown; expectedLevel?: unknown };
      return progression().purchase(me(req), body?.upgradeId, body?.expectedLevel, req.headers['idempotency-key']);
    }),
  );

  app.put(
    '/api/loadout',
    requireAccounts,
    small,
    sameOrigin,
    requireUser,
    wrap(async (req) => ({ equipment: await progression().setLoadout(me(req), (req.body as { loadout?: unknown })?.loadout) })),
  );

  app.post(
    '/api/account/import-local',
    requireAccounts,
    express.json({ limit: '600kb' }),
    sameOrigin,
    requireUser,
    wrap((req) => progression().importLocal(me(req), (req.body as { save?: unknown })?.save)),
  );

  app.post(
    '/api/game/ticket',
    requireAccounts,
    small,
    sameOrigin,
    requireUser,
    wrap(async (req) => services.tickets.issue(me(req))),
  );

  // ---- Development only ----------------------------------------------------------------
  if (config.devMailOutbox && services.mailer instanceof OutboxMailer) {
    const outbox = services.mailer;
    /** The latest email for an address (dev/test only; production refuses DEV_MAIL_OUTBOX). */
    app.get('/api/dev/outbox', (req, res) => {
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      const kind = req.query.kind === 'reset-password' || req.query.kind === 'verify-email' ? req.query.kind : undefined;
      const message = outbox.latest(to, kind);
      if (!message) return void res.status(404).json({ error: 'no_message' });
      res.json({ to: message.to, kind: message.kind, subject: message.subject, link: message.link });
    });
  }

  // ---- Private room codes (Phase 3) ------------------------------------------------------
  app.post('/api/rooms/resolve', small, (req: Request, res: Response) => {
    const ip = clientIp(req);
    const limiter = services.joinLimiter;
    if (!limiter.attempt(ip)) return void res.status(429).json({ error: 'too_many_attempts' });
    const lookup = services.codes.lookup((req.body as { code?: unknown } | undefined)?.code);
    switch (lookup.status) {
      case 'ok':
        return void res.json({ roomId: lookup.roomId });
      case 'invalid':
        limiter.fail(ip);
        return void res.status(404).json({ error: 'invalid_code' });
      case 'expired':
        return void res.status(410).json({ error: 'expired' });
      case 'full':
        return void res.status(409).json({ error: 'room_full' });
      case 'in_progress':
        return void res.status(409).json({ error: 'match_in_progress' });
    }
  });

  // ---- Errors: stable codes, never internals ----------------------------------------------------
  app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next;
    if (err instanceof ApiError) return void res.status(err.status).json({ error: err.code });
    const status = (err as { status?: number; type?: string })?.status;
    if (status === 413) return void res.status(413).json({ error: 'too_large' });
    if (status === 400) return void res.status(400).json({ error: 'bad_request' });
    // Log the message only (no request body, headers or tokens).
    console.error('[api] internal error:', err instanceof Error ? err.message : 'unknown');
    res.status(500).json({ error: 'internal' });
  });

  setInterval(() => services.joinLimiter.prune(), 60_000).unref();
}
