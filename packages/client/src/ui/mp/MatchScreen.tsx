import { BALANCE, getMatchBoard, MATCH_CONFIG, otherSeat, type MatchResult, type Seat } from '@brick-riot/shared';
import { useEffect, useRef, useState } from 'react';
import { GameBridge } from '../../game/bridge';
import { createMatchGame } from '../../game/createGame';
import { matchActions, useMatch } from '../../net/matchStore';
import { useProgress } from '../../progress/progressStore';
import { AbilityBar, AbilityFeed, OpponentEffects } from './AbilityBar';
import { NetDebug, netDebugEnabled } from './NetDebug';

const showNetDebug = netDebugEnabled();
import { INITIAL_HUD, useHud } from '../../state/hudStore';
import { ComboBadge, EffectChips } from '../Hud';
import { MatchResultPanel } from './MatchResultPanel';
import { OpponentPreview } from './OpponentPreview';

function formatClock(ticks: number): string {
  const s = Math.max(0, Math.ceil(ticks / MATCH_CONFIG.tickRate));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Re-renders `fn()` ten times a second (timer, countdown, deadlines). */
function useTicking<T>(fn: () => T): T {
  const [value, setValue] = useState(fn);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const id = setInterval(() => setValue(ref.current()), 100);
    return () => clearInterval(id);
  }, []);
  return value;
}

function MatchTimer() {
  const net = useMatch((s) => s.net);
  const result = useMatch((s) => s.result);
  const timeLeft = useTicking(() => {
    if (!net) return 0;
    const elapsed = Math.max(0, (net.serverTickFloat() * MATCH_CONFIG.tickRate) / net.start.ticksPerSecond);
    return net.durationTicks - elapsed;
  });
  const shown = result ? Math.max(0, result.durationTicks - result.endTick) : timeLeft;
  return (
    <div className={`mp-timer${shown < 15 * MATCH_CONFIG.tickRate ? ' urgent' : ''}`} data-testid="match-timer">
      {formatClock(shown)}
    </div>
  );
}

function Balls({ count }: { count: number }) {
  return (
    <span className="lives" aria-label={`${count} balls left`}>
      {Array.from({ length: BALANCE.lives }, (_, i) => (
        <span key={i} className={i < count ? 'life on' : 'life'} />
      ))}
    </span>
  );
}

function OpponentStrip({ seat, onLeave }: { seat: Seat; onLeave(): void }) {
  const start = useMatch((s) => s.start);
  const progress = useMatch((s) => s.progress);
  const lobby = useMatch((s) => s.lobby);
  const opp = otherSeat(seat);
  const view = progress?.players.find((p) => p.seat === opp);
  const lobbyPlayer = lobby?.players.find((p) => p.seat === opp);
  const deadline = lobbyPlayer?.reconnectDeadline ?? null;
  const secondsLeft = useTicking(() => (deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0));
  if (!start) return null;
  const boardId = start.boards[opp].boardId;
  const cleared = view && view.bricksTotal > 0 ? (view.bricksTotal - view.bricksRemaining) / view.bricksTotal : 0;
  const offline = lobbyPlayer ? !lobbyPlayer.connected : false;
  return (
    <header className="opp-strip" data-ui data-testid="opponent-strip">
      <OpponentPreview boardId={boardId} width={54} />
      <div className="opp-info">
        <span className="opp-name" data-testid="opponent-name">
          {start.names[opp]}
        </span>
        <span className="opp-board">{getMatchBoard(boardId)?.name}</span>
        <div className="opp-bar" role="progressbar" aria-label="Opponent bricks cleared" aria-valuenow={Math.round(cleared * 100)}>
          <div className="opp-fill" style={{ transform: `scaleX(${cleared})` }} />
        </div>
        <span className="opp-meta">
          <span data-testid="opponent-cleared">{Math.round(cleared * 100)}%</span>
          <Balls count={view?.lives ?? BALANCE.lives} />
          <OpponentEffects seat={seat} />
          {offline ? (
            <span className="opp-offline" data-testid="opponent-offline">
              OFFLINE · {secondsLeft}s
            </span>
          ) : view?.status === 'exhausted' ? (
            <span className="opp-offline">OUT OF BALLS</span>
          ) : view?.status === 'cleared' ? (
            <span className="opp-done">CLEARED</span>
          ) : null}
        </span>
      </div>
      <div className="opp-right">
        <MatchTimer />
        <button type="button" className="icon-btn small" onClick={onLeave} aria-label="Leave match" data-testid="match-leave">
          <span className="icon-x" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function OwnHud({ seat }: { seat: Seat }) {
  const score = useHud((s) => s.score);
  const lives = useHud((s) => s.lives);
  const progress = useMatch((s) => s.progress);
  const rtt = useMatch((s) => s.rttMs);
  const status = useMatch((s) => s.status);
  const mine = progress?.players.find((p) => p.seat === seat);
  const cleared = mine && mine.bricksTotal > 0 ? (mine.bricksTotal - mine.bricksRemaining) / mine.bricksTotal : 0;
  return (
    <div className="own-hud" data-ui>
      <div className="hud-block">
        <span className="hud-label">YOU</span>
        <span className="hud-value" data-testid="hud-score">
          {score.toLocaleString('en-US')}
        </span>
      </div>
      <div className="own-progress">
        <div className="progress">
          <div className="progress-fill" style={{ transform: `scaleX(${cleared})` }} />
        </div>
        <span className="mp-small" data-testid="own-cleared">
          {Math.round(cleared * 100)}% cleared
        </span>
      </div>
      <div className="hud-block right">
        <Balls count={lives} />
        <span className={`net-dot ${status === 'connected' ? (rtt > 200 ? 'slow' : 'good') : 'bad'}`} data-testid="connection-indicator">
          {status === 'connected' ? `${rtt}ms` : status.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function CountdownOverlay() {
  const net = useMatch((s) => s.net);
  const ms = useTicking(() => (net ? net.msUntilStart() : 0));
  if (!net || ms < -700) return null;
  return (
    <div className="overlay passive countdown" data-testid="countdown">
      <span key={ms > 0 ? Math.ceil(ms / 1000) : 'go'} className="countdown-num">
        {ms > 0 ? Math.ceil(ms / 1000) : 'GO!'}
      </span>
    </div>
  );
}

function RunBanner({ seat }: { seat: Seat }) {
  const phase = useHud((s) => s.phase);
  const progress = useMatch((s) => s.progress);
  const net = useMatch((s) => s.net);
  const result = useMatch((s) => s.result);
  const mine = progress?.players.find((p) => p.seat === seat);
  if (result || !net || net.msUntilStart() > 0) return null;
  let text: string | null = null;
  if (mine?.status === 'exhausted') text = 'OUT OF BALLS · your opponent can still clear';
  else if (phase === 'won') text = 'BOARD CLEAR · confirming with the server…';
  else if (phase === 'ready') text = 'TAP OR SPACE TO LAUNCH';
  if (!text) return null;
  return (
    <div className="overlay passive">
      <p className="hint mp-banner" data-testid="run-banner">
        {text}
      </p>
    </div>
  );
}

function ConnectionOverlay() {
  const status = useMatch((s) => s.status);
  if (status === 'connected') return null;
  return (
    <div className="overlay blocking" data-ui>
      <section className="panel neutral" role="dialog" aria-label="Connection">
        <h2 className="panel-title">{status === 'reconnecting' ? 'RECONNECTING…' : 'CONNECTION LOST'}</h2>
        <p className="mp-small">
          The match keeps running on the server. If you do not reconnect within the grace period, the match is
          forfeited.
        </p>
        {status === 'disconnected' && (
          <div className="panel-actions">
            <button type="button" className="btn primary" onClick={() => void matchActions.rejoin()} data-testid="rejoin">
              REJOIN
            </button>
            <button type="button" className="btn ghost" onClick={() => void matchActions.leave()}>
              LEAVE
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ConfirmLeave({ onCancel }: { onCancel(): void }) {
  return (
    <div className="overlay blocking" data-ui>
      <section className="panel loss" role="dialog" aria-label="Leave match">
        <h2 className="panel-title">LEAVE?</h2>
        <p className="mp-small">Leaving now forfeits the match.</p>
        <div className="panel-actions">
          <button type="button" className="btn primary" onClick={onCancel} autoFocus>
            KEEP PLAYING
          </button>
          <button type="button" className="btn ghost" onClick={() => void matchActions.leave()} data-testid="confirm-leave">
            LEAVE AND FORFEIT
          </button>
        </div>
      </section>
    </div>
  );
}

function MatchStage({ seat }: { seat: Seat }) {
  const surfaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const net = useMatch((s) => s.net);
  const result = useMatch((s) => s.result);
  const [bridge] = useState(() => new GameBridge());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const boardId = net?.start.boards[seat].boardId;

  useEffect(() => {
    const parent = stageRef.current;
    const surface = surfaceRef.current;
    const board = boardId ? getMatchBoard(boardId) : undefined;
    if (!parent || !surface || !board || !net) return;
    useHud.setState({ ...INITIAL_HUD });
    const reducedEffects = useProgress.getState().progress.settings.reducedEffects;
    const game = createMatchGame({ parent, inputSurface: surface, board, levelNumber: 0, bridge, net, reducedEffects });
    return () => {
      game.destroy(true);
      useHud.setState({ ...INITIAL_HUD });
    };
  }, [bridge, net, boardId]);

  const opp = otherSeat(seat);
  return (
    <main className="solo mp-match" ref={surfaceRef}>
      <div className="solo-column mp-column">
        <OpponentStrip seat={seat} onLeave={() => (result ? void matchActions.leave() : setConfirmLeave(true))} />
        <OwnHud seat={seat} />
        <div className="stage">
          <div className="stage-canvas" ref={stageRef} data-testid="stage" />
          <EffectChips />
          <ComboBadge />
          <AbilityFeed />
          {showNetDebug && <NetDebug />}
          <CountdownOverlay />
          <RunBanner seat={seat} />
          {result && <MatchResultPanel result={result} seat={seat} />}
          <ConnectionOverlay />
          {confirmLeave && !result && <ConfirmLeave onCancel={() => setConfirmLeave(false)} />}
        </div>
        {!result && <AbilityBar seat={seat} />}
      </div>
      {net && (
        <aside className="opponent-panel" data-ui>
          <h2>OPPONENT</h2>
          <OpponentPreview boardId={net.start.boards[opp].boardId} width={220} />
        </aside>
      )}
    </main>
  );
}

export function MatchScreen() {
  const seat = useMatch((s) => s.seat);
  const start = useMatch((s) => s.start);
  const result = useMatch((s) => s.result);
  if (!seat) return null;
  if (!start && result) return <ResultOnly result={result} seat={seat} />;
  if (!start) {
    return (
      <main className="loading-screen">
        <p className="loading-label">LOADING MATCH</p>
      </main>
    );
  }
  return <MatchStage key={start.matchId} seat={seat} />;
}

/** After rejoining a finished room there is no live game; show just the result. */
function ResultOnly({ result, seat }: { result: MatchResult; seat: Seat }) {
  return (
    <main className="solo">
      <div className="solo-column">
        <div className="stage">
          <MatchResultPanel result={result} seat={seat} />
        </div>
      </div>
    </main>
  );
}
