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

export function ScoreBadge({ score }: { score?: number }) {
  if (score === undefined) return <span className="faint">No score yet</span>;
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

export const inviteUrl = (code: string) => `${location.origin}/i/${code}`;
