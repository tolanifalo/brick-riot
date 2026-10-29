import { BALANCE, SIM, type BalanceConfig } from '../config/balance';
import { POWER_UP_KINDS, TIMED_POWER_UPS, type PowerUpKind, type TimedPowerUp } from '../config/powerups';
import { compileBoard, gridPitch, type BoardDefinition } from '../levels/schema';
import { nextRandom, normalizeSeed } from '../math/rng';
import { clearBonus, destroyScore } from './scoring';
import type { BallState, BrickState, EffectTimers, ExternalCommand, SimEvent, SimState, TickInput } from './types';

export interface SimulationOptions {
  seed?: number;
  config?: BalanceConfig;
}

interface PendingExplosion {
  brickId: number;
  x: number;
  y: number;
  radius: number;
  source: 'brick' | 'bomb';
}

/** Salt that derives the drop RNG stream from the run seed. */
const DROP_STREAM_SALT = 0x5bd1e995;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function emptyEffects(): EffectTimers {
  return { wide: 0, heavy: 0, magnet: 0, laser: 0, bomb: 0 };
}

export function createInitialState(board: BoardDefinition, seed: number, config: BalanceConfig): SimState {
  const bricks: BrickState[] = compileBoard(board, SIM.worldWidth).map((b, id) => ({
    id,
    ...b,
    maxHp: b.hp,
    alive: true,
    baseX: b.x,
    vx: 0,
  }));
  const requiredTotal = bricks.filter((b) => b.required).length;
  const state: SimState = {
    boardId: board.id,
    boardVersion: board.version,
    seed,
    tick: 0,
    status: 'ready',
    paused: false,
    rngState: seed,
    dropRngState: (seed ^ DROP_STREAM_SALT) | 0,
    lives: config.lives,
    score: 0,
    combo: 0,
    bestCombo: 0,
    bricksDestroyed: 0,
    ballsLost: 0,
    elapsedTicks: 0,
    started: false,
    requiredTotal,
    requiredRemaining: requiredTotal,
    ticksSinceProgress: 0,
    speedHits: 0,
    nextBallId: 0,
    nextEntityId: 0,
    clearBonus: 0,
    paddle: {
      x: SIM.worldWidth / 2,
      y: config.paddle.y,
      width: config.paddle.width,
      height: config.paddle.height,
      vx: 0,
    },
    balls: [],
    bricks,
    pickups: [],
    lasers: [],
    effects: emptyEffects(),
    laserCooldown: 0,
    powerUpsCollected: 0,
    energy10: Math.round(Math.min(config.energy.max, Math.max(0, config.energy.start)) * 10),
    cooldowns: { emp: 0, shrink: 0, frost: 0, shield: 0, cleanse: 0 },
    shieldUntil: 0,
    debuff: null,
    immuneUntil: 0,
    serveReadyTick: 0,
    armorCharge: 0,
  };
  state.balls.push(spawnAttachedBall(state, config));
  return state;
}

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function spawnAttachedBall(state: SimState, config: BalanceConfig): BallState {
  const { paddle } = state;
  return {
    id: state.nextBallId++,
    x: paddle.x,
    y: paddle.y - paddle.height / 2 - config.ball.radius,
    vx: 0,
    vy: 0,
    speed: config.ball.baseSpeed,
    radius: config.ball.radius,
    attached: true,
    attachOffset: 0,
    heldTicks: 0,
  };
}

/**
 * Deterministic, render-independent brick-breaker simulation.
 *
 * Advance it only through `step`, once per fixed tick (SIM.dt). Identical
 * board, seed, config and input sequence always yield identical state, which
 * lets the server re-run and verify a client's result.
 */
export class Simulation {
  readonly board: BoardDefinition;
  readonly config: BalanceConfig;
  state: SimState;
  private events: SimEvent[] = [];
  private readonly explosionQueue: PendingExplosion[] = [];
  private readonly pitch: { x: number; y: number };

  constructor(board: BoardDefinition, options: SimulationOptions = {}) {
    this.board = board;
    this.config = options.config ?? BALANCE;
    this.state = createInitialState(board, normalizeSeed(options.seed ?? 1), this.config);
    this.pitch = gridPitch(board, SIM.worldWidth);
  }

  get isOver(): boolean {
    return this.state.status === 'won' || this.state.status === 'lost';
  }

  setPaused(paused: boolean): void {
    this.state.paused = this.isOver ? false : paused;
  }

  step(input: TickInput): SimEvent[] {
    const events: SimEvent[] = [];
    this.events = events;
    const s = this.state;
    if (s.paused || this.isOver) return events;

    s.tick++;
    if (s.started) s.elapsedTicks++;
    if (input.ext && input.ext.length > 0) this.applyExternal(input.ext);
    if (s.debuff) this.updateDebuff();
    this.moveBricks();
    this.applyPaddleWidth();
    this.movePaddle(input);

    if (s.status === 'ready') {
      this.syncAttachedBalls();
      if (input.launch && s.tick >= s.serveReadyTick) this.launch();
      return events;
    }

    s.ticksSinceProgress++;
    if (input.launch) this.handleAction();
    this.updateHeldBalls();
    for (const ball of s.balls) {
      if (ball.attached) continue;
      this.advanceBall(ball);
      if (s.status === 'won') return events;
    }
    this.advanceLasers();
    if (s.status === 'won') return events;
    this.advancePickups();
    this.separateFromMovingBricks();
    this.tickEffects();
    this.removeLostBalls();
    return events;
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }

  // ---- Bricks & paddle -------------------------------------------------------

  /** Moving bricks follow a triangle wave of the tick count: a pure function of time. */
  private moveBricks(): void {
    const tick = this.state.tick;
    for (const b of this.state.bricks) {
      if (b.moveRange === 0 || !b.alive) continue;
      const period = 2 * b.moveRange;
      const travel = (tick * b.moveSpeed * SIM.dt) % period;
      const forward = travel <= b.moveRange;
      b.x = b.baseX + (forward ? travel : period - travel);
      b.vx = forward ? b.moveSpeed : -b.moveSpeed;
    }
  }

  /** True while an EMP is active: paddle power-ups (wide, magnet, laser) are suspended. */
  private get jammed(): boolean {
    const d = this.state.debuff;
    return d !== null && d.kind === 'emp' && d.phase === 'active';
  }

  private applyPaddleWidth(): void {
    const p = this.state.paddle;
    const base = this.config.paddle.width;
    let width = this.state.effects.wide > 0 && !this.jammed ? base * this.config.powerUps.definitions.wide.strength : base;
    const d = this.state.debuff;
    if (d && d.kind === 'shrink' && d.phase === 'active') {
      width = Math.max(this.config.sabotage.minPaddleWidth, width * d.factor);
    }
    if (p.width === width) return;
    p.width = width;
    p.x = clamp(p.x, width / 2, SIM.worldWidth - width / 2);
    for (const ball of this.state.balls) {
      if (ball.attached) ball.attachOffset = clamp(ball.attachOffset, -width / 2, width / 2);
    }
  }

  private movePaddle(input: TickInput): void {
    const p = this.state.paddle;
    const half = p.width / 2;
    let next: number;
    if (input.targetX !== null && Number.isFinite(input.targetX)) {
      const maxDelta = this.config.paddle.pointerMaxSpeed * SIM.dt;
      next = p.x + clamp(input.targetX - p.x, -maxDelta, maxDelta);
    } else {
      const axis = Number.isFinite(input.axis) ? clamp(input.axis, -1, 1) : 0;
      next = p.x + axis * this.config.paddle.keyboardSpeed * SIM.dt;
    }
    next = clamp(next, half, SIM.worldWidth - half);
    p.vx = (next - p.x) / SIM.dt;
    p.x = next;
  }

  private syncAttachedBalls(): void {
    const p = this.state.paddle;
    for (const ball of this.state.balls) {
      if (!ball.attached) continue;
      ball.x = p.x;
      ball.y = p.y - p.height / 2 - ball.radius;
    }
  }

  private launch(): void {
    const s = this.state;
    const roll = nextRandom(s.rngState);
    s.rngState = roll.state;
    const offset = (roll.value * 2 - 1) * this.config.ball.launchSpread;
    for (const ball of s.balls) {
      if (!ball.attached) continue;
      ball.attached = false;
      setDirection(ball, offset * this.config.rebound.maxTan, -1);
      this.emit({ type: 'launch', ballId: ball.id, x: ball.x, y: ball.y });
    }
    s.status = 'playing';
    s.started = true;
    s.ticksSinceProgress = 0;
  }

  // ---- Player action (launch input during play) ------------------------------

  private handleAction(): void {
    const s = this.state;
    for (const ball of s.balls) if (ball.attached) this.releaseBall(ball);
    if (s.effects.laser > 0 && s.laserCooldown === 0 && !this.jammed) this.fireLaser();
  }

  /** Contact offset in [-1, 1], scaled by Precision Aim when equipped. */
  private reboundOffset(raw: number): number {
    const gain = this.config.rebound.offsetGain;
    return clamp(gain === 1 ? raw : raw * gain, -1, 1);
  }

  private releaseBall(ball: BallState): void {
    const p = this.state.paddle;
    const offset = this.reboundOffset(ball.attachOffset / (p.width / 2 + ball.radius * 0.5));
    ball.attached = false;
    ball.heldTicks = 0;
    ball.y = p.y - p.height / 2 - ball.radius;
    setDirection(ball, offset * this.config.rebound.maxTan, -1);
    this.emit({ type: 'magnetRelease', ballId: ball.id });
  }

  private updateHeldBalls(): void {
    const s = this.state;
    const p = s.paddle;
    const holdTicks = Math.round(this.config.powerUps.definitions.magnet.strength * SIM.tickRate);
    for (const ball of s.balls) {
      if (!ball.attached) continue;
      ball.x = clamp(p.x + ball.attachOffset, ball.radius, SIM.worldWidth - ball.radius);
      ball.y = p.y - p.height / 2 - ball.radius;
      ball.heldTicks++;
      if (ball.heldTicks >= holdTicks) this.releaseBall(ball);
    }
  }

  // ---- Balls -----------------------------------------------------------------

  private advanceBall(ball: BallState): void {
    const steps = Math.max(1, Math.ceil((ball.speed * SIM.dt) / this.config.ball.maxStep));
    const subDt = SIM.dt / steps;
    for (let i = 0; i < steps; i++) {
      ball.x += ball.vx * subDt;
      ball.y += ball.vy * subDt;
      this.collideWalls(ball);
      this.collidePaddle(ball);
      if (ball.attached) return;
      this.collideBricks(ball);
      this.processExplosions();
      if (this.state.requiredRemaining === 0) {
        this.win();
        return;
      }
      if (ball.y - ball.radius > SIM.worldHeight) return;
    }
  }

  private collideWalls(ball: BallState): void {
    const r = ball.radius;
    let bounced = false;
    if (ball.x - r < 0) {
      ball.x = r;
      if (ball.vx < 0) ball.vx = -ball.vx;
      bounced = true;
    } else if (ball.x + r > SIM.worldWidth) {
      ball.x = SIM.worldWidth - r;
      if (ball.vx > 0) ball.vx = -ball.vx;
      bounced = true;
    }
    if (ball.y - r < 0) {
      ball.y = r;
      if (ball.vy < 0) ball.vy = -ball.vy;
      bounced = true;
    }
    if (bounced) {
      this.afterBounce(ball, true);
      this.emit({ type: 'wall', x: ball.x, y: ball.y });
    }
  }

  private collidePaddle(ball: BallState): void {
    if (ball.vy <= 0) return;
    const p = this.state.paddle;
    const r = ball.radius;
    const half = p.width / 2;
    const top = p.y - p.height / 2;
    const bottom = p.y + p.height / 2;
    if (ball.y + r < top || ball.y > bottom) return;
    const cx = clamp(ball.x, p.x - half, p.x + half);
    const cy = clamp(ball.y, top, bottom);
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    if (dx * dx + dy * dy > r * r) return;

    const s = this.state;
    s.combo = 0;
    s.ticksSinceProgress = 0;
    if (s.effects.magnet > 0 && !this.jammed) {
      ball.attached = true;
      ball.attachOffset = clamp(ball.x - p.x, -half, half);
      ball.heldTicks = 0;
      ball.vx = 0;
      ball.vy = 0;
      ball.y = top - r;
      this.emit({ type: 'paddle', x: ball.x, y: top, offset: ball.attachOffset / half });
      this.emit({ type: 'magnetCatch', ballId: ball.id });
      return;
    }

    // Rebound angle depends only on where the ball meets the paddle.
    const offset = this.reboundOffset((ball.x - p.x) / (half + r * 0.5));
    setDirection(ball, offset * this.config.rebound.maxTan, -1);
    ball.y = top - r;
    this.emit({ type: 'paddle', x: ball.x, y: top, offset });
  }

  private collideBricks(ball: BallState): void {
    const r = ball.radius;
    let best: BrickState | null = null;
    let bestPen = 0;
    // Bricks are iterated in id order and only a strictly deeper contact wins,
    // so collision ordering is stable.
    for (const b of this.state.bricks) {
      if (!b.alive) continue;
      if (ball.x + r <= b.x || ball.x - r >= b.x + b.width || ball.y + r <= b.y || ball.y - r >= b.y + b.height) {
        continue;
      }
      const pen = penetration(ball, b);
      if (pen > bestPen) {
        bestPen = pen;
        best = b;
      }
    }
    if (!best) return;

    const breakable = best.type !== 'indestructible';
    if (breakable && this.state.effects.heavy > 0) {
      // Heavy ball: smash straight through without deflecting.
      this.damageBrick(best, this.config.powerUps.definitions.heavy.strength);
      this.detonateBomb(best);
      this.bumpSpeed(ball);
      return;
    }

    if (!resolveBrickContact(ball, best)) return;
    if (!breakable) {
      this.emit({ type: 'brickDeflect', brickId: best.id, x: ball.x, y: ball.y });
      this.afterBounce(ball, true);
      return;
    }
    this.damageBrick(best, this.ballDamage(best));
    this.detonateBomb(best);
    this.bumpSpeed(ball);
    this.afterBounce(ball, false);
  }

  /**
   * Ball Power upgrade: each contact with a multi-hit brick charges the ball;
   * a full charge adds 1 damage to that contact. Deterministic, no RNG.
   */
  private ballDamage(brick: BrickState): number {
    const charge = this.config.ball.armorCharge;
    if (charge <= 0 || brick.hp < 2 || brick.type === 'frost') return 1;
    const s = this.state;
    s.armorCharge += charge;
    if (s.armorCharge < 1) return 1;
    s.armorCharge -= 1;
    return 2;
  }

  private gainEnergy(units: number): void {
    const s = this.state;
    const e = this.config.energy;
    s.energy10 = Math.min(e.max * 10, s.energy10 + Math.round(units * 10 * e.gainMultiplier));
  }

  private damageBrick(brick: BrickState, amount: number): void {
    if (!brick.alive || brick.type === 'indestructible') return;
    if (brick.type === 'frost') return this.damageFrost(brick, amount);
    const s = this.state;
    const scoring = this.config.scoring;
    const x = brick.x + brick.width / 2;
    const y = brick.y + brick.height / 2;
    s.ticksSinceProgress = 0;
    brick.hp -= amount;
    if (brick.hp > 0) {
      s.score += scoring.hitPoints;
      this.gainEnergy(this.config.energy.perDamage);
      this.emit({ type: 'brickHit', brickId: brick.id, x, y, destroyed: false, points: scoring.hitPoints, combo: s.combo });
      return;
    }
    brick.hp = 0;
    brick.alive = false;
    brick.vx = 0;
    s.bricksDestroyed++;
    if (brick.required) s.requiredRemaining--;
    s.combo++;
    if (s.combo > s.bestCombo) s.bestCombo = s.combo;
    const points = destroyScore(scoring.destroyPoints[brick.type], s.combo, scoring);
    s.score += points;
    // Each brick is destroyed exactly once, so chain reactions cannot double-award energy.
    this.gainEnergy(this.config.energy.perDestroy);
    if (s.combo % this.config.energy.comboEvery === 0) this.gainEnergy(this.config.energy.comboBonus);
    this.emit({ type: 'brickHit', brickId: brick.id, x, y, destroyed: true, points, combo: s.combo });
    if (brick.type === 'explosive') {
      this.explosionQueue.push({ brickId: brick.id, x, y, radius: 1, source: 'brick' });
    }
    this.maybeDrop(brick, x, y);
  }

  private detonateBomb(brick: BrickState): void {
    const s = this.state;
    if (s.effects.bomb <= 0) return;
    s.effects.bomb = 0;
    this.explosionQueue.push({
      brickId: brick.id,
      x: brick.x + brick.width / 2,
      y: brick.y + brick.height / 2,
      radius: this.config.powerUps.definitions.bomb.strength,
      source: 'bomb',
    });
    this.emit({ type: 'effectEnded', kind: 'bomb' });
  }

  /**
   * Damages every brick whose centre lies within `radius` grid cells of the
   * blast centre. For static grids this is exactly the surrounding
   * (2r+1)x(2r+1) cells; moving bricks are caught by where they are now.
   */
  private processExplosions(): void {
    let blast = this.explosionQueue.shift();
    while (blast) {
      this.emit({ type: 'explosion', brickId: blast.brickId, x: blast.x, y: blast.y, radius: blast.radius, source: blast.source });
      const reachX = (blast.radius + 0.5) * this.pitch.x;
      const reachY = (blast.radius + 0.5) * this.pitch.y;
      for (const other of this.state.bricks) {
        if (!other.alive) continue;
        const ox = other.x + other.width / 2;
        const oy = other.y + other.height / 2;
        if (Math.abs(ox - blast.x) < reachX && Math.abs(oy - blast.y) < reachY) {
          this.damageBrick(other, this.config.explosive.damage);
        }
      }
      blast = this.explosionQueue.shift();
    }
  }

  private bumpSpeed(ball: BallState): void {
    const { baseSpeed, maxSpeed, speedPerHit } = this.config.ball;
    this.state.speedHits++;
    setSpeed(ball, Math.min(maxSpeed, baseSpeed + this.state.speedHits * speedPerHit));
  }

  /**
   * Keeps the ball out of near-horizontal loops and, if it has made no
   * progress for a while, rotates it by a fixed angle on its next
   * wall/obstacle bounce. Both rules are deterministic.
   */
  private afterBounce(ball: BallState, canNudge: boolean): void {
    const s = this.state;
    const g = this.config.safeguards;
    const stuckTicks = g.stuckSeconds * SIM.tickRate;
    if (canNudge && s.ticksSinceProgress >= stuckTicks) {
      rotate(ball, g.nudgeSin, g.nudgeCos);
      s.ticksSinceProgress = stuckTicks - g.nudgeRepeatSeconds * SIM.tickRate;
      this.emit({ type: 'nudge', ballId: ball.id });
    }
    this.enforceMinVertical(ball);
  }

  private enforceMinVertical(ball: BallState): void {
    const g = this.config.safeguards;
    const minVy = ball.speed * g.minVerticalSin;
    if (Math.abs(ball.vy) < minVy) {
      const sy = ball.vy > 0 ? 1 : -1;
      const sx = ball.vx < 0 ? -1 : 1;
      ball.vy = sy * minVy;
      ball.vx = sx * ball.speed * g.minVerticalCos;
    }
  }

  /**
   * Safety net: a ball must never end a tick inside a moving brick (the brick
   * may have slid into it). Push it out vertically, away from the brick.
   */
  private separateFromMovingBricks(): void {
    for (const ball of this.state.balls) {
      if (ball.attached) continue;
      for (const b of this.state.bricks) {
        if (!b.alive || b.moveRange === 0) continue;
        if (ball.x <= b.x || ball.x >= b.x + b.width || ball.y <= b.y || ball.y >= b.y + b.height) continue;
        const above = ball.y < b.y + b.height / 2;
        ball.y = above ? b.y - ball.radius : b.y + b.height + ball.radius;
        if ((above && ball.vy > 0) || (!above && ball.vy < 0)) ball.vy = -ball.vy;
      }
    }
  }

  // ---- Power-ups -------------------------------------------------------------

  private rollPowerUp(): PowerUpKind {
    const defs = this.config.powerUps.definitions;
    let total = 0;
    for (const kind of POWER_UP_KINDS) total += defs[kind].dropWeight;
    const roll = nextRandom(this.state.dropRngState);
    this.state.dropRngState = roll.state;
    let pick = roll.value * total;
    for (const kind of POWER_UP_KINDS) {
      pick -= defs[kind].dropWeight;
      if (pick < 0) return kind;
    }
    return POWER_UP_KINDS[POWER_UP_KINDS.length - 1] ?? 'multiball';
  }

  private maybeDrop(brick: BrickState, x: number, y: number): void {
    const s = this.state;
    let kind: PowerUpKind | null = null;
    if (brick.powerUp) {
      kind = brick.powerUp === 'random' ? this.rollPowerUp() : brick.powerUp;
    } else if ((this.board.dropChance ?? 0) > 0) {
      const roll = nextRandom(s.dropRngState);
      s.dropRngState = roll.state;
      if (roll.value < (this.board.dropChance ?? 0)) kind = this.rollPowerUp();
    }
    if (!kind || s.pickups.length >= this.config.powerUps.maxPickups) return;
    const id = s.nextEntityId++;
    s.pickups.push({ id, kind, x, y });
    this.emit({ type: 'pickupSpawned', pickupId: id, kind, x, y });
  }

  private advancePickups(): void {
    const s = this.state;
    const cfg = this.config.powerUps;
    const p = s.paddle;
    const top = p.y - p.height / 2;
    const bottom = p.y + p.height / 2;
    const dy = cfg.fallSpeed * SIM.dt;
    let i = 0;
    while (i < s.pickups.length) {
      const pickup = s.pickups[i];
      if (!pickup) break;
      pickup.y += dy;
      const overlapsX = Math.abs(pickup.x - p.x) <= cfg.capsuleWidth / 2 + p.width / 2;
      const overlapsY = pickup.y + cfg.capsuleHeight / 2 >= top && pickup.y - cfg.capsuleHeight / 2 <= bottom;
      if (overlapsX && overlapsY) {
        s.pickups.splice(i, 1);
        s.score += cfg.collectPoints;
        s.powerUpsCollected++;
        this.emit({ type: 'powerUp', kind: pickup.kind, x: pickup.x, y: top });
        this.applyPowerUp(pickup.kind);
        continue;
      }
      if (pickup.y - cfg.capsuleHeight / 2 > SIM.worldHeight) {
        s.pickups.splice(i, 1);
        this.emit({ type: 'pickupMissed', pickupId: pickup.id });
        continue;
      }
      i++;
    }
  }

  private applyPowerUp(kind: PowerUpKind): void {
    const def = this.config.powerUps.definitions[kind];
    if (kind === 'multiball') {
      this.spawnMultiball(def.strength);
      return;
    }
    // Timed effects refresh to full duration; they never stack beyond it.
    this.state.effects[kind] = Math.max(1, Math.round(def.durationSeconds * SIM.tickRate));
  }

  private spawnMultiball(count: number): void {
    const s = this.state;
    const cfg = this.config.powerUps;
    let source = s.balls.find((b) => !b.attached);
    if (!source) {
      source = s.balls[0];
      if (!source) return;
      this.releaseBall(source);
    }
    let spawned = 0;
    for (let k = 0; k < count && s.balls.length < cfg.maxBalls; k++) {
      const ball: BallState = { ...source, id: s.nextBallId++, attached: false, attachOffset: 0, heldTicks: 0 };
      const turns = Math.floor(k / 2) + 1;
      const sin = k % 2 === 0 ? cfg.multiballSin : -cfg.multiballSin;
      for (let t = 0; t < turns; t++) rotate(ball, sin, cfg.multiballCos);
      this.enforceMinVertical(ball);
      s.balls.push(ball);
      spawned++;
    }
    if (spawned > 0) this.emit({ type: 'multiball', spawned });
  }

  private fireLaser(): void {
    const s = this.state;
    const p = s.paddle;
    const y = p.y - p.height / 2 - 2;
    const leftX = p.x - p.width / 2 + 8;
    const rightX = p.x + p.width / 2 - 8;
    s.lasers.push({ id: s.nextEntityId++, x: leftX, y }, { id: s.nextEntityId++, x: rightX, y });
    s.laserCooldown = Math.max(1, Math.round(this.config.powerUps.definitions.laser.cooldownSeconds * SIM.tickRate));
    this.emit({ type: 'laserFired', leftX, rightX, y });
  }

  private advanceLasers(): void {
    const s = this.state;
    if (s.lasers.length === 0) return;
    const dy = this.config.powerUps.laserBoltSpeed * SIM.dt;
    let i = 0;
    while (i < s.lasers.length) {
      const bolt = s.lasers[i];
      if (!bolt) break;
      const prevY = bolt.y;
      bolt.y -= dy;
      // First brick the bolt's swept segment reaches (lowest bottom edge wins).
      let hit: BrickState | null = null;
      for (const b of s.bricks) {
        if (!b.alive || bolt.x < b.x || bolt.x > b.x + b.width) continue;
        if (b.y > prevY || b.y + b.height < bolt.y) continue;
        if (!hit || b.y + b.height > hit.y + hit.height) hit = b;
      }
      if (hit) {
        s.lasers.splice(i, 1);
        this.emit({ type: 'laserHit', boltId: bolt.id, x: bolt.x, y: hit.y + hit.height });
        if (hit.type === 'indestructible') {
          this.emit({ type: 'brickDeflect', brickId: hit.id, x: bolt.x, y: hit.y + hit.height });
        } else {
          this.damageBrick(hit, this.config.powerUps.definitions.laser.strength);
        }
        continue;
      }
      if (bolt.y < 0) {
        s.lasers.splice(i, 1);
        continue;
      }
      i++;
    }
    this.processExplosions();
    if (s.requiredRemaining === 0) this.win();
  }

  private tickEffects(): void {
    const s = this.state;
    if (s.laserCooldown > 0) s.laserCooldown--;
    const jammed = this.jammed;
    for (const kind of TIMED_POWER_UPS) {
      if (s.effects[kind] <= 0) continue;
      // EMP suspends paddle power-ups; their timers pause rather than run down.
      if (jammed && (kind === 'wide' || kind === 'magnet' || kind === 'laser')) continue;
      s.effects[kind]--;
      if (s.effects[kind] === 0) this.expireEffect(kind);
    }
  }

  private expireEffect(kind: TimedPowerUp): void {
    this.emit({ type: 'effectEnded', kind });
    if (kind === 'magnet') {
      for (const ball of this.state.balls) if (ball.attached) this.releaseBall(ball);
    }
  }

  private clearPowerUps(): void {
    const s = this.state;
    s.effects = emptyEffects();
    s.pickups = [];
    s.lasers = [];
    s.laserCooldown = 0;
    s.paddle.width = this.config.paddle.width;
    s.paddle.x = clamp(s.paddle.x, s.paddle.width / 2, SIM.worldWidth - s.paddle.width / 2);
  }

  // ---- Outcomes --------------------------------------------------------------

  private win(): void {
    const s = this.state;
    s.status = 'won';
    s.clearBonus = clearBonus(s.lives, s.elapsedTicks, this.board.parTimeSeconds, this.config.scoring);
    s.score += s.clearBonus;
    this.emit({ type: 'won', clearBonus: s.clearBonus });
  }

  /**
   * A life is lost only when the last ball in play drains. Extra (multiball)
   * balls that fall are simply removed.
   */
  private removeLostBalls(): void {
    const s = this.state;
    const isLost = (b: BallState): boolean => b.y - b.radius > SIM.worldHeight;
    const lostBall = s.balls.find(isLost);
    if (!lostBall) return;
    const drained = s.balls.filter(isLost);
    s.balls = s.balls.filter((b) => !isLost(b));
    if (s.balls.length > 0) {
      for (const b of drained) this.emit({ type: 'ballDrained', ballId: b.id, x: b.x });
      return;
    }

    s.lives--;
    s.ballsLost++;
    s.combo = 0;
    this.emit({ type: 'ballLost', x: lostBall.x, livesRemaining: Math.max(0, s.lives) });
    if (s.lives <= 0) {
      s.lives = 0;
      s.status = 'lost';
      this.emit({ type: 'lost' });
      return;
    }
    s.status = 'ready';
    s.speedHits = 0;
    if (hasAnyPowerUpState(s)) this.clearPowerUps();
    s.balls.push(spawnAttachedBall(s, this.config));
    const delay = this.config.ball.relaunchDelaySeconds;
    if (delay > 0) s.serveReadyTick = s.tick + Math.round(delay * SIM.tickRate);
  }

  // ---- Abilities (Phase 4) -----------------------------------------------------
  // The simulation never DECIDES anything about abilities: the server's arbiter
  // validates every activation and schedules these mechanical commands. Here
  // they are only applied, deterministically, on their tick.

  private applyExternal(commands: readonly ExternalCommand[]): void {
    const s = this.state;
    for (const cmd of commands) {
      switch (cmd.k) {
        case 'spend':
          s.energy10 = Math.max(0, s.energy10 - cmd.cost10);
          s.cooldowns[cmd.ability] = cmd.readyTick;
          this.emit({ type: 'abilityUsed', ability: cmd.ability });
          break;
        case 'shield':
          s.shieldUntil = cmd.untilTick;
          this.emit({ type: 'shieldUp' });
          break;
        case 'block':
          s.shieldUntil = 0;
          this.emit({ type: 'attackBlocked', ability: cmd.ability });
          break;
        case 'debuff':
          this.applyDebuff(cmd);
          break;
        case 'cleanse':
          if (s.debuff) this.endDebuff('cleansed', cmd.immunityTicks);
          break;
      }
    }
  }

  private applyDebuff(cmd: Extract<ExternalCommand, { k: 'debuff' }>): void {
    const s = this.state;
    if (s.debuff) {
      // The arbiter never schedules a second debuff; ignore defensively.
      this.emit({ type: 'debuffEnded', kind: cmd.kind, reason: 'fizzled' });
      return;
    }
    if (cmd.kind === 'frost') {
      const cell = this.frostCell();
      if (!cell) {
        this.emit({ type: 'debuffEnded', kind: 'frost', reason: 'fizzled' });
        return;
      }
      const id = s.bricks.length;
      s.bricks.push({
        id,
        row: -1,
        col: -1,
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        type: 'frost',
        color: 'cyan',
        hp: cmd.hp,
        maxHp: cmd.hp,
        required: false,
        alive: true,
        baseX: cell.x,
        moveRange: 0,
        moveSpeed: 0,
        vx: 0,
        powerUp: null,
      });
      s.debuff = { kind: 'frost', phase: 'active', remaining: cmd.ticks, deferred: 0, factor: 1, brickId: id, hp: cmd.hp, immunityTicks: cmd.immunityTicks };
      this.emit({ type: 'frostSpawned', brickId: id, x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 });
      this.emit({ type: 'debuffActive', kind: 'frost' });
      return;
    }
    s.debuff = { kind: cmd.kind, phase: 'pending', remaining: cmd.ticks, deferred: 0, factor: cmd.factor, brickId: null, hp: 0, immunityTicks: cmd.immunityTicks };
    this.emit({ type: 'debuffIncoming', kind: cmd.kind });
  }

  /**
   * Paddle-size changes (Shrink, or EMP switching off Wide) start only when no
   * ball is descending close to the paddle, so they can never cause an
   * unavoidable miss. The wait is bounded by `maxDeferSeconds`.
   */
  private paddleZoneSafe(): boolean {
    const p = this.state.paddle;
    const zone = this.config.sabotage.safetyZone;
    return !this.state.balls.some((b) => !b.attached && b.vy > 0 && b.y > p.y - zone && b.y < p.y + p.height);
  }

  private updateDebuff(): void {
    const d = this.state.debuff;
    if (!d) return;
    if (d.phase === 'pending') {
      const maxDefer = Math.round(this.config.sabotage.maxDeferSeconds * SIM.tickRate);
      if (!this.paddleZoneSafe() && d.deferred < maxDefer) {
        d.deferred++;
        return;
      }
      d.phase = 'active';
      this.emit({ type: 'debuffActive', kind: d.kind });
    }
    d.remaining--;
    if (d.remaining <= 0) this.endDebuff('expired', d.immunityTicks);
  }

  private endDebuff(reason: 'expired' | 'cleansed' | 'shattered', immunityTicks: number): void {
    const s = this.state;
    const d = s.debuff;
    if (!d) return;
    if (d.brickId !== null) {
      const brick = s.bricks[d.brickId];
      if (brick) brick.alive = false;
    }
    s.debuff = null;
    s.immuneUntil = s.tick + immunityTicks;
    this.emit({ type: 'debuffEnded', kind: d.kind, reason });
  }

  private damageFrost(brick: BrickState, amount: number): void {
    // Frost is the opponent's obstacle: no score, combo, energy or drops.
    brick.hp -= Math.max(1, Math.min(amount, brick.hp));
    const x = brick.x + brick.width / 2;
    const y = brick.y + brick.height / 2;
    const destroyed = brick.hp <= 0;
    this.emit({ type: 'brickHit', brickId: brick.id, x, y, destroyed, points: 0, combo: this.state.combo });
    if (!destroyed) return;
    brick.hp = 0;
    brick.alive = false;
    const d = this.state.debuff;
    if (d && d.brickId === brick.id) this.endDebuff('shattered', d.immunityTicks);
  }

  /**
   * Deterministic Frost Brick placement: a free grid-aligned cell in the open
   * space BELOW every brick (so it can never seal an entrance or trap a ball),
   * at least `frostMinClearance` above the paddle, clear of balls and capsules.
   * Prefers the row nearest the bricks and the column under the lowest
   * remaining required brick. Returns null when there is no room.
   */
  frostCell(): CellRect | null {
    const s = this.state;
    const g = this.board.grid;
    const width = this.pitch.x - g.gap;
    const height = g.brickHeight;
    let lowest = g.top;
    let targetX = SIM.worldWidth / 2;
    let targetBottom = -1;
    for (const b of s.bricks) {
      if (!b.alive) continue;
      lowest = Math.max(lowest, b.y + b.height);
      if (b.required && b.y + b.height > targetBottom) {
        targetBottom = b.y + b.height;
        targetX = b.x + b.width / 2;
      }
    }
    const firstRow = Math.ceil((lowest + this.pitch.y - g.top) / this.pitch.y);
    const maxBottom = s.paddle.y - this.config.sabotage.frostMinClearance;
    const cols = Array.from({ length: g.cols }, (_, c) => c).sort((a, b) => {
      const da = Math.abs(g.sideMargin + a * this.pitch.x + width / 2 - targetX);
      const db = Math.abs(g.sideMargin + b * this.pitch.x + width / 2 - targetX);
      return da - db || a - b;
    });
    for (let row = firstRow; row < firstRow + 3; row++) {
      const y = g.top + row * this.pitch.y;
      if (y + height > maxBottom) break;
      for (const c of cols) {
        const x = g.sideMargin + c * this.pitch.x;
        if (this.cellBlocked(x, y, width, height)) continue;
        return { x, y, width, height };
      }
    }
    return null;
  }

  private cellBlocked(x: number, y: number, w: number, h: number): boolean {
    const s = this.state;
    for (const ball of s.balls) {
      const m = ball.radius * 3;
      if (ball.x + m > x && ball.x - m < x + w && ball.y + m > y && ball.y - m < y + h) return true;
    }
    const cw = this.config.powerUps.capsuleWidth;
    const ch = this.config.powerUps.capsuleHeight;
    for (const p of s.pickups) {
      if (p.x + cw > x && p.x - cw < x + w && p.y + ch > y && p.y - ch < y + h) return true;
    }
    for (const b of s.bricks) {
      if (!b.alive) continue;
      const left = b.moveRange > 0 ? b.baseX : b.x;
      const right = (b.moveRange > 0 ? b.baseX + b.moveRange : b.x) + b.width;
      if (left < x + w && right > x && b.y < y + h && b.y + b.height > y) return true;
    }
    return false;
  }
}

function hasAnyPowerUpState(s: SimState): boolean {
  return (
    s.pickups.length > 0 ||
    s.lasers.length > 0 ||
    s.laserCooldown > 0 ||
    TIMED_POWER_UPS.some((k) => s.effects[k] > 0)
  );
}

function setDirection(ball: BallState, dx: number, dy: number): void {
  const len = Math.sqrt(dx * dx + dy * dy);
  ball.vx = (dx / len) * ball.speed;
  ball.vy = (dy / len) * ball.speed;
}

function setSpeed(ball: BallState, speed: number): void {
  const current = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  ball.speed = speed;
  if (current === 0) return;
  ball.vx = (ball.vx / current) * speed;
  ball.vy = (ball.vy / current) * speed;
}

function rotate(ball: BallState, sin: number, cos: number): void {
  const vx = ball.vx * cos - ball.vy * sin;
  const vy = ball.vx * sin + ball.vy * cos;
  ball.vx = vx;
  ball.vy = vy;
}

function penetration(ball: BallState, b: BrickState): number {
  const cx = clamp(ball.x, b.x, b.x + b.width);
  const cy = clamp(ball.y, b.y, b.y + b.height);
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    return d < ball.radius ? ball.radius - d : 0;
  }
  const inside = Math.min(ball.x - b.x, b.x + b.width - ball.x, ball.y - b.y, b.y + b.height - ball.y);
  return ball.radius + inside;
}

/**
 * Axis-aligned reflection off a brick. Returns false when the ball is already
 * leaving the brick, which prevents double hits on the same contact. Moving
 * bricks are handled in the brick's frame of reference (relative velocity).
 */
function resolveBrickContact(ball: BallState, b: BrickState): boolean {
  const r = ball.radius;
  const cx = clamp(ball.x, b.x, b.x + b.width);
  const cy = clamp(ball.y, b.y, b.y + b.height);
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  let nx = 0;
  let ny = 0;
  if (dx === 0 && dy === 0) {
    const left = ball.x - b.x;
    const right = b.x + b.width - ball.x;
    const top = ball.y - b.y;
    const bottom = b.y + b.height - ball.y;
    if (Math.min(left, right) < Math.min(top, bottom)) nx = left < right ? -1 : 1;
    else ny = top < bottom ? -1 : 1;
  } else {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax >= ay) nx = Math.sign(dx);
    if (ay >= ax) ny = Math.sign(dy);
  }

  const relVx = ball.vx - b.vx;
  let reflectX = nx !== 0 && relVx * nx < 0;
  let reflectY = ny !== 0 && ball.vy * ny < 0;
  if (!reflectX && !reflectY) {
    // Grazing an edge the ball is leaving: fall back to the other axis.
    if (nx !== 0 && ny === 0) {
      ny = ball.y < b.y + b.height / 2 ? -1 : 1;
      reflectY = ball.vy * ny < 0;
    } else if (ny !== 0 && nx === 0) {
      nx = ball.x < b.x + b.width / 2 ? -1 : 1;
      reflectX = relVx * nx < 0;
    }
  }
  if (!reflectX && !reflectY) return false;
  if (reflectX) {
    if (b.vx === 0) {
      ball.vx = -ball.vx;
    } else {
      // Reflect in the brick's frame, then restore the ball's own speed.
      ball.vx = 2 * b.vx - ball.vx;
      setSpeed(ball, ball.speed);
    }
    ball.x = nx < 0 ? b.x - r : b.x + b.width + r;
  }
  if (reflectY) {
    ball.vy = -ball.vy;
    ball.y = ny < 0 ? b.y - r : b.y + b.height + r;
  }
  return true;
}
