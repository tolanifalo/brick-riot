import { CAMPAIGN_BOARDS, isBoardUnlocked, type RunOutcome } from '@brick-riot/shared';
import type { ReactNode } from 'react';
import type { GameBridge } from '../game/bridge';
import { useProgress } from '../progress/progressStore';
import { useApp } from '../state/appStore';
import { formatTime, useHud } from '../state/hudStore';
import { Stars } from './Stars';

export type RunRecordState = { status: 'idle' } | { status: 'saving' } | { status: 'done'; outcome: RunOutcome };

interface Props {
  bridge: GameBridge;
  boardIndex: number;
  record: RunRecordState;
  onExit(): void;
}

function Panel({ title, tone, children }: { title: string; tone: 'neutral' | 'win' | 'loss'; children: ReactNode }) {
  return (
    <div className="overlay blocking" data-ui>
      <section className={`panel ${tone}`} role="dialog" aria-label={title}>
        <h2 className="panel-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function Stat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={highlight ? 'stat best' : 'stat'}>
      <dt>{label}</dt>
      <dd>
        {value}
        {highlight && <span className="best-tag">BEST</span>}
      </dd>
    </div>
  );
}

function Rewards({ outcome }: { outcome: RunOutcome }) {
  if (!outcome.verified) {
    return (
      <p className="reward-note" data-testid="run-unverified">
        This run could not be verified on this device, so it was not recorded.
      </p>
    );
  }
  if (outcome.rewards.length === 0) return null;
  return (
    <div className="rewards" data-testid="rewards">
      <ul className="reward-lines">
        {outcome.rewards.map((r, i) => (
          <li key={r.label} style={{ animationDelay: `${900 + i * 120}ms` }}>
            <span>{r.label}</span>
            <span>
              +{r.xp} XP{r.coins > 0 ? ` · +${r.coins}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="reward-total">
        <span data-testid="reward-xp">+{outcome.xp} XP</span>
        <span className="coin" aria-hidden="true" />
        <span data-testid="reward-coins">+{outcome.coins}</span>
      </p>
      {outcome.levelAfter > outcome.levelBefore && (
        <p className="callout level-up" data-testid="level-up">
          LEVEL UP · {outcome.levelAfter}
        </p>
      )}
      {outcome.unlocked.map((id) => {
        const i = CAMPAIGN_BOARDS.findIndex((b) => b.id === id);
        return (
          <p key={id} className="callout unlock" data-testid="unlock-notice">
            UNLOCKED · {i + 1}. {CAMPAIGN_BOARDS[i]?.name}
          </p>
        );
      })}
    </div>
  );
}

export function StatusOverlay({ bridge, boardIndex, record, onExit }: Props) {
  const phase = useHud((s) => s.phase);
  const paused = useHud((s) => s.paused);
  const score = useHud((s) => s.score);
  const elapsed = useHud((s) => s.elapsedMs);
  const bestCombo = useHud((s) => s.bestCombo);
  const clearBonus = useHud((s) => s.clearBonus);
  const remaining = useHud((s) => s.bricksRemaining);
  const total = useHud((s) => s.bricksTotal);
  const boardName = useHud((s) => s.boardName);
  const levelNumber = useHud((s) => s.levelNumber);
  const progress = useProgress((s) => s.progress);
  const startBoard = useApp((s) => s.startBoard);

  if (phase === 'loading') {
    return (
      <div className="overlay passive">
        <p className="hint">LOADING BOARD</p>
      </div>
    );
  }

  if (paused) {
    return (
      <Panel title="PAUSED" tone="neutral">
        <div className="panel-actions">
          <button type="button" className="btn primary" onClick={() => bridge.setPaused(false)} autoFocus>
            RESUME
          </button>
          <button type="button" className="btn" onClick={() => bridge.restart()}>
            RESTART
          </button>
          <button type="button" className="btn ghost" onClick={onExit}>
            LEVELS
          </button>
        </div>
      </Panel>
    );
  }

  if (phase === 'won' || phase === 'lost') {
    const won = phase === 'won';
    const outcome = record.status === 'done' ? record.outcome : null;
    const next = CAMPAIGN_BOARDS[boardIndex + 1];
    const nextOpen = won && !!next && isBoardUnlocked(next, progress);
    return (
      <Panel title={won ? 'BOARD CLEAR' : 'OUT OF BALLS'} tone={won ? 'win' : 'loss'}>
        {won && (
          <div className="result-stars">
            <Stars value={outcome?.stars ?? 0} animate size="lg" />
          </div>
        )}
        <dl className="stats" data-testid="result-stats">
          <Stat label="Score" value={score.toLocaleString('en-US')} highlight={!!outcome?.newBestScore} />
          <Stat label="Time" value={formatTime(elapsed)} highlight={!!outcome?.newBestTime} />
          <Stat label="Best combo" value={`×${bestCombo}`} />
          {won ? (
            <Stat label="Clear bonus" value={`+${clearBonus.toLocaleString('en-US')}`} />
          ) : (
            <Stat label="Bricks cleared" value={`${total - remaining} / ${total}`} />
          )}
        </dl>
        {record.status === 'saving' && <p className="reward-note">Saving…</p>}
        {outcome && <Rewards outcome={outcome} />}
        <div className="panel-actions">
          {nextOpen && next && (
            <button type="button" className="btn primary" onClick={() => startBoard(next.id)} autoFocus data-testid="next-level">
              NEXT: {next.name.toUpperCase()}
            </button>
          )}
          <button
            type="button"
            className={nextOpen ? 'btn' : 'btn primary'}
            onClick={() => bridge.restart()}
            autoFocus={!nextOpen}
          >
            {won ? 'PLAY AGAIN' : 'RETRY'}
          </button>
          <button type="button" className="btn ghost" onClick={onExit} data-testid="exit-to-levels">
            LEVELS
          </button>
        </div>
      </Panel>
    );
  }

  if (phase === 'ready') {
    const intro = elapsed === 0;
    return (
      <div className="overlay passive">
        <div className="launch-hint" data-testid="launch-hint">
          {intro && (
            <div className="level-intro" key={boardName}>
              <p className="intro-num">LEVEL {levelNumber}</p>
              <p className="board-name">{boardName}</p>
            </div>
          )}
          <p className="hint">
            <span className="hide-coarse">CLICK OR SPACE TO LAUNCH</span>
            <span className="show-coarse">TAP TO LAUNCH</span>
          </p>
        </div>
      </div>
    );
  }

  return null;
}
