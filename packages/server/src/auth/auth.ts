import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { isAllowedOrigin, type ServerConfig } from '../config';
import type { Db } from '../db/client';
import type { Mailer } from './mailer';

/**
 * Header the HTTP layer sets to Express's resolved client IP (honouring
 * TRUST_PROXY) after deleting any client-supplied copy. better-auth reads only
 * this header, so its per-IP rate limits cannot be spoofed.
 */
export const CLIENT_IP_HEADER = 'x-brickriot-client-ip';

export interface AuthDeps {
  db: Db;
  config: ServerConfig;
  mailer: Mailer;
  /** Creates the player profile, starter unlocks and equipment (idempotent). */
  provisionPlayer(userId: string): Promise<void>;
}

/**
 * Accounts and sessions via better-auth (maintained library; scrypt password
 * hashing, signed HTTP-only session cookies, CSRF origin checks, rate limits).
 * We do not implement any cryptography ourselves.
 */
export function createAuth({ db, config, mailer, provisionPlayer }: AuthDeps) {
  const secure = config.publicUrl.startsWith('https://');
  const k = config.relaxedAuthLimits ? 100 : 1;
  return betterAuth({
    appName: 'BRICK RIOT',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: prismaAdapter(db, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    trustedOrigins: (request) => {
      const origin = request?.headers.get('origin') ?? undefined;
      const list = [new URL(config.appUrl).origin];
      if (origin && isAllowedOrigin(config, origin)) list.push(origin);
      return list;
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      // Players may log in before verifying; verified email is required for
      // features that need a trustworthy identity (leaderboards, future ranked).
      requireEmailVerification: false,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          kind: 'reset-password',
          subject: 'Reset your BRICK RIOT password',
          text: `Someone asked to reset the password for this BRICK RIOT account.\n\nOpen this link within 1 hour to choose a new password:\n${url}\n\nIf this wasn't you, ignore this email; your password stays the same.`,
          link: url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          kind: 'verify-email',
          subject: 'Verify your BRICK RIOT email',
          text: `Welcome to BRICK RIOT!\n\nConfirm your email address within 24 hours:\n${url}`,
          link: url,
        });
      },
    },
    session: {
      // Sessions last 7 days and are refreshed (rotated expiry) at most daily.
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      // Sensitive actions (delete account, change password) need a login from the last 10 minutes.
      freshAge: 10 * 60,
    },
    user: {
      deleteUser: { enabled: true },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rateLimit',
      window: 60,
      max: 100 * k,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 * k },
        '/sign-up/email': { window: 60 * 10, max: 5 * k },
        '/request-password-reset': { window: 60 * 10, max: 3 * k },
        '/send-verification-email': { window: 60 * 10, max: 3 * k },
        '/reset-password': { window: 60 * 10, max: 5 * k },
      },
    },
    advanced: {
      cookiePrefix: 'brickriot',
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionPlayer(user.id);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({ where: { id: session.userId }, select: { status: true } });
            if (user?.status === 'suspended') return false;
            return undefined;
          },
          after: async (session) => {
            await db.user.update({ where: { id: session.userId }, data: { lastLoginAt: new Date() } });
          },
        },
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
