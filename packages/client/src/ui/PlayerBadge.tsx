import { levelForXp } from '@brick-riot/shared';
import { useProgress } from '../progress/progressStore';

/** Player level, XP progress and coins, from persisted progress. */
export function PlayerBadge({ compact = false }: { compact?: boolean }) {
  const xp = useProgress((s) => s.progress.xp);
  const coins = useProgress((s) => s.progress.coins);
  const info = levelForXp(xp);
  const fraction = info.xpForNext > 0 ? info.xpIntoLevel / info.xpForNext : 1;
  return (
    <div className={compact ? 'player-badge compact' : 'player-badge'} data-testid="player-badge">
      <div className="badge-level" aria-label={`Player level ${info.level}`}>
        <span className="badge-label">LVL</span>
        <span className="badge-value" data-testid="player-level">
          {info.level}
        </span>
      </div>
      <div className="badge-xp">
        <div className="xp-bar" role="progressbar" aria-label="XP to next level" aria-valuemin={0} aria-valuemax={info.xpForNext} aria-valuenow={info.xpIntoLevel}>
          <div className="xp-fill" style={{ transform: `scaleX(${fraction})` }} />
        </div>
        <span className="badge-sub" data-testid="player-xp">
          {info.xpForNext > 0 ? `${info.xpIntoLevel} / ${info.xpForNext} XP` : 'MAX LEVEL'}
        </span>
      </div>
      <div className="badge-coins" aria-label={`${coins} coins`}>
        <span className="coin" aria-hidden="true" />
        <span className="badge-value" data-testid="player-coins">
          {coins.toLocaleString('en-US')}
        </span>
      </div>
    </div>
  );
}
