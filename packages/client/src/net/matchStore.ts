import { Client, type Room } from '@colyseus/sdk';
import {
  QUEUE_ROOM_NAME,
  ROOM_NAME,
  type GameTicketResponse,
  type QueueMatchedMessage,
  type QueueStatusMessage,
  type QuickPreferences,
  type AbilityEventMessage,
  type AbilityResultMessage,
  type ExtMessage,
  type JoinOptions,
  type LobbyView,
  type MatchResult,
  type MatchStartInfo,
  type PreviewMessage,
  type StateMessage,
  type SyncMessage,
} from '@brick-riot/shared';
import { create } from 'zustand';
import { useAccount } from '../account/accountStore';
import { useProgress } from '../progress/progressStore';
import { api } from './api';
import { ServerClock } from './clock';
import { MatchNet } from './matchNet';
import { loadName, loadReconnectToken, profileId, saveReconnectToken } from './profile';
import { serverHttpUrl } from './serverUrl';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface MatchState {
  status: ConnectionStatus;
  error: string | null;
  /** Latest rejection from the server, shown briefly in the lobby. */
  notice: string | null;
  seat: 'A' | 'B' | null;
  playerId: string | null;
  roomCode: string | null;
  lobby: LobbyView | null;
  start: MatchStartInfo | null;
  progress: SyncMessage | null;
  result: MatchResult | null;
  closedReason: string | null;
  rttMs: number;
  /** Prediction driver for the current match (not reactive). */
  net: MatchNet | null;
  /** Recent ability feedback for the HUD (newest last). */
  feed: AbilityFeedItem[];
  /** Public Quick Match search state. */
  quick: QuickState;
}

export interface QuickState {
  phase: 'idle' | 'searching' | 'found';
  waitedSeconds: number;
  playersSearching: number;
  timeoutSeconds: number;
  match: QueueMatchedMessage | null;
  /** Player-facing explanation of the last event (timeout, opponent did not confirm, ...). */
  notice: string | null;
}

const QUICK_IDLE: QuickState = { phase: 'idle', waitedSeconds: 0, playersSearching: 0, timeoutSeconds: 0, match: null, notice: null };

export interface AbilityFeedItem {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
  at: number;
}

const REFUSAL_TEXT: Record<string, string> = {
  insufficient_energy: 'Not enough energy',
  cooldown: 'Still cooling down',
  already_pending: 'Already activating',
  already_active: 'Shield already up',
  opening_lockout: 'Attacks unlock 5 s into the match',
  target_awaiting_launch: 'Opponent is serving: wait for launch',
  target_debuffed: 'Opponent is already affected',
  target_immune: 'Opponent is briefly immune',
  target_finished: 'Opponent has finished',
  no_space: 'No safe space for Frost',
  nothing_to_cleanse: 'Nothing to cleanse',
  not_playing: 'Launch first',
  not_equipped: 'Not in your loadout',
  rate_limited: 'Too fast',
};

const ABILITY_NAME: Record<string, string> = { emp: 'EMP', shrink: 'Shrink Ray', frost: 'Frost Brick', shield: 'Shield', cleanse: 'Cleanse' };

let feedId = 0;
function pushFeed(text: string, tone: AbilityFeedItem['tone']): void {
  const now = Date.now();
  const feed = useMatch.getState().feed.filter((f) => now - f.at < 4000).slice(-3);
  useMatch.setState({ feed: [...feed, { id: ++feedId, text, tone, at: now }] });
}

const ERROR_TEXT: Record<string, string> = {
  invalid_code: 'No room with that code.',
  expired: 'That room has closed.',
  room_full: 'That room is full.',
  match_in_progress: 'That room is already playing.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  already_in_room: 'This browser is already in that room.',
  network: 'Cannot reach the multiplayer server.',
};

export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? `Something went wrong (${code}).`;
}

export const useMatch = create<MatchState>(() => ({
  status: 'idle',
  error: null,
  notice: null,
  seat: null,
  playerId: null,
  roomCode: null,
  lobby: null,
  start: null,
  progress: null,
  result: null,
  closedReason: null,
  rttMs: 0,
  net: null,
  feed: [],
  quick: QUICK_IDLE,
}));

/** Signed in: a single-use game ticket that proves the account to the room. */
async function accountTicket(): Promise<string | undefined> {
  if (useAccount.getState().status !== 'signedIn') return undefined;
  const res = await api<GameTicketResponse>('POST', '/api/game/ticket', {});
  return res.ticket;
}

let queueRoom: Room | null = null;
let lastQuickPrefs: QuickPreferences | null = null;

const QUICK_ERRORS: Record<string, string> = {
  account_required: 'Sign in to use Quick Match.',
  already_queued: 'You are already searching in another tab.',
  bad_preferences: 'Choose at least one board.',
  accounts_unavailable: 'Quick Match is not available on this server.',
};

export const quickActions = {
  /** Joins the public queue with board preferences. There are no bots: you wait for a real player. */
  async start(preferences: QuickPreferences, notice: string | null = null): Promise<void> {
    if (queueRoom) return;
    lastQuickPrefs = preferences;
    useMatch.setState({ quick: { ...QUICK_IDLE, phase: 'searching', notice }, error: null, closedReason: null });
    try {
      const ticket = await accountTicket();
      const client = new Client(serverHttpUrl());
      const q = await client.joinOrCreate(QUEUE_ROOM_NAME, { ticket, preferences });
      queueRoom = q;
      q.reconnection.enabled = false;
      q.onMessage('queue', (s: QueueStatusMessage) =>
        useMatch.setState((st) => ({ quick: { ...st.quick, waitedSeconds: s.waitedSeconds, playersSearching: s.playersSearching, timeoutSeconds: s.timeoutSeconds } })),
      );
      q.onMessage('retrying', () => useMatch.setState((st) => ({ quick: { ...st.quick, notice: 'Setting up the match failed; still searching.' } })));
      q.onMessage('timeout', () => {
        useMatch.setState({ quick: { ...QUICK_IDLE, notice: 'No suitable opponent was found in time. Try again, or allow alternative boards.' } });
      });
      q.onMessage('matched', (m: QueueMatchedMessage) => {
        useMatch.setState((st) => ({ quick: { ...st.quick, phase: 'found', match: m } }));
        void (async () => {
          const room = await client.consumeSeatReservation(m.reservation as never);
          // Attach before anything else is awaited: the room sends welcome/lobby
          // immediately and messages without a handler are dropped.
          attach(room);
          const current = queueRoom;
          queueRoom = null;
          await current?.leave().catch(() => undefined);
        })().catch(() => {
          useMatch.setState({ quick: { ...QUICK_IDLE, notice: 'Could not join the match. Searching again.' } });
          if (lastQuickPrefs) void quickActions.start(lastQuickPrefs);
        });
      });
      q.onLeave(() => {
        if (queueRoom === q) {
          queueRoom = null;
          if (useMatch.getState().quick.phase === 'searching') useMatch.setState((st) => ({ quick: { ...st.quick, phase: 'idle' } }));
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = Object.keys(QUICK_ERRORS).find((k) => message.includes(k));
      useMatch.setState({ quick: { ...QUICK_IDLE, notice: code ? (QUICK_ERRORS[code] ?? null) : 'Cannot reach the matchmaking server.' } });
    }
  },

  async cancel(): Promise<void> {
    lastQuickPrefs = null;
    const q = queueRoom;
    queueRoom = null;
    useMatch.setState({ quick: QUICK_IDLE });
    await q?.leave().catch(() => undefined);
  },
};

let room: Room | null = null;
let clock = new ServerClock();
let pingTimer: ReturnType<typeof setInterval> | null = null;
const previewListeners = new Set<(p: PreviewMessage) => void>();
let lastPreview: PreviewMessage | null = null;

/** Opponent board previews arrive at 10 Hz; consumers draw them without React re-renders. */
export function subscribePreview(listener: (p: PreviewMessage) => void): () => void {
  previewListeners.add(listener);
  if (lastPreview) listener(lastPreview);
  return () => previewListeners.delete(listener);
}

function joinOptions(extra: Partial<JoinOptions> = {}): JoinOptions {
  const { progress } = useProgress.getState();
  return {
    name: loadName(),
    profileId: profileId(),
    clearedBoardIds: Object.values(progress.boards)
      .filter((b) => b.completions > 0)
      .map((b) => b.boardId),
    xp: progress.xp,
    // Preferences only: the server validates the loadout and treats upgrade
    // levels as untrusted claims (casual rooms only, capped; never ranked).
    loadout: progress.loadout,
    upgrades: progress.upgrades,
    ...extra,
  };
}

function send(type: string, payload: unknown = {}): void {
  room?.send(type as never, payload as never);
}

export const matchActions = {
  send,

  async create(devMode: boolean): Promise<void> {
    await connect(async (client) => client.create(ROOM_NAME, joinOptions({ devMode, ticket: await accountTicket() })));
  },

  async join(code: string): Promise<void> {
    useMatch.setState({ status: 'connecting', error: null });
    let roomId: string;
    try {
      const res = await fetch(`${serverHttpUrl()}/api/rooms/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json()) as { roomId?: string; error?: string };
      if (!body.roomId) {
        useMatch.setState({ status: 'idle', error: describeError(body.error ?? 'unknown') });
        return;
      }
      roomId = body.roomId;
    } catch {
      useMatch.setState({ status: 'idle', error: describeError('network') });
      return;
    }
    await connect(async (client) => client.joinById(roomId, joinOptions({ code: code.trim().toUpperCase(), ticket: await accountTicket() })));
  },

  /** Rejoins a room after a reload, using the stored reconnection token. */
  async rejoin(): Promise<boolean> {
    const token = loadReconnectToken(5 * 60_000);
    if (!token) return false;
    await connect((client) => client.reconnect(token));
    return useMatch.getState().status === 'connected';
  },

  hasRejoinToken(): boolean {
    return loadReconnectToken(5 * 60_000) !== null;
  },

  /** Leaves the room. During a match this forfeits (the UI confirms first). */
  async leave(): Promise<void> {
    const current = room;
    room = null;
    saveReconnectToken(null);
    stopPing();
    reset();
    if (current) await current.leave(true).catch(() => undefined);
  },

  clearError(): void {
    useMatch.setState({ error: null });
  },
};

function reset(): void {
  useMatch.setState({
    status: 'idle',
    notice: null,
    seat: null,
    playerId: null,
    roomCode: null,
    lobby: null,
    start: null,
    progress: null,
    result: null,
    net: null,
    feed: [],
  });
  lastPreview = null;
}

async function connect(open: (client: Client) => Promise<Room>): Promise<void> {
  useMatch.setState({ status: 'connecting', error: null, closedReason: null });
  try {
    const client = new Client(serverHttpUrl());
    const joined = await open(client);
    attach(joined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = Object.keys(ERROR_TEXT).find((k) => message.includes(k)) ?? 'network';
    saveReconnectToken(null);
    useMatch.setState({ status: 'idle', error: describeError(code) });
  }
}

function attach(joined: Room): void {
  room = joined;
  clock = new ServerClock();
  saveReconnectToken(joined.reconnectionToken);
  useMatch.setState({ status: 'connected', error: null });

  joined.onMessage('welcome', (w: { seat: 'A' | 'B'; playerId: string; roomCode: string }) => {
    useMatch.setState({ seat: w.seat, playerId: w.playerId, roomCode: w.roomCode });
  });
  joined.onMessage('lobby', (lobby: LobbyView) => {
    const s = useMatch.getState();
    useMatch.setState({ lobby, ...(lobby.phase === 'lobby' && s.result && !lobby.result ? { result: null } : {}) });
    if (lobby.phase === 'lobby' && s.start) useMatch.setState({ start: null, net: null, progress: null });
  });
  joined.onMessage('matchStart', (start: MatchStartInfo) => {
    const existing = useMatch.getState().net;
    const net = existing && existing.start.matchId === start.matchId ? existing : new MatchNet(start, clock, send);
    useMatch.setState({ start, net, result: null, progress: null });
    lastPreview = null;
    // Rejoining a running match (reconnect or page reload): adopt the
    // authoritative state rather than re-simulating from tick 0.
    if (existing === net || net.serverTickFloat() > 1) net.requestResync();
  });
  joined.onMessage('sync', (msg: SyncMessage) => {
    useMatch.getState().net?.onSync(msg);
    useMatch.setState({ progress: msg });
  });
  joined.onMessage('state', (msg: StateMessage) => useMatch.getState().net?.onState(msg));
  joined.onMessage('preview', (msg: PreviewMessage) => {
    lastPreview = msg;
    for (const l of previewListeners) l(msg);
  });
  joined.onMessage('ext', (msg: ExtMessage) => useMatch.getState().net?.onExt(msg));
  joined.onMessage('abilityResult', (r: AbilityResultMessage) => {
    if (!r.accepted) pushFeed(REFUSAL_TEXT[r.reason ?? ''] ?? 'Ability refused', 'info');
  });
  joined.onMessage('abilityEvent', (e: AbilityEventMessage) => {
    const mine = e.by === useMatch.getState().seat;
    const name = ABILITY_NAME[e.ability] ?? e.ability;
    if (e.target === null) {
      if (!mine) pushFeed(`Opponent used ${name}`, 'info');
      return;
    }
    if (mine) pushFeed(e.blocked ? `${name} blocked by Shield` : `${name} sent`, e.blocked ? 'bad' : 'good');
    else pushFeed(e.blocked ? `Shield blocked ${name}!` : `Incoming ${name}!`, e.blocked ? 'good' : 'bad');
  });
  joined.onMessage('result', (result: MatchResult) => useMatch.setState({ result }));
  joined.onMessage('pong', (p: { t: number; serverTime: number }) => {
    clock.onPong(p.t, p.serverTime);
    useMatch.setState({ rttMs: Math.round(clock.rtt) });
  });
  joined.onMessage('rejected', (r: { type: string; reason: string }) => {
    if (r.type !== 'input' && r.type !== 'resync') useMatch.setState({ notice: r.reason });
  });
  joined.onMessage('closed', (c: { reason: string; seats?: ('A' | 'B')[] }) => {
    useMatch.setState({ closedReason: c.reason });
    // Quick Match called off before the start: if it was not this player's fault, search again.
    if (c.reason === 'ready_timeout' || c.reason === 'opponent_left' || c.reason === 'match_failed') {
      const mine = useMatch.getState().seat;
      const myFault = !!mine && (c.seats ?? []).includes(mine);
      const prefs = lastQuickPrefs;
      void matchActions.leave().then(() => {
        if (!myFault && prefs) void quickActions.start(prefs, 'Your opponent did not confirm. Searching again…');
        else useMatch.setState({ quick: { ...QUICK_IDLE, notice: myFault ? 'You did not confirm in time.' : null } });
      });
    }
  });

  joined.onDrop(() => useMatch.setState({ status: 'reconnecting' }));
  joined.onReconnect(() => {
    useMatch.setState({ status: 'connected' });
    saveReconnectToken(joined.reconnectionToken);
    useMatch.getState().net?.requestResync();
  });
  joined.onLeave((code) => {
    if (room !== joined) return;
    room = null;
    stopPing();
    // 1000 = normal close (we left, or the room closed): forget the token.
    if (code === 1000) saveReconnectToken(null);
    useMatch.setState({ status: code === 1000 ? 'idle' : 'disconnected' });
  });

  startPing();
}

function startPing(): void {
  stopPing();
  let count = 0;
  const ping = () => {
    send('ping', { t: Date.now() });
    count++;
    // Ping quickly at first to settle the clock estimate, then every 2 s.
    if (count === 8 && pingTimer) {
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 2000);
    }
  };
  ping();
  pingTimer = setInterval(ping, 250);
}

function stopPing(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}
