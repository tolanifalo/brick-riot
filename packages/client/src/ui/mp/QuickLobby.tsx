import { getMatchBoard } from '@brick-riot/shared';
import { useEffect, useState } from 'react';
import { matchActions, useMatch } from '../../net/matchStore';
import { loadoutSummary } from '../LoadoutPicker';

const boardName = (id: string | null) => (id ? (getMatchBoard(id)?.name ?? id) : '?');

/**
 * Quick Match confirmation: shows the opponent, both (assigned) boards and why
 * each was chosen, then both players confirm READY before the deadline.
 */
export function QuickLobby() {
  const lobby = useMatch((s) => s.lobby);
  const seat = useMatch((s) => s.seat);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (!lobby?.matchmaking) return null;
  const me = lobby.players.find((p) => p.seat === seat);
  const opponent = lobby.players.find((p) => p.seat !== seat);
  const left = Math.max(0, Math.ceil((lobby.matchmaking.readyDeadline - now) / 1000));
  return (
    <main className="mp-lobby quick-lobby" data-testid="quick-lobby">
      <h1 className="quick-title">MATCH FOUND</h1>
      <div className="mp-slots">
        {[me, opponent].map((p, i) =>
          p ? (
            <div key={p.seat} className={`mp-slot${p.ready ? ' ready' : ''}${i === 0 ? ' me' : ''}`} data-testid={`quick-slot-${i === 0 ? 'me' : 'opponent'}`}>
              <span className="slot-name">
                {p.name}
                {i === 0 && <span className="tag">YOU</span>}
              </span>
              <span className="slot-board">{boardName(p.boardId)}</span>
              <span className="slot-loadout">{loadoutSummary(p.loadout)}</span>
              <span className="slot-state">{p.ready ? 'READY' : 'CONFIRMING…'}</span>
            </div>
          ) : (
            <div key={i} className="mp-slot empty">
              <span className="slot-name">Opponent joining…</span>
            </div>
          ),
        )}
      </div>
      {seat && (
        <p className="mp-small" data-testid="quick-note">
          Your board: {lobby.matchmaking.notes[seat]}
        </p>
      )}
      {lobby.compatibility && <p className="mp-small">Board compatibility: fair match-up (balance {lobby.compatibility.calibration}).</p>}
      <div className="lobby-footer" data-ui>
        <button
          type="button"
          className="btn primary"
          disabled={!!me?.ready}
          onClick={() => matchActions.send('setReady', { ready: true })}
          data-testid="quick-ready"
        >
          {me?.ready ? 'WAITING FOR OPPONENT' : `READY (${left}s)`}
        </button>
        <button type="button" className="btn ghost" onClick={() => void matchActions.leave()} data-testid="quick-decline">
          DECLINE
        </button>
      </div>
    </main>
  );
}
