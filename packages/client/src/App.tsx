import { useEffect } from 'react';
import { useAccount } from './account/accountStore';
import { useProgress } from './progress/progressStore';
import { useApp } from './state/appStore';
import { AccountScreen } from './ui/account/AccountScreen';
import { ProfileScreen } from './ui/account/ProfileScreen';
import { LeaderboardScreen } from './ui/LeaderboardScreen';
import { QuickMatchScreen } from './ui/QuickMatchScreen';
import { CampaignScreen } from './ui/CampaignScreen';
import { LoadingScreen } from './ui/LoadingScreen';
import { MainMenu } from './ui/MainMenu';
import { MultiplayerScreen } from './ui/mp/MultiplayerScreen';
import { SoloScreen } from './ui/SoloScreen';
import { WorkshopScreen } from './ui/WorkshopScreen';

function Notice() {
  const notice = useProgress((s) => s.notice);
  const saveError = useProgress((s) => s.saveError);
  const dismiss = useProgress((s) => s.dismissNotice);
  const text = saveError ?? notice;
  if (!text) return null;
  return (
    <div className="notice" role="status" data-ui>
      <span>{text}</span>
      {notice && !saveError && (
        <button type="button" className="notice-close" onClick={dismiss} aria-label="Dismiss">
          OK
        </button>
      )}
    </div>
  );
}

/**
 * Email links return here: `?reset=1&token=…` opens the new-password form;
 * `?verified=1` (or `?error=…`) reports the verification. The query is then
 * removed from the address bar so the token is not kept in history.
 */
function handleEmailLink(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (![...params.keys()].length) return false;
  const clean = () => window.history.replaceState(null, '', window.location.pathname);
  if (params.get('reset') === '1') {
    const token = params.get('token');
    clean();
    if (token) {
      useApp.getState().openAccount('reset', token);
      return true;
    }
    useProgress.setState({ notice: 'That password reset link is invalid or has expired. Ask for a new one.' });
    useApp.getState().openAccount('forgot');
    return true;
  }
  if (params.get('verified') === '1') {
    clean();
    const error = params.get('error');
    useProgress.setState({ notice: error ? 'That verification link is invalid or has expired.' : 'Email verified. Thanks!' });
    void useAccount.getState().refresh();
    useApp.getState().setScreen(useAccount.getState().status === 'signedIn' ? 'profile' : 'menu');
    return true;
  }
  return false;
}

export function App() {
  const screen = useApp((s) => s.screen);
  const setScreen = useApp((s) => s.setScreen);

  useEffect(() => {
    // Phaser draws text to canvas, so the display font must load first.
    let cancelled = false;
    const fallback = new Promise((resolve) => setTimeout(resolve, 2500));
    const fonts = Promise.race([document.fonts.load('24px Bungee'), fallback]);
    // The account check never blocks play for long: guests start at once if the server is away.
    const account = Promise.race([useAccount.getState().refresh(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    void Promise.all([fonts, useProgress.getState().init(), account]).then(() => {
      if (cancelled) return;
      if (!handleEmailLink()) setScreen('menu');
    });
    return () => {
      cancelled = true;
    };
  }, [setScreen]);

  let content;
  switch (screen) {
    case 'loading':
      content = <LoadingScreen />;
      break;
    case 'menu':
      content = <MainMenu />;
      break;
    case 'campaign':
      content = <CampaignScreen />;
      break;
    case 'solo':
      content = <SoloScreen />;
      break;
    case 'multiplayer':
      content = <MultiplayerScreen />;
      break;
    case 'workshop':
      content = <WorkshopScreen />;
      break;
    case 'account':
      content = <AccountScreen />;
      break;
    case 'profile':
      content = <ProfileScreen />;
      break;
    case 'quickmatch':
      content = <QuickMatchScreen />;
      break;
    case 'leaderboards':
      content = <LeaderboardScreen />;
      break;
  }
  return (
    <>
      <div className="screen-enter" key={screen}>
        {content}
      </div>
      {screen !== 'loading' && <Notice />}
    </>
  );
}
