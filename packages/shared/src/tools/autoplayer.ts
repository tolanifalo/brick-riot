import { SIM } from '../config/balance';
import { isPowerDown } from '../config/powerups';
import type { Simulation } from '../sim/simulation';
import type { BallState, TickInput } from '../sim/types';

export type AutoplayMode = 'win' | 'lose';

/**
 * Scripted player used for automated playtesting, calibration and browser tests.
 *
 * 'win' predicts where the most urgent ball will meet the paddle and picks the
 * contact offset that sends it toward the lowest remaining required brick. When
 * it stops making progress it cycles through fixed aim offsets.
 * 'lose' keeps the paddle on the far side of the field from the ball.
 *
 * It only produces TickInput, exactly like a human, so runs it plays are
 * ordinary replayable runs.
 */
export function createAutoplayer(mode: AutoplayMode = 'win'): (sim: Simulation) => TickInput {
  const decide = createDecider(mode);
  return (sim) => {
    const input = decide(sim);
    // Reversed: aim at the mirror image, as a human would once they adapt.
    if (sim.inverted && input.targetX !== null) return { ...input, targetX: SIM.worldWidth - input.targetX };
    return input;
  };
}

function createDecider(mode: AutoplayMode): (sim: Simulation) => TickInput {
  let tick = 0;
  let lastRemaining = -1;
  let lastProgressTick = 0;
  return (sim) => {
    tick++;
    const s = sim.state;
    // The sim's own progress counter resets on paddle contact, so track
    // cleared bricks here to notice aiming loops (e.g. at a brick behind steel).
    if (s.requiredRemaining !== lastRemaining) {
      lastRemaining = s.requiredRemaining;
      lastProgressTick = tick;
    }
    const cfg = sim.config;
    const free = s.balls.filter((b) => !b.attached);
    const needsLaunch = s.status === 'ready' || s.balls.some((b) => b.attached) || hasLaser(sim);
    const ball = urgentBall(free, s.paddle.y - s.paddle.height / 2);

    if (mode === 'lose') {
      const x = ball ? ball.x : s.paddle.x;
      return { targetX: x < SIM.worldWidth / 2 ? SIM.worldWidth : 0, axis: 0, launch: s.status === 'ready' };
    }

    const paddleTop = s.paddle.y - s.paddle.height / 2;
    // Grab a falling capsule when it lands well before the next ball needs the paddle.
    const pickup = nextPickup(sim, paddleTop);
    if (pickup) {
      const ballTime = ball && ball.vy > 0 ? (paddleTop - ball.radius - ball.y) / ball.vy : Number.POSITIVE_INFINITY;
      const safeWindow = ball && ball.vy <= 0 ? 0.5 : ballTime - 0.3;
      if (!ball || pickup.time < safeWindow) return { targetX: pickup.x, axis: 0, launch: needsLaunch };
    }
    if (!ball) return { targetX: s.paddle.x, axis: 0, launch: needsLaunch };

    const landX = predictLandingX(ball, paddleTop);
    const half = s.paddle.width / 2;
    let offset: number;
    const stuck = tick - lastProgressTick > 5 * SIM.tickRate;
    const target = stuck ? null : aimTarget(sim, landX);
    if (target) {
      const tan = (target.x - landX) / Math.max(40, paddleTop - target.y);
      offset = Math.max(-0.85, Math.min(0.85, tan / cfg.rebound.maxTan));
    } else {
      // Escape aiming loops with a well-spread deterministic sequence of offsets
      // (golden-ratio sampling), changing every second.
      const k = Math.floor(tick / SIM.tickRate);
      offset = ((k * 0.6180339887) % 1) * 1.7 - 0.85;
    }
    return { targetX: landX - offset * (half + ball.radius * 0.5), axis: 0, launch: needsLaunch };
  };
}

function hasLaser(sim: Simulation): boolean {
  return sim.state.effects.laser > 0 && sim.state.laserCooldown === 0;
}

/** The power-up (never a power-down) that reaches the paddle first, with its time to arrival in seconds. */
function nextPickup(sim: Simulation, paddleTop: number): { x: number; time: number } | null {
  let best: { x: number; y: number } | null = null;
  for (const p of sim.state.pickups) if (!isPowerDown(p.kind) && p.y < paddleTop && (!best || p.y > best.y)) best = p;
  if (!best) return null;
  return { x: best.x, time: (paddleTop - best.y) / sim.config.powerUps.fallSpeed };
}

function urgentBall(balls: BallState[], paddleTop: number): BallState | null {
  let best: BallState | null = null;
  let bestT = Number.POSITIVE_INFINITY;
  for (const b of balls) {
    if (b.vy > 0) {
      const t = (paddleTop - b.y) / b.vy;
      if (t >= -0.05 && t < bestT) {
        bestT = t;
        best = b;
      }
    }
  }
  if (best) return best;
  for (const b of balls) if (!best || b.y > best.y) best = b;
  return best;
}

/** Straight-line prediction with side-wall reflections. */
export function predictLandingX(ball: BallState, paddleTop: number): number {
  if (ball.vy <= 0) return ball.x;
  const t = Math.max(0, (paddleTop - ball.radius - ball.y) / ball.vy);
  const min = ball.radius;
  const span = SIM.worldWidth - 2 * ball.radius;
  let x = ball.x + ball.vx * t - min;
  const period = 2 * span;
  x = ((x % period) + period) % period;
  if (x > span) x = period - x;
  return x + min;
}

function aimTarget(sim: Simulation, fromX: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestKey = Number.NEGATIVE_INFINITY;
  for (const b of sim.state.bricks) {
    if (!b.alive || !b.required) continue;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    // Prefer low bricks, then ones close to where the ball lands.
    const key = y * 4 - Math.abs(x - fromX);
    if (key > bestKey) {
      bestKey = key;
      best = { x, y };
    }
  }
  return best;
}
