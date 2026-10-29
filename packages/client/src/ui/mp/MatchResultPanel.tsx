import { getMatchBoard, MATCH_CONFIG, otherSeat, type MatchResult, type ResultReason, type Seat } from '@brick-riot/shared';
import { matchActions, useMatch } from '../../net/matchStore';

const REASON_TEXT: Record<ResultReason, string> = {
  board_cleared: 'First to clear their board',
  same_tick_clear: 'Both cleared on the same tick',
  both_exhausted: 'Both ran out of balls',
  time_expired: 'Time ran out',
  forfeit: 'Forfeit',
  both_disconnected: 'Both players disconnected',
  match_cancelled: 'Match cancelled',
};

function seconds(tick: number | null): string {
  return tick === null ? '-' : `${(tick / MATCH_CONFIG.tickRate).toFixed(2)}s`;
}

export function MatchResultPanel({ result, seat }: { result: MatchResult; seat: Seat }) {
  const lobby = useMatch((s) => s.lobby);
  const me = lobby?.players.find((p) => p.seat === seat);
  const opponent = lobby?.players.find((p) => p.seat === otherSeat(seat));

  let title = 'DRAW';
  let tone: 'win' | 'loss' | 'neutral' = 'neutral';
  if (result.outcome === 'cancelled') title = 'NO CONTEST';
  else if (result.outcome === 'win') {
    const won = result.winnerSeat === seat;
    title = won ? 'YOU WIN' : 'YOU LOSE';
    tone = won ? 'win' : 'loss';
  }

  return (
    <div className="overlay blocking" data-ui>
      <section className={`panel ${tone} mp-result`} role="dialog" aria-label="Match result" data-testid="match-result">
        <h2 className="panel-title" data-testid="result-title">
          {title}
        </h2>
        <p className="result-reason" data-testid="result-reason">
          {REASON_TEXT[result.reason]}
        </p>
        <table className="result-table">
          <thead>
            <tr>
              <th />
              {result.players.map((p) => (
                <th key={p.seat} className={p.seat === seat ? 'me' : ''}>
                  {p.name}
                  {p.seat === seat ? ' (you)' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Board</td>
              {result.players.map((p) => (
                <td key={p.seat}>{getMatchBoard(p.boardId)?.name ?? p.boardId}</td>
              ))}
            </tr>
            <tr>
              <td>Cleared</td>
              {result.players.map((p) => (
                <td key={p.seat}>
                  {p.bricksCleared}/{p.bricksTotal}
                </td>
              ))}
            </tr>
            <tr>
              <td>Clear time</td>
              {result.players.map((p) => (
                <td key={p.seat}>{seconds(p.completionTick)}</td>
              ))}
            </tr>
            <tr>
              <td>Balls left</td>
              {result.players.map((p) => (
                <td key={p.seat}>{p.forfeited ? 'forfeit' : p.ballsRemaining}</td>
              ))}
            </tr>
            <tr>
              <td>Score</td>
              {result.players.map((p) => (
                <td key={p.seat}>{p.score.toLocaleString('en-US')}</td>
              ))}
            </tr>
          </tbody>
        </table>
        <p className={`verified ${result.verification.replayVerified ? 'ok' : 'bad'}`} data-testid="result-verified">
          {result.verification.replayVerified ? 'SERVER VERIFIED · replay matches' : 'VERIFICATION FAILED'}
        </p>
        <p className="mp-small result-id">Match {result.matchId.slice(0, 8)} · unranked</p>

        <div className="panel-actions">
          {!opponent ? (
            <>
              <p className="mp-small">Your opponent left.</p>
              <button type="button" className="btn primary" onClick={() => matchActions.send('returnToLobby')} data-testid="reopen-room">
                WAIT FOR A NEW OPPONENT
              </button>
            </>
          ) : opponent.rematch === 'requested' ? (
            <>
              <button type="button" className="btn primary" onClick={() => matchActions.send('rematch', { action: 'accept' })} data-testid="rematch-accept">
                ACCEPT REMATCH
              </button>
              <button type="button" className="btn" onClick={() => matchActions.send('rematch', { action: 'decline' })} data-testid="rematch-decline">
                DECLINE
              </button>
            </>
          ) : me?.rematch === 'requested' ? (
            <p className="mp-small" data-testid="rematch-waiting">
              Rematch requested. Waiting for {opponent.name}…
            </p>
          ) : (
            <button type="button" className="btn primary" onClick={() => matchActions.send('rematch', { action: 'request' })} data-testid="rematch-request">
              {opponent.rematch === 'declined' ? 'ASK AGAIN' : 'REMATCH'}
            </button>
          )}
          {me?.rematch === 'declined' || opponent?.rematch === 'declined' ? (
            <p className="mp-small">{opponent?.rematch === 'declined' ? `${opponent.name} declined.` : 'You declined.'}</p>
          ) : null}
          <button type="button" className="btn ghost" onClick={() => void matchActions.leave()} data-testid="result-leave">
            LEAVE ROOM
          </button>
        </div>
      </section>
    </div>
  );
}
