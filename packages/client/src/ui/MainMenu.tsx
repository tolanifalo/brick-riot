import { useAccount } from '../account/accountStore';
import { useApp } from '../state/appStore';
import { PlayerBadge } from './PlayerBadge';

interface MenuEntry {
  label: string;
  /** Roadmap phase that delivers the feature. */
  arrivesIn: string;
}

const LOCKED: MenuEntry[] = [{ label: 'BOARDS', arrivesIn: 'Phase 7' }];

const STRIP = ['red', 'orange', 'yellow', 'lime', 'cyan', 'blue', 'violet', 'magenta'];

function AccountChip() {
  const status = useAccount((s) => s.status);
  const profile = useAccount((s) => s.profile);
  const setScreen = useApp((s) => s.setScreen);
  const openAccount = useApp((s) => s.openAccount);
  if (status === 'loading' || status === 'unavailable') return null;
  return status === 'signedIn' && profile ? (
    <button type="button" className="account-chip signed-in" onClick={() => setScreen('profile')} data-testid="menu-profile">
      <span className="account-chip-name">{profile.account.name}</span>
      <span className="account-chip-note">PROFILE</span>
    </button>
  ) : (
    <button type="button" className="account-chip" onClick={() => openAccount('signin')} data-testid="menu-signin">
      <span className="account-chip-name">GUEST</span>
      <span className="account-chip-note">SIGN IN</span>
    </button>
  );
}

export function MainMenu() {
  const setScreen = useApp((s) => s.setScreen);
  const accounts = useAccount((s) => s.status !== 'unavailable');
  return (
    <main className="menu">
      <div className="menu-top">
        <PlayerBadge compact />
        <AccountChip />
      </div>
      <div className="menu-strip" aria-hidden="true">
        {STRIP.map((c) => (
          <span key={c} className={`strip-brick c-${c}`} />
        ))}
      </div>
      <h1 className="logo">
        <span className="logo-line">BRICK</span>
        <span className="logo-line logo-riot">RIOT</span>
      </h1>
      <p className="tagline">Arcade brick-breaker. Break fast, break first.</p>

      <nav className="menu-list" aria-label="Main menu">
        <button type="button" className="menu-btn primary" onClick={() => setScreen('campaign')} autoFocus>
          <span>PLAY SOLO</span>
          <span className="menu-btn-note">12 classic levels, then endless</span>
        </button>
        <button type="button" className="menu-btn mp" onClick={() => setScreen('quickmatch')} disabled={!accounts} data-testid="menu-quickmatch">
          <span>QUICK MATCH</span>
          <span className="menu-btn-note">{accounts ? 'Casual 1v1 vs a real player · account' : 'Unavailable on this server'}</span>
        </button>
        <button type="button" className="menu-btn" onClick={() => setScreen('multiplayer')} data-testid="menu-multiplayer">
          <span>MULTIPLAYER</span>
          <span className="menu-btn-note">Private rooms with a code</span>
        </button>
        <button type="button" className="menu-btn" onClick={() => setScreen('workshop')} data-testid="menu-workshop">
          <span>WORKSHOP</span>
          <span className="menu-btn-note">Upgrades · loadout · settings</span>
        </button>
        <button type="button" className="menu-btn" onClick={() => setScreen('leaderboards')} disabled={!accounts} data-testid="menu-leaderboards">
          <span>LEADERBOARDS</span>
          <span className="menu-btn-note">{accounts ? 'Verified solo records · Quick Match wins' : 'Unavailable on this server'}</span>
        </button>
        {LOCKED.map((entry) => (
          <button key={entry.label} type="button" className="menu-btn" disabled aria-disabled="true">
            <span>{entry.label}</span>
            <span className="menu-btn-note">Unavailable · {entry.arrivesIn}</span>
          </button>
        ))}
      </nav>

      <footer className="menu-footer">
        <span>v0.5.0 · Phase 5 build</span>
        <span className="hide-coarse">Mouse or ← → to move · Space to launch/fire · P to pause</span>
        <span className="show-coarse">Drag to move · Tap to launch/fire</span>
      </footer>
    </main>
  );
}
