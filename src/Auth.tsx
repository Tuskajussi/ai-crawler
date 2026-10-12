import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, Code2, Eye, EyeOff, GitMerge, KeyRound, LoaderCircle, LockKeyhole, LogOut, Repeat2, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { AuthSession, PublicUser } from '../shared/types';
import { ApiError, request, setCsrfToken } from './api';
import './auth.css';

type AuthContextValue = {
  user: PublicUser;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an authenticated AuthProvider.');
  return value;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/** No workspace data is mounted or requested before the server confirms a session. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [notice, setNotice] = useState('');
  const [retrying, setRetrying] = useState(false);
  const sequence = useRef(0);
  const currentSession = useRef<AuthSession | null>(null);

  const acceptSession = useCallback((next: AuthSession) => {
    ++sequence.current;
    currentSession.current = next;
    setCsrfToken(next.user ? next.csrfToken : undefined);
    setSession(next);
    setSessionError('');
    setNotice('');
    setReady(true);
  }, []);

  const expireSession = useCallback(() => {
    ++sequence.current;
    const next: AuthSession = { user: null, registrationEnabled: currentSession.current?.registrationEnabled ?? false };
    currentSession.current = next;
    setCsrfToken();
    setSession(next);
    setSessionError('');
    setNotice('Your session has ended. Sign in to continue.');
    setReady(true);
  }, []);

  const refreshSession = useCallback(async () => {
    const attempt = ++sequence.current;
    try {
      const next = await request('/auth/session') as AuthSession;
      if (attempt !== sequence.current) return;
      const wasSignedIn = !!currentSession.current?.user;
      acceptSession(next);
      if (wasSignedIn && !next.user) setNotice('Your session has ended. Sign in to continue.');
    } catch (error) {
      if (attempt !== sequence.current) return;
      if (error instanceof ApiError && error.status === 401) {
        expireSession();
        return;
      }
      // A disconnected server does not mean that the user has signed out.
      setSessionError(messageOf(error));
      setReady(true);
      throw error;
    }
  }, [acceptSession, expireSession]);

  useEffect(() => {
    void refreshSession().catch(() => {});
    window.addEventListener('crawlspace:unauthorized', expireSession);
    return () => {
      ++sequence.current;
      window.removeEventListener('crawlspace:unauthorized', expireSession);
    };
  }, [refreshSession, expireSession]);

  useEffect(() => {
    if (!session?.user) return;
    const check = () => { if (document.visibilityState !== 'hidden') void refreshSession().catch(() => {}); };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [session?.user?.id, refreshSession]);

  const logout = useCallback(async () => {
    try {
      await request('/auth/logout', 'POST');
      acceptSession({ user: null, registrationEnabled: currentSession.current?.registrationEnabled ?? false });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { expireSession(); return; }
      throw error;
    }
  }, [acceptSession, expireSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    try {
      const next = await request('/auth/password', 'POST', { currentPassword, newPassword }) as AuthSession;
      acceptSession(next);
      setNotice('Password updated. Sign in with your new password.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { expireSession(); return; }
      throw error;
    }
  }, [acceptSession, expireSession]);

  if (ready && session?.user) {
    return <AuthContext.Provider key={session.user.id} value={{ user: session.user, logout, refreshSession, changePassword }}>{children}</AuthContext.Provider>;
  }
  return <AuthLayout>
    {!ready ? <div className="auth-status" role="status"><LoaderCircle size={26} className="spin" /><h1>Opening your workspace</h1><p>Checking your session...</p></div>
      : sessionError ? <div className="auth-status"><span className="auth-status-icon"><LockKeyhole size={24} /></span><h1>Let’s reconnect.</h1><p>Your workspace server could not be reached. Check the connection and try again.</p><div className="auth-error" role="alert">{sessionError}</div><button className="auth-submit" disabled={retrying} onClick={async () => { setRetrying(true); try { await refreshSession(); } catch { /* Keep the retry screen available. */ } finally { setRetrying(false); } }}>{retrying ? <LoaderCircle size={17} className="spin" /> : <Repeat2 size={17} />}Try again</button></div>
      : <AuthForm registrationEnabled={session?.registrationEnabled ?? false} notice={notice} onAuthenticated={acceptSession} />}
  </AuthLayout>;
}

function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="auth-page">
    <section className="auth-story" aria-label="About Crawlspace">
      <a className="auth-brand" href="/" aria-label="Crawlspace home"><span><Repeat2 size={24} /></span>crawlspace<span className="auth-brand-dot">.</span></a>
      <div className="auth-story-body">
        <div className="auth-eyebrow"><span /> YOUR AUTONOMOUS WORKSPACE</div>
        <h2>A little team.<br />A better codebase<span>.</span></h2>
        <p>Give your agents a purpose.<br />Let curiosity do the rest.</p>
        <div className="auth-flow" aria-hidden="true">
          <div className="auth-flow-card auth-flow-first"><span className="auth-flow-icon"><Code2 size={19} /></span><span><strong>Explore the code</strong><small>A fresh pair of eyes</small></span><span className="auth-flow-dot" /></div>
          <div className="auth-flow-line" />
          <div className="auth-flow-card auth-flow-second"><span className="auth-flow-icon"><Eye size={19} /></span><span><strong>Find what matters</strong><small>Every detail has a story</small></span><span className="auth-flow-dot" /></div>
          <div className="auth-flow-line auth-flow-line-second" />
          <div className="auth-flow-card auth-flow-third"><span className="auth-flow-icon"><GitMerge size={19} /></span><span><strong>Make it better, together</strong><small>One thoughtful loop at a time</small></span><span className="auth-flow-dot" /></div>
        </div>
      </div>
      <div className="auth-story-footer"><Sparkles size={15} /><span>Made for the long run.</span><Repeat2 size={15} /></div>
    </section>
    <section className="auth-entry" aria-label="Workspace account">
      <div className="auth-entry-inner"><div className="auth-private-label"><ShieldCheck size={14} /> PRIVATE WORKSPACE</div><div className="auth-card">{children}</div><p className="auth-entry-footer"><LockKeyhole size={12} /> Your team’s workspace starts with you.</p></div>
    </section>
  </main>;
}

function AuthForm({ registrationEnabled, notice, onAuthenticated }: { registrationEnabled: boolean; notice: string; onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [registrationSecret, setRegistrationSecret] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const register = mode === 'register' && registrationEnabled;

  const changeMode = (next: 'login' | 'register') => {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmation('');
    setRegistrationSecret('');
    setVisible(false);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (register && password !== confirmation) { setError('Your passwords don’t match. Check them and try again.'); return; }
    setPending(true);
    try {
      const next = await request(register ? '/auth/register' : '/auth/login', 'POST', {
        username: username.trim(), password, ...(register ? { registrationSecret } : {}),
      }) as AuthSession;
      setPassword('');
      setConfirmation('');
      setRegistrationSecret('');
      onAuthenticated(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally { setPending(false); }
  };

  return <>
    <span className="auth-welcome-icon"><Repeat2 size={25} /></span>
    <h1>{register ? 'Make yourself at home.' : 'Welcome to your workspace.'}</h1>
    <p className="auth-description">{register ? 'A place for your agents, ideas, and the next improvement.' : 'Sign in to pick up where your team left off.'}</p>
    {registrationEnabled && <div className="auth-tabs" role="tablist" aria-label="Account access"><button id="auth-login-tab" type="button" role="tab" aria-selected={!register} aria-controls="auth-form-panel" tabIndex={!register ? 0 : -1} disabled={pending} className={!register ? 'active' : ''} onClick={() => changeMode('login')} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); changeMode('register'); document.getElementById('auth-register-tab')?.focus(); } }}>Sign in</button><button id="auth-register-tab" type="button" role="tab" aria-selected={register} aria-controls="auth-form-panel" tabIndex={register ? 0 : -1} disabled={pending} className={register ? 'active' : ''} onClick={() => changeMode('register')} onKeyDown={event => { if (event.key === 'ArrowLeft') { event.preventDefault(); changeMode('login'); document.getElementById('auth-login-tab')?.focus(); } }}>Create account</button></div>}
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    <div id="auth-form-panel" role={registrationEnabled ? 'tabpanel' : undefined} aria-labelledby={registrationEnabled ? register ? 'auth-register-tab' : 'auth-login-tab' : undefined}>
      <form className="auth-form" onSubmit={submit}>
        <label className="auth-field" htmlFor="auth-username">Username<input id="auth-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={register ? 3 : undefined} maxLength={32} pattern={register ? '[A-Za-z0-9_-]{3,32}' : undefined} aria-describedby={register ? 'auth-username-help' : undefined} value={username} disabled={pending} onChange={event => setUsername(event.target.value)} placeholder="Your username" /></label>
        {register && <p className="auth-field-help" id="auth-username-help">3–32 letters, numbers, underscores, or hyphens.</p>}
        <label className="auth-field" htmlFor="auth-password">Password<div className="auth-password-wrap"><input id="auth-password" name="password" type={visible ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} maxLength={256} aria-describedby={register ? 'auth-password-help' : undefined} value={password} disabled={pending} onChange={event => setPassword(event.target.value)} placeholder={register ? 'Choose a strong password' : 'Your password'} /><button type="button" className="auth-password-toggle" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} disabled={pending} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        {register && <><p className="auth-field-help" id="auth-password-help">Use at least 12 characters.</p><label className="auth-field" htmlFor="auth-password-confirm">Confirm password<input id="auth-password-confirm" name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} disabled={pending} onChange={event => setConfirmation(event.target.value)} placeholder="Enter your password again" /></label><div className="auth-invite"><div className="auth-invite-caption"><KeyRound size={15} /><strong>One little key to get started</strong></div><p>Ask the workspace owner for the registration secret. You need it to create an account.</p><label className="auth-field" htmlFor="auth-registration-secret">Registration secret<input id="auth-registration-secret" name="registrationSecret" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={registrationSecret} disabled={pending} onChange={event => setRegistrationSecret(event.target.value)} placeholder="Enter your invitation secret" /></label></div></>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-submit" type="submit" disabled={pending}>{pending ? <><LoaderCircle size={17} className="spin" />{register ? 'Creating your account...' : 'Signing in...'}</> : <>{register ? 'Create account' : 'Sign in'}<ArrowRight size={17} /></>}</button>
      </form>
    </div>
    {!registrationEnabled && <p className="auth-registration-closed"><KeyRound size={14} /> Account creation is closed. Ask the workspace owner for access.</p>}
    {register && <p className="auth-form-footnote"><Check size={13} /> Your registration secret is only sent to this server.</p>}
  </>;
}

/** Compact account control intended for the workspace sidebar. */
export function AccountMenu({ onDialogChange }: { onDialogChange?: (open: boolean) => void }) {
  const { user, logout, changePassword } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const passwordButton = useRef<HTMLButtonElement>(null);
  const closePassword = () => { setPasswordOpen(false); onDialogChange?.(false); passwordButton.current?.focus(); };
  return <div className="auth-account-wrap"><div className="auth-account"><span className="auth-account-avatar" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span><span className="auth-account-name">{user.username}<small>Private workspace</small></span><button ref={passwordButton} type="button" className="auth-signout" aria-label="Change password" title="Change password" disabled={pending} onClick={() => { onDialogChange?.(true); setPasswordOpen(true); }}><KeyRound size={15} /></button><button type="button" className="auth-signout" aria-label="Sign out" title="Sign out" disabled={pending} onClick={async () => { setError(''); setPending(true); try { await logout(); } catch (cause) { setError(messageOf(cause)); } finally { setPending(false); } }}>{pending ? <LoaderCircle size={16} className="spin" /> : <LogOut size={16} />}</button></div>{error && <p className="auth-account-error" role="alert">{error}</p>}{passwordOpen && createPortal(<PasswordDialog onClose={closePassword} onChangePassword={changePassword} />, document.body)}</div>;
}

function PasswordDialog({ onClose, onChangePassword }: { onClose: () => void; onChangePassword: (currentPassword: string, newPassword: string) => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const currentInput = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  const closeRef = useRef(onClose);
  pendingRef.current = pending; closeRef.current = onClose;
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => currentInput.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pendingRef.current) closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey, true); document.body.style.overflow = previousOverflow; };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (newPassword !== confirmation) { setError('Your new passwords don’t match. Check them and try again.'); return; }
    setPending(true);
    try { await onChangePassword(currentPassword, newPassword); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setPending(false); }
  };
  return <div className="modal-overlay auth-password-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}><section ref={dialog} className="auth-password-dialog" role="dialog" aria-modal="true" aria-labelledby="change-password-title" tabIndex={-1}><div className="auth-password-dialog-heading"><span className="auth-welcome-icon"><KeyRound size={23} /></span><button type="button" className="btn-icon" aria-label="Close change password" disabled={pending} onClick={onClose}><X size={18} /></button></div><h2 id="change-password-title">A new key to your workspace.</h2><p>Changing your password signs you out on every device. You can sign back in with your new password.</p><form className="auth-form" onSubmit={submit}><label className="auth-field" htmlFor="account-current-password">Current password<input ref={currentInput} id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" maxLength={256} required value={currentPassword} disabled={pending} onChange={event => setCurrentPassword(event.target.value)} /></label><label className="auth-field" htmlFor="account-new-password">New password<input id="account-new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={newPassword} disabled={pending} aria-describedby="account-password-help" onChange={event => setNewPassword(event.target.value)} /></label><p className="auth-field-help" id="account-password-help">Use at least 12 characters.</p><label className="auth-field" htmlFor="account-confirm-password">Confirm new password<input id="account-confirm-password" name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} disabled={pending} onChange={event => setConfirmation(event.target.value)} /></label>{error && <div className="auth-error" role="alert">{error}</div>}<button type="submit" className="auth-submit" disabled={pending}>{pending ? <><LoaderCircle size={17} className="spin" />Updating password...</> : <>Update password<ArrowRight size={17} /></>}</button><button type="button" className="auth-cancel" disabled={pending} onClick={onClose}>Cancel</button></form></section></div>;
}
