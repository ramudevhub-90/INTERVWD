import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import type { CandidateStatus, Session } from '../api/types';

// ---------- Formatting ----------

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export function when(isoDate: string, opts: { date?: boolean } = { date: true }): string {
  const d = new Date(isoDate);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!opts.date) return time;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} · ${time}`;
}

export const STATUS: Record<CandidateStatus, { label: string; tone: string }> = {
  invited: { label: 'Invited', tone: '' },
  pending_approval: { label: 'Needs approval', tone: 'badge-warning' },
  declined: { label: 'Sign-up declined', tone: 'badge-danger' },
  scheduled: { label: 'Scheduled', tone: '' },
  in_progress: { label: 'In interview', tone: 'badge-accent' },
  completed: { label: 'Needs decision', tone: 'badge-warning' },
  advanced: { label: 'Moved on', tone: 'badge-success' },
  on_hold: { label: 'On hold', tone: '' },
  rejected: { label: 'Not progressing', tone: 'badge-danger' },
};

export function StatusBadge({ status }: { status: CandidateStatus }) {
  const s = STATUS[status];
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

export function scoreTone(score: number) {
  return score >= 4 ? 'badge-success' : score >= 3 ? 'badge-accent' : 'badge-warning';
}

export function ScoreBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="faint">No score yet</span>;
  return <span className={`badge ${scoreTone(score)} score`}>{score.toFixed(1)} / 5</span>;
}

// ---------- Data loading ----------

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(undefined);
    load().then((d) => live && setData(d)).catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload, setData };
}

export function Loading({ error }: { error?: string }) {
  if (error) return <div className="card empty"><p className="error" style={{ marginTop: 0 }}>{error}</p></div>;
  return <div className="empty faint">Loading…</div>;
}

// ---------- Session ----------

interface Auth {
  session: Session | null | undefined; // undefined while loading
  setSession: (s: Session | null) => void;
}

const AuthContext = createContext<Auth>({ session: undefined, setSession: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);
  return <AuthContext.Provider value={{ session, setSession }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export function copy(text: string) {
  return navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** A round's public invite link: intervwd.com/<company>/<job>-r<round> (older rounds: /i/<code>). */
export const invitePath = (round: { inviteCode: string; publicPath?: string }) => (round.publicPath ? `/${round.publicPath}` : `/i/${round.inviteCode}`);
export const inviteUrl = (round: { inviteCode: string; publicPath?: string }) => `${location.origin}${invitePath(round)}`;

/** "Northwind Labs'" and "Acme's". */
export const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** Why the camera didn't start, in words a candidate can act on. */
export function cameraProblem(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // A saved "Deny" can't be overridden by the site, and the browser won't ask again: say where to change it.
    const ua = navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|CriOS|FxiOS/.test(ua);
    const ios = /iPhone|iPad/.test(ua);
    if (ios) return 'Camera access is blocked. Open the Settings app → Safari (or your browser) → Camera → Allow, then reload this page.';
    if (safari) return `Camera access is blocked for this site. In the menu bar: Safari → Settings for ${location.hostname} → Camera → Allow, then reload.`;
    return 'Camera access is blocked for this site. Click the camera or lock icon in the address bar, allow the camera, then reload.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') return 'Your camera is busy: another tab or app (Zoom, Teams, another Intervwd tab) is using it. Close that, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found on this device.';
  return 'The camera didn’t start. Try again, or use another browser.';
}
