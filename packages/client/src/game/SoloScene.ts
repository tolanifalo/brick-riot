import {
  ACTIVE_ABILITIES,
  BALANCE,
  createAutoplayer,
  NO_UPGRADES,
  type ActiveAbility,
  type IssueRunResponse,
  type UpgradeLevels,
  POWER_UP_INFO,
  SIM,
  Simulation,
  summarizeRun,
  ticksToMs,
  TIMED_POWER_UPS,
  type BallState,
  type BoardDefinition,
  type BrickColor,
  type BrickState,
  type PowerUpKind,
  type SimEvent,
  type TickInput,
} from '@brick-riot/shared';
import Phaser from 'phaser';
import { soloConfig } from '../progress/progressStore';
import { encodeEffects, patchHud, type HudSnapshot } from '../state/hudStore';
import type { GameBridge, SceneCommands } from './bridge';
import { installE2EHooks, type E2ESnapshot } from './e2eHooks';
import { InputController } from './input';
import {
  brickVariant,
  ensureBrickTexture,
  ensureCapsuleTexture,
  ensureCommonTextures,
  ensurePaddleTexture,
  TEX_SCALE,
} from './textures';
import { getTheme, shade, type VisualTheme } from './theme';

export interface SoloSceneOptions {
  board: BoardDefinition;
  /** 1-based campaign position, shown in the HUD/intro. */
  levelNumber: number;
  bridge: GameBridge;
  /** Camera zoom: canvas pixels per world unit. */
  resolution: number;
  /** Element receiving touch input (the whole screen, not just the canvas). */
  inputSurface: HTMLElement;
  /** Workshop upgrades applied to solo runs (recorded with the run for verification). */
  upgrades?: UpgradeLevels;
  /** Player setting: fewer particles, no screen shake (also on prefers-reduced-motion). */
  reducedEffects?: boolean;
  /** Signed in: hands out a server-issued run (seed + upgrades) for each start/restart. */
  takeRunTicket?: () => IssueRunResponse | null;
}

const ABILITY_LABEL: Record<ActiveAbility, string> = {
  emp: 'EMP',
  shrink: 'SHRINK',
  frost: 'FROST',
  shield: 'SHIELD',
  cleanse: 'CLEANSE',
};

type Quality = 'high' | 'low';

const MAX_STEPS_PER_FRAME = 12;
const TRAIL_LENGTH = 10;
const POPUP_POOL = 10;
const RING_POOL = 4;
const BOLT_POOL = 12;

interface BallView {
  core: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Image;
  trail: { x: number; y: number }[];
}

function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function newRunId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Renders a Simulation and feeds it input at a fixed timestep. Contains no
 * gameplay rules: everything that affects outcome lives in @brick-riot/shared.
 * Every input the simulation consumes is recorded so the run can be replayed
 * and verified.
 */
export class SoloScene extends Phaser.Scene implements SceneCommands {
  protected readonly opts: SoloSceneOptions;
  protected readonly theme: VisualTheme;
  protected sim!: Simulation;
  protected controls!: InputController;
  protected accumulator = 0;
  protected quality: Quality = 'high';
  protected slowSeconds = 0;
  protected fpsTimer = 0;

  // Run recording
  protected runId = '';
  protected seed = 0;
  protected inputs: TickInput[] = [];
  protected reported = false;
  protected serverRunId: string | null = null;
  protected runUpgrades: UpgradeLevels = NO_UPGRADES;

  // Views
  protected prevPaddleX = 0;
  protected readonly prevBallPos = new Map<number, { x: number; y: number }>();
  protected readonly prevBrickX = new Map<number, number>();
  protected brickSprites: Phaser.GameObjects.Image[] = [];
  protected paddle!: Phaser.GameObjects.Image;
  protected paddleGlow!: Phaser.GameObjects.Image;
  protected paddleWidth = 0;
  protected cannons: Phaser.GameObjects.Image[] = [];
  protected bombRing!: Phaser.GameObjects.Image;
  protected readonly ballViews = new Map<number, BallView>();
  protected readonly pickupViews = new Map<number, Phaser.GameObjects.Image>();
  protected boltPool: Phaser.GameObjects.Image[] = [];
  protected trailPool: Phaser.GameObjects.Image[] = [];
  protected readonly emitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
  protected popups: Phaser.GameObjects.Text[] = [];
  protected popupCursor = 0;
  protected rings: Phaser.GameObjects.Image[] = [];
  protected ringCursor = 0;
  protected lossFlash!: Phaser.GameObjects.Rectangle;
  protected readonly flashUntil = new Map<Phaser.GameObjects.Image, number>();
  protected autopilot: ((sim: Simulation) => TickInput) | null = null;
  protected autopilotSpeed = 1;
  protected uninstallHooks: () => void = () => undefined;
  protected shieldRing!: Phaser.GameObjects.Image;
  /** Fewer particles and no camera shake. */
  protected readonly reduced: boolean;

  constructor(opts: SoloSceneOptions) {
    super({ key: 'solo' });
    this.opts = opts;
    this.theme = getTheme(opts.board.theme);
    const prefersReduced =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.reduced = !!opts.reducedEffects || prefersReduced;
  }

  create(): void {
    const cam = this.cameras.main;
    cam.setZoom(this.opts.resolution);
    cam.centerOn(SIM.worldWidth / 2, SIM.worldHeight / 2);
    cam.setBackgroundColor(this.theme.background);

    ensureCommonTextures(this, 7);
    this.drawField();
    this.createPools();

    this.startRun();
    this.createPaddleView();

    const canvas = this.game.canvas;
    this.controls = new InputController(
      this.opts.inputSurface,
      () => canvas.getBoundingClientRect(),
      SIM.worldWidth,
      {
        onTogglePause: () => this.togglePause(),
        onRestart: () => this.restart(),
        isOver: () => this.sim.isOver,
        onFocusLost: () => {
          if (this.sim.state.status === 'playing') this.setPaused(true);
        },
      },
    );
    this.controls.attach();
    this.opts.bridge.connect(this);
    this.uninstallHooks = installE2EHooks({
      snapshot: () => {
        const s = this.sim.state;
        return {
          status: s.status,
          paused: s.paused,
          paddleX: s.paddle.x,
          paddleWidth: s.paddle.width,
          balls: s.balls.map((b) => ({ x: b.x, y: b.y, attached: b.attached })),
          lives: s.lives,
          score: s.score,
          boardId: s.boardId,
          tick: s.tick,
          energy: Math.floor(s.energy10 / 10),
          debuff: s.debuff?.kind ?? null,
          shielded: s.shieldUntil > s.tick,
          frost: s.bricks.filter((b) => b.type === 'frost' && b.alive).length,
          ...this.extraSnapshot(),
        };
      },
      setAutopilot: (mode, speed = 1) => {
        this.autopilot = mode === 'off' ? null : createAutoplayer(mode);
        this.autopilotSpeed = Math.max(1, Math.min(32, Math.floor(speed)));
      },
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
    this.pushHud();
  }

  override update(time: number, delta: number): void {
    this.monitorPerformance(delta);
    const speed = this.autopilot ? this.autopilotSpeed : 1;
    this.accumulator += (Math.min(delta, 250) / 1000) * speed;
    const maxSteps = MAX_STEPS_PER_FRAME * speed;
    let steps = 0;
    while (this.accumulator >= SIM.dt && steps < maxSteps) {
      this.capturePrevious();
      const human = this.controls.sample();
      const input = this.autopilot ? this.autopilot(this.sim) : human;
      // Record exactly the inputs the simulation consumes.
      const consumed = !this.sim.state.paused && !this.sim.isOver;
      const events = this.sim.step(input);
      if (consumed) this.inputs.push(input);
      if (events.length > 0) this.handleEvents(events);
      if (this.sim.state.tick % 2 === 0) this.sampleTrails();
      this.accumulator -= SIM.dt;
      steps++;
      if (this.sim.isOver) {
        this.reportRun();
        this.accumulator = 0;
        break;
      }
    }
    if (steps >= maxSteps) this.accumulator = 0;
    this.renderState(this.accumulator / SIM.dt, time);
    this.pushHud();
  }

  /** Extra fields for the e2e snapshot (overridden by MatchScene). */
  protected extraSnapshot(): Partial<E2ESnapshot> {
    return {};
  }

  // ---- SceneCommands -------------------------------------------------------

  restart(): void {
    for (const sprite of this.brickSprites) {
      this.tweens.killTweensOf(sprite);
      sprite.destroy();
    }
    this.brickSprites = [];
    this.flashUntil.clear();
    for (const view of this.ballViews.values()) {
      view.core.destroy();
      view.glow.destroy();
    }
    this.ballViews.clear();
    this.prevBallPos.clear();
    for (const view of this.pickupViews.values()) view.destroy();
    this.pickupViews.clear();
    for (const img of this.trailPool) img.setVisible(false);
    for (const img of this.boltPool) img.setVisible(false);
    this.startRun();
    this.accumulator = 0;
    this.controls.clearLaunch();
    this.cameras.main.resetFX();
    this.pushHud();
  }

  setPaused(paused: boolean): void {
    this.sim.setPaused(paused);
    this.controls.clearLaunch();
    this.pushHud();
  }

  togglePause(): void {
    this.setPaused(!this.sim.state.paused);
  }

  // ---- Run lifecycle ---------------------------------------------------------

  protected startRun(): void {
    // Signed-in players get a server-issued run (seed + upgrade snapshot) so the
    // server can verify the result; guests (or offline) pick a local seed.
    const ticket = this.opts.takeRunTicket?.() ?? null;
    this.serverRunId = ticket?.runId ?? null;
    this.runUpgrades = ticket ? ticket.upgrades : (this.opts.upgrades ?? NO_UPGRADES);
    this.seed = ticket ? ticket.seed : newSeed();
    this.runId = ticket ? ticket.runId : newRunId();
    this.inputs = [];
    this.reported = false;
    this.sim = new Simulation(this.opts.board, { seed: this.seed, config: soloConfig(this.runUpgrades) });
    this.prevBrickX.clear();
    this.buildBoardViews();
    this.opts.bridge.runStarted();
  }

  protected reportRun(): void {
    if (this.reported) return;
    this.reported = true;
    this.opts.bridge.runFinished({
      runId: this.runId,
      seed: this.seed,
      inputs: this.inputs,
      summary: summarizeRun(this.sim.state),
      upgrades: this.runUpgrades,
      ...(this.serverRunId ? { serverRunId: this.serverRunId } : {}),
    });
  }

  // ---- Setup ---------------------------------------------------------------

  protected drawField(): void {
    const { worldWidth: W, worldHeight: H } = SIM;
    const g = this.add.graphics().setDepth(-10);
    g.lineStyle(1, this.theme.gridLine, 1);
    for (let x = 24; x < W; x += 24) g.lineBetween(x, 0, x, H);
    for (let y = 24; y < H; y += 24) g.lineBetween(0, y, W, y);
    g.lineStyle(3, this.theme.rail, 0.9);
    g.lineBetween(1.5, 0, 1.5, H);
    g.lineBetween(W - 1.5, 0, W - 1.5, H);
    g.lineBetween(0, 1.5, W, 1.5);
    g.lineStyle(2, this.theme.dangerLine, 0.35);
    const dangerY = BALANCE.paddle.y + 44;
    for (let x = 0; x < W; x += 16) g.lineBetween(x, dangerY, x + 8, dangerY);

    this.lossFlash = this.add
      .rectangle(W / 2, H - 40, W, 80, this.theme.dangerLine, 1)
      .setAlpha(0)
      .setDepth(5)
      .setBlendMode(Phaser.BlendModes.ADD);
  }

  protected createPools(): void {
    for (let i = 0; i < TRAIL_LENGTH * 3; i++) {
      this.trailPool.push(
        this.add.image(0, 0, 'dot').setVisible(false).setDepth(8).setBlendMode(Phaser.BlendModes.ADD),
      );
    }
    for (let i = 0; i < BOLT_POOL; i++) {
      this.boltPool.push(
        this.add
          .image(0, 0, 'bolt')
          .setDisplaySize(3, 14)
          .setTint(this.theme.bricks.red)
          .setVisible(false)
          .setDepth(9)
          .setBlendMode(Phaser.BlendModes.ADD),
      );
    }
    for (let i = 0; i < POPUP_POOL; i++) {
      this.popups.push(
        this.add
          .text(0, 0, '', {
            fontFamily: 'Bungee, Impact, sans-serif',
            fontSize: '15px',
            color: '#ffffff',
            stroke: '#0a0d1c',
            strokeThickness: 4,
            resolution: this.opts.resolution,
          })
          .setOrigin(0.5)
          .setDepth(30)
          .setVisible(false),
      );
    }
    for (let i = 0; i < RING_POOL; i++) {
      this.rings.push(
        this.add.image(0, 0, 'ring').setVisible(false).setDepth(25).setBlendMode(Phaser.BlendModes.ADD),
      );
    }
    this.bombRing = this.add
      .image(0, 0, 'ring')
      .setDisplaySize(30, 30)
      .setTint(this.theme.bricks.magenta)
      .setVisible(false)
      .setDepth(13)
      .setBlendMode(Phaser.BlendModes.ADD);
    for (let i = 0; i < 2; i++) {
      this.cannons.push(this.add.image(0, 0, 'cannon').setDisplaySize(6, 7).setVisible(false).setDepth(11));
    }
    this.shieldRing = this.add
      .image(0, 0, 'glow')
      .setTint(this.theme.bricks.cyan)
      .setAlpha(0.6)
      .setVisible(false)
      .setDepth(9)
      .setBlendMode(Phaser.BlendModes.ADD);
  }

  protected brickTexture(brick: BrickState): string {
    return ensureBrickTexture(
      this,
      this.theme,
      brick.color,
      brickVariant(brick.type, brick.hp, brick.maxHp, brick.moveRange > 0),
      brick.width,
      brick.height,
    );
  }

  protected buildBoardViews(): void {
    for (const brick of this.sim.state.bricks) this.addBrickView(brick);
  }

  protected addBrickView(brick: BrickState): Phaser.GameObjects.Image {
    const sprite = this.add
      .image(brick.x + brick.width / 2, brick.y + brick.height / 2, this.brickTexture(brick))
      .setDisplaySize(brick.width, brick.height)
      .setDepth(1)
      .setVisible(brick.alive);
    if (brick.type === 'explosive' || brick.type === 'powerup') {
      this.tweens.add({ targets: sprite, alpha: 0.72, duration: 520, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    }
    this.brickSprites[brick.id] = sprite;
    return sprite;
  }

  /**
   * Bricks the engine adds mid-run (the Frost Brick ability) get sprites
   * here; ones that vanish without a hit (expiry, resync) are shattered.
   */
  protected syncDynamicBricks(): void {
    const bricks = this.sim.state.bricks;
    for (const brick of bricks) {
      if (brick.type !== 'frost') continue;
      const sprite = this.brickSprites[brick.id] ?? (brick.alive ? this.addBrickView(brick) : undefined);
      if (!sprite) continue;
      if (!brick.alive && sprite.visible && !this.tweens.isTweening(sprite)) this.shatter(sprite, brick);
    }
    // A resync can drop bricks that only existed in the prediction.
    for (let id = bricks.length; id < this.brickSprites.length; id++) this.brickSprites[id]?.setVisible(false);
  }

  protected shatter(sprite: Phaser.GameObjects.Image, brick: BrickState): void {
    this.tweens.killTweensOf(sprite);
    this.flashUntil.delete(sprite);
    this.burst(0xe8fbff, brick.x + brick.width / 2, brick.y + brick.height / 2, 14);
    this.tweens.add({
      targets: sprite,
      alpha: 0,
      scaleX: sprite.scaleX * 1.3,
      duration: this.reduced ? 1 : 160,
      onComplete: () => sprite.setVisible(false).setAlpha(1),
    });
  }

  protected shake(duration: number, intensity: number): void {
    if (!this.reduced) this.cameras.main.shake(duration, intensity);
  }

  protected createPaddleView(): void {
    const p = this.sim.state.paddle;
    this.paddleGlow = this.add
      .image(p.x, p.y, 'glow')
      .setDisplaySize(p.width * 1.6, 48)
      .setTint(this.theme.paddleCap)
      .setAlpha(0.45)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(9);
    this.paddle = this.add.image(p.x, p.y, ensurePaddleTexture(this, this.theme, p.width, p.height)).setDepth(10);
    this.applyPaddleWidth(p.width);
    this.prevPaddleX = p.x;
  }

  protected applyPaddleWidth(width: number): void {
    const p = this.sim.state.paddle;
    this.paddleWidth = width;
    this.tweens.killTweensOf(this.paddle);
    this.paddle.setTexture(ensurePaddleTexture(this, this.theme, width, p.height)).setDisplaySize(width, p.height);
    this.paddleGlow.setDisplaySize(width * 1.6, 48);
  }

  protected ballView(ball: BallState): BallView {
    let view = this.ballViews.get(ball.id);
    if (!view) {
      const size = ball.radius * 2;
      view = {
        glow: this.add
          .image(ball.x, ball.y, 'glow')
          .setDisplaySize(size * 4, size * 4)
          .setTint(this.theme.ballGlow)
          .setAlpha(0.55)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(11),
        core: this.add
          .image(ball.x, ball.y, 'ball')
          .setDisplaySize(size + 2 / TEX_SCALE, size + 2 / TEX_SCALE)
          .setDepth(12),
        trail: [],
      };
      this.ballViews.set(ball.id, view);
    }
    return view;
  }

  protected pickupView(id: number, kind: PowerUpKind): Phaser.GameObjects.Image {
    let view = this.pickupViews.get(id);
    if (!view) {
      const info = POWER_UP_INFO[kind];
      const cfg = this.sim.config.powerUps;
      const key = ensureCapsuleTexture(this, kind, info.glyph, this.theme.bricks[info.color], cfg.capsuleWidth, cfg.capsuleHeight);
      view = this.add.image(0, 0, key).setDisplaySize(cfg.capsuleWidth, cfg.capsuleHeight).setDepth(14);
      this.pickupViews.set(id, view);
    }
    return view;
  }

  protected emitter(color: number): Phaser.GameObjects.Particles.ParticleEmitter {
    let emitter = this.emitters.get(color);
    if (!emitter) {
      emitter = this.add.particles(0, 0, 'spark', {
        speed: { min: 70, max: 300 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 260, max: 560 },
        scale: { start: 0.9, end: 0 },
        alpha: { start: 1, end: 0.2 },
        rotate: { min: 0, max: 360 },
        gravityY: 520,
        tint: color,
        emitting: false,
      });
      emitter.setDepth(20);
      this.emitters.set(color, emitter);
    }
    return emitter;
  }

  protected burst(color: number, x: number, y: number, count: number): void {
    const n = this.quality === 'high' && !this.reduced ? count : Math.ceil(count / 3);
    this.emitter(color).explode(n, x, y);
  }

  protected brickColor(color: BrickColor): number {
    return this.theme.bricks[color];
  }

  // ---- Simulation -> view --------------------------------------------------

  protected capturePrevious(): void {
    const s = this.sim.state;
    this.prevPaddleX = s.paddle.x;
    for (const ball of s.balls) {
      const prev = this.prevBallPos.get(ball.id);
      if (prev) {
        prev.x = ball.x;
        prev.y = ball.y;
      } else {
        this.prevBallPos.set(ball.id, { x: ball.x, y: ball.y });
      }
    }
    for (const b of s.bricks) if (b.moveRange > 0) this.prevBrickX.set(b.id, b.x);
  }

  protected sampleTrails(): void {
    for (const ball of this.sim.state.balls) {
      const view = this.ballViews.get(ball.id);
      if (!view) continue;
      if (ball.attached) {
        view.trail.length = 0;
        continue;
      }
      view.trail.unshift({ x: ball.x, y: ball.y });
      if (view.trail.length > TRAIL_LENGTH) view.trail.length = TRAIL_LENGTH;
    }
  }

  protected renderState(alpha: number, time: number): void {
    const s = this.sim.state;
    this.expireFlashes(this.time.now);
    if (s.paddle.width !== this.paddleWidth) this.applyPaddleWidth(s.paddle.width);
    const px = Phaser.Math.Linear(this.prevPaddleX, s.paddle.x, alpha);
    this.paddle.setPosition(px, s.paddle.y);
    this.paddleGlow.setPosition(px, s.paddle.y + 4);
    const jammed = s.debuff?.kind === 'emp' && s.debuff.phase === 'active';
    this.paddleGlow.setTint(jammed ? 0xffd60a : s.effects.magnet > 0 ? this.theme.bricks.violet : this.theme.paddleCap);
    // EMP: power-up systems flicker (static), but the paddle itself still moves normally.
    this.paddleGlow.setAlpha(jammed ? (this.reduced ? 0.25 : 0.15 + 0.35 * (Math.floor(time / 70) % 2)) : 0.45);
    const shielded = s.shieldUntil > s.tick;
    this.shieldRing.setVisible(shielded);
    if (shielded) {
      const pulse = this.reduced ? 0 : Math.sin(time / 160) * 4;
      this.shieldRing.setPosition(px, s.paddle.y).setDisplaySize(s.paddle.width + 34 + pulse, 40 + pulse);
    }
    this.syncDynamicBricks();
    const laser = s.effects.laser > 0;
    this.cannons.forEach((c, i) => {
      c.setVisible(laser);
      if (laser) c.setPosition(px + (i === 0 ? -1 : 1) * (s.paddle.width / 2 - 8), s.paddle.y - s.paddle.height / 2 - 2);
    });

    // Moving bricks
    for (const b of s.bricks) {
      if (b.moveRange === 0 || !b.alive) continue;
      const sprite = this.brickSprites[b.id];
      const prev = this.prevBrickX.get(b.id) ?? b.x;
      sprite?.setX(Phaser.Math.Linear(prev, b.x, alpha) + b.width / 2);
    }

    // Balls
    const heavy = s.effects.heavy > 0;
    const glowTint = heavy ? this.theme.bricks.orange : this.theme.ballGlow;
    const live = new Set<number>();
    let leadX = 0;
    let leadY = 0;
    let hasLead = false;
    for (const ball of s.balls) {
      live.add(ball.id);
      const view = this.ballView(ball);
      const prev = this.prevBallPos.get(ball.id);
      const x = prev && !ball.attached ? Phaser.Math.Linear(prev.x, ball.x, alpha) : ball.x;
      const y = prev && !ball.attached ? Phaser.Math.Linear(prev.y, ball.y, alpha) : ball.y;
      view.core.setPosition(x, y).setVisible(true);
      view.glow
        .setPosition(x, y)
        .setVisible(true)
        .setTint(glowTint)
        .setDisplaySize(ball.radius * (heavy ? 11 : 8), ball.radius * (heavy ? 11 : 8));
      if (!hasLead) {
        leadX = x;
        leadY = y;
        hasLead = true;
      }
    }
    for (const [id, view] of this.ballViews) {
      if (live.has(id)) continue;
      view.core.destroy();
      view.glow.destroy();
      this.ballViews.delete(id);
      this.prevBallPos.delete(id);
    }
    const bomb = s.effects.bomb > 0 && hasLead;
    this.bombRing.setVisible(bomb);
    if (bomb) {
      const pulse = 26 + Math.sin(time / 90) * 4;
      this.bombRing.setPosition(leadX, leadY).setDisplaySize(pulse, pulse);
    }

    // Pickups and laser bolts
    const livePickups = new Set<number>();
    for (const pickup of s.pickups) {
      livePickups.add(pickup.id);
      this.pickupView(pickup.id, pickup.kind).setPosition(pickup.x, pickup.y);
    }
    for (const [id, view] of this.pickupViews) {
      if (livePickups.has(id)) continue;
      view.destroy();
      this.pickupViews.delete(id);
    }
    this.boltPool.forEach((img, i) => {
      const bolt = s.lasers[i];
      img.setVisible(!!bolt);
      if (bolt) img.setPosition(bolt.x, bolt.y);
    });

    // Trails
    let used = 0;
    if (this.quality === 'high') {
      for (const view of this.ballViews.values()) {
        view.trail.forEach((point, i) => {
          const img = this.trailPool[used++];
          if (!img) return;
          const t = 1 - i / TRAIL_LENGTH;
          img
            .setPosition(point.x, point.y)
            .setDisplaySize(12 * t + 2, 12 * t + 2)
            .setTint(glowTint)
            .setAlpha(0.5 * t)
            .setVisible(true);
        });
      }
    }
    for (let i = used; i < this.trailPool.length; i++) this.trailPool[i]?.setVisible(false);
  }

  protected handleEvents(events: SimEvent[]): void {
    const s = this.sim.state;
    for (const e of events) {
      switch (e.type) {
        case 'brickHit': {
          const brick = s.bricks[e.brickId];
          const sprite = this.brickSprites[e.brickId];
          if (!brick || !sprite) break;
          const color = this.brickColor(brick.color);
          if (e.destroyed) {
            this.flashUntil.delete(sprite);
            this.tweens.killTweensOf(sprite);
            sprite.setTintFill(0xffffff).setAlpha(1);
            this.tweens.add({
              targets: sprite,
              scaleX: sprite.scaleX * 1.25,
              scaleY: sprite.scaleY * 1.5,
              alpha: 0,
              duration: 130,
              onComplete: () => sprite.setVisible(false),
            });
            this.burst(color, e.x, e.y, 12);
            if (e.combo >= 2 && e.points > 0) this.popup(`+${e.points}`, e.x, e.y, e.combo >= 6 ? '#ffd60a' : '#ffffff');
          } else {
            sprite.setTexture(this.brickTexture(brick));
            this.flash(sprite);
            this.burst(color, e.x, e.y, 5);
          }
          break;
        }
        case 'brickDeflect': {
          const sprite = this.brickSprites[e.brickId];
          if (sprite) this.flash(sprite);
          this.burst(this.theme.bricks.steel, e.x, e.y, 4);
          break;
        }
        case 'explosion':
          this.shockwave(e.x, e.y, e.source === 'bomb' ? 200 : 150);
          this.burst(this.theme.bricks.magenta, e.x, e.y, 18);
          this.burst(this.theme.bricks.yellow, e.x, e.y, 12);
          this.shake(100, 0.003);
          break;
        case 'paddle':
          this.tweens.killTweensOf(this.paddle);
          this.paddle.setDisplaySize(s.paddle.width, s.paddle.height);
          this.tweens.add({
            targets: this.paddle,
            scaleY: { from: this.paddle.scaleY * 0.7, to: this.paddle.scaleY },
            duration: 140,
            ease: 'Back.Out',
          });
          this.burst(this.theme.paddleCap, e.x, e.y, 6);
          break;
        case 'wall':
          this.burst(0xffffff, e.x, e.y, 3);
          break;
        case 'launch':
          this.burst(this.theme.ballGlow, e.x, e.y, 8);
          break;
        case 'ballLost':
          this.lossFlash.setAlpha(0.45);
          this.tweens.add({ targets: this.lossFlash, alpha: 0, duration: 420 });
          this.shake(160, 0.004);
          this.burst(this.theme.dangerLine, e.x, SIM.worldHeight - 4, 16);
          break;
        case 'ballDrained':
          this.burst(this.theme.dangerLine, e.x, SIM.worldHeight - 4, 8);
          break;
        case 'pickupSpawned':
          this.burst(this.theme.bricks[POWER_UP_INFO[e.kind].color], e.x, e.y, 6);
          break;
        case 'powerUp': {
          const info = POWER_UP_INFO[e.kind];
          const color = this.theme.bricks[info.color];
          this.burst(color, e.x, e.y, 16);
          this.popup(info.label.toUpperCase(), s.paddle.x, s.paddle.y - 34, `#${shade(color, 0.2).toString(16).padStart(6, '0')}`, 1.25);
          this.paddle.setTintFill(color);
          this.time.delayedCall(70, () => this.paddle.clearTint());
          break;
        }
        case 'multiball':
          this.burst(this.theme.bricks.cyan, s.paddle.x, s.paddle.y - 60, 14);
          break;
        case 'magnetCatch':
          this.burst(this.theme.bricks.violet, s.paddle.x, s.paddle.y - 8, 6);
          break;
        case 'laserFired':
          this.burst(this.theme.bricks.red, e.leftX, e.y, 3);
          this.burst(this.theme.bricks.red, e.rightX, e.y, 3);
          break;
        case 'laserHit':
          this.burst(this.theme.bricks.red, e.x, e.y, 4);
          break;
        case 'won':
          this.celebrate();
          break;
        case 'abilityUsed':
          this.burst(this.theme.bricks.yellow, s.paddle.x, s.paddle.y - 10, 10);
          this.popup(ABILITY_LABEL[e.ability], s.paddle.x, s.paddle.y - 40, '#ffd60a', 1.15);
          break;
        case 'shieldUp':
          this.burst(this.theme.bricks.cyan, s.paddle.x, s.paddle.y, 14);
          break;
        case 'attackBlocked':
          this.shockwave(s.paddle.x, s.paddle.y, 160);
          this.burst(this.theme.bricks.cyan, s.paddle.x, s.paddle.y - 10, 20);
          this.popup(`${ABILITY_LABEL[e.ability]} BLOCKED`, s.paddle.x, s.paddle.y - 46, '#5ef1ff', 1.25);
          break;
        case 'debuffIncoming':
          this.popup(`INCOMING ${ABILITY_LABEL[e.kind]}`, SIM.worldWidth / 2, s.paddle.y - 70, '#ff4d6d', 1.2);
          break;
        case 'debuffActive':
          if (e.kind === 'emp') {
            this.paddle.setTintFill(0xffd60a);
            this.time.delayedCall(90, () => this.paddle.clearTint());
            this.burst(0xffd60a, s.paddle.x, s.paddle.y, 12);
            this.shake(90, 0.002);
          } else if (e.kind === 'shrink') {
            this.burst(this.theme.bricks.magenta, s.paddle.x, s.paddle.y, 12);
          }
          break;
        case 'debuffEnded':
          if (e.reason === 'cleansed') {
            this.burst(0xffffff, s.paddle.x, s.paddle.y - 10, 18);
            this.popup('CLEANSED', s.paddle.x, s.paddle.y - 46, '#ffffff', 1.2);
          } else if (e.reason === 'shattered') {
            this.popup('FROST SHATTERED', SIM.worldWidth / 2, s.paddle.y - 70, '#5ef1ff', 1.1);
          }
          break;
        case 'frostSpawned': {
          const brick = s.bricks[e.brickId];
          if (!brick) break;
          const sprite = this.brickSprites[e.brickId] ?? this.addBrickView(brick);
          sprite.setVisible(true).setAlpha(1);
          if (!this.reduced) {
            const sx = sprite.scaleX;
            const sy = sprite.scaleY;
            sprite.setScale(sx * 0.2, sy * 0.2);
            this.tweens.add({ targets: sprite, scaleX: sx, scaleY: sy, duration: 180, ease: 'Back.Out' });
          }
          this.burst(0xe8fbff, e.x, e.y, 16);
          break;
        }
        case 'pickupMissed':
        case 'effectEnded':
        case 'magnetRelease':
        case 'nudge':
        case 'lost':
          break;
      }
    }
  }

  /** Brief white hit flash, cleared by the render loop (see expireFlashes). */
  protected flash(sprite: Phaser.GameObjects.Image): void {
    sprite.setTintFill(0xffffff);
    this.flashUntil.set(sprite, this.time.now + 55);
  }

  protected expireFlashes(now: number): void {
    for (const [sprite, until] of this.flashUntil) {
      if (now < until) continue;
      this.flashUntil.delete(sprite);
      if (sprite.active) sprite.clearTint();
    }
  }

  protected popup(text: string, x: number, y: number, color: string, scale = 1): void {
    if (this.quality === 'low' && scale === 1) return;
    const label = this.popups[this.popupCursor];
    this.popupCursor = (this.popupCursor + 1) % this.popups.length;
    if (!label) return;
    this.tweens.killTweensOf(label);
    const clampedX = Phaser.Math.Clamp(x, 70, SIM.worldWidth - 70);
    label.setText(text).setColor(color).setPosition(clampedX, y).setAlpha(1).setScale(0.8 * scale).setVisible(true);
    this.tweens.add({
      targets: label,
      y: y - 26,
      alpha: 0,
      scale: 1.1 * scale,
      duration: scale > 1 ? 900 : 520,
      ease: 'Cubic.Out',
      onComplete: () => label.setVisible(false),
    });
  }

  protected shockwave(x: number, y: number, size: number): void {
    const ring = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    if (!ring) return;
    this.tweens.killTweensOf(ring);
    ring.setPosition(x, y).setDisplaySize(20, 20).setAlpha(1).setTint(this.theme.bricks.yellow).setVisible(true);
    this.tweens.add({
      targets: ring,
      displayWidth: size,
      displayHeight: size,
      alpha: 0,
      duration: 340,
      ease: 'Cubic.Out',
      onComplete: () => ring.setVisible(false),
    });
  }

  protected celebrate(): void {
    const colors = Object.values(this.theme.bricks);
    for (let i = 0; i < 8; i++) {
      this.time.delayedCall(i * 90, () => {
        const color = colors[i % colors.length] ?? 0xffffff;
        this.burst(color, 60 + ((i * 53) % (SIM.worldWidth - 120)), 120 + ((i * 97) % 220), 20);
      });
    }
  }

  // ---- HUD & performance ---------------------------------------------------

  protected pushHud(): void {
    const s = this.sim.state;
    const defs = this.sim.config.powerUps.definitions;
    const effects = TIMED_POWER_UPS.filter((k) => s.effects[k] > 0).map((kind) => ({
      kind,
      fraction: s.effects[kind] / Math.max(1, defs[kind].durationSeconds * SIM.tickRate),
    }));
    const snapshot: HudSnapshot = {
      phase: s.status,
      paused: s.paused,
      boardName: this.opts.board.name,
      levelNumber: this.opts.levelNumber,
      score: s.score,
      lives: s.lives,
      combo: s.combo,
      bestCombo: s.bestCombo,
      elapsedMs: Math.floor(ticksToMs(s.elapsedTicks) / 100) * 100,
      bricksRemaining: s.requiredRemaining,
      bricksTotal: s.requiredTotal,
      clearBonus: s.clearBonus,
      quality: this.quality,
      effects: s.status === 'playing' ? encodeEffects(effects) : '',
      energy: Math.floor(s.energy10 / 10),
      energyMax: this.sim.config.energy.max,
      cooldowns: ACTIVE_ABILITIES.filter((a) => s.cooldowns[a] > s.tick)
        .map((a) => `${a}:${Math.ceil(((s.cooldowns[a] - s.tick) * 10) / SIM.tickRate)}`)
        .join('|'),
      debuff: s.debuff ? `${s.debuff.kind}:${s.debuff.phase}:${Math.ceil((s.debuff.remaining * 10) / SIM.tickRate)}` : '',
      shield: s.shieldUntil > s.tick ? Math.ceil(((s.shieldUntil - s.tick) * 10) / SIM.tickRate) : 0,
      immune: s.immuneUntil > s.tick,
    };
    patchHud(snapshot);
  }

  /** Drops to low-effects mode after ~3 s of sustained low frame rate. */
  protected monitorPerformance(delta: number): void {
    if (this.quality === 'low') return;
    this.fpsTimer += delta;
    if (this.fpsTimer < 1000) return;
    this.fpsTimer = 0;
    if (this.game.loop.actualFps < 45) this.slowSeconds++;
    else this.slowSeconds = 0;
    if (this.slowSeconds >= 3) this.quality = 'low';
  }

  protected teardown(): void {
    this.uninstallHooks();
    this.controls.detach();
    this.opts.bridge.disconnect(this);
  }
}
