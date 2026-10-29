import { useState, type FormEvent } from 'react';
import { useAccount } from '../../account/accountStore';
import { describeApiError } from '../../net/api';
import { useApp } from '../../state/appStore';

export type AccountMode = 'signin' | 'register' | 'forgot' | 'reset';

/**
 * Sign in, register, forgotten password, and choosing a new password from an
 * emailed reset link. Every action calls the server; messages never reveal
 * whether an email address has an account.
 */
export function AccountScreen() {
  const setScreen = useApp((s) => s.setScreen);
  const initialMode = useApp((s) => s.accountMode);
  const resetToken = useApp((s) => s.resetToken);
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const account = useAccount();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'signin') {
      void run(async () => {
        await account.signIn(email.trim(), password);
        setScreen('profile');
      });
    } else if (mode === 'register') {
      void run(async () => {
        await account.signUp(name.trim() || 'Player', email.trim(), password);
        setScreen('profile');
      });
    } else if (mode === 'forgot') {
      void run(async () => {
        await account.requestPasswordReset(email.trim());
        setInfo('If an account exists for that address, a reset link is on its way. It expires in 1 hour.');
      });
    } else {
      void run(async () => {
        if (!resetToken) throw new Error('missing token');
        await account.resetPassword(resetToken, password);
        setPassword('');
        setMode('signin');
        setInfo('Password changed. Every device was signed out; sign in with your new password.');
      });
    }
  };

  const title = { signin: 'SIGN IN', register: 'CREATE ACCOUNT', forgot: 'RESET PASSWORD', reset: 'NEW PASSWORD' }[mode];

  return (
    <main className="account" data-testid="account-screen">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="account-back">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>{title}</h1>
      </header>

      {mode !== 'reset' && mode !== 'forgot' && (
        <div className="seg account-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'signin'} className={`seg-btn${mode === 'signin' ? ' on' : ''}`} onClick={() => setMode('signin')} data-testid="tab-signin">
            SIGN IN
          </button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={`seg-btn${mode === 'register' ? ' on' : ''}`} onClick={() => setMode('register')} data-testid="tab-register">
            REGISTER
          </button>
        </div>
      )}

      <form className="account-form" onSubmit={submit}>
        {mode === 'register' && (
          <label className="field">
            <span>Display name (public)</span>
            <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} autoComplete="nickname" data-testid="account-name" required />
          </label>
        )}
        {mode !== 'reset' && (
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-testid="account-email" required />
          </label>
        )}
        {mode !== 'forgot' && (
          <label className="field">
            <span>{mode === 'reset' ? 'New password' : 'Password'}</span>
            <input
              type="password"
              value={password}
              minLength={mode === 'signin' ? 1 : 10}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              data-testid="account-password"
              required
            />
            {mode !== 'signin' && <small className="mp-small">At least 10 characters.</small>}
          </label>
        )}
        {error && (
          <p className="mp-error" role="alert" data-testid="account-error">
            {error}
          </p>
        )}
        {info && (
          <p className="ws-ok" role="status" data-testid="account-info">
            {info}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={busy} data-testid="account-submit">
          {busy ? 'PLEASE WAIT…' : title}
        </button>
      </form>

      <div className="account-links">
        {mode === 'signin' && (
          <button type="button" className="link-btn" onClick={() => setMode('forgot')} data-testid="forgot-link">
            Forgot your password?
          </button>
        )}
        {(mode === 'forgot' || mode === 'reset') && (
          <button type="button" className="link-btn" onClick={() => setMode('signin')}>
            Back to sign in
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => setScreen('menu')}>
          Keep playing as a guest (solo only)
        </button>
      </div>
      <p className="mp-small account-note">
        Guests can play the solo campaign; progress stays in this browser. An account keeps verified progress on the
        server, unlocks Quick Match and leaderboards, and works on any device. Ranked play is not available yet.
      </p>
    </main>
  );
}
