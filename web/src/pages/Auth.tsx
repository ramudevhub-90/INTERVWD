import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { PublicTop } from '../components/Shell';
import { useAuth } from '../lib/util';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Already signed in on this device (sessions last 30 days): skip the code and go straight in. */
function useSignedIn() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  return session?.role === 'recruiter' ? <Navigate to={params.get('next') ?? '/app'} replace /> : null;
}

/** Second step of both forms: enter the 6-digit code from the email. */
function CodeStep({ email, hint, onBack }: { email: string; hint?: string; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) return setError('Enter the 6-digit code from the email.');
    setBusy(true);
    try {
      setSession(await api.verifyCode(email, code));
      navigate(params.get('next') ?? '/app', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <h2>Check your email</h2>
      <p className="muted" style={{ margin: '6px 0 18px' }}>We sent a 6-digit code to <b>{email}</b>.</p>
      {hint && <p className="notice" style={{ marginBottom: 14 }}>{hint}</p>}
      <label className="field">
        <span>Code</span>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(undefined); }} placeholder="123456" autoFocus style={{ letterSpacing: '0.3em', fontSize: 18 }} />
      </label>
      <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className="error">{error}</p>}
      <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={onBack}>Use a different email</button>
    </form>
  );
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ hint?: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const signedIn = useSignedIn();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) return setError('Enter your work email, like name@company.com.');
    setBusy(true);
    try {
      setSent(await api.sendCode(email.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (signedIn) return signedIn;
  return (
    <>
      <PublicTop />
      <div className="centered">
        <div className="card narrow">
          {sent ? (
            <CodeStep email={email.trim()} hint={sent.hint} onBack={() => setSent(undefined)} />
          ) : (
            <form onSubmit={submit} noValidate>
              <h2>Sign in</h2>
              <p className="muted" style={{ margin: '6px 0 18px' }}>For recruiters and hiring teams. Candidates join through their invite link.</p>
              <label className="field">
                <span>Work email</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(undefined); }} placeholder="name@company.com" autoFocus />
              </label>
              <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
              {error && <p className="error">{error}</p>}
              <p className="faint" style={{ marginTop: 16 }}>
                Demo account: <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }} onClick={() => setEmail('demo@intervwd.com')}>demo@intervwd.com</button>
                {' · '}New here? <Link to="/signup">Set up your company</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

export function SignUp() {
  const [form, setForm] = useState({ orgName: '', name: '', email: '' });
  const [sent, setSent] = useState<{ hint?: string }>();
  const [errors, setErrors] = useState<Partial<Record<keyof typeof form | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({ ...errors, [k]: undefined, form: undefined });
  };

  const signedIn = useSignedIn();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (form.orgName.trim().length < 2) next.orgName = 'Enter your company name.';
    if (form.name.trim().length < 2) next.name = 'Enter your name.';
    if (!EMAIL.test(form.email.trim())) next.email = 'Enter your work email, like name@company.com.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      setSent(await api.createOrg(form));
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (signedIn) return signedIn;
  return (
    <>
      <PublicTop right={<Link className="btn btn-ghost" to="/signin">Sign in</Link>} />
      <div className="centered">
        <div className="card narrow">
          {sent ? (
            <CodeStep email={form.email.trim()} hint={sent.hint} onBack={() => setSent(undefined)} />
          ) : (
            <form onSubmit={submit} noValidate>
              <h2>Set up your company</h2>
              <p className="muted" style={{ margin: '6px 0 18px' }}>Your hiring team runs rounds here. Candidates join through links you share.</p>
              <label className="field">
                <span>Company name</span>
                <input value={form.orgName} onChange={set('orgName')} placeholder="Northwind Labs" autoFocus />
                {errors.orgName && <span className="error" style={{ marginTop: 0 }}>{errors.orgName}</span>}
              </label>
              <label className="field">
                <span>Your name</span>
                <input value={form.name} onChange={set('name')} autoComplete="name" placeholder="Priya Sharma" />
                {errors.name && <span className="error" style={{ marginTop: 0 }}>{errors.name}</span>}
              </label>
              <label className="field">
                <span>Work email</span>
                <input type="email" value={form.email} onChange={set('email')} autoComplete="email" placeholder="priya@northwind.com" />
                {errors.email && <span className="error" style={{ marginTop: 0 }}>{errors.email}</span>}
              </label>
              <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create company'}</button>
              {errors.form && <p className="error">{errors.form}</p>}
              <p className="faint" style={{ marginTop: 16 }}>We email a 6-digit code to sign in. No password to remember.</p>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
