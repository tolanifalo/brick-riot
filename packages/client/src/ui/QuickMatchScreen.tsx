import { getMatchBoard, MULTIPLAYER_BOARDS } from '@brick-riot/shared';
import { useState } from 'react';
import { useAccount } from '../account/accountStore';
import { quickActions, useMatch } from '../net/matchStore';
import { useApp } from '../state/appStore';
import { MultiplayerRouter } from './mp/MultiplayerScreen';

const boardName = (id: string) => getMatchBoard(id)?.name ?? id;

/**
 * Public casual matchmaking. Real opponents only: with nobody suitable you see
 * an honest waiting state and can cancel. Boards come from YOUR preferences
 * (or a clearly explained alternative, if you allow one).
 */
export function QuickMatchScreen() {
  const lobby = useMatch((s) => s.lobby);
  if (lobby) return <MultiplayerRouter />;
  return <QuickSearch />;
}

function QuickSearch() {
  const setScreen = useApp((s) => s.setScreen);
  const openAccount = useApp((s) => s.openAccount);
  const status = useAccount((s) => s.status);
  const profile = useAccount((s) => s.profile);
  const quick = useMatch((s) => s.quick);
  const unlocked = new Set(profile?.unlockedBoardIds ?? []);
  const playable = MULTIPLAYER_BOARDS.filter((p) => unlocked.has(p.variantOf ?? p.boardId));
  const [prefs, setPrefs] = useState<string[]>(() => (playable[0] ? [playable[0].boardId] : []));
  const [alternatives, setAlternatives] = useState(true);

  const toggle = (id: string) =>
    setPrefs((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? p : [...p, id]));

  return (
    <main className="quick" data-testid="quick-screen">
      <header className="campaign-head" data-ui>
        <button
          type="button"
          className="back-btn"
          onClick={() => {
            void quickActions.cancel();
            setScreen('menu');
          }}
          data-testid="quick-back"
        >
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>QUICK MATCH</h1>
      </header>
      <p className="mp-intro">
        A casual 1v1 race against a real player of similar skill, on boards the compatibility rules rate as a fair
        pair. Unranked: no rating points are at stake.
      </p>

      {status !== 'signedIn' ? (
        <div className="compat">
          <h3>SIGN IN TO PLAY QUICK MATCH</h3>
          <p className="mp-small">Matchmaking needs a verified account so results, rewards and fairness checks can be trusted.</p>
          <button type="button" className="btn primary" onClick={() => openAccount('signin')} data-testid="quick-signin">
            SIGN IN
          </button>
        </div>
      ) : quick.phase === 'idle' ? (
        <>
          {quick.notice && (
            <p className="mp-error" role="status" data-testid="quick-notice">
              {quick.notice}
            </p>
          )}
          <h2 className="mp-subtitle">YOUR BOARDS (UP TO 3, IN ORDER)</h2>
          {playable.length === 0 ? (
            <p className="mp-small" data-testid="quick-no-boards">
              Clear level 1 (Kickoff) in the campaign (signed in) to unlock your first multiplayer board.
            </p>
          ) : (
            <ul className="mp-board-grid">
              {playable.map((p) => {
                const rank = prefs.indexOf(p.boardId);
                return (
                  <li key={p.boardId}>
                    <button
                      type="button"
                      className={`mp-board${rank >= 0 ? ' selected' : ''}`}
                      aria-pressed={rank >= 0}
                      onClick={() => toggle(p.boardId)}
                      data-testid={`quick-board-${p.boardId}`}
                    >
                      <span className="mp-board-name">
                        {rank >= 0 ? `${rank + 1}. ` : ''}
                        {boardName(p.boardId)}
                      </span>
                      <span className="mp-board-meta">
                        ~{p.expectedCompletionSeconds}s · {p.band}
                        {p.variantOf ? ' · MP variant' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <label className="dev-toggle">
            <input type="checkbox" checked={alternatives} onChange={(e) => setAlternatives(e.target.checked)} data-testid="quick-alternatives" />
            <span>
              <strong>Allow a suggested board</strong> if none of mine has a fair match-up. You will always see which
              board you got and why.
            </span>
          </label>
          <button
            type="button"
            className="btn primary big"
            disabled={prefs.length === 0}
            onClick={() => void quickActions.start({ boards: prefs, allowAlternatives: alternatives })}
            data-testid="quick-search"
          >
            FIND OPPONENT
          </button>
          <p className="mp-small">Private rooms with a code are still available under MULTIPLAYER.</p>
        </>
      ) : quick.phase === 'searching' ? (
        <section className="quick-searching" aria-live="polite" data-testid="quick-searching">
          <div className="searching-pulse" aria-hidden="true" />
          <h2>SEARCHING…</h2>
          {quick.notice && <p className="mp-small">{quick.notice}</p>}
          <p className="mp-small" data-testid="quick-wait">
            {quick.waitedSeconds}s · {quick.playersSearching} player{quick.playersSearching === 1 ? '' : 's'} searching
          </p>
          <p className="mp-small">
            We only pair real players. The skill window widens the longer you wait; the search stops after{' '}
            {Math.round((quick.timeoutSeconds || 300) / 60)} minutes.
          </p>
          <button type="button" className="btn" onClick={() => void quickActions.cancel()} data-testid="quick-cancel">
            CANCEL
          </button>
        </section>
      ) : (
        <section className="quick-searching" data-testid="quick-found">
          <h2>OPPONENT FOUND</h2>
          {quick.match && (
            <p>
              <strong>{quick.match.opponentName}</strong> · your board {boardName(quick.match.myBoardId)} vs{' '}
              {boardName(quick.match.opponentBoardId)}
            </p>
          )}
          <p className="mp-small">Joining the match…</p>
        </section>
      )}
    </main>
  );
}
