import { CLASSIC_01, NO_UPGRADES, type ProfileView, type RunSummary } from '@brick-riot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccount } from '../src/account/accountStore';
import { canStartBoard, progressFromProfile, useProgress } from '../src/progress/progressStore';
import { InMemoryProgressRepository } from '../src/progress/repository';

vi.stubGlobal('window', { location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:5173', pathname: '/' } });

function profile(over: Partial<ProfileView> = {}): ProfileView {
  return {
    account: { id: 'u1', name: 'Ace', email: 'ace@example.test', emailVerified: true, createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: null },
    progress: { xp: 500, level: 2, xpIntoLevel: 200, xpForNext: 354, coins: 321 },
    boards: [{ boardId: 'classic-01', attempts: 3, completions: 2, bestScore: 9000, bestTimeMs: 100_000, bestStars: 2, mastery: ['classic-01-clear'] }],
    unlockedBoardIds: ['classic-01', 'classic-02', 'classic-05'],
    importedRecords: [
      { boardId: 'classic-01', completions: 9, bestScore: 1, bestTimeMs: 1, bestStars: 3 },
      { boardId: 'classic-04', completions: 1, bestScore: 4444, bestTimeMs: 200_000, bestStars: 1 },
    ],
    equipment: {
      ownedAbilities: ['emp', 'shield', 'quickRelaunch', 'cleanse'],
      loadout: { offensive: 'emp', defensive: 'cleanse', passive: 'quickRelaunch' },
      upgrades: { ...NO_UPGRADES, paddleWidth: 2 },
      loadoutPower: 65,
      equipmentPower: 70,
    },
    settings: { reducedEffects: true },
    localImport: null,
    stats: { casualMatches: 0, casualWins: 0, casualDraws: 0, privateMatches: 0 },
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  await useProgress.getState().init(new InMemoryProgressRepository());
  useAccount.setState({ status: 'guest', profile: null });
});

afterEach(() => {
  useAccount.setState({ status: 'guest', profile: null });
});

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('server profile as progress', () => {
  it('uses verified records over imported ones, keeps imported-only boards, and takes balances from the server', () => {
    const p = progressFromProfile(profile());
    expect(p.coins).toBe(321);
    expect(p.xp).toBe(500);
    expect(p.upgrades.paddleWidth).toBe(2);
    expect(p.settings.reducedEffects).toBe(true);
    expect(p.boards['classic-01']).toMatchObject({ completions: 2, bestScore: 9000, mastery: ['classic-01-clear'] });
    expect(p.boards['classic-04']).toMatchObject({ completions: 1, bestScore: 4444 });
  });

  it('switches between the signed-in profile and the untouched guest save', () => {
    const guest = useProgress.getState().guestProgress;
    useAccount.setState({ status: 'signedIn', profile: profile() });
    expect(useProgress.getState().mode).toBe('account');
    expect(useProgress.getState().progress.coins).toBe(321);
    // Board access follows the SERVER's unlocks when signed in.
    expect(canStartBoard('classic-05')).toBe(true);
    expect(canStartBoard('classic-03')).toBe(false);
    useAccount.setState({ status: 'guest', profile: null });
    expect(useProgress.getState().mode).toBe('guest');
    expect(useProgress.getState().progress).toBe(guest);
  });
});

describe('signed-in actions go to the server', () => {
  it('a purchase retried after a network failure reuses the same idempotency key', async () => {
    useAccount.setState({ status: 'signedIn', profile: profile() });
    const keys: string[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('/api/workshop/purchase')) {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key'] ?? '');
        if (keys.length === 1) return Promise.reject(new TypeError('network down'));
        return json(200, { purchaseId: 'p1', upgradeId: 'paddleWidth', level: 3, cost: 450, coins: 0, replayed: false });
      }
      return json(200, profile());
    });
    const result = await useProgress.getState().purchase('paddleWidth', 2);
    expect(result).toEqual({ ok: true, cost: 450, level: 3 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]?.length).toBeGreaterThanOrEqual(8);
  });

  it('server refusals are reported, not retried, and nothing changes locally', async () => {
    useAccount.setState({ status: 'signedIn', profile: profile() });
    fetchMock.mockImplementation(() => json(409, { error: 'insufficient_coins' }));
    expect(await useProgress.getState().purchase('ballPower', 0)).toEqual({ ok: false, error: 'insufficient_coins' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useProgress.getState().progress.coins).toBe(321);
  });

  it('a signed-in run without a server ticket is never recorded or rewarded', async () => {
    useAccount.setState({ status: 'signedIn', profile: profile() });
    const summary = { boardId: CLASSIC_01.id, boardVersion: CLASSIC_01.version, status: 'won', score: 5000, elapsedMs: 60_000, livesRemaining: 3, ballsLost: 0, bestCombo: 5 } as RunSummary;
    const outcome = await useProgress.getState().recordRun({ runId: 'local', seed: 1, inputs: [], summary, upgrades: NO_UPGRADES });
    expect(outcome?.verified).toBe(false);
    expect(outcome?.xp).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
