import { MATCH_CONFIG, matchConfig, Simulation, stateChecksum, type StateMessage } from '@brick-riot/shared';
import type { MatchNet } from '../net/matchNet';
import type { E2ESnapshot } from './e2eHooks';
import { brickVariant, ensureBrickTexture } from './textures';
import { SoloScene, type SoloSceneOptions } from './SoloScene';

export interface MatchSceneOptions extends SoloSceneOptions {
  net: MatchNet;
}

/** Ticks behind the server beyond which we wait for a state snapshot instead of fast-forwarding. */
const MAX_CATCH_UP_TICKS = 240;
const MAX_STEPS_PER_FRAME = 60;

/**
 * The local player's board in a multiplayer race. Rendering, effects and input
 * are inherited from SoloScene; only the tick driver differs: ticks advance to
 * the predicted server tick (not a free-running local clock), every consumed
 * input is sent to the server, and the authoritative checksum/state stream
 * corrects any divergence. There is no pause or restart in multiplayer.
 */
export class MatchScene extends SoloScene {
  private readonly net: MatchNet;

  constructor(opts: MatchSceneOptions) {
    super(opts);
    this.net = opts.net;
  }

  protected override startRun(): void {
    this.seed = this.net.start.seed;
    this.runId = this.net.start.matchId;
    this.inputs = [];
    this.reported = true; // Results come from the server only.
    // The exact per-player config the server uses (loadout passive, locked upgrades).
    this.sim = new Simulation(this.opts.board, { seed: this.seed, config: matchConfig(this.net.start) });
    this.prevBrickX.clear();
    this.buildBoardViews();
  }

  protected override extraSnapshot(): Partial<E2ESnapshot> {
    return { net: { ...this.net.stats } };
  }

  override restart(): void {
    // Not available in multiplayer.
  }

  override setPaused(): void {
    // The server clock never pauses.
  }

  override togglePause(): void {
    // The server clock never pauses.
  }

  override update(time: number, delta: number): void {
    this.monitorPerformance(delta);
    const net = this.net;
    if (delta > 50) net.stats.frameStalls++;
    const resync = net.takeResync();
    if (resync) this.applyResync(resync);

    const predicted = net.predictedTickFloat();
    const target = Math.min(Math.floor(predicted), net.durationTicks);
    if (target <= 0) {
      // Countdown: controls are locked and any taps are discarded.
      this.controls.sample();
    } else if (target - this.sim.state.tick > MAX_CATCH_UP_TICKS) {
      // Far behind (tab was hidden, or we just rejoined): adopt server state.
      net.requestResync();
    } else {
      let steps = 0;
      while (!this.sim.isOver && this.sim.state.tick < target && steps < MAX_STEPS_PER_FRAME) {
        this.capturePrevious();
        const human = this.controls.sample();
        const own = this.autopilot ? this.autopilot(this.sim) : human;
        const tick = this.sim.state.tick + 1;
        // Server-scheduled ability effects apply on exactly their tick.
        const ext = net.extAt(tick);
        const input = ext ? { ...own, ext } : own;
        net.recordInput(tick, input);
        const events = this.sim.step(input);
        if (events.length > 0) this.handleEvents(events);
        if (tick % 2 === 0) this.sampleTrails();
        if (tick % MATCH_CONFIG.syncEveryTicks === 0) net.recordHash(tick, stateChecksum(this.sim.state));
        steps++;
      }
    }
    net.flush();
    const alpha = Math.min(1, Math.max(0, predicted - Math.floor(predicted)));
    this.renderState(this.sim.state.tick >= target ? alpha : 1, time);
    this.pushHud();
  }

  /** Adopts the authoritative state, then replays local inputs made since. */
  private applyResync(msg: StateMessage): void {
    const localTick = this.sim.state.tick;
    const before = { paddleX: this.sim.state.paddle.x, ball: this.sim.state.balls[0] };
    this.sim.state = structuredClone(msg.state);
    let held = { targetX: null as number | null, axis: 0, launch: false };
    for (let t = msg.tick + 1; t <= localTick && !this.sim.isOver; t++) {
      const input = this.net.replayInput(t, { ...held, launch: false });
      held = { targetX: input.targetX, axis: input.axis, launch: false };
      this.sim.step(input);
      if (t % MATCH_CONFIG.syncEveryTicks === 0) this.net.recordHash(t, stateChecksum(this.sim.state));
    }
    // How far the correction moved what the player sees (diagnostics).
    const after = this.sim.state;
    const ball = after.balls[0];
    const ballShift = before.ball && ball ? Math.hypot(before.ball.x - ball.x, before.ball.y - ball.y) : 0;
    this.net.noteCorrection(Math.max(Math.abs(before.paddleX - after.paddle.x), ballShift));
    this.refreshBoardViews();
  }

  /** Brings every brick sprite in line with the (replaced) simulation state. */
  private refreshBoardViews(): void {
    for (const brick of this.sim.state.bricks) {
      const sprite = this.brickSprites[brick.id];
      if (!sprite) continue;
      this.tweens.killTweensOf(sprite);
      this.flashUntil.delete(sprite);
      sprite.clearTint().setAlpha(1).setVisible(brick.alive);
      if (!brick.alive) continue;
      sprite
        .setTexture(
          ensureBrickTexture(this, this.theme, brick.color, brickVariant(brick.type, brick.hp, brick.maxHp, brick.moveRange > 0), brick.width, brick.height),
        )
        .setDisplaySize(brick.width, brick.height)
        .setPosition(brick.x + brick.width / 2, brick.y + brick.height / 2);
    }
    this.prevBallPos.clear();
    this.prevBrickX.clear();
    for (const view of this.ballViews.values()) view.trail.length = 0;
  }
}
