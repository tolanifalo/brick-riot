import { getLevelAt, LAST_LEVEL, type LeaderboardCategoryId, type LeaderboardPage, type RankedStatus } from '@brick-riot/shared';
import { useEffect, useState } from 'react';
import { api, describeApiError } from '../net/api';
import { useApp } from '../state/appStore';

type Tab = LeaderboardCategoryId | 'ranked';

const TABS: { id: Tab; label: string }[] = [
  { id: 'solo_time', label: 'FASTEST' },
  { id: 'solo_score', label: 'HIGH SCORE' },
  { id: 'highest_level', label: 'TOP LEVEL' },
  { id: 'total_stars', label: 'STARS' },
  { id: 'mastery', label: 'MASTERY' },
  { id: 'casual_wins', label: 'QUICK WINS' },
  { id: 'ranked', label: 'RANKED' },
];

const NOTES: Record<LeaderboardCategoryId, string> = {
  solo_time: 'Only runs replayed and verified by the server count. Verified-email accounts only.',
  solo_score: 'Only runs replayed and verified by the server count. Verified-email accounts only.',
  highest_level: 'The furthest level cleared in a server-verified run. Levels never end.',
  total_stars: 'Best stars summed over every level, from server-verified runs.',
  mastery: 'Mastery objectives completed in verified runs.',
  casual_wins: 'Quick Match wins (casual, unranked).',
};

function formatValue(category: LeaderboardCategoryId, value: number): string {
  if (category === 'solo_time') return `${(value / 120).toFixed(2)}s`;
  if (category === 'highest_level') return `Level ${value.toLocaleString('en-US')}`;
  if (category === 'total_stars') return `${value.toLocaleString('en-US')} stars`;
  return value.toLocaleString('en-US');
}

/**
 * Persistent leaderboards. Solo entries come only from runs the server
 * replayed itself (server-issued seed, verified input log); local saves never
 * appear here. Players need a verified email to be listed.
 */
export function LeaderboardScreen() {
  const setScreen = useApp((s) => s.setScreen);
  const [tab, setTab] = useState<Tab>('solo_time');
  const [level, setLevel] = useState(1);
  const levelBoard = getLevelAt(level);
  const board = levelBoard?.id ?? 'classic-01';
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaderboardPage | null>(null);
  const [ranked, setRanked] = useState<RankedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const perBoard = tab === 'solo_time' || tab === 'solo_score';

  useEffect(() => {
    let cancelled = false;
    if (tab === 'ranked') {
      api<RankedStatus>('GET', '/api/ranked/status').then(
        (r) => {
          if (cancelled) return;
          setRanked(r);
          setError(null);
        },
        (e: unknown) => !cancelled && setError(describeApiError(e)),
      );
      return () => {
        cancelled = true;
      };
    }
    const q = `page=${page}&pageSize=20${perBoard ? `&board=${encodeURIComponent(board)}` : ''}`;
    api<LeaderboardPage>('GET', `/api/leaderboards/${tab}?${q}`).then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      },
      (e: unknown) => !cancelled && setError(describeApiError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [tab, board, page, perBoard]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <main className="leaderboards" data-testid="leaderboards">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="lb-back">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>LEADERBOARDS</h1>
      </header>
      <div className="seg lb-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`seg-btn${tab === t.id ? ' on' : ''}`}
            onClick={() => {
              setTab(t.id);
              setPage(1);
              setData(null);
            }}
            data-testid={`lb-tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {perBoard && (
        <div className="lb-level" data-testid="lb-level">
          <button
            type="button"
            className="btn ghost chapter-arrow"
            disabled={level <= 1}
            onClick={() => {
              setLevel((l) => Math.max(1, l - 1));
              setPage(1);
            }}
            aria-label="Previous level"
          >
            ◀
          </button>
          <label className="field">
            <span>Level</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={LAST_LEVEL}
              value={level}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n)) setLevel(Math.min(LAST_LEVEL, Math.max(1, n)));
                setPage(1);
              }}
              data-testid="lb-level-input"
            />
          </label>
          <span className="lb-level-name" data-testid="lb-level-name">
            {levelBoard?.name}
          </span>
          <button
            type="button"
            className="btn ghost chapter-arrow"
            disabled={level >= LAST_LEVEL}
            onClick={() => {
              setLevel((l) => Math.min(LAST_LEVEL, l + 1));
              setPage(1);
            }}
            aria-label="Next level"
          >
            ▶
          </button>
        </div>
      )}
      {error && <p className="mp-error">{error}</p>}

      {tab === 'ranked' ? (
        <section className="compat" data-testid="lb-ranked">
          <h3>RANKED: COMING LATER</h3>
          <p className="mp-small">
            Ranked play and divisions (Bronze to Riot Master) are built but switched off. No ranked ratings exist yet,
            so none are shown. Ranked launches only when:
          </p>
          <ul className="mp-small">{ranked?.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </section>
      ) : (
        <>
          <p className="mp-small">{NOTES[tab]}</p>
          {data && data.rows.length === 0 && <p className="mp-small">No entries yet. Be the first.</p>}
          <ol className="lb-list" data-testid="lb-rows">
            {data?.rows.map((r) => (
              <li key={r.playerId} className={`lb-row${data.me?.playerId === r.playerId ? ' me' : ''}`}>
                <span className="lb-rank">{r.rank}</span>
                <span className="lb-name">{r.name}</span>
                <span className="lb-value">{formatValue(data.category, r.value)}</span>
              </li>
            ))}
          </ol>
          {data?.me && !data.rows.some((r) => r.playerId === data.me?.playerId) && (
            <p className="lb-row me" data-testid="lb-me">
              <span className="lb-rank">{data.me.rank}</span>
              <span className="lb-name">{data.me.name} (you)</span>
              <span className="lb-value">{formatValue(data.category, data.me.value)}</span>
            </p>
          )}
          {data && pages > 1 && (
            <div className="panel-actions">
              <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                PREV
              </button>
              <span className="mp-small">
                Page {page} / {pages}
              </span>
              <button type="button" className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                NEXT
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
