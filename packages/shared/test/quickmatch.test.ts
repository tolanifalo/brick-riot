import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT } from '../src/abilities/loadout';
import { rateEquipment } from '../src/abilities/equipment';
import { NO_UPGRADES } from '../src/upgrades/upgrades';
import { assignBoards, evaluateQuickPair, findQuickPairs, QUICK_POLICY, type QuickCandidate } from '../src/competitive/quickmatch';

const ALL = ['classic-01', 'classic-02', 'classic-03', 'classic-04', 'classic-05', 'classic-06', 'classic-07', 'classic-08', 'classic-09', 'classic-10'];
const equip = rateEquipment({ loadout: DEFAULT_LOADOUT, upgrades: NO_UPGRADES }, 'casual');

function candidate(id: string, over: Partial<QuickCandidate> = {}): QuickCandidate {
  return {
    id,
    rating: 1500,
    deviation: 100,
    gamesPlayed: 20,
    equipment: equip,
    unlockedBoardIds: ALL,
    preferences: { boards: ['classic-05'], allowAlternatives: false },
    enqueuedAt: 0,
    ...over,
  };
}

describe('Quick Match board assignment', () => {
  it('keeps different boards when the players prefer different compatible boards', () => {
    const a = candidate('a', { preferences: { boards: ['classic-05'], allowAlternatives: false } });
    const b = candidate('b', { preferences: { boards: ['classic-08'], allowAlternatives: false } });
    const r = assignBoards(a, b);
    expect(r).toMatchObject({ boardA: 'classic-05', boardB: 'classic-08', noteA: 'Your 1st choice.', noteB: 'Your 1st choice.' });
    expect(r?.report.compatible).toBe(true);
  });

  it('uses a lower preference before an alternative, and says so', () => {
    const a = candidate('a', { preferences: { boards: ['classic-03', 'classic-05'], allowAlternatives: false } });
    const b = candidate('b', { preferences: { boards: ['classic-08'], allowAlternatives: false } });
    expect(assignBoards(a, b)).toMatchObject({ boardA: 'classic-05', noteA: 'Your 2nd choice.' });
  });

  it('never pairs incompatible boards and never loosens thresholds; alternatives only with permission', () => {
    const a = candidate('a', { preferences: { boards: ['classic-03'], allowAlternatives: false } });
    const b = candidate('b', { preferences: { boards: ['classic-10'], allowAlternatives: false } });
    expect(assignBoards(a, b)).toBeNull();
    const flexible = { ...b, preferences: { boards: ['classic-10'], allowAlternatives: true } };
    const r = assignBoards(a, flexible);
    expect(r?.boardA).toBe('classic-03');
    expect(r?.noteB).toMatch(/Suggested alternative/);
    expect(r?.report.compatible).toBe(true);
  });

  it('only offers boards the player has unlocked on the server (variants follow their base)', () => {
    const a = candidate('a', { unlockedBoardIds: ['classic-01', 'classic-02'], preferences: { boards: ['classic-05'], allowAlternatives: false } });
    const b = candidate('b', { preferences: { boards: ['classic-08'], allowAlternatives: false } });
    expect(assignBoards(a, b)).toBeNull();
    const c = candidate('c', { unlockedBoardIds: ['classic-07', 'classic-10'], preferences: { boards: ['classic-07-mp'], allowAlternatives: false } });
    const d = candidate('d', { preferences: { boards: ['classic-10-mp'], allowAlternatives: false } });
    expect(assignBoards(c, d)).toMatchObject({ boardA: 'classic-07-mp', boardB: 'classic-10-mp' });
  });
});

describe('Quick Match pairing criteria (each checked separately)', () => {
  const pair = (a: QuickCandidate, b: QuickCandidate, now = 0) => evaluateQuickPair(a, b, now);
  const prefB = { preferences: { boards: ['classic-08'], allowAlternatives: false } };

  it('accepts a comparable pair', () => {
    expect(pair(candidate('a'), candidate('b', prefB)).acceptable).toBe(true);
  });

  it('refuses a large skill gap, then widens the window as both wait', () => {
    const a = candidate('a');
    const b = candidate('b', { ...prefB, rating: 1900 });
    expect(pair(a, b, 0).skill.ok).toBe(false);
    expect(pair(a, b, 70_000).skill.ok).toBe(true);
    // ...but never beyond the cap.
    const far = candidate('c', { ...prefB, rating: 2400 });
    expect(pair(a, far, 10_000_000).skill.ok).toBe(false);
  });

  it('legal loadouts alone are always within the even-equipment gap (budget 80, weakest 65)', () => {
    const heavy = rateEquipment({ loadout: { offensive: 'frost', defensive: 'shield', passive: 'quickRelaunch' }, upgrades: NO_UPGRADES }, 'casual');
    const light = rateEquipment({ loadout: { offensive: 'emp', defensive: 'cleanse', passive: 'quickRelaunch' }, upgrades: NO_UPGRADES }, 'casual');
    expect(heavy.power - light.power).toBe(15);
    expect(pair(candidate('a', { equipment: heavy }), candidate('b', { ...prefB, equipment: light })).equipment.ok).toBe(true);
  });

  it('a strong skill match cannot buy an equipment or beginner mismatch (no blended score)', () => {
    // Explicit ratings: the criterion must work on its own whenever equipment does differ.
    const heavy = { power: 100, band: 5, components: [], verified: true };
    const light = { power: 65, band: 3, components: [], verified: true };
    const e = pair(candidate('a', { equipment: heavy }), candidate('b', { ...prefB, equipment: light }));
    expect(e.skill.ok).toBe(true);
    expect(e.equipment.ok).toBe(false);
    expect(e.acceptable).toBe(false);
    const newbie = pair(candidate('a', { gamesPlayed: 2 }), candidate('b', { ...prefB, gamesPlayed: 200 }));
    expect(newbie.skill.ok).toBe(true);
    expect(newbie.beginner.ok).toBe(false);
    expect(newbie.acceptable).toBe(false);
    expect(pair(candidate('a', { gamesPlayed: 2 }), candidate('b', { ...prefB, gamesPlayed: 12 })).acceptable).toBe(true);
  });
});

describe('Quick Match queue pairing', () => {
  it('serves the longest-waiting player first with the closest acceptable opponent; leaves the rest waiting', () => {
    const queue = [
      candidate('late', { enqueuedAt: 5_000, rating: 1500, ...{ preferences: { boards: ['classic-08'], allowAlternatives: false } } }),
      candidate('early', { enqueuedAt: 0, rating: 1520 }),
      candidate('close', { enqueuedAt: 3_000, rating: 1510, preferences: { boards: ['classic-08'], allowAlternatives: false } }),
      candidate('alone', { enqueuedAt: 1_000, rating: 3000 }),
    ];
    const pairs = findQuickPairs(queue, 6_000);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.a.id, pairs[0]?.b.id]).toEqual(['early', 'close']);
    expect(findQuickPairs([candidate('solo')], 6_000)).toEqual([]);
  });

  it('never pairs a player with themselves and is deterministic', () => {
    const queue = [candidate('x'), candidate('y', { preferences: { boards: ['classic-08'], allowAlternatives: false } })];
    const first = findQuickPairs(queue, 1000).map((p) => [p.a.id, p.b.id, p.assignment.boardA, p.assignment.boardB]);
    expect(findQuickPairs([...queue].reverse(), 1000).map((p) => [p.a.id, p.b.id, p.assignment.boardA, p.assignment.boardB])).toEqual(first);
    expect(first[0]?.[0]).not.toBe(first[0]?.[1]);
    expect(QUICK_POLICY.queueTimeoutSeconds).toBeGreaterThan(0);
  });
});
