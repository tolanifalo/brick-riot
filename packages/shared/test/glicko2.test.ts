import { describe, expect, it } from 'vitest';
import { divisionFor, GLICKO2, initialRating, rateMatch, updateRating, winProbability } from '../src/competitive/glicko2';
import { decodeInputLog, encodeInputLog, MAX_SOLO_TICKS } from '../src/sim/inputCodec';

describe('Glicko-2', () => {
  it("reproduces Glickman's published worked example", () => {
    // Glickman (2012): player 1500/200/0.06 vs 1400/30 (win), 1550/100 (loss), 1700/300 (loss), tau 0.5.
    const next = updateRating({ rating: 1500, deviation: 200, volatility: 0.06 }, [
      { opponent: { rating: 1400, deviation: 30, volatility: 0.06 }, score: 1 },
      { opponent: { rating: 1550, deviation: 100, volatility: 0.06 }, score: 0 },
      { opponent: { rating: 1700, deviation: 300, volatility: 0.06 }, score: 0 },
    ], { ...GLICKO2, minDeviation: 0 });
    expect(next.rating).toBeCloseTo(1464.06, 1);
    expect(next.deviation).toBeCloseTo(151.52, 1);
    expect(next.volatility).toBeCloseTo(0.05999, 4);
  });

  it('a period without games only increases uncertainty', () => {
    const r = { rating: 1600, deviation: 80, volatility: 0.06 };
    const next = updateRating(r, []);
    expect(next.rating).toBe(1600);
    expect(next.deviation).toBeGreaterThan(80);
    expect(next.deviation).toBeLessThanOrEqual(GLICKO2.maxDeviation);
  });

  it('is zero-sum in direction and symmetric for equal players; draws between equals change nothing', () => {
    const [a, b] = rateMatch(initialRating(), initialRating(), 1);
    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(a.rating - 1500).toBeCloseTo(1500 - b.rating, 6);
    const [c, d] = rateMatch(initialRating(), initialRating(), 0.5);
    expect(c.rating).toBeCloseTo(1500, 6);
    expect(d.rating).toBeCloseTo(1500, 6);
  });

  it('beating a stronger player gains more than beating a weaker one', () => {
    const me = { rating: 1500, deviation: 100, volatility: 0.06 };
    const strong = updateRating(me, [{ opponent: { rating: 1800, deviation: 100, volatility: 0.06 }, score: 1 }]);
    const weak = updateRating(me, [{ opponent: { rating: 1200, deviation: 100, volatility: 0.06 }, score: 1 }]);
    expect(strong.rating - 1500).toBeGreaterThan(weak.rating - 1500);
  });

  it('deviation shrinks with games and never drops below the floor', () => {
    let r = initialRating();
    for (let i = 0; i < 200; i++) r = updateRating(r, [{ opponent: initialRating(), score: i % 2 === 0 ? 1 : 0 }]);
    expect(r.deviation).toBeGreaterThanOrEqual(GLICKO2.minDeviation);
    expect(r.deviation).toBeLessThan(120);
  });

  it('win probability is 0.5 for equals and monotonic in rating', () => {
    expect(winProbability(initialRating(), initialRating())).toBeCloseTo(0.5, 9);
    const strong = { rating: 1800, deviation: 50, volatility: 0.06 };
    expect(winProbability(strong, initialRating())).toBeGreaterThan(0.5);
  });

  it('divisions use the conservative rating, so new players are never inflated', () => {
    expect(divisionFor(initialRating())).toBe('Bronze');
    expect(divisionFor({ rating: 1800, deviation: 40, volatility: 0.06 })).toBe('Platinum');
    expect(divisionFor({ rating: 2300, deviation: 50, volatility: 0.06 })).toBe('Riot Master');
    // Same rating, but very uncertain: 2300 − 2×350 = 1600 → only Gold.
    expect(divisionFor({ rating: 2300, deviation: 350, volatility: 0.06 })).toBe('Gold');
  });
});

describe('solo input log codec', () => {
  it('round-trips exactly and collapses repeated inputs', () => {
    const inputs = [
      ...Array.from({ length: 50 }, () => ({ targetX: 123.456789, axis: 0, launch: false })),
      { targetX: 123.456789, axis: 0, launch: true },
      { targetX: null, axis: -1, launch: false },
      { targetX: null, axis: -1, launch: false },
    ];
    const encoded = encodeInputLog(inputs);
    expect(encoded).toHaveLength(3);
    const decoded = decodeInputLog(JSON.parse(JSON.stringify(encoded)));
    expect(decoded).toEqual({ ok: true, inputs });
  });

  it('rejects malformed and oversized logs', () => {
    expect(decodeInputLog('x')).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInputLog([[0, null, 0, 0]])).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInputLog([[1, 'a', 0, 0]])).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInputLog([[1, null, 2, 0]])).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInputLog([[1, Number.POSITIVE_INFINITY, 0, 0]])).toEqual({ ok: false, error: 'malformed' });
    expect(decodeInputLog([[MAX_SOLO_TICKS + 1, null, 0, 0]])).toEqual({ ok: false, error: 'too_long' });
  });
});
