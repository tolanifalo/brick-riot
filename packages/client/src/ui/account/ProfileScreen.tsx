import {
  ABILITY_DEFINITIONS,
  getLevel,
  getMatchBoard,
  UPGRADE_IDS,
  UPGRADES,
  type ImportSummary,
  type MatchHistoryEntry,
  type Page,
  type ProfileView,
} from '@brick-riot/shared';
import { useEffect, useState } from 'react';
import { useAccount, type SessionInfo } from '../../account/accountStore';
import { api, describeApiError } from '../../net/api';
import { SAVE_KEYS } from '../../progress/repository';
import { useApp } from '../../state/appStore';

type Tab = 'overview' | 'equipment' | 'history' | 'account';

/** Solo levels (hand-made or endless) first, then multiplayer variants. */
const boardName = (id: string) => getLevel(id)?.name ?? getMatchBoard(id)?.name ?? id;
const seconds = (ticks: number | null) => (ticks === null ? '—' : `${(ticks / 120).toFixed(1)}s`);

export function ProfileScreen() {
  const setScreen = useApp((s) => s.setScreen);
  const status = useAccount((s) => s.status);
  const profile = useAccount((s) => s.profile);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    if (status === 'guest') useApp.getState().openAccount('signin');
  }, [status]);
  if (!profile) return null;

  return (
    <main className="profile" data-testid="profile-screen">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="profile-back">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>PROFILE</h1>
        <span className="coins" data-testid="profile-coins">
          {profile.progress.coins.toLocaleString('en-US')} C
        </span>
      </header>
      <div className="seg profile-tabs" role="tablist">
        {(['overview', 'equipment', 'history', 'account'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`seg-btn${tab === t ? ' on' : ''}`} onClick={() => setTab(t)} data-testid={`profile-tab-${t}`}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview profile={profile} />}
      {tab === 'equipment' && <Equipment profile={profile} />}
      {tab === 'history' && <History />}
      {tab === 'account' && <AccountSettings profile={profile} />}
    </main>
  );
}

function Overview({ profile }: { profile: ProfileView }) {
  const resend = useAccount((s) => s.resendVerification);
  const [sent, setSent] = useState(false);
  const p = profile.progress;
  const cleared = profile.boards.filter((b) => b.completions > 0).length;
  return (
    <section className="profile-section">
      <div className="profile-hero">
        <span className="profile-name" data-testid="profile-name">
          {profile.account.name}
        </span>
        <span className="profile-level" data-testid="profile-level">
          LEVEL {p.level}
        </span>
        <div className="progress" aria-label={`XP ${p.xpIntoLevel} of ${p.xpForNext}`}>
          <div className="progress-fill" style={{ transform: `scaleX(${p.xpForNext ? p.xpIntoLevel / p.xpForNext : 1})` }} />
        </div>
        <span className="mp-small">
          {p.xp.toLocaleString('en-US')} XP · {p.coins.toLocaleString('en-US')} coins · server-verified
        </span>
      </div>
      {!profile.account.emailVerified && (
        <p className="compat bad" data-testid="verify-banner">
          Your email is not verified yet. Verified accounts appear on leaderboards.{' '}
          <button type="button" className="link-btn" disabled={sent} onClick={() => void resend().then(() => setSent(true))}>
            {sent ? 'Email sent' : 'Send the link again'}
          </button>
        </p>
      )}
      <div className="stat-grid">
        <Stat label="BOARDS CLEARED" value={`${cleared}/12`} />
        <Stat label="MASTERY" value={String(profile.boards.reduce((n, b) => n + b.mastery.length, 0))} />
        <Stat label="QUICK MATCH WINS" value={`${profile.stats.casualWins}/${profile.stats.casualMatches}`} />
        <Stat label="PRIVATE MATCHES" value={String(profile.stats.privateMatches)} />
      </div>
      <h2 className="mp-subtitle">SOLO RECORDS (VERIFIED)</h2>
      {profile.boards.length === 0 ? (
        <p className="mp-small">No verified runs yet. Every run you finish while signed in is replayed by the server.</p>
      ) : (
        <table className="result-table records" data-testid="records-table">
          <thead>
            <tr>
              <th>Board</th>
              <th>Clears</th>
              <th>Best time</th>
              <th>Best score</th>
              <th>Stars</th>
            </tr>
          </thead>
          <tbody>
            {profile.boards.map((b) => (
              <tr key={b.boardId}>
                <td>{boardName(b.boardId)}</td>
                <td>{b.completions}</td>
                <td>{b.bestTimeMs === null ? '—' : `${(b.bestTimeMs / 1000).toFixed(1)}s`}</td>
                <td>{b.bestScore?.toLocaleString('en-US') ?? '—'}</td>
                <td>{b.bestStars}/3</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {profile.importedRecords.length > 0 && (
        <>
          <h2 className="mp-subtitle">IMPORTED FROM THIS BROWSER (UNVERIFIED)</h2>
          <p className="mp-small">Kept for your reference. They unlock boards for casual play but never count for leaderboards.</p>
          <ul className="imported-list" data-testid="imported-records">
            {profile.importedRecords.map((r) => (
              <li key={r.boardId}>
                {boardName(r.boardId)} · {r.completions} clear{r.completions === 1 ? '' : 's'} · best {r.bestScore?.toLocaleString('en-US') ?? '—'}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Equipment({ profile }: { profile: ProfileView }) {
  const e = profile.equipment;
  const setScreen = useApp((s) => s.setScreen);
  return (
    <section className="profile-section" data-testid="equipment-inventory">
      <p className="mp-small">
        Ownership and levels are recorded on the server. Abilities unlock with your level; upgrades are bought in the
        Workshop with earned coins. Nothing is sold for money.
      </p>
      <div className="stat-grid">
        <Stat label="LOADOUT POWER" value={`${e.loadoutPower}/80`} />
        <Stat label="EQUIPMENT POWER (UPGRADE ROOMS)" value={String(e.equipmentPower)} />
      </div>
      <h2 className="mp-subtitle">ABILITIES</h2>
      <ul className="inventory">
        {(Object.keys(ABILITY_DEFINITIONS) as (keyof typeof ABILITY_DEFINITIONS)[]).map((id) => {
          const def = ABILITY_DEFINITIONS[id];
          const owned = e.ownedAbilities.includes(id);
          const equipped = [e.loadout.offensive, e.loadout.defensive, e.loadout.passive].includes(id as never);
          return (
            <li key={id} className={`inventory-item${owned ? '' : ' locked'}`} data-testid={`inventory-${id}`}>
              <span className="loadout-name">{def.label}</span>
              <span className="loadout-meta">
                {def.slot.toUpperCase()} · PWR {def.power} · {owned ? (equipped ? 'EQUIPPED' : 'OWNED') : `UNLOCKS AT LEVEL ${def.unlockLevel}`}
              </span>
            </li>
          );
        })}
      </ul>
      <h2 className="mp-subtitle">UPGRADES</h2>
      <ul className="inventory">
        {UPGRADE_IDS.map((id) => (
          <li key={id} className="inventory-item">
            <span className="loadout-name">{UPGRADES[id].label}</span>
            <span className="loadout-meta">
              LEVEL {e.upgrades[id]} / {UPGRADES[id].costs.length}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => setScreen('workshop')}>
        OPEN WORKSHOP
      </button>
    </section>
  );
}

function History() {
  const [items, setItems] = useState<MatchHistoryEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (cursor: string | null) =>
    api<Page<MatchHistoryEntry>>('GET', `/api/me/matches?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).then(
      (page) => {
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNext(page.next);
        setLoaded(true);
      },
      (err: unknown) => {
        setError(describeApiError(err));
        setLoaded(true);
      },
    );

  useEffect(() => {
    let cancelled = false;
    api<Page<MatchHistoryEntry>>('GET', '/api/me/matches?limit=10').then(
      (page) => {
        if (cancelled) return;
        setItems(page.items);
        setNext(page.next);
        setLoaded(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(describeApiError(err));
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="profile-section" data-testid="match-history">
      {error && <p className="mp-error">{error}</p>}
      {loaded && items.length === 0 && !error && <p className="mp-small">No matches yet. Play Quick Match or a private room while signed in.</p>}
      <ul className="history">
        {items.map((m) => (
          <li key={m.matchId} className={`history-item ${m.result}`} data-testid="history-item">
            <span className="history-result">{m.result.toUpperCase()}</span>
            <span className="history-main">
              vs {m.opponentName} · {m.mode === 'quick' ? 'Quick Match' : 'Private room'}
            </span>
            <span className="mp-small">
              {boardName(m.myBoardId)} ({seconds(m.myCompletionTick)}) vs {boardName(m.opponentBoardId)} ({seconds(m.opponentCompletionTick)}) ·{' '}
              {m.reason.replace(/_/g, ' ')} · {new Date(m.endedAt).toLocaleString()}
              {m.replayVerified ? ' · verified' : ''}
            </span>
          </li>
        ))}
      </ul>
      {next && (
        <button type="button" className="btn" onClick={() => void load(next)} data-testid="history-more">
          LOAD MORE
        </button>
      )}
    </section>
  );
}

function AccountSettings({ profile }: { profile: ProfileView }) {
  const account = useAccount();
  const setScreen = useApp((s) => s.setScreen);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [password, setPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void account.sessions().then(setSessions, () => setSessions([]));
  }, [account]);

  const act = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn();
      setMessage({ ok: true, text: ok });
    } catch (err) {
      setMessage({ ok: false, text: describeApiError(err) });
    }
  };

  return (
    <section className="profile-section" data-testid="account-settings">
      <p className="mp-small">
        Signed in as <strong>{profile.account.email}</strong> · member since {new Date(profile.account.createdAt).toLocaleDateString()}
      </p>
      {message && <p className={message.ok ? 'ws-ok' : 'mp-error'}>{message.text}</p>}
      <ImportPanel profile={profile} />

      <h2 className="mp-subtitle">SESSIONS</h2>
      <ul className="history">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="history-item">
            <span className="history-main">{s.current ? 'This device' : 'Other device'}</span>
            <span className="mp-small">
              {s.userAgent?.slice(0, 60) ?? 'Unknown browser'} · signed in {new Date(s.createdAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      <div className="panel-actions">
        <button type="button" className="btn" onClick={() => void act(account.revokeOtherSessions, 'Other devices were signed out.').then(() => account.sessions().then(setSessions))} data-testid="revoke-others">
          SIGN OUT OTHER DEVICES
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void account.signOut().then(() => {
              setScreen('menu');
            })
          }
          data-testid="sign-out"
        >
          SIGN OUT
        </button>
      </div>

      <h2 className="mp-subtitle danger">DELETE ACCOUNT</h2>
      <p className="mp-small">Deletes your account and all server progress permanently. Match results stay, without your name or account.</p>
      {!confirmDelete ? (
        <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)} data-testid="delete-start">
          DELETE ACCOUNT…
        </button>
      ) : (
        <form
          className="account-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await account.deleteAccount(password);
              setScreen('menu');
            }, 'Account deleted.');
          }}
        >
          <label className="field">
            <span>Confirm with your password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid="delete-password" required />
          </label>
          <div className="panel-actions">
            <button type="submit" className="btn primary danger-btn" data-testid="delete-confirm">
              DELETE FOREVER
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
              CANCEL
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** One-time import of this browser's guest progress (unverified data is clearly separated). */
export function ImportPanel({ profile }: { profile: ProfileView }) {
  const importLocalSave = useAccount((s) => s.importLocalSave);
  const [summary, setSummary] = useState<ImportSummary | null>(profile.localImport?.summary ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVE_KEYS.main);
  } catch {
    raw = null;
  }
  if (profile.localImport && summary) {
    return (
      <div className="compat ok" data-testid="import-done">
        <h3>LOCAL PROGRESS IMPORTED</h3>
        <ImportResult summary={summary} />
      </div>
    );
  }
  if (!raw) return null;
  return (
    <div className="compat" data-testid="import-panel">
      <h3>IMPORT THIS BROWSER&apos;S PROGRESS?</h3>
      <p className="mp-small">
        Guest progress lives only in this browser and can be edited, so it is <strong>unverified</strong>. Importing
        brings over your board unlocks, personal records (marked unverified) and settings. XP, coins, upgrades and
        mastery rewards are <strong>not</strong> imported: earn them again with verified runs. Your local save is kept
        unchanged as a backup. You can import only once.
      </p>
      {error && <p className="mp-error">{error}</p>}
      {summary ? (
        <ImportResult summary={summary} />
      ) : (
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          data-testid="import-confirm"
          onClick={() => {
            setBusy(true);
            setError(null);
            importLocalSave(raw ?? '').then(setSummary, (err: unknown) => setError(describeApiError(err))).finally(() => setBusy(false));
          }}
        >
          IMPORT UNLOCKS AND RECORDS
        </button>
      )}
    </div>
  );
}

function ImportResult({ summary }: { summary: ImportSummary }) {
  return (
    <p className="mp-small" data-testid="import-result">
      Unlocked {summary.boardsUnlocked.length} board{summary.boardsUnlocked.length === 1 ? '' : 's'}, kept {summary.recordsImported} record
      {summary.recordsImported === 1 ? '' : 's'} as unverified. Not imported: {summary.notImported.xp.toLocaleString('en-US')} XP,{' '}
      {summary.notImported.coins.toLocaleString('en-US')} coins, {summary.notImported.upgradeLevels} upgrade levels,{' '}
      {summary.notImported.masteryObjectives} mastery objectives.
    </p>
  );
}
