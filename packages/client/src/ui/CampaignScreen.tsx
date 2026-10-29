import {
  CAMPAIGN_BOARDS,
  chapterInfo,
  chapterOf,
  currentBoardId,
  describeObjective,
  describeRequirement,
  ECONOMY,
  getLevelAt,
  highestLevel,
  isBoardUnlocked,
  LAST_LEVEL,
  levelNumber,
  levelTag,
  type BoardDefinition,
  type BoardProgress,
  type PlayerProgress,
} from '@brick-riot/shared';
import { useRef, useState, type RefObject } from 'react';
import { useProgress } from '../progress/progressStore';
import { useApp } from '../state/appStore';
import { formatTime } from '../state/hudStore';
import { PlayerBadge } from './PlayerBadge';
import { Stars } from './Stars';

function formatSeconds(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Hard and boss levels are flagged (endless levels only; the hand-made chapter has its own curve). */
function tagFor(n: number): 'HARD' | 'BOSS' | null {
  if (n <= CAMPAIGN_BOARDS.length) return null;
  const tag = levelTag(n);
  return tag === 'boss' ? 'BOSS' : tag === 'hard' ? 'HARD' : null;
}

function clearedIds(progress: PlayerProgress): string[] {
  return Object.values(progress.boards)
    .filter((b) => b.completions > 0)
    .map((b) => b.boardId);
}

/** The level to play next: the first uncleared hand-made level, then the one after the highest cleared. */
function currentLevel(progress: PlayerProgress): number {
  const inChapter1 = currentBoardId(CAMPAIGN_BOARDS, progress);
  const n1 = inChapter1 ? (levelNumber(inChapter1) ?? 1) : 1;
  if ((progress.boards[inChapter1 ?? '']?.completions ?? 0) === 0) return n1;
  return Math.min(LAST_LEVEL, Math.max(n1, highestLevel(clearedIds(progress)) + 1));
}

function LevelCard({
  board,
  n,
  record,
  unlocked,
  current,
  selected,
  onSelect,
}: {
  board: BoardDefinition;
  n: number;
  record: BoardProgress | undefined;
  unlocked: boolean;
  current: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  const cleared = (record?.completions ?? 0) > 0;
  const tag = tagFor(n);
  const classes = [
    'level-card',
    unlocked ? 'unlocked' : 'locked',
    cleared ? 'cleared' : '',
    current ? 'current' : '',
    selected ? 'selected' : '',
    tag ? `tag-${tag.toLowerCase()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li>
      <button
        type="button"
        className={classes}
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Level ${n}, ${board.name}${tag ? `, ${tag.toLowerCase()} level` : ''}${unlocked ? '' : ', locked'}`}
        data-testid={`level-card-${board.id}`}
        data-locked={!unlocked}
      >
        <span className="card-top">
          <span className="card-num">{String(n).padStart(2, '0')}</span>
          {current && <span className="tag">CURRENT</span>}
          {tag && !current && <span className={`tag level-tag ${tag.toLowerCase()}`}>{tag}</span>}
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

function BoardDetail({ board, n, sectionRef }: { board: BoardDefinition; n: number; sectionRef: RefObject<HTMLElement | null> }) {
  const progress = useProgress((s) => s.progress);
  const startBoard = useApp((s) => s.startBoard);
  const record = progress.boards[board.id];
  const unlocked = isBoardUnlocked(board, progress);
  const cleared = (record?.completions ?? 0) > 0;
  const done = new Set(record?.mastery ?? []);
  const tag = tagFor(n);
  return (
    <section ref={sectionRef} className="board-detail" aria-label={`${board.name} details`} data-testid="board-detail" data-ui>
      <div className="detail-head">
        <h2>
          <span className="detail-num">{n}.</span> {board.name}
          {tag && <span className={`tag level-tag ${tag.toLowerCase()}`}>{tag}</span>}
        </h2>
        <span className="difficulty" aria-label={`Difficulty ${board.difficulty.designerRating} of 10`}>
          {Array.from({ length: 10 }, (_, i) => (
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
      {(board.powerDownChance ?? 0) > 0 && (
        <p className="detail-hazard" data-testid="detail-powerdowns">
          Power-downs drop here: dodge the striped capsules (or catch them for +250).
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
        MASTERY <span>
          {done.size} / {board.mastery.length}
        </span>
      </h3>
      <ul className="mastery-list" data-testid="mastery-list">
        {board.mastery.map((m) => {
          const reward = ECONOMY.mastery[m.kind];
          return (
            <li key={m.id} className={done.has(m.id) ? 'done' : ''}>
              <span className="check" aria-hidden="true" />
              <span className="mastery-text">{describeObjective(m)}</span>
              <span className="mastery-reward">{done.has(m.id) ? 'Earned' : `+${reward.xp} XP · +${reward.coins}`}</span>
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

/**
 * Level select. Chapter 1 is the 12 hand-made levels; every later chapter is
 * 20 generated levels (endless). You can look one chapter past your progress.
 */
export function CampaignScreen() {
  const progress = useProgress((s) => s.progress);
  const setScreen = useApp((s) => s.setScreen);
  const selectedId = useApp((s) => s.selectedBoardId);
  const selectBoard = useApp((s) => s.selectBoard);
  const detailRef = useRef<HTMLElement>(null);

  const current = currentLevel(progress);
  const highest = highestLevel(clearedIds(progress));
  const selectedLevel = selectedId ? levelNumber(selectedId) : null;
  const maxChapter = chapterOf(Math.min(LAST_LEVEL, Math.max(current, CAMPAIGN_BOARDS.length + 1))).chapter;
  const [chapter, setChapter] = useState(() => chapterOf(selectedLevel ?? current).chapter);
  const info = chapterInfo(Math.min(chapter, maxChapter));
  const levels: { n: number; board: BoardDefinition }[] = [];
  for (let n = info.first; n <= info.last; n++) {
    const board = getLevelAt(n);
    if (board) levels.push({ n, board });
  }
  const inChapter = (n: number | null) => n !== null && n >= info.first && n <= info.last;
  const selectedN = inChapter(selectedLevel) ? (selectedLevel ?? info.first) : inChapter(current) ? current : info.first;
  const selected = getLevelAt(selectedN);

  const records = levels.map(({ board }) => progress.boards[board.id]);
  const cleared = records.filter((r) => (r?.completions ?? 0) > 0).length;
  const stars = records.reduce((n, r) => n + (r?.bestStars ?? 0), 0);
  const allStars = Object.values(progress.boards).reduce((n, r) => n + r.bestStars, 0);
  const next = getLevelAt(current);
  const nextLocked = next && !isBoardUnlocked(next, progress) ? next : getLevelAt(current + 1);

  return (
    <main className="campaign">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="back-to-menu">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>{info.chapter === 1 ? 'CLASSIC' : 'ENDLESS'}</h1>
        <PlayerBadge compact />
      </header>

      <nav className="chapter-nav" aria-label="Chapters" data-ui>
        <button
          type="button"
          className="btn ghost chapter-arrow"
          disabled={info.chapter <= 1}
          onClick={() => setChapter(info.chapter - 1)}
          aria-label="Previous chapter"
          data-testid="chapter-prev"
        >
          ◀
        </button>
        <span className="chapter-title" data-testid="chapter-title">
          CHAPTER {info.chapter} · LEVELS {info.first}-{info.last}
        </span>
        <button
          type="button"
          className="btn ghost chapter-arrow"
          disabled={info.chapter >= maxChapter}
          onClick={() => setChapter(info.chapter + 1)}
          aria-label="Next chapter"
          data-testid="chapter-next"
        >
          ▶
        </button>
      </nav>

      <div className="campaign-summary">
        <span data-testid="campaign-cleared">
          {cleared}/{levels.length} cleared
        </span>
        <span>
          {stars}/{levels.length * 3} stars
        </span>
        <span data-testid="campaign-highest">
          {highest > 0 ? `Highest level ${highest}` : 'No level cleared yet'} · {allStars} stars total
        </span>
      </div>
      <p className="next-unlock" data-testid="next-unlock">
        {nextLocked && !isBoardUnlocked(nextLocked, progress)
          ? `Next unlock: ${levelNumber(nextLocked.id)}. ${nextLocked.name} · ${describeRequirement(nextLocked.unlock, CAMPAIGN_BOARDS)}`
          : 'Levels go on forever: each clear unlocks the next.'}
      </p>
      {info.chapter > 1 && info.first > current && (
        <p className="next-unlock">Endless levels unlock one at a time, starting after level {CAMPAIGN_BOARDS.length}.</p>
      )}

      <div className="campaign-body">
        <ol className="level-grid" aria-label={`Chapter ${info.chapter} levels`}>
          {levels.map(({ n, board }) => (
            <LevelCard
              key={board.id}
              board={board}
              n={n}
              record={progress.boards[board.id]}
              unlocked={isBoardUnlocked(board, progress)}
              current={n === current}
              selected={n === selectedN}
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
        {selected && <BoardDetail board={selected} n={selectedN} sectionRef={detailRef} />}
      </div>
    </main>
  );
}
