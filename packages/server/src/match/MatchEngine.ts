import {
  ABILITY_RULES,
  AbilityArbiter,
  DEFAULT_LOADOUT,
  fnv1a,
  IDLE_INPUT,
  type AbilityDecision,
  type BalanceConfig,
  type ExternalCommand,
  type Loadout,
  MATCH_CONFIG,
  parseInputBatch,
  replayRun,
  Simulation,
  SEATS,
  stateChecksum,
  summarizeRun,
  type BoardDefinition,
  type InputRejectReason,
  type LeadFeedback,
  type PlayerProgressView,
  type PreviewMessage,
  type ResultReason,
  type Seat,
  type SimState,
  type TickInput,
} from '@brick-riot/shared';

export interface EnginePlayer {
  seat: Seat;
  board: BoardDefinition;
  seed: number;
  /** Per-player simulation config (passives, upgrades). Defaults to BALANCE. */
  config?: BalanceConfig;
  /** Equipped abilities. Defaults to the beginner loadout. */
  loadout?: Loadout;
}

export interface EngineOptions {
  durationTicks: number;
  syncEveryTicks?: number;
  maxInputLeadTicks?: number;
  maxLaunchesPerSecond?: number;
  ticksPerSecond?: number;
}

export interface EngineOutcome {
  outcome: 'win' | 'draw' | 'cancelled';
  winnerSeat: Seat | null;
  reason: ResultReason;
  endTick: number;
}

export type SubmitRejectReason = InputRejectReason | 'match_over' | 'launch_rate';

export interface SubmitReport {
  accepted: number;
  /** Inputs whose tick had already been simulated; applied on the next tick. */
  late: number;
  rejected: SubmitRejectReason[];
}

/**
 * Effects of abilities are delivered as server-scheduled ExternalCommands
 * (see the shared AbilityArbiter), recorded in each player's applied input
 * log so replays verify. Clients can never send them.
 */
export type ExternalEffect = ExternalCommand;

export type AbilityQueueReject = 'malformed' | 'duplicate_seq' | 'rate_limited' | 'match_over';

class PlayerSlot {
  readonly sim: Simulation;
  lastAbilitySeq = -1;
  readonly abilityTicks: number[] = [];
  readonly buffer = new Map<number, TickInput>();
  held: TickInput = { ...IDLE_INPUT };
  pendingLaunch = false;
  lastSeq = -1;
  lastInputTick = 0;
  /** Exactly the inputs this player's simulation consumed, in order. */
  readonly log: TickInput[] = [];
  readonly launchTicks: number[] = [];
  completionTick: number | null = null;
  exhaustedTick: number | null = null;
  forfeited = false;
  lastHash: { tick: number; hash: string } = { tick: 0, hash: '' };
  /** Input timing since the last sync (adaptive-lead feedback). */
  net = { late: 0, minMargin: Number.POSITIVE_INFINITY, inputs: 0 };
  /** Whole-match input timing (diagnostics and tests). */
  readonly netTotals = { late: 0, inputs: 0 };

  constructor(readonly setup: EnginePlayer) {
    this.sim = new Simulation(setup.board, setup.config ? { seed: setup.seed, config: setup.config } : { seed: setup.seed });
    this.lastHash = { tick: 0, hash: stateChecksum(this.sim.state) };
  }
}

/**
 * Authoritative two-player match: one independent Simulation per player on a
 * single shared tick clock, plus the race rules. Pure (no networking or
 * timers), so every rule is unit-testable and deterministic.
 *
 * Input policy (documented in ARCHITECTURE.md):
 * - Inputs are tick-stamped; each player's ticks must strictly increase.
 * - At tick T a player's buffered input for T is used; if none arrived, the
 *   last paddle intent is repeated with launch=false.
 * - An input stamped for an already-simulated tick ("late") becomes the held
 *   intent from the next tick; a late launch is applied on the next tick.
 * - Both simulations advance in the same loop iteration for every tick, in
 *   seat order A then B (they are independent, so order cannot matter).
 */
export class MatchEngine {
  tick = 0;
  outcome: EngineOutcome | null = null;
  readonly durationTicks: number;
  private readonly slots: Record<Seat, PlayerSlot>;
  private readonly syncEvery: number;
  private readonly maxLead: number;
  private readonly maxLaunches: number;
  private readonly ticksPerSecond: number;
  private readonly arbiter: AbilityArbiter;
  private abilityQueue: { seat: Seat; ability: unknown; tick: number }[] = [];

  constructor(players: readonly [EnginePlayer, EnginePlayer], options: EngineOptions) {
    const [a, b] = players;
    if (a.seat !== 'A' || b.seat !== 'B') throw new Error('players must be [A, B]');
    this.slots = { A: new PlayerSlot(a), B: new PlayerSlot(b) };
    this.arbiter = new AbilityArbiter({ A: a.loadout ?? DEFAULT_LOADOUT, B: b.loadout ?? DEFAULT_LOADOUT });
    this.durationTicks = options.durationTicks;
    this.syncEvery = options.syncEveryTicks ?? MATCH_CONFIG.syncEveryTicks;
    this.maxLead = options.maxInputLeadTicks ?? MATCH_CONFIG.maxInputLeadTicks;
    this.maxLaunches = options.maxLaunchesPerSecond ?? MATCH_CONFIG.maxLaunchesPerSecond;
    this.ticksPerSecond = options.ticksPerSecond ?? MATCH_CONFIG.tickRate;
  }

  get isOver(): boolean {
    return this.outcome !== null;
  }

  sim(seat: Seat): Simulation {
    return this.slots[seat].sim;
  }

  // ---- Inputs ---------------------------------------------------------------

  submitInputs(seat: Seat, raw: unknown): SubmitReport {
    const report: SubmitReport = { accepted: 0, late: 0, rejected: [] };
    if (this.outcome) {
      report.rejected.push('match_over');
      return report;
    }
    const parsed = parseInputBatch(raw);
    if (!parsed.ok) {
      report.rejected.push(parsed.reason);
      return report;
    }
    const slot = this.slots[seat];
    const { batch } = parsed;
    if (batch.seq <= slot.lastSeq) {
      report.rejected.push('duplicate_seq');
      return report;
    }
    slot.lastSeq = batch.seq;
    for (const r of batch.rejected) report.rejected.push(r.reason);

    for (const { tick, input } of batch.inputs) {
      if (tick <= slot.lastInputTick) {
        report.rejected.push('duplicate_tick');
        continue;
      }
      if (tick > this.tick + this.maxLead) {
        report.rejected.push('future_tick');
        continue;
      }
      slot.lastInputTick = tick;
      const accepted = { ...input };
      if (accepted.launch && !this.allowLaunch(slot)) {
        accepted.launch = false;
        report.rejected.push('launch_rate');
      }
      // Arrival margin: how many ticks before it was needed this input arrived (<= 0 = late).
      const margin = tick - this.tick;
      slot.net.minMargin = Math.min(slot.net.minMargin, margin);
      slot.net.inputs++;
      slot.netTotals.inputs++;
      if (tick <= this.tick) {
        slot.held = { targetX: accepted.targetX, axis: accepted.axis, launch: false };
        if (accepted.launch) slot.pendingLaunch = true;
        report.late++;
        slot.net.late++;
        slot.netTotals.late++;
      } else {
        slot.buffer.set(tick, accepted);
      }
      report.accepted++;
    }
    return report;
  }

  /**
   * Input-timing feedback for one player since the previous call (sent with
   * each sync): how many inputs arrived late, and the smallest arrival margin
   * in ticks. The client's adaptive lead uses it.
   */
  takeLeadFeedback(seat: Seat): LeadFeedback {
    const slot = this.slots[seat];
    const feedback: LeadFeedback = {
      late: slot.net.late,
      margin: Number.isFinite(slot.net.minMargin) ? slot.net.minMargin : null,
      inputs: slot.net.inputs,
    };
    slot.net = { late: 0, minMargin: Number.POSITIVE_INFINITY, inputs: 0 };
    return feedback;
  }

  /** Whole-match late-input totals (diagnostics/tests). */
  inputTiming(seat: Seat): { late: number; inputs: number } {
    return { ...this.slots[seat].netTotals };
  }

  private allowLaunch(slot: PlayerSlot): boolean {
    const windowStart = this.tick - this.ticksPerSecond;
    while (slot.launchTicks.length > 0 && (slot.launchTicks[0] ?? 0) <= windowStart) slot.launchTicks.shift();
    if (slot.launchTicks.length >= this.maxLaunches) return false;
    slot.launchTicks.push(this.tick);
    return true;
  }

  // ---- Abilities ----------------------------------------------------------------

  /**
   * Queues an ability request (shape, sequence and rate checks only). Requests
   * are resolved by `resolveAbilities` in a deterministic order: by the
   * client's tick stamp, then seat A before B.
   */
  queueAbility(seat: Seat, raw: unknown): { queued: true } | { queued: false; reason: AbilityQueueReject } {
    if (this.outcome) return { queued: false, reason: 'match_over' };
    if (typeof raw !== 'object' || raw === null) return { queued: false, reason: 'malformed' };
    const { seq, ability, tick } = raw as { seq?: unknown; ability?: unknown; tick?: unknown };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || typeof tick !== 'number' || !Number.isInteger(tick)) {
      return { queued: false, reason: 'malformed' };
    }
    const slot = this.slots[seat];
    if (seq <= slot.lastAbilitySeq) return { queued: false, reason: 'duplicate_seq' };
    slot.lastAbilitySeq = seq;
    const windowStart = this.tick - this.ticksPerSecond;
    while (slot.abilityTicks.length > 0 && (slot.abilityTicks[0] ?? 0) <= windowStart) slot.abilityTicks.shift();
    if (slot.abilityTicks.length >= ABILITY_RULES.maxRequestsPerSecond) return { queued: false, reason: 'rate_limited' };
    slot.abilityTicks.push(this.tick);
    this.abilityQueue.push({ seat, ability, tick });
    return { queued: true };
  }

  /** Resolves every queued request against the current tick. */
  resolveAbilities(): AbilityDecision[] {
    const queue = this.abilityQueue.sort((a, b) => a.tick - b.tick || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
    this.abilityQueue = [];
    if (this.outcome) return [];
    const sims = { A: this.slots.A.sim, B: this.slots.B.sim };
    return queue.map((r) => this.arbiter.request(r.seat, r.ability, sims, this.tick));
  }

  /** Scheduled commands a seat's simulation has not applied yet. */
  upcomingCommands(seat: Seat): { tick: number; commands: ExternalCommand[] }[] {
    return this.arbiter.upcoming(seat);
  }

  // ---- Clock ----------------------------------------------------------------

  /** Advances the shared clock to `target`, stopping as soon as the match is decided. */
  advanceTo(target: number): void {
    const end = Math.min(target, this.durationTicks);
    while (!this.outcome && this.tick < end) this.stepOnce();
  }

  private stepOnce(): void {
    const t = ++this.tick;
    for (const seat of SEATS) {
      const slot = this.slots[seat];
      const buffered = slot.buffer.get(t);
      slot.buffer.delete(t);
      if (slot.sim.isOver || slot.forfeited) {
        this.arbiter.clear(seat);
        continue;
      }
      let input: TickInput = buffered ?? { ...slot.held, launch: false };
      if (slot.pendingLaunch) {
        input = { ...input, launch: true };
        slot.pendingLaunch = false;
      }
      slot.held = { targetX: input.targetX, axis: input.axis, launch: false };
      const ext = this.arbiter.take(seat, t);
      if (ext) input = { ...input, ext };
      else if (input.ext) input = { targetX: input.targetX, axis: input.axis, launch: input.launch };
      slot.sim.step(input);
      slot.log.push(input);
      const status = slot.sim.state.status;
      if (status === 'won' && slot.completionTick === null) slot.completionTick = t;
      if (status === 'lost' && slot.exhaustedTick === null) slot.exhaustedTick = t;
      if (t % this.syncEvery === 0) slot.lastHash = { tick: t, hash: stateChecksum(slot.sim.state) };
    }
    this.evaluate(t);
  }

  /** The race rules. Called once per tick after both simulations stepped. */
  private evaluate(t: number): void {
    const a = this.slots.A;
    const b = this.slots.B;
    const clearedA = a.completionTick === t;
    const clearedB = b.completionTick === t;
    if (clearedA && clearedB) return this.finish('draw', null, 'same_tick_clear', t);
    if (clearedA) return this.finish('win', 'A', 'board_cleared', t);
    if (clearedB) return this.finish('win', 'B', 'board_cleared', t);
    if (a.exhaustedTick !== null && b.exhaustedTick !== null) return this.finish('draw', null, 'both_exhausted', t);
    if (t >= this.durationTicks) return this.finish('draw', null, 'time_expired', t);
  }

  private finish(outcome: EngineOutcome['outcome'], winnerSeat: Seat | null, reason: ResultReason, endTick: number): void {
    if (this.outcome) return;
    this.outcome = { outcome, winnerSeat, reason, endTick };
  }

  // ---- Lifecycle decisions -----------------------------------------------------

  /** `seat` failed to reconnect (or left during play): the opponent wins. */
  forfeit(seat: Seat): void {
    if (this.outcome) return;
    this.slots[seat].forfeited = true;
    this.finish('win', seat === 'A' ? 'B' : 'A', 'forfeit', this.tick);
  }

  /** Neither player is present when a reconnection deadline passes. */
  abandon(): void {
    this.finish('cancelled', null, 'both_disconnected', this.tick);
  }

  // ---- Views -----------------------------------------------------------------

  progress(seat: Seat, connected: boolean): PlayerProgressView {
    const slot = this.slots[seat];
    const s = slot.sim.state;
    let status: PlayerProgressView['status'] = 'playing';
    if (slot.forfeited) status = 'forfeited';
    else if (s.status === 'won') status = 'cleared';
    else if (s.status === 'lost') status = 'exhausted';
    return {
      seat,
      score: s.score,
      lives: s.lives,
      bricksRemaining: s.requiredRemaining,
      bricksTotal: s.requiredTotal,
      status,
      connected,
      energy: Math.floor(s.energy10 / 10),
      debuff: s.debuff ? s.debuff.kind : null,
      shielded: s.shieldUntil > s.tick,
      immune: s.immuneUntil > s.tick,
    };
  }

  latestHash(seat: Seat): { tick: number; hash: string } {
    return this.slots[seat].lastHash;
  }

  state(seat: Seat): SimState {
    return this.slots[seat].sim.state;
  }

  preview(seat: Seat): PreviewMessage {
    const s = this.slots[seat].sim.state;
    const r = (v: number) => Math.round(v * 10) / 10;
    return {
      tick: this.tick,
      seat,
      paddleX: r(s.paddle.x),
      paddleWidth: s.paddle.width,
      balls: s.balls.map((b) => [r(b.x), r(b.y)]),
      bricks: s.bricks.map((b) => (b.alive ? String(Math.min(9, b.type === 'indestructible' ? 9 : b.hp)) : '.')).join(''),
      movers: s.bricks.filter((b) => b.alive && b.moveRange > 0).map((b) => [b.id, r(b.x)]),
      frost: s.bricks.filter((b) => b.alive && b.type === 'frost').map((b) => [r(b.x), r(b.y), r(b.width), r(b.height)]),
    };
  }

  slotInfo(seat: Seat): { completionTick: number | null; exhaustedTick: number | null; forfeited: boolean } {
    const s = this.slots[seat];
    return { completionTick: s.completionTick, exhaustedTick: s.exhaustedTick, forfeited: s.forfeited };
  }

  // ---- Verification -----------------------------------------------------------

  inputLogHash(seat: Seat): string {
    return fnv1a(JSON.stringify(this.slots[seat].log));
  }

  appliedInputs(seat: Seat): readonly TickInput[] {
    return this.slots[seat].log;
  }

  /**
   * Re-simulates each player's applied input log from scratch and checks it
   * reproduces the live final state exactly.
   */
  verifyReplays(): boolean {
    return SEATS.every((seat) => {
      const slot = this.slots[seat];
      const replayed = replayRun(slot.setup.board, slot.setup.seed, slot.log, slot.setup.config);
      return (
        stateChecksum(replayed) === stateChecksum(slot.sim.state) &&
        JSON.stringify(summarizeRun(replayed)) === JSON.stringify(summarizeRun(slot.sim.state))
      );
    });
  }
}
