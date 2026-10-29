import type { ImportSummary, ProfileView } from '@brick-riot/shared';
import { create } from 'zustand';
import { api, ApiRequestError } from '../net/api';

export type AccountStatus = 'loading' | 'guest' | 'signedIn' | 'unavailable';

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

interface AccountState {
  status: AccountStatus;
  profile: ProfileView | null;
  /** Reloads the signed-in profile (or learns that we are a guest). */
  refresh(): Promise<void>;
  signUp(name: string, email: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  resendVerification(): Promise<void>;
  sessions(): Promise<SessionInfo[]>;
  revokeOtherSessions(): Promise<void>;
  deleteAccount(password: string): Promise<void>;
  importLocalSave(save: string): Promise<ImportSummary>;
}

/** Where email links send the player back to (this app). */
function appLink(query: string): string {
  return `${window.location.origin}${window.location.pathname}?${query}`;
}

/**
 * The signed-in account. Sessions are HTTP-only cookies managed by the
 * server (better-auth); nothing secret is stored in JavaScript or localStorage.
 */
export const useAccount = create<AccountState>((set, get) => ({
  status: 'loading',
  profile: null,

  async refresh() {
    try {
      const profile = await api<ProfileView>('GET', '/api/me');
      set({ status: 'signedIn', profile });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) set({ status: 'guest', profile: null });
      else set({ status: err instanceof ApiRequestError && err.status === 503 ? 'unavailable' : 'guest', profile: null });
    }
  },

  async signUp(name, email, password) {
    await api('POST', '/api/auth/sign-up/email', { name, email, password, callbackURL: appLink('verified=1') });
    await get().refresh();
  },

  async signIn(email, password) {
    await api('POST', '/api/auth/sign-in/email', { email, password });
    await get().refresh();
  },

  async signOut() {
    await api('POST', '/api/auth/sign-out', {}).catch(() => undefined);
    set({ status: 'guest', profile: null });
  },

  async requestPasswordReset(email) {
    await api('POST', '/api/auth/request-password-reset', { email, redirectTo: appLink('reset=1') });
  },

  async resetPassword(token, newPassword) {
    await api('POST', '/api/auth/reset-password', { token, newPassword });
  },

  async resendVerification() {
    const email = get().profile?.account.email;
    if (!email) return;
    await api('POST', '/api/auth/send-verification-email', { email, callbackURL: appLink('verified=1') });
  },

  async sessions() {
    const list = await api<{ id: string; token: string; createdAt: string; expiresAt: string; userAgent?: string | null }[]>('GET', '/api/auth/list-sessions');
    const current = await api<{ session?: { id: string } } | null>('GET', '/api/auth/get-session');
    return list.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      userAgent: s.userAgent ?? null,
      current: s.id === current?.session?.id,
    }));
  },

  async revokeOtherSessions() {
    await api('POST', '/api/auth/revoke-other-sessions', {});
  },

  async deleteAccount(password) {
    await api('POST', '/api/auth/delete-user', { password });
    set({ status: 'guest', profile: null });
  },

  async importLocalSave(save) {
    const summary = await api<ImportSummary>('POST', '/api/account/import-local', { save });
    await get().refresh();
    return summary;
  },
}));
