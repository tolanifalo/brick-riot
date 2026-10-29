import { Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import {
  checkBoardChoice,
  matchConfig,
  compareEquipment,
  DEFAULT_LOADOUT,
  effectiveUpgrades,
  evaluateCompatibility,
  getMatchBoard,
  getMultiplayerProfile,
  levelForXp,
  MATCH_CONFIG,
  NO_UPGRADES,
  otherSeat,
  rateEquipment,
  sanitizeName,
  sanitizeUpgradeLevels,
  SEATS,
  validateLoadout,
  type AbilityDecision,
  type ClaimedProgress,
  type CompatibilityReport,
  type Equipment,
  type EquipmentCompatibility,
  type Loadout,
  type RoomEquipmentMode,
  type UpgradeLevels,
  type JoinOptions,
  type LobbyPlayerView,
  type LobbyView,
  type MatchResult,
  type MatchResultPlayer,
  type MatchStartInfo,
  type RoomPhase,
  type Seat,
  type SyncMessage,
} from '@brick-riot/shared';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { MatchEngine } from '../match/MatchEngine';
import { loadSeatAccount, type SeatAccount } from './seatAccount';
import type { MatchLogEntry } from '../persistence/matchResults';
import { TokenBucket } from '../security/rateLimit';
import { RoomCodeRegistry } from '../security/roomCodes';
import { getServices, type Services } from '../services';

interface SeatState {
  seat: Seat;
  playerId: string;
  profileId: string;
  name: string;
  claim: ClaimedProgress;
  ip: string;
  sessionId: string;
  client: Client | null;
  connected: boolean;
  reconnectDeadline: number | null;
  boardId: string | null;
  ready: boolean;
  acceptsUnranked: boolean;
  rematch: LobbyPlayerView['rematch'];
  /** Validated loadout (accounts: server-owned abilities; guests: unlocks from the claimed level). */
  loadout: Loadout;
  /** Server-verified upgrade levels for accounts; none for guests (claims are ignored). */
  upgrades: UpgradeLevels;
  /** The signed-in account behind this seat (verified via game ticket), or null for a guest. */
  account: SeatAccount | null;
  messages: TokenBucket;
  resyncs: TokenBucket;
  lastRejectNotice: number;
}

const PROFILE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Per-process secret: only the server's own matchmaker can create Quick Match rooms. */
export const QUICK_ROOM_SECRET = randomBytes(32).toString('hex');

/** Created by the matchmaker (never by clients): who sits where, on which board, and why. */
export interface QuickRoomOptions {
  secret: string;
  seats: Record<Seat, { userId: string; boardId: string; note: string }>;
  /** Both players must confirm within this many seconds. */
  readySeconds: number;
}

/** Result of onAuth (or the matchmaker's seat reservation). */
export interface JoinAuth {
  ip: string;
  account: SeatAccount | null;
}

function sanitizeClaim(options: Partial<JoinOptions>): ClaimedProgress {
  const ids = Array.isArray(options.clearedBoardIds) ? options.clearedBoardIds : [];
  return {
    clearedBoardIds: ids.filter((id): id is string => typeof id === 'string' && id.length <= 40).slice(0, 100),
    xp: typeof options.xp === 'number' && Number.isFinite(options.xp) ? Math.min(1e8, Math.max(0, options.xp)) : 0,
  };
}

/**
 * One private 1v1 room: lobby, countdown, match, results and rematches.
 * The room owns all authority; clients only send intentions.
 *
 * Reconnection policy (applies to both players identically): a dropped player
 * keeps their seat for `reconnectSeconds`. During a match the game CONTINUES:
 * their paddle holds its last intent and no launch happens. Missing the
 * deadline forfeits. If the opponent is also absent at that moment, the match
 * is cancelled with no winner ('both_disconnected').
 */
export class MatchRoom extends Room {
  override maxClients = 2;
  override maxMessagesPerSecond = 300;

  private services!: Services;
  private code = '';
  private devMode = false;
  private creatorJoined = false;
  private readonly seats: Partial<Record<Seat, SeatState>> = {};
  private hostSeat: Seat | null = null;
  private phase: RoomPhase = 'lobby';
  private matchNumber = 0;
  private matchId: string | null = null;
  private goAt: number | null = null;
  private engine: MatchEngine | null = null;
  private seeds: Record<Seat, number> = { A: 0, B: 0 };
  private compatibilityAtStart: CompatibilityReport | null = null;
  private result: MatchResult | null = null;
  private finalized = false;
  private lastSyncIndex = 0;
  private lastPreviewIndex = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: MatchLogEntry[] = [];
  private ticksPerSecond: number = MATCH_CONFIG.tickRate;
  private durationTicks = 0;
  /** Host-chosen: 'casual' (loadouts only) or 'casualUpgrades' (Workshop upgrades, capped). */
  private equipmentMode: RoomEquipmentMode = 'casual';
  /** Equipment locked at countdown (what the engine and clients use). */
  private lockedEquipment: Record<Seat, Equipment> | null = null;
  /** Set for public Quick Match rooms; null for private (code) rooms. */
  private quick: QuickRoomOptions | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private quickReadyDeadline = 0;
  private readonly loopStats = { lastAt: 0, maxGapMs: 0, lastStepTicks: 0 };

  override onCreate(options: Partial<JoinOptions> & { quick?: QuickRoomOptions }): void {
    this.services = getServices();
    const { config, codes } = this.services;
    // Quick Match options are honoured only with the server's own secret, never from clients.
    if (options?.quick && options.quick.secret === QUICK_ROOM_SECRET) {
      this.quick = options.quick;
      this.quickReadyDeadline = Date.now() + options.quick.readySeconds * 1000;
      this.readyTimer = setTimeout(() => this.quickReadyTimeout(), options.quick.readySeconds * 1000);
    }
    this.code = codes.generate();
    codes.register(this.code, { roomId: this.roomId, status: () => this.joinStatus() });
    this.devMode = options?.devMode === true && config.allowDevRooms;
    this.ticksPerSecond = MATCH_CONFIG.tickRate * config.clockScale;
    this.durationTicks = Math.round(config.matchSeconds * MATCH_CONFIG.tickRate);
    this.patchRate = null;
    void this.setPrivate(true);
    this.setTimestep(() => this.update(), 1000 / 60);
    this.registerHandlers();
    this.armIdleTimer();
    this.note('room_created', undefined, this.devMode ? 'dev' : undefined);
  }

  // ---- Joining ---------------------------------------------------------------

  override async onAuth(client: Client, options: Partial<JoinOptions>, context: AuthContext): Promise<JoinAuth | true> {
    const ip = context.ip ?? 'unknown';
    const { joinLimiter } = this.services;
    // Quick Match rooms accept only the two accounts the matchmaker reserved
    // seats for. `client.auth` here is the reservation's server-side auth data
    // (never client input); anyone else is refused.
    if (this.quick) {
      const reserved = (client.auth as JoinAuth | undefined)?.account?.userId;
      const quick = this.quick;
      if (reserved && SEATS.some((s) => quick.seats[s].userId === reserved) && !this.seatList().some((s) => s.account?.userId === reserved)) {
        return true;
      }
      throw new ServerError(403, 'reserved_room');
    }
    if (this.creatorJoined) {
      if (joinLimiter.isBlocked(ip)) throw new ServerError(429, 'too_many_attempts');
      if (RoomCodeRegistry.normalize(options?.code) !== this.code) {
        joinLimiter.fail(ip);
        throw new ServerError(403, 'invalid_code');
      }
      if (this.phase !== 'lobby') throw new ServerError(409, 'match_in_progress');
      if (this.seatList().length >= 2) throw new ServerError(409, 'room_full');
    }
    if (typeof options?.profileId !== 'string' || !PROFILE_ID.test(options.profileId)) {
      throw new ServerError(400, 'bad_profile');
    }
    if (this.seatList().some((s) => s.profileId === options.profileId)) {
      throw new ServerError(409, 'already_in_room');
    }
    let account: SeatAccount | null = null;
    if (options?.ticket !== undefined) {
      const userId = this.services.tickets.redeem(options.ticket);
      if (!userId) throw new ServerError(401, 'invalid_ticket');
      if (this.seatList().some((s) => s.account?.userId === userId)) throw new ServerError(409, 'already_in_room');
      account = await loadSeatAccount(this.services, userId);
      if (!account) throw new ServerError(401, 'invalid_ticket');
    }
    return { ip, account };
  }

  override onJoin(client: Client, options: Partial<JoinOptions>, auth?: JoinAuth): void {
    this.creatorJoined = true;
    const account = auth?.account ?? null;
    const reserved = account && this.quick ? SEATS.find((s) => this.quick?.seats[s].userId === account.userId) : undefined;
    const seat: Seat = reserved ?? (this.seats.A ? 'B' : 'A');
    const now = Date.now();
    const claim = sanitizeClaim(options);
    // Accounts: server-owned equipment (the client's loadout is only a preference to validate).
    // Guests: loadout validated against the claimed level; upgrades never trusted.
    const preferred = account ? this.validateAccountLoadout(account, options.loadout) : null;
    const guestCheck = account ? null : validateLoadout(options.loadout, levelForXp(claim.xp).level, { ignoreUnlocks: this.devMode });
    const loadout = account ? (preferred ?? account.loadout) : guestCheck?.ok ? guestCheck.loadout : { ...DEFAULT_LOADOUT };
    const state: SeatState = {
      loadout,
      upgrades: account ? account.upgrades : { ...NO_UPGRADES },
      account,
      seat,
      playerId: randomUUID(),
      profileId: options.profileId ?? `account-${account?.userId ?? randomUUID()}`,
      name: account ? account.name : sanitizeName(options.name),
      claim,
      ip: (client.auth as { ip?: string } | undefined)?.ip ?? 'unknown',
      sessionId: client.sessionId,
      client,
      connected: true,
      reconnectDeadline: null,
      boardId: null,
      ready: false,
      acceptsUnranked: false,
      rematch: 'none',
      messages: new TokenBucket(MATCH_CONFIG.messagesPerSecond, MATCH_CONFIG.messageBurst, now),
      resyncs: new TokenBucket(MATCH_CONFIG.resyncPerSecond, 2, now),
      lastRejectNotice: 0,
    };
    this.seats[seat] = state;
    if (this.quick) state.boardId = this.quick.seats[seat].boardId;
    if (!this.hostSeat) this.hostSeat = seat;
    client.send('welcome', { seat, playerId: state.playerId, roomCode: this.code });
    if (guestCheck && !guestCheck.ok && options.loadout !== undefined) this.reject(state, 'setLoadout', guestCheck.error);
    this.note('join', seat, account ? 'account' : 'guest');
    this.broadcastLobby();
  }

  /** Accounts may pick eligible boards they have unlocked on the SERVER (variants follow their base board). */
  private checkAccountBoard(account: SeatAccount, boardId: string): { ok: true } | { ok: false; error: string } {
    const profile = getMultiplayerProfile(boardId);
    if (!profile || !getMatchBoard(boardId)) return { ok: false, error: 'unknown_board' };
    if (!profile.multiplayerEligible) return { ok: false, error: 'not_multiplayer_eligible' };
    if (this.devMode) return { ok: true };
    const base = profile.variantOf ?? boardId;
    return account.unlockedBoardIds.includes(base) ? { ok: true } : { ok: false, error: 'locked' };
  }

  /** Quick Match: nobody confirmed in time. Both clients are told why and can requeue. */
  private quickReadyTimeout(): void {
    if (!this.quick || this.phase !== 'lobby') return;
    const notReady = this.seatList().filter((s) => !s.ready).map((s) => s.seat);
    const missing = SEATS.filter((s) => !this.seats[s]);
    this.note('quick_ready_timeout', undefined, [...notReady, ...missing].join(','));
    this.broadcast('closed', { reason: 'ready_timeout', seats: [...notReady, ...missing] });
    this.closeRoom('ready_timeout');
  }

  /** A loadout an ACCOUNT may use: slots, budget, level unlocks and server-recorded ownership. */
  private validateAccountLoadout(account: SeatAccount, raw: unknown): Loadout | null {
    if (raw === undefined) return null;
    const check = validateLoadout(raw, account.level, { ignoreUnlocks: this.devMode });
    if (!check.ok) return null;
    const owns = [check.loadout.offensive, check.loadout.defensive, check.loadout.passive].every((id) => account.ownedAbilities.includes(id));
    return owns || this.devMode ? check.loadout : null;
  }

  override onDrop(client: Client): void {
    const seat = this.seatOf(client);
    if (!seat) return;
    seat.connected = false;
    seat.client = null;
    seat.reconnectDeadline = Date.now() + this.services.config.reconnectSeconds * 1000;
    this.note('drop', seat.seat);
    if (this.phase === 'countdown') this.abortCountdown('player_disconnected');
    const pending = this.allowReconnection(client, this.services.config.reconnectSeconds);
    Promise.resolve(pending).catch(() => undefined);
    this.broadcastLobby();
  }

  override onReconnect(client: Client): void {
    const seat = this.seatOf(client);
    if (!seat) return;
    seat.client = client;
    seat.connected = true;
    seat.reconnectDeadline = null;
    this.note('reconnect', seat.seat);
    client.send('welcome', { seat: seat.seat, playerId: seat.playerId, roomCode: this.code });
    if (this.engine && this.matchId && (this.phase === 'countdown' || this.phase === 'playing')) {
      client.send('matchStart', this.matchStartInfo(seat.seat));
    }
    if (this.result) client.send('result', this.result);
    this.broadcastLobby();
  }

  override onLeave(client: Client): void {
    const seat = this.seatOf(client);
    if (!seat) return;
    this.note('leave', seat.seat);
    if (this.phase === 'playing' && this.engine && !this.engine.isOver) {
      const opponent = this.seats[otherSeat(seat.seat)];
      if (opponent?.connected) this.engine.forfeit(seat.seat);
      else this.engine.abandon();
      seat.connected = false;
      this.finalize();
    }
    if (this.phase === 'countdown') this.abortCountdown('player_left');
    // A Quick Match opponent who leaves before the match starts: close so the other can requeue.
    if (this.quick && this.phase === 'lobby') {
      this.seats[seat.seat] = undefined;
      this.broadcast('closed', { reason: 'opponent_left', seats: [seat.seat] });
      return this.closeRoom('opponent_left');
    }
    this.seats[seat.seat] = undefined;
    if (this.hostSeat === seat.seat) this.hostSeat = this.seatList()[0]?.seat ?? null;
    for (const s of this.seatList()) {
      s.ready = false;
      s.acceptsUnranked = false;
      s.rematch = 'none';
    }
    // In 'finished' the remaining player keeps the result on screen and may send
    // 'returnToLobby' to reopen the room for a new opponent.
    this.broadcastLobby();
  }

  override onDispose(): void {
    this.services.codes.release(this.code);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
  }

  // ---- Messages --------------------------------------------------------------

  private registerHandlers(): void {
    const guarded = <T>(type: string, handler: (seat: SeatState, msg: T) => void) =>
      this.onMessage(type, (client: Client, msg: T) => {
        const seat = this.seatOf(client);
        if (!seat) return;
        if (!seat.messages.take()) {
          this.note('rate_limited', seat.seat, type);
          return;
        }
        handler(seat, msg);
      });

    guarded<{ boardId?: unknown }>('selectBoard', (seat, msg) => {
      if (this.phase !== 'lobby') return this.reject(seat, 'selectBoard', 'not_in_lobby');
      // Quick Match boards are assigned (transparently) by the matchmaker.
      if (this.quick) return this.reject(seat, 'selectBoard', 'assigned_by_matchmaking');
      if (typeof msg?.boardId !== 'string') return this.reject(seat, 'selectBoard', 'malformed');
      const choice = seat.account ? this.checkAccountBoard(seat.account, msg.boardId) : checkBoardChoice(msg.boardId, seat.claim, this.devMode);
      if (!choice.ok) return this.reject(seat, 'selectBoard', choice.error);
      seat.boardId = msg.boardId;
      for (const s of this.seatList()) {
        s.ready = false;
        s.acceptsUnranked = false;
      }
      this.broadcastLobby();
    });

    guarded<{ ready?: unknown }>('setReady', (seat, msg) => {
      if (this.phase !== 'lobby') return this.reject(seat, 'setReady', 'not_in_lobby');
      const ready = msg?.ready === true;
      if (ready && !seat.boardId) return this.reject(seat, 'setReady', 'choose_board_first');
      if (ready && this.needsAcceptance() && !seat.acceptsUnranked) {
        return this.reject(seat, 'setReady', 'accept_unranked_first');
      }
      seat.ready = ready;
      this.broadcastLobby();
      this.maybeStartCountdown();
    });

    guarded<{ accept?: unknown }>('acceptUnranked', (seat, msg) => {
      if (this.phase !== 'lobby') return this.reject(seat, 'acceptUnranked', 'not_in_lobby');
      seat.acceptsUnranked = msg?.accept === true;
      if (!seat.acceptsUnranked) seat.ready = false;
      this.broadcastLobby();
    });

    guarded<{ loadout?: unknown }>('setLoadout', (seat, msg) => {
      // Loadouts may change until the player readies up; the countdown locks them.
      if (this.phase !== 'lobby') return this.reject(seat, 'setLoadout', 'locked');
      if (seat.ready) return this.reject(seat, 'setLoadout', 'unready_first');
      const level = seat.account ? seat.account.level : levelForXp(seat.claim.xp).level;
      const check = validateLoadout(msg?.loadout, level, { ignoreUnlocks: this.devMode });
      if (!check.ok) return this.reject(seat, 'setLoadout', check.error);
      if (seat.account && !this.validateAccountLoadout(seat.account, check.loadout)) return this.reject(seat, 'setLoadout', 'not_owned');
      seat.loadout = check.loadout;
      // Accounts: the lobby choice also becomes the saved server loadout.
      if (seat.account && !this.devMode) {
        void this.services.progression?.setLoadout(seat.account.userId, check.loadout).catch(() => undefined);
      }
      this.resetAcceptance();
      this.broadcastLobby();
    });

    guarded<{ mode?: unknown }>('setEquipmentMode', (seat, msg) => {
      if (this.phase !== 'lobby') return this.reject(seat, 'setEquipmentMode', 'not_in_lobby');
      if (this.quick) return this.reject(seat, 'setEquipmentMode', 'fixed_in_quick_match');
      if (seat.seat !== this.hostSeat) return this.reject(seat, 'setEquipmentMode', 'host_only');
      if (msg?.mode !== 'casual' && msg?.mode !== 'casualUpgrades') return this.reject(seat, 'setEquipmentMode', 'malformed');
      this.equipmentMode = msg.mode;
      for (const s of this.seatList()) s.ready = false;
      this.resetAcceptance();
      this.broadcastLobby();
    });

    guarded<unknown>('cancel', (seat) => {
      if (this.phase === 'countdown') return this.abortCountdown('cancelled_by_player');
      if (this.phase === 'lobby' && seat.seat === this.hostSeat) return this.closeRoom('host_cancelled');
      this.reject(seat, 'cancel', 'not_allowed');
    });

    guarded<unknown>('input', (seat, msg) => {
      if (this.phase !== 'playing' || !this.engine) return this.reject(seat, 'input', 'not_started', true);
      const report = this.engine.submitInputs(seat.seat, msg);
      if (report.rejected.length > 0) {
        this.note('input_rejected', seat.seat, [...new Set(report.rejected)].join(','));
        this.reject(seat, 'input', report.rejected[0] ?? 'rejected', true);
      }
    });

    guarded<unknown>('resync', (seat) => {
      if (!this.engine || !seat.client) return;
      if (!seat.resyncs.take()) return this.reject(seat, 'resync', 'rate_limited', true);
      seat.client.send('state', {
        tick: this.engine.tick,
        state: this.engine.state(seat.seat),
        upcoming: this.engine.upcomingCommands(seat.seat),
      });
    });

    guarded<{ t?: unknown }>('ping', (seat, msg) => {
      seat.client?.send('pong', { t: typeof msg?.t === 'number' ? msg.t : 0, serverTime: Date.now() });
    });

    guarded<{ action?: unknown }>('rematch', (seat, msg) => this.handleRematch(seat, msg?.action));

    guarded<unknown>('returnToLobby', (seat) => {
      if (this.phase !== 'finished' || this.seatList().length !== 1) return this.reject(seat, 'returnToLobby', 'not_allowed');
      this.resetToLobby();
      this.broadcastLobby();
    });

    // Ability requests are queued here and resolved by the authoritative
    // arbiter in the next server step (see update()).
    guarded<unknown>('ability', (seat, msg) => {
      if (this.phase !== 'playing' || !this.engine) return this.reject(seat, 'ability', 'not_started');
      const queued = this.engine.queueAbility(seat.seat, msg);
      if (!queued.queued) {
        this.note('ability_rejected', seat.seat, queued.reason);
        seat.client?.send('abilityResult', { ability: (msg as { ability?: unknown })?.ability ?? null, accepted: false, reason: queued.reason });
      }
    });
    guarded<unknown>('pause', (seat) => this.reject(seat, 'pause', 'pause_not_allowed'));

    // Anything else (e.g. a forged "complete" or "result") is ignored and logged.
    this.onMessage('*', (client: Client, type: string | number) => {
      const seat = this.seatOf(client);
      if (!seat) return;
      this.note('unknown_message', seat.seat, String(type).slice(0, 40));
      this.reject(seat, String(type).slice(0, 40), 'unknown_message', true);
    });
  }

  private reject(seat: SeatState, type: string, reason: string, throttled = false): void {
    const now = Date.now();
    if (throttled && now - seat.lastRejectNotice < 1000) return;
    seat.lastRejectNotice = now;
    seat.client?.send('rejected', { type, reason });
  }

  private handleRematch(seat: SeatState, action: unknown): void {
    if (this.phase !== 'finished') return this.reject(seat, 'rematch', 'not_finished');
    const other = this.seats[otherSeat(seat.seat)];
    if (!other?.connected) return this.reject(seat, 'rematch', 'opponent_absent');
    if (action === 'request' || action === 'accept') {
      if (action === 'accept' && other.rematch !== 'requested') return this.reject(seat, 'rematch', 'no_request');
      seat.rematch = other.rematch === 'requested' ? 'accepted' : 'requested';
      if (seat.rematch === 'accepted') {
        this.note('rematch_accepted', seat.seat);
        this.resetToLobby();
      }
    } else if (action === 'decline') {
      if (other.rematch !== 'requested') return this.reject(seat, 'rematch', 'no_request');
      seat.rematch = 'declined';
      other.rematch = 'none';
    } else {
      return this.reject(seat, 'rematch', 'malformed');
    }
    this.broadcastLobby();
  }

  // ---- Match lifecycle ---------------------------------------------------------

  private compatibility(): CompatibilityReport | null {
    const a = this.seats.A?.boardId;
    const b = this.seats.B?.boardId;
    if (!a || !b) return null;
    const pa = getMultiplayerProfile(a);
    const pb = getMultiplayerProfile(b);
    if (!pa || !pb) return null;
    return evaluateCompatibility(pa, pb, this.services.config.matchSeconds);
  }

  private equipmentOf(s: SeatState): Equipment {
    return { loadout: s.loadout, upgrades: s.upgrades };
  }

  private equipmentCompatibility(): EquipmentCompatibility | null {
    const a = this.seats.A;
    const b = this.seats.B;
    if (!a || !b) return null;
    return compareEquipment(rateEquipment(this.equipmentOf(a), this.equipmentMode), rateEquipment(this.equipmentOf(b), this.equipmentMode));
  }

  /** Uneven boards OR uneven equipment: both players must explicitly accept an unranked race. */
  private needsAcceptance(): boolean {
    return this.compatibility()?.compatible === false || this.equipmentCompatibility()?.even === false;
  }

  private resetAcceptance(): void {
    for (const s of this.seatList()) {
      s.acceptsUnranked = false;
      if (this.needsAcceptance()) s.ready = false;
    }
  }

  private maybeStartCountdown(): void {
    if (this.phase !== 'lobby') return;
    const seats = this.seatList();
    if (seats.length !== 2 || !seats.every((s) => s.connected && s.ready && s.boardId)) return;
    const compat = this.compatibility();
    if (!compat) return;
    if (this.needsAcceptance() && !seats.every((s) => s.acceptsUnranked)) return;
    this.startCountdown(compat);
  }

  private startCountdown(compat: CompatibilityReport): void {
    const a = this.seats.A;
    const b = this.seats.B;
    const boardA = a?.boardId ? getMatchBoard(a.boardId) : undefined;
    const boardB = b?.boardId ? getMatchBoard(b.boardId) : undefined;
    if (!a || !b || !boardA || !boardB) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.matchNumber++;
    this.matchId = randomUUID();
    this.seeds = { A: randomInt(1, 0x7fffffff), B: randomInt(1, 0x7fffffff) };
    // Lock equipment: loadouts as chosen, upgrades trimmed to what this room's mode allows.
    const lock = (s: SeatState): Equipment => ({ loadout: s.loadout, upgrades: effectiveUpgrades(s.upgrades, this.equipmentMode) });
    this.lockedEquipment = { A: lock(a), B: lock(b) };
    const startEnergyOverride = this.services.config.testStartEnergy;
    const config = (s: Seat) =>
      matchConfig({
        equipment: this.lockedEquipment?.[s] ?? this.equipmentOf(s === 'A' ? a : b),
        equipmentMode: this.equipmentMode,
        startEnergyOverride,
      });
    this.engine = new MatchEngine(
      [
        { seat: 'A', board: boardA, seed: this.seeds.A, config: config('A'), loadout: a.loadout },
        { seat: 'B', board: boardB, seed: this.seeds.B, config: config('B'), loadout: b.loadout },
      ],
      { durationTicks: this.durationTicks },
    );
    this.compatibilityAtStart = compat;
    this.goAt = Date.now() + this.services.config.countdownMs;
    this.phase = 'countdown';
    this.result = null;
    this.finalized = false;
    this.lastSyncIndex = 0;
    this.lastPreviewIndex = 0;
    this.note('countdown', undefined, this.matchId);
    for (const s of this.seatList()) s.client?.send('matchStart', this.matchStartInfo(s.seat));
    this.broadcastLobby();
  }

  private matchStartInfo(seat: Seat): MatchStartInfo {
    const a = this.seats.A;
    const b = this.seats.B;
    const engine = this.engine;
    const board = (s: Seat) => ({ boardId: engine?.state(s).boardId ?? '', boardVersion: engine?.state(s).boardVersion ?? 0 });
    return {
      matchId: this.matchId ?? '',
      seat,
      seed: this.seeds[seat],
      boards: { A: board('A'), B: board('B') },
      names: { A: a?.name ?? '', B: b?.name ?? '' },
      goAt: this.goAt ?? 0,
      serverTime: Date.now(),
      ticksPerSecond: this.ticksPerSecond,
      durationTicks: this.durationTicks,
      equipmentMode: this.equipmentMode,
      loadouts: {
        A: this.lockedEquipment?.A.loadout ?? DEFAULT_LOADOUT,
        B: this.lockedEquipment?.B.loadout ?? DEFAULT_LOADOUT,
      },
      equipment: this.lockedEquipment?.[seat] ?? { loadout: DEFAULT_LOADOUT, upgrades: sanitizeUpgradeLevels(null) },
      startEnergyOverride: this.services.config.testStartEnergy,
    };
  }

  private abortCountdown(reason: string): void {
    if (this.phase !== 'countdown') return;
    this.note('countdown_aborted', undefined, reason);
    if (this.engine && this.matchId) {
      // The match never started; record it as cancelled for the audit trail.
      this.engine.abandon();
      this.persist(this.buildResult('cancelled', null, 'match_cancelled', 0));
    }
    this.engine = null;
    this.matchId = null;
    this.goAt = null;
    this.phase = 'lobby';
    for (const s of this.seatList()) s.ready = false;
    if (this.quick) {
      // A failed Quick Match start: release both players so they can requeue.
      this.broadcast('closed', { reason: 'match_failed', seats: [] });
      return this.closeRoom('match_failed');
    }
    this.armIdleTimer();
    this.broadcastLobby();
  }

  private update(): void {
    const engine = this.engine;
    if (!engine || this.goAt === null) return;
    const now = Date.now();
    if (this.phase === 'countdown' && now >= this.goAt) {
      this.phase = 'playing';
      this.note('start', undefined, this.matchId ?? '');
      this.broadcastLobby();
    }
    if (this.phase !== 'playing') return;
    // Resolve queued ability requests at the current tick, BEFORE advancing, so
    // their effects land at a future tick both clients hear about in time.
    const decisions = engine.resolveAbilities();
    if (decisions.length > 0) this.announceAbilities(decisions);
    const target = Math.floor(((now - this.goAt) * this.ticksPerSecond) / 1000);
    const before = engine.tick;
    engine.advanceTo(target);
    // Server loop stability (diagnostics): gaps between iterations and ticks per step.
    if (this.loopStats.lastAt > 0) this.loopStats.maxGapMs = Math.max(this.loopStats.maxGapMs, now - this.loopStats.lastAt);
    this.loopStats.lastAt = now;
    this.loopStats.lastStepTicks = engine.tick - before;
    const syncIndex = Math.floor(engine.tick / MATCH_CONFIG.syncEveryTicks);
    if (syncIndex > this.lastSyncIndex || engine.isOver) {
      this.lastSyncIndex = syncIndex;
      this.sendSync();
    }
    const previewIndex = Math.floor(engine.tick / MATCH_CONFIG.previewEveryTicks);
    if (previewIndex > this.lastPreviewIndex) {
      this.lastPreviewIndex = previewIndex;
      this.sendPreviews();
    }
    if (engine.isOver) this.finalize();
  }

  private announceAbilities(decisions: AbilityDecision[]): void {
    const engine = this.engine;
    if (!engine) return;
    const touched = new Set<Seat>();
    for (const d of decisions) {
      const requester = this.seats[d.seat];
      requester?.client?.send('abilityResult', {
        ability: d.ability,
        accepted: d.accepted,
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.applyTick !== undefined ? { applyTick: d.applyTick } : {}),
        ...(d.blocked !== undefined ? { blocked: d.blocked } : {}),
      });
      this.note(d.accepted ? 'ability' : 'ability_rejected', d.seat, d.accepted ? `${d.ability}${d.blocked ? ':blocked' : ''}` : `${d.ability}:${d.reason}`);
      if (!d.accepted || d.applyTick === undefined) continue;
      const offensive = d.ability === 'emp' || d.ability === 'shrink' || d.ability === 'frost';
      touched.add(d.seat);
      if (offensive) touched.add(otherSeat(d.seat));
      this.broadcast('abilityEvent', {
        by: d.seat,
        ability: d.ability,
        applyTick: d.applyTick,
        target: offensive ? otherSeat(d.seat) : null,
        blocked: d.blocked ?? false,
      });
    }
    // Each affected client learns its own upcoming commands now, well before they apply.
    for (const seat of touched) this.seats[seat]?.client?.send('ext', { upcoming: engine.upcomingCommands(seat) });
  }

  private sendSync(): void {
    const engine = this.engine;
    if (!engine) return;
    const players = SEATS.map((seat) => engine.progress(seat, this.seats[seat]?.connected ?? false));
    const timeLeftTicks = Math.max(0, this.durationTicks - engine.tick);
    const diagnostics = this.services.config.netDiagnostics;
    for (const s of this.seatList()) {
      const lead = engine.takeLeadFeedback(s.seat);
      if (!s.client) continue;
      const hash = engine.latestHash(s.seat);
      const msg: SyncMessage = { tick: engine.tick, hashTick: hash.tick, hash: hash.hash, timeLeftTicks, players, lead };
      if (diagnostics) {
        const timing = engine.inputTiming(s.seat);
        msg.diag = { maxLoopGapMs: this.loopStats.maxGapMs, lastStepTicks: this.loopStats.lastStepTicks, lateInputs: timing.late, inputs: timing.inputs };
      }
      s.client.send('sync', msg);
    }
    this.loopStats.maxGapMs = 0;
  }

  private sendPreviews(): void {
    const engine = this.engine;
    if (!engine) return;
    for (const s of this.seatList()) s.client?.send('preview', engine.preview(otherSeat(s.seat)));
  }

  /** Decides the match exactly once; later calls are no-ops. */
  private finalize(): void {
    const engine = this.engine;
    if (this.finalized || !engine?.outcome) return;
    this.finalized = true;
    const { outcome, winnerSeat, reason, endTick } = engine.outcome;
    const result = this.buildResult(outcome, winnerSeat, reason, endTick);
    this.result = result;
    this.phase = 'finished';
    this.goAt = null;
    for (const s of this.seatList()) s.rematch = 'none';
    this.sendSync();
    this.persist(result);
    this.services.telemetry.recordMatch(result);
    this.note('finalized', winnerSeat ?? undefined, `${outcome}:${reason}`);
    this.broadcast('result', result);
    this.armIdleTimer();
    this.broadcastLobby();
  }

  private buildResult(
    outcome: MatchResult['outcome'],
    winnerSeat: Seat | null,
    reason: MatchResult['reason'],
    endTick: number,
  ): MatchResult {
    const engine = this.engine;
    if (!engine) throw new Error('no engine');
    const players: MatchResultPlayer[] = SEATS.map((seat) => {
      const s = engine.state(seat);
      const info = engine.slotInfo(seat);
      const st = this.seats[seat];
      return {
        seat,
        playerId: st?.playerId ?? '',
        name: st?.name ?? '',
        boardId: s.boardId,
        boardVersion: s.boardVersion,
        completionTick: info.completionTick,
        exhaustedTick: info.exhaustedTick,
        ballsRemaining: s.lives,
        bricksCleared: s.requiredTotal - s.requiredRemaining,
        bricksTotal: s.requiredTotal,
        score: s.score,
        forfeited: info.forfeited,
        disconnectedAtEnd: !(st?.connected ?? false),
      };
    });
    return {
      matchId: this.matchId ?? randomUUID(),
      roomId: this.roomId,
      ranked: false,
      devMode: this.devMode,
      outcome,
      winnerPlayerId: winnerSeat ? (this.seats[winnerSeat]?.playerId ?? null) : null,
      winnerSeat,
      reason,
      startTick: 0,
      endTick,
      durationTicks: this.durationTicks,
      ticksPerSecond: MATCH_CONFIG.tickRate,
      players,
      compatibility: this.compatibilityAtStart,
      verification: {
        method: 'server-authoritative-simulation',
        replayVerified: engine.verifyReplays(),
        inputLogHashes: { A: engine.inputLogHash('A'), B: engine.inputLogHash('B') },
      },
      finalizedAt: new Date().toISOString(),
    };
  }

  private persist(result: MatchResult): void {
    const engine = this.engine;
    if (!engine) return;
    void this.services.results
      .save({
        result,
        mode: this.quick ? 'quick' : 'private',
        accounts: { A: this.seats.A?.account?.userId ?? null, B: this.seats.B?.account?.userId ?? null },
        startedAt: this.goAt ?? Date.now(),
        seeds: { ...this.seeds },
        equipmentMode: this.equipmentMode,
        equipment: this.lockedEquipment ?? undefined,
        inputs: { A: [...engine.appliedInputs('A')], B: [...engine.appliedInputs('B')] },
        events: [...this.log],
      })
      .catch((err: unknown) => this.note('persist_failed', undefined, String(err)));
  }

  private resetToLobby(): void {
    this.phase = 'lobby';
    this.engine = null;
    this.matchId = null;
    this.goAt = null;
    this.result = null;
    this.finalized = false;
    for (const s of this.seatList()) {
      s.ready = false;
      s.acceptsUnranked = false;
      s.rematch = 'none';
    }
    this.armIdleTimer();
  }

  private closeRoom(reason: string): void {
    this.note('closed', undefined, reason);
    this.broadcast('closed', { reason });
    this.services.codes.release(this.code);
    void this.disconnect();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeRoom('expired'), this.services.config.lobbyIdleMinutes * 60_000);
  }

  // ---- Views & helpers -------------------------------------------------------------

  private joinStatus(): 'joinable' | 'full' | 'in_progress' {
    if (this.phase !== 'lobby') return 'in_progress';
    return this.seatList().length >= 2 ? 'full' : 'joinable';
  }

  private broadcastLobby(): void {
    const compat = this.compatibility();
    const view: LobbyView = {
      roomCode: this.code,
      phase: this.phase,
      devMode: this.devMode,
      matchNumber: this.matchNumber,
      matchId: this.matchId,
      players: this.seatList().map((s) => ({
        seat: s.seat,
        playerId: s.playerId,
        name: s.name,
        isHost: s.seat === this.hostSeat,
        boardId: s.boardId,
        ready: s.ready,
        acceptsUnranked: s.acceptsUnranked,
        connected: s.connected,
        reconnectDeadline: s.reconnectDeadline,
        rematch: s.rematch,
        loadout: s.loadout,
        equipment: rateEquipment(this.equipmentOf(s), this.equipmentMode),
      })),
      compatibility: compat,
      equipmentMode: this.equipmentMode,
      equipmentCompatibility: this.equipmentCompatibility(),
      needsUnrankedAcceptance: this.needsAcceptance(),
      matchmaking: this.quick
        ? { readyDeadline: this.quickReadyDeadline, notes: { A: this.quick.seats.A.note, B: this.quick.seats.B.note } }
        : null,
      goAt: this.goAt,
      durationTicks: this.durationTicks,
      ticksPerSecond: this.ticksPerSecond,
      result: this.result,
    };
    for (const s of this.seatList()) s.client?.send('lobby', view);
  }

  private seatList(): SeatState[] {
    return SEATS.flatMap((s) => (this.seats[s] ? [this.seats[s]] : []));
  }

  private seatOf(client: Client): SeatState | undefined {
    return this.seatList().find((s) => s.sessionId === client.sessionId);
  }

  private note(type: string, seat?: Seat, detail?: string): void {
    this.log.push({ at: Date.now(), tick: this.engine?.tick ?? 0, type, ...(seat ? { seat } : {}), ...(detail ? { detail } : {}) });
    if (this.log.length > 500) this.log.shift();
  }
}
