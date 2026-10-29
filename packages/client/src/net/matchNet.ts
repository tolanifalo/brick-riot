import {
  encodeInput,
  LeadController,
  MATCH_CONFIG,
  type NetDiagnostics,
  type ActiveAbility,
  type ExternalCommand,
  type ExtMessage,
  type MatchStartInfo,
  type StateMessage,
  type SyncMessage,
  type TickInput,
  type WireInput,
} from '@brick-riot/shared';
import type { ServerClock } from './clock';

/** Sends one protocol message (wired to the Colyseus room). */
export type Sender = (type: string, payload: unknown) => void;

const HISTORY_TICKS = 1200;

/**
 * Client-side prediction for the local board.
 *
 * The client runs its own copy of the deterministic simulation slightly
 * ahead of the server clock (by about half the round trip plus a margin) and
 * sends every input stamped with the tick it was applied on. When inputs arrive
 * in time the server applies them on the same tick, so both simulations stay
 * bit-identical. Every 20 Hz sync carries a checksum of the authoritative state;
 * on any mismatch the client fetches the server state, adopts it and replays its
 * own pending inputs. The client can never silently diverge, and it never
 * decides anything: results come only from the server.
 */
export class MatchNet {
  private seq = 0;
  private pending: WireInput[] = [];
  private lastFlush = 0;
  private readonly history = new Map<number, TickInput>();
  private readonly hashes = new Map<number, string>();
  private readonly pendingChecks: { tick: number; hash: string }[] = [];
  private resync: StateMessage | null = null;
  private lastResyncRequest = Number.NEGATIVE_INFINITY;
  private highestTick = 0;
  private lastInputTick = 0;
  private readonly ext = new Map<number, ExternalCommand[]>();
  private abilitySeq = 0;
  private readonly lead = new LeadController();
  private serverDiag: NetDiagnostics | null = null;
  /**
   * Diagnostics: checksum comparisons, divergences found, commands that arrived
   * too late, the size of resync corrections (world units) and long client frames.
   */
  readonly stats = { checks: 0, mismatches: 0, resyncs: 0, lateCommands: 0, maxLateTicks: 0, lastCorrection: 0, maxCorrection: 0, frameStalls: 0 };

  /** Records how far a resync moved the predicted paddle/ball (world units). */
  noteCorrection(distance: number): void {
    this.stats.lastCorrection = Math.round(distance * 10) / 10;
    this.stats.maxCorrection = Math.max(this.stats.maxCorrection, this.stats.lastCorrection);
  }

  constructor(
    readonly start: MatchStartInfo,
    private readonly clock: ServerClock,
    private readonly send: Sender,
  ) {
    clock.seed(start.serverTime);
  }

  get durationTicks(): number {
    return this.start.durationTicks;
  }

  /** Authoritative clock estimate in (fractional) ticks; <= 0 during the countdown. */
  serverTickFloat(): number {
    return ((this.clock.serverNow() - this.start.goAt) * this.start.ticksPerSecond) / 1000;
  }

  /**
   * How far ahead of the server the local prediction runs: RTT/2 + 40 ms plus
   * an adaptive extra that grows only when the server reports late inputs
   * (see shared/multiplayer/leadController.ts).
   */
  leadTicks(): number {
    return this.lead.leadTicks(this.clock.rtt, this.start.ticksPerSecond);
  }

  /** Development diagnostics snapshot (no identifiers or tokens). */
  diagnostics() {
    return {
      rttMs: Math.round(this.clock.rtt),
      leadTicks: Math.round(this.leadTicks() * 10) / 10,
      extraLeadTicks: this.lead.extraTicks,
      lateReported: this.lead.stats.lateReported,
      lastMargin: this.lead.stats.lastMargin,
      server: this.serverDiag,
      ...this.stats,
    };
  }

  predictedTickFloat(): number {
    const server = this.serverTickFloat();
    return server <= 0 ? server : server + this.leadTicks();
  }

  msUntilStart(): number {
    return this.start.goAt - this.clock.serverNow();
  }

  /** Records the input the local simulation consumed for `tick` and queues it for sending. */
  recordInput(tick: number, input: TickInput): void {
    this.history.set(tick, input);
    this.lastInputTick = Math.max(this.lastInputTick, tick);
    this.history.delete(tick - HISTORY_TICKS);
    this.pending.push(encodeInput(tick, input));
    if (input.launch) this.flush(true);
  }

  inputAt(tick: number): TickInput | undefined {
    return this.history.get(tick);
  }

  recordHash(tick: number, hash: string): void {
    this.hashes.set(tick, hash);
    this.hashes.delete(tick - HISTORY_TICKS);
    this.highestTick = Math.max(this.highestTick, tick);
    for (let i = this.pendingChecks.length - 1; i >= 0; i--) {
      const check = this.pendingChecks[i];
      if (check && check.tick <= tick) {
        this.pendingChecks.splice(i, 1);
        this.compare(check.tick, check.hash);
      }
    }
  }

  /** Asks the server to activate an ability. The server decides; nothing is predicted. */
  requestAbility(ability: ActiveAbility): void {
    this.flush(true);
    this.send('ability', { ability, seq: ++this.abilitySeq, tick: Math.max(0, Math.floor(this.predictedTickFloat())) });
  }

  /** Sends queued inputs; batched at ~30 Hz unless a launch makes it urgent. */
  flush(force = false): void {
    const now = performance.now();
    if (this.pending.length === 0) return;
    if (!force && now - this.lastFlush < 33 && this.pending.length < 8) return;
    while (this.pending.length > 0) {
      const inputs = this.pending.splice(0, MATCH_CONFIG.maxInputsPerMessage);
      this.send('input', { seq: this.seq++, inputs });
    }
    this.lastFlush = now;
  }

  onSync(msg: SyncMessage): void {
    if (msg.lead) this.lead.onFeedback(msg.lead, performance.now());
    if (msg.diag) this.serverDiag = msg.diag;
    if (!msg.hash) return;
    if (this.hashes.has(msg.hashTick)) this.compare(msg.hashTick, msg.hash);
    else if (msg.hashTick > this.highestTick) this.pendingChecks.push({ tick: msg.hashTick, hash: msg.hash });
  }

  private compare(tick: number, hash: string): void {
    const local = this.hashes.get(tick);
    if (local === undefined) return;
    this.stats.checks++;
    if (local !== hash) {
      this.stats.mismatches++;
      this.requestResync();
    }
  }

  requestResync(): void {
    const now = performance.now();
    if (now - this.lastResyncRequest < 600) return;
    this.lastResyncRequest = now;
    this.send('resync', {});
  }

  /**
   * Server-scheduled commands (ability effects) for this player's simulation.
   * They are stored by tick and attached to the local input on exactly that
   * tick, so prediction applies them where the server does. A command for a
   * tick the client already simulated without it means prediction is wrong:
   * fetch the authoritative state.
   */
  onExt(msg: ExtMessage): void {
    for (const { tick, commands } of msg.upcoming) {
      if (tick <= this.lastInputTick) {
        const applied = this.history.get(tick)?.ext;
        if (JSON.stringify(applied ?? []) !== JSON.stringify(commands)) {
          this.stats.lateCommands++;
          this.stats.maxLateTicks = Math.max(this.stats.maxLateTicks, this.lastInputTick - tick + 1);
          this.requestResync();
        }
        continue;
      }
      this.ext.set(tick, commands);
    }
  }

  /** Scheduled commands for `tick` (empty when there are none). */
  extAt(tick: number): ExternalCommand[] | undefined {
    const commands = this.ext.get(tick);
    if (commands) this.ext.delete(tick);
    return commands;
  }

  onState(msg: StateMessage): void {
    this.resync = msg;
  }

  /**
   * The input to replay for `tick` after adopting a resync state: the local
   * player's own input with the AUTHORITATIVE commands for that tick. The
   * history is corrected so later checks compare against the right input.
   */
  replayInput(tick: number, fallback: TickInput): TickInput {
    const own = this.history.get(tick) ?? fallback;
    const commands = this.ext.get(tick);
    if (commands) this.ext.delete(tick);
    const input: TickInput = { targetX: own.targetX, axis: own.axis, launch: own.launch, ...(commands ? { ext: commands } : {}) };
    this.history.set(tick, input);
    return input;
  }

  /** The authoritative state to adopt, if one arrived. */
  takeResync(): StateMessage | null {
    const r = this.resync;
    this.resync = null;
    if (r) {
      this.stats.resyncs++;
      // The authoritative schedule replaces whatever we had queued.
      this.ext.clear();
      for (const { tick, commands } of r.upcoming ?? []) if (tick > r.tick) this.ext.set(tick, commands);
      // Checks for ticks the replay will recompute are no longer meaningful.
      for (const t of [...this.hashes.keys()]) if (t > r.tick) this.hashes.delete(t);
      this.pendingChecks.length = 0;
    }
    return r;
  }
}
