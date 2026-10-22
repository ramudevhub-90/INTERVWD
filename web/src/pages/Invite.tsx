import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { Loading, useLoad, when } from '../lib/util';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CV = 5 * 1024 * 1024;

export function Invite() {
  const { code = '' } = useParams();
  const { data, error } = useLoad(() => api.invite(code), [code]);
  const [form, setForm] = useState({ name: '', email: '', slotId: '', consent: false });
  const [cv, setCv] = useState<File>();
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ interviewId: string; start: string }>();

  if (!data) {
    return (
      <>
        <PublicTop />
        <div className="centered"><div className="narrow"><Loading error={error} /></div></div>
      </>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = 'Enter your full name.';
    if (!EMAIL.test(form.email.trim())) next.email = 'Enter your email, like name@example.com.';
    if (!cv) next.cv = 'Upload your CV as a PDF or text file.';
    else if (cv.size > MAX_CV) next.cv = 'Your CV is over 5 MB. Upload a smaller file.';
    if (!form.slotId) next.slotId = 'Pick a time for your interview.';
    if (!form.consent) next.consent = 'Agree to the recording terms to book.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const { interviewId } = await api.join(code, { ...form, cv: cv! });
      setBooked({ interviewId, start: data.openSlots.find((s) => s.id === form.slotId)!.start });
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (booked) {
    return (
      <>
        <PublicTop />
        <div className="centered">
          <div className="card narrow" style={{ textAlign: 'center' }}>
            <div className="orb" style={{ margin: '0 auto 14px', background: 'var(--success)' }}><Icon name="check" size={26} /></div>
            <h2>You're booked</h2>
            <p className="muted" style={{ margin: '8px 0 4px' }}>{data.job.title} · {data.round.name}</p>
            <p style={{ fontWeight: 500 }}>{when(booked.start)}</p>
            <p className="muted small" style={{ margin: '14px 0 18px' }}>We've emailed your interview link to {form.email.trim()}. Use a quiet room, Chrome or Edge, and allow the camera and microphone.</p>
            <Link className="btn btn-primary btn-block" to={`/interview/${booked.interviewId}`}>Go to the interview room</Link>
            <p className="faint" style={{ marginTop: 10 }}>You can open the room early to test your camera and microphone.</p>
          </div>
        </div>
      </>
    );
  }

  const field = (k: string) => errors[k] && <span className="error" style={{ marginTop: 0 }}>{errors[k]}</span>;
  const clear = (k: string) => setErrors({ ...errors, [k]: undefined, form: undefined });

  return (
    <>
      <PublicTop />
      <div className="centered">
        <form className="card" style={{ width: '100%', maxWidth: 520 }} onSubmit={submit} noValidate>
          <p className="faint">{data.orgName} invited you to interview for</p>
          <h1 style={{ fontSize: 24, margin: '4px 0 6px' }}>{data.job.title}</h1>
          <p className="muted small">{data.job.location} · {data.round.name} · about {data.round.durationMin} minutes, by voice with an AI interviewer</p>
          <div className="divider" style={{ margin: '18px 0' }} />

          <label className="field"><span>Full name</span><input value={form.name} autoComplete="name" onChange={(e) => { setForm({ ...form, name: e.target.value }); clear('name'); }} placeholder="Rahul Mehta" />{field('name')}</label>
          <label className="field"><span>Email</span><input type="email" autoComplete="email" value={form.email} onChange={(e) => { setForm({ ...form, email: e.target.value }); clear('email'); }} placeholder="rahul@example.com" />{field('email')}</label>

          <div className="field">
            <span>CV</span>
            <label style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', padding: '14px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
              <Icon name={cv ? 'file' : 'upload'} />
              <span className="small" style={{ flex: 1 }}>{cv ? cv.name : 'Upload a PDF or text file (up to 5 MB)'}</span>
              {cv && <span className="badge badge-success">Ready</span>}
              <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" className="sr-only" onChange={(e) => { setCv(e.target.files?.[0]); clear('cv'); }} />
            </label>
            <span className="faint">The interviewer reads it so questions fit your experience.</span>
            {field('cv')}
          </div>

          <label className="field">
            <span>Interview time</span>
            <select value={form.slotId} onChange={(e) => { setForm({ ...form, slotId: e.target.value }); clear('slotId'); }}>
              <option value="">{data.openSlots.length ? 'Pick a time' : 'No times left. Ask the company for more.'}</option>
              {data.openSlots.map((s) => <option key={s.id} value={s.id}>{when(s.start)}</option>)}
            </select>
            {field('slotId')}
          </label>

          <label className="row small" style={{ alignItems: 'flex-start', margin: '6px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.consent} onChange={(e) => { setForm({ ...form, consent: e.target.checked }); clear('consent'); }} />
            <span className="muted">I agree that the interview is recorded and transcribed, and that a few camera snapshots are taken. {data.orgName}'s recruiters review them. An AI scores answers, and a person makes every decision.</span>
          </label>
          {field('consent')}

          <button className="btn btn-primary btn-block btn-lg" disabled={busy}>{busy ? 'Booking…' : 'Book my interview'}</button>
          {errors.form && <p className="error">{errors.form}</p>}
        </form>
      </div>
    </>
  );
}
