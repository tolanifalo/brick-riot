import { useState } from 'react';
import { describeError, matchActions, useMatch } from '../../net/matchStore';
import { loadName, saveName } from '../../net/profile';
import { useApp } from '../../state/appStore';
import { LobbyScreen } from './LobbyScreen';
import { MatchScreen } from './MatchScreen';
import { QuickLobby } from './QuickLobby';

/** Routes between the multiplayer menu, the lobby and the match by connection + room phase. */
export function MultiplayerScreen() {
  const lobby = useMatch((s) => s.lobby);
  if (lobby) return <MultiplayerRouter />;
  return <MultiplayerHome />;
}

/** Lobby or match for the current room (private or Quick Match). */
export function MultiplayerRouter() {
  const lobby = useMatch((s) => s.lobby);
  const status = useMatch((s) => s.status);
  if (lobby && (status === 'connected' || status === 'reconnecting')) {
    if (lobby.phase !== 'lobby') return <MatchScreen />;
    return lobby.matchmaking ? <QuickLobby /> : <LobbyScreen />;
  }
  if (lobby && status === 'disconnected') return <MatchScreen />;
  return null;
}

function MultiplayerHome() {
  const setScreen = useApp((s) => s.setScreen);
  const status = useMatch((s) => s.status);
  const error = useMatch((s) => s.error);
  const closedReason = useMatch((s) => s.closedReason);
  const [name, setName] = useState(loadName);
  const [mode, setMode] = useState<'menu' | 'join'>('menu');
  const [code, setCode] = useState('');
  const [devMode, setDevMode] = useState(false);
  const busy = status === 'connecting';
  const canRejoin = matchActions.hasRejoinToken();

  const commitName = () => saveName(name.trim().slice(0, 16) || loadName());

  return (
    <main className="mp-home">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="mp-back">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>MULTIPLAYER</h1>
      </header>
      <p className="mp-intro">
        A 1v1 race on separate boards. First to clear every required brick wins. The server runs both games and
        decides the result.
      </p>

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={16}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          data-testid="mp-name"
          autoComplete="nickname"
        />
      </label>

      {error && (
        <p className="mp-error" role="alert" data-testid="mp-error">
          {error}
        </p>
      )}
      {closedReason && !error && <p className="mp-error">The room was closed ({closedReason.replace(/_/g, ' ')}).</p>}

      {mode === 'menu' ? (
        <div className="mp-actions">
          {canRejoin && (
            <button type="button" className="menu-btn primary" disabled={busy} onClick={() => void matchActions.rejoin()} data-testid="mp-rejoin">
              <span>REJOIN MATCH</span>
              <span className="menu-btn-note">Reconnect to your last room</span>
            </button>
          )}
          <button
            type="button"
            className={canRejoin ? 'menu-btn' : 'menu-btn primary'}
            disabled={busy}
            onClick={() => {
              commitName();
              void matchActions.create(devMode);
            }}
            data-testid="mp-create"
          >
            <span>CREATE ROOM</span>
            <span className="menu-btn-note">Get a code to share</span>
          </button>
          <button
            type="button"
            className="menu-btn"
            disabled={busy}
            onClick={() => {
              matchActions.clearError();
              setMode('join');
            }}
            data-testid="mp-join"
          >
            <span>JOIN ROOM</span>
            <span className="menu-btn-note">Enter a friend's code</span>
          </button>
          <label className="dev-toggle">
            <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} data-testid="mp-dev" />
            <span>
              <strong>Development room</strong> · any eligible board, unlocks not checked. For testing; the server may
              refuse it.
            </span>
          </label>
          <button type="button" className="menu-btn" onClick={() => setScreen('quickmatch')} data-testid="mp-quick">
            <span>QUICK MATCH</span>
            <span className="menu-btn-note">Public casual matchmaking · sign-in required</span>
          </button>
          <button type="button" className="menu-btn" disabled aria-disabled="true">
            <span>RANKED</span>
            <span className="menu-btn-note">Unavailable · coming after human calibration</span>
          </button>
        </div>
      ) : (
        <form
          className="mp-join-form"
          onSubmit={(e) => {
            e.preventDefault();
            commitName();
            void matchActions.join(code);
          }}
        >
          <label className="field">
            <span>Room code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="ABC234"
              className="code-input"
              data-testid="mp-code"
              autoFocus
            />
          </label>
          <div className="panel-actions">
            <button type="submit" className="btn primary" disabled={busy || code.length !== 6} data-testid="mp-join-submit">
              {busy ? 'JOINING…' : 'JOIN'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode('menu')}>
              BACK
            </button>
          </div>
        </form>
      )}
      {busy && <p className="hint-static">Connecting…</p>}
    </main>
  );
}

export { describeError };
