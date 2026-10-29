import {
  CAMPAIGN_BOARDS,
  currentBoardId,
  describeObjective,
  describeRequirement,
  ECONOMY,
  isBoardUnlocked,
  type BoardDefinition,
  type BoardProgress,
} from '@brick-riot/shared';
import { useRef, type RefObject } from 'react';
import { useProgress } from '../progress/progressStore';
import { useApp } from '../state/appStore';
import { formatTime } from '../state/hudStore';
import { PlayerBadge } from './PlayerBadge';
import { Stars } from './Stars';

function formatSeconds(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function LevelCard({
  board,
  index,
  record,
  unlocked,
  current,
  selected,
  onSelect,
}: {
  board: BoardDefinition;
  index: number;
  record: BoardProgress | undefined;
  unlocked: boolean;
  current: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const cleared = (record?.completions ?? 0) > 0;
  const classes = ['level-card', unlocked ? 'unlocked' : 'locked', cleared ? 'cleared' : '', current ? 'current' : '', selected ? 'selected' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li>
      <button
        type="button"
        className={classes}
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Level ${index + 1}, ${board.name}${unlocked ? '' : ', locked'}`}
        data-testid={`level-card-${board.id}`}
        data-locked={!unlocked}
      >
        <span className="card-top">
          <span className="card-num">{String(index + 1).padStart(2, '0')}</span>
          {current && <span className="tag">CURRENT</span>}
          {!unlocked && <span className="lock" aria-hidden="true" />}
        </span>
        <span className="card-name">{board.name}</span>
        {unlocked ? (
          <>
            <Stars value={record?.bestStars ?? 0} />
            <span className="card-stats">
              {cleared ? (
                <>
                  <span>{(record?.bestScore ?? 0).toLocaleString('en-US')}</span>
                  <span>{record?.bestTimeMs != null ? formatTime(record.bestTimeMs) : '-'}</span>
                </>
              ) : (
                <span>Not cleared</span>
              )}
            </span>
          </>
        ) : (
          <span className="card-req">{describeRequirement(board.unlock, CAMPAIGN_BOARDS)}</span>
        )}
      </button>
    </li>
  );
}

function BoardDetail({
  board,
  index,
  sectionRef,
}: {
  board: BoardDefinition;
  index: number;
  sectionRef: RefObject<HTMLElement | null>;
}) {
  const progress = useProgress((s) => s.progress);
  const startBoard = useApp((s) => s.startBoard);
  const record = progress.boards[board.id];
  const unlocked = isBoardUnlocked(board, progress);
  const cleared = (record?.completions ?? 0) > 0;
  const done = new Set(record?.mastery ?? []);
  return (
    <section
      ref={sectionRef}
      className="board-detail"
      aria-label={`${board.name} details`}
      data-testid="board-detail"
      data-ui
    >
      <div className="detail-head">
        <h2>
          <span className="detail-num">{index + 1}.</span> {board.name}
        </h2>
        <span className="difficulty" aria-label={`Difficulty ${board.difficulty.designerRating} of 10`}>
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className={i < Math.round(board.difficulty.designerRating) ? 'pip on' : 'pip'} />
          ))}
        </span>
      </div>
      {board.stars && (
        <p className="detail-targets">
          <Stars value={2} /> under {formatSeconds(board.stars.twoStarSeconds)} <Stars value={3} /> under{' '}
          {formatSeconds(board.stars.threeStarSeconds)}
        </p>
      )}
      {cleared && (
        <dl className="detail-records">
          <div>
            <dt>Best score</dt>
            <dd>{(record?.bestScore ?? 0).toLocaleString('en-US')}</dd>
          </div>
          <div>
            <dt>Best time</dt>
            <dd>{record?.bestTimeMs != null ? formatTime(record.bestTimeMs) : '-'}</dd>
          </div>
          <div>
            <dt>Clears</dt>
            <dd>{record?.completions ?? 0}</dd>
          </div>
        </dl>
      )}
      <h3 className="mastery-title">
        MASTERY <span>{done.size} / {board.mastery.length}</span>
      </h3>
      <ul className="mastery-list" data-testid="mastery-list">
        {board.mastery.map((m) => {
          const reward = ECONOMY.mastery[m.kind];
          return (
            <li key={m.id} className={done.has(m.id) ? 'done' : ''}>
              <span className="check" aria-hidden="true" />
              <span className="mastery-text">{describeObjective(m)}</span>
              <span className="mastery-reward">
                {done.has(m.id) ? 'Earned' : `+${reward.xp} XP · +${reward.coins}`}
              </span>
            </li>
          );
        })}
      </ul>
      {unlocked ? (
        <button type="button" className="btn primary play-btn" onClick={() => startBoard(board.id)} data-testid="play-board">
          {cleared ? 'REPLAY' : 'PLAY'}
        </button>
      ) : (
        <button type="button" className="btn play-btn" disabled data-testid="play-board">
          LOCKED · {describeRequirement(board.unlock, CAMPAIGN_BOARDS)}
        </button>
      )}
    </section>
  );
}

export function CampaignScreen() {
  const progress = useProgress((s) => s.progress);
  const setScreen = useApp((s) => s.setScreen);
  const selectedId = useApp((s) => s.selectedBoardId);
  const selectBoard = useApp((s) => s.selectBoard);
  const detailRef = useRef<HTMLElement>(null);
  const current = currentBoardId(CAMPAIGN_BOARDS, progress);
  const selected = CAMPAIGN_BOARDS.find((b) => b.id === (selectedId ?? current)) ?? CAMPAIGN_BOARDS[0];
  const selectedIndex = selected ? CAMPAIGN_BOARDS.indexOf(selected) : 0;

  const records = CAMPAIGN_BOARDS.map((b) => progress.boards[b.id]);
  const cleared = records.filter((r) => (r?.completions ?? 0) > 0).length;
  const stars = records.reduce((n, r) => n + (r?.bestStars ?? 0), 0);
  const mastery = records.reduce((n, r) => n + (r?.mastery.length ?? 0), 0);
  const nextLocked = CAMPAIGN_BOARDS.find((b) => !isBoardUnlocked(b, progress));
  const nextLockedIndex = nextLocked ? CAMPAIGN_BOARDS.indexOf(nextLocked) : -1;

  return (
    <main className="campaign">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="back-to-menu">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>CLASSIC</h1>
        <PlayerBadge compact />
      </header>

      <div className="campaign-summary">
        <span data-testid="campaign-cleared">
          {cleared}/{CAMPAIGN_BOARDS.length} cleared
        </span>
        <span>
          {stars}/{CAMPAIGN_BOARDS.length * 3} stars
        </span>
        <span>
          {mastery}/{CAMPAIGN_BOARDS.length * 5} mastery
        </span>
      </div>
      <p className="next-unlock" data-testid="next-unlock">
        {nextLocked
          ? `Next unlock: ${nextLockedIndex + 1}. ${nextLocked.name} · ${describeRequirement(nextLocked.unlock, CAMPAIGN_BOARDS)}`
          : 'Every board unlocked'}
      </p>

      <div className="campaign-body">
        <ol className="level-grid" aria-label="Campaign levels">
          {CAMPAIGN_BOARDS.map((board, i) => (
            <LevelCard
              key={board.id}
              board={board}
              index={i}
              record={progress.boards[board.id]}
              unlocked={isBoardUnlocked(board, progress)}
              current={board.id === current}
              selected={board.id === selected?.id}
              onSelect={() => {
                selectBoard(board.id);
                // On narrow layouts the detail panel sits below the grid: bring it into view.
                requestAnimationFrame(() => {
                  const el = detailRef.current;
                  if (!el) return;
                  const rect = el.getBoundingClientRect();
                  if (rect.top > window.innerHeight || rect.bottom < 0) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                });
              }}
            />
          ))}
        </ol>
        {selected && <BoardDetail board={selected} index={selectedIndex} sectionRef={detailRef} />}
      </div>
    </main>
  );
}
