import { BALANCE, POWER_UP_INFO } from '@brick-riot/shared';
import type { GameBridge } from '../game/bridge';
import { formatTime, parseEffects, useHud } from '../state/hudStore';

function Score() {
  const score = useHud((s) => s.score);
  return (
    <span className="hud-value" data-testid="hud-score">
      {score.toLocaleString('en-US')}
    </span>
  );
}

function Time() {
  const elapsed = useHud((s) => s.elapsedMs);
  return (
    <span className="hud-value mono" data-testid="hud-time">
      {formatTime(elapsed)}
    </span>
  );
}

function Lives() {
  const lives = useHud((s) => s.lives);
  return (
    <span className="lives" data-testid="hud-lives" aria-label={`${lives} balls left`}>
      {Array.from({ length: BALANCE.lives }, (_, i) => (
        <span key={i} className={i < lives ? 'life on' : 'life'} />
      ))}
    </span>
  );
}

function Progress() {
  const remaining = useHud((s) => s.bricksRemaining);
  const total = useHud((s) => s.bricksTotal);
  const cleared = total > 0 ? (total - remaining) / total : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label="Bricks cleared"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={total - remaining}
    >
      <div className="progress-fill" style={{ transform: `scaleX(${cleared})` }} />
    </div>
  );
}

function PauseButton({ bridge }: { bridge: GameBridge }) {
  const phase = useHud((s) => s.phase);
  const paused = useHud((s) => s.paused);
  const enabled = phase === 'ready' || phase === 'playing';
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => bridge.togglePause()}
      disabled={!enabled}
      aria-label={paused ? 'Resume' : 'Pause'}
      data-testid="pause-button"
    >
      <span className={paused ? 'icon-play' : 'icon-pause'} aria-hidden="true" />
    </button>
  );
}

export function Hud({ bridge }: { bridge: GameBridge }) {
  return (
    <header className="hud" data-ui>
      <div className="hud-row">
        <div className="hud-block">
          <span className="hud-label">SCORE</span>
          <Score />
        </div>
        <div className="hud-block center">
          <span className="hud-label">TIME</span>
          <Time />
        </div>
        <div className="hud-block right">
          <span className="hud-label">BALLS</span>
          <Lives />
        </div>
        <PauseButton bridge={bridge} />
      </div>
      <Progress />
    </header>
  );
}

/** Active timed power-ups with a draining bar. Hidden when nothing is active. */
export function EffectChips() {
  const encoded = useHud((s) => s.effects);
  const effects = parseEffects(encoded);
  if (effects.length === 0) return null;
  return (
    <ul className="effect-chips" aria-label="Active power-ups" data-testid="effect-chips">
      {effects.map(({ kind, fraction }) => {
        const info = POWER_UP_INFO[kind];
        return (
          <li key={kind} className={`effect-chip c-${info.color}${info.negative ? ' negative' : ''}`} title={info.activation}>
            <span className="chip-glyph">{info.glyph}</span>
            <span className="chip-label">{info.label}</span>
            <span className="chip-bar" style={{ transform: `scaleX(${fraction})` }} />
          </li>
        );
      })}
    </ul>
  );
}

export function ComboBadge() {
  const combo = useHud((s) => s.combo);
  const phase = useHud((s) => s.phase);
  if (combo < 3 || phase !== 'playing') return null;
  return (
    <div className={combo >= 8 ? 'combo hot' : 'combo'} key={combo} aria-live="polite">
      COMBO ×{combo}
    </div>
  );
}
