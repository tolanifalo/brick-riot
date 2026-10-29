import { DIVISIONS, type Division } from './types';

/**
 * Glicko-2 rating system (Mark Glickman, "Example of the Glicko-2 system",
 * 2012). Ratings use the familiar Glicko scale (1500 start). This module is
 * pure and deterministic; the server decides WHEN it may be applied:
 * casual matches update a hidden matchmaking estimate only, and ranked
 * ratings stay disabled until ranked play launches.
 */
export interface GlickoRating {
  rating: number;
  deviation: number;
  volatility: number;
}

export interface GlickoOpponentResult {
  opponent: GlickoRating;
  /** 1 = win, 0.5 = draw, 0 = loss. */
  score: 0 | 0.5 | 1;
}

export interface GlickoConfig {
  /** System constant: constrains volatility change (0.3–1.2 is typical). */
  tau: number;
  initialRating: number;
  initialDeviation: number;
  initialVolatility: number;
  /** Deviations never fall below this (keeps ratings responsive). */
  minDeviation: number;
  maxDeviation: number;
  /** Convergence tolerance of the volatility iteration. */
  epsilon: number;
}

export const GLICKO2: GlickoConfig = {
  tau: 0.5,
  initialRating: 1500,
  initialDeviation: 350,
  initialVolatility: 0.06,
  minDeviation: 30,
  maxDeviation: 350,
  epsilon: 0.000001,
};

const SCALE = 173.7178;

export function initialRating(config: GlickoConfig = GLICKO2): GlickoRating {
  return { rating: config.initialRating, deviation: config.initialDeviation, volatility: config.initialVolatility };
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * One rating period for one player. With no results, only the deviation grows
 * (step 6 of the paper). Pure: inputs are not modified.
 */
export function updateRating(player: GlickoRating, results: readonly GlickoOpponentResult[], config: GlickoConfig = GLICKO2): GlickoRating {
  const mu = (player.rating - config.initialRating) / SCALE;
  const phi = player.deviation / SCALE;
  const sigma = player.volatility;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, deviation: clampDeviation(phiStar * SCALE, config), volatility: sigma };
  }

  // Step 3: estimated variance; step 4: estimated improvement.
  let vInv = 0;
  let deltaSum = 0;
  for (const { opponent, score } of results) {
    const muJ = (opponent.rating - config.initialRating) / SCALE;
    const phiJ = opponent.deviation / SCALE;
    const e = expected(mu, muJ, phiJ);
    const gj = g(phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility (Illinois algorithm).
  const a = Math.log(sigma * sigma);
  const tau2 = config.tau * config.tau;
  const f = (x: number) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / tau2;
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * config.tau) < 0) k++;
    B = a - k * config.tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > config.epsilon; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  // Steps 6–7: new deviation and rating.
  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return {
    rating: muNew * SCALE + config.initialRating,
    deviation: clampDeviation(phiNew * SCALE, config),
    volatility: sigmaNew,
  };
}

function clampDeviation(d: number, config: GlickoConfig): number {
  return Math.min(config.maxDeviation, Math.max(config.minDeviation, d));
}

/** Both players' new ratings after one head-to-head game (each game is its own rating period). */
export function rateMatch(a: GlickoRating, b: GlickoRating, scoreA: 0 | 0.5 | 1, config: GlickoConfig = GLICKO2): [GlickoRating, GlickoRating] {
  const scoreB = (1 - scoreA) as 0 | 0.5 | 1;
  return [updateRating(a, [{ opponent: b, score: scoreA }], config), updateRating(b, [{ opponent: a, score: scoreB }], config)];
}

/** Probability that `a` beats `b`, accounting for both deviations. */
export function winProbability(a: GlickoRating, b: GlickoRating): number {
  const phi = Math.sqrt(a.deviation ** 2 + b.deviation ** 2) / SCALE;
  return 1 / (1 + Math.exp(-g(phi) * ((a.rating - b.rating) / SCALE)));
}

/**
 * Division thresholds on the conservative rating (rating − 2·deviation), so
 * an uncertain rating never shows an inflated division. RANKED ONLY: divisions
 * are not displayed until ranked play launches.
 */
export const DIVISION_FLOORS: Record<Division, number> = {
  Bronze: -Infinity,
  Silver: 1300,
  Gold: 1500,
  Platinum: 1700,
  Diamond: 1900,
  'Riot Master': 2150,
};

export const PLACEMENT_MATCHES = 10;

export function divisionFor(r: GlickoRating): Division {
  const conservative = r.rating - 2 * r.deviation;
  let result: Division = 'Bronze';
  for (const d of DIVISIONS) if (conservative >= DIVISION_FLOORS[d]) result = d;
  return result;
}
