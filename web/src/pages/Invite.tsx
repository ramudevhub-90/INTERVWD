import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { JoinResult } from '../api/types';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { Loading, possessive, useLoad, when } from '../lib/util';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CV = 5 * 1024 * 1024;
const MAX_PHOTO = 5 * 1024 * 1024;

/** The candidate's profile: through the round's invite link, or the personal link HR sent (?t=…). */
export function Invite() {
  // /i/<code>, or the named link /<company>/<round> (sent to the server as "<company>~<round>").
  const { code: plain, org, round: roundSlug } = useParams();
  const code = plain ?? (org && roundSlug ? `${org}~${roundSlug}` : '');
  const [params] = useSearchParams();
  const token = params.get('t') ?? undefined;
  const { data, error } = useLoad(() => api.invite(code, token), [code, token]);
  const [form, setForm] = useState({ name: '', email: '', phone: '', slotId: '', consent: false, faceConsent: false });
  const [cv, setCv] = useState<File>();
  const [photo, setPhoto] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<JoinResult & { start: string }>();

  useEffect(() => {
    if (data?.invited) setForm((f) => ({ ...f, name: data.invited!.name, email: data.invited!.email }));
  }, [data]);
  useEffect(() => {
    if (!photo) return setPreview(undefined);
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  if (!data) {
    return (
      <>
        <PublicTop />
        <div className="centered"><div className="narrow"><Loading error={error} /></div></div>
      </>
    );
  }
  const face = data.round.identityCheck;
  const cvOptional = !!data.invited?.hasCv;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = 'Enter your full name.';
    if (!EMAIL.test(form.email.trim())) next.email = 'Enter your email, like name@example.com.';
    if (!cv && !cvOptional) next.cv = 'Upload your CV as a PDF or text file.';
    else if (cv && cv.size > MAX_CV) next.cv = 'Your CV is over 5 MB. Upload a smaller file.';
    if (face && !photo) next.photo = 'Add a clear photo of your face for the identity check.';
    else if (photo && (photo.size > MAX_PHOTO || !photo.type.startsWith('image/'))) next.photo = 'Use a JPEG or PNG photo under 5 MB.';
    if (face && !form.faceConsent) next.faceConsent = 'Agree to the identity check to book.';
    if (!form.slotId) next.slotId = 'Pick a time for your interview.';
    if (!form.consent) next.consent = 'Agree to the recording terms to book.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const out = await api.join(code, { ...form, cv, photo, token });
      setBooked({ ...out, start: data.openSlots.find((s) => s.id === form.slotId)!.start });
    } catch (err) {
      setErrors({ form: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (booked) {
    const waiting = booked.status === 'pending_approval';
    return (
      <>
        <PublicTop />
        <div className="centered">
          <div className="card narrow" style={{ textAlign: 'center' }}>
            <div className="orb" style={{ margin: '0 auto 14px', background: waiting ? 'var(--warning)' : 'var(--success)' }}><Icon name={waiting ? 'clock' : 'check'} size={26} /></div>
            <h2>{waiting ? 'Profile sent for approval' : "You're booked"}</h2>
            <p className="muted" style={{ margin: '8px 0 4px' }}>{data.job.title} · {data.round.name}</p>
            <p style={{ fontWeight: 500 }}>{when(booked.start)}</p>
            <p className="muted small" style={{ margin: '14px 0 18px' }}>
              {waiting
                ? `${possessive(data.orgName)} team will review your profile. Once they approve it, we'll email your interview link to ${form.email.trim()}.`
                : `We've emailed your interview link to ${form.email.trim()}. Use a quiet room, Chrome or Edge, and allow the camera and microphone.`}
            </p>
            {booked.interviewId && <Link className="btn btn-primary btn-block" to={`/interview/${booked.interviewId}`}>Go to the interview room</Link>}
            {booked.interviewId && <Link className="btn btn-block" style={{ marginTop: 8 }} to={`/echo/${booked.interviewId}`}><Icon name="alexa" /> Or interview with Alexa on Echo Show (preview)</Link>}
            {booked.interviewId && <p className="faint" style={{ marginTop: 10 }}>You can open the room early to test your camera{face ? ' and do the identity check' : ''}.</p>}
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
        <form className="card" style={{ width: '100%', maxWidth: 540 }} onSubmit={submit} noValidate>
          <p className="faint">{data.invited ? `${data.orgName} invited you, ${data.invited.name.split(' ')[0]}, to interview for` : `${data.orgName} invited you to interview for`}</p>
          <h1 style={{ fontSize: 24, margin: '4px 0 6px' }}>{data.job.title}</h1>
          <p className="muted small">{data.job.location} · {data.round.name} · about {data.round.durationMin} minutes, by voice with an AI interviewer</p>
          {(data.round.requireApproval || face) && (
            <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
              {data.round.requireApproval && <span className="badge">The team approves profiles first</span>}
              {face && <span className="badge"><Icon name="shield" size={13} /> Identity check before the interview</span>}
            </div>
          )}
          <div className="divider" style={{ margin: '18px 0' }} />

          <h3 style={{ marginBottom: 12 }}>Your profile</h3>
          <label className="field"><span>Full name</span><input value={form.name} autoComplete="name" onChange={(e) => { setForm({ ...form, name: e.target.value }); clear('name'); }} placeholder="Rahul Mehta" />{field('name')}</label>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <label className="field"><span>Email</span><input type="email" autoComplete="email" value={form.email} readOnly={!!data.invited} onChange={(e) => { setForm({ ...form, email: e.target.value }); clear('email'); }} placeholder="rahul@example.com" />{field('email')}</label>
            <label className="field"><span>Phone (optional)</span><input type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" /></label>
          </div>

          <div className="field">
            <span>CV{cvOptional ? ' (the team already has one; upload to replace it)' : ''}</span>
            <label style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', padding: 14, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
              <Icon name={cv ? 'file' : 'upload'} />
              <span className="small" style={{ flex: 1 }}>{cv ? cv.name : 'Upload a PDF, Word or text file (up to 5 MB)'}</span>
              {cv && <span className="badge badge-success">Ready</span>}
              <input type="file" accept=".pdf,.doc,.docx,.txt,.md,application/pdf,text/plain" className="sr-only" onChange={(e) => { setCv(e.target.files?.[0]); clear('cv'); }} />
            </label>
            <span className="faint">The interviewer reads it so questions fit your experience.</span>
            {field('cv')}
          </div>

          {face && (
            <div className="field">
              <span>Face photo for the identity check</span>
              <label style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', padding: 12, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                {preview ? <img src={preview} alt="Your photo" style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover' }} /> : <Icon name="camera" />}
                <span className="small" style={{ flex: 1 }}>{photo ? photo.name : 'A recent, clear photo of your face, looking at the camera'}</span>
                <input type="file" accept="image/jpeg,image/png" capture="user" className="sr-only" onChange={(e) => { setPhoto(e.target.files?.[0]); clear('photo'); }} />
              </label>
              {field('photo')}
            </div>
          )}

          <label className="field">
            <span>Interview time</span>
            <select value={form.slotId} onChange={(e) => { setForm({ ...form, slotId: e.target.value }); clear('slotId'); }}>
              <option value="">{data.openSlots.length ? 'Pick a time' : 'No times left. Ask the company for more.'}</option>
              {data.openSlots.map((s) => <option key={s.id} value={s.id}>{when(s.start)}</option>)}
            </select>
            {field('slotId')}
          </label>

          {face && (
            <>
              <label className="row small" style={{ alignItems: 'flex-start', margin: '6px 0 6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.faceConsent} onChange={(e) => { setForm({ ...form, faceConsent: e.target.checked }); clear('faceConsent'); }} />
                <span className="muted">I agree that before and during the interview, my camera image is compared with this photo to confirm it's me (Amazon Rekognition). The photo is deleted once {data.orgName} decides, or after 30 days. If the check fails, a person reviews it.</span>
              </label>
              {field('faceConsent')}
            </>
          )}
          <label className="row small" style={{ alignItems: 'flex-start', margin: '6px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.consent} onChange={(e) => { setForm({ ...form, consent: e.target.checked }); clear('consent'); }} />
            <span className="muted">I agree that the interview is recorded and transcribed, and that a few camera snapshots are taken. {possessive(data.orgName)} recruiters review them. An AI scores answers, and a person makes every decision.</span>
          </label>
          {field('consent')}

          <button className="btn btn-primary btn-block btn-lg" disabled={busy}>{busy ? 'Sending…' : data.round.requireApproval ? 'Send my profile' : 'Book my interview'}</button>
          {errors.form && <p className="error">{errors.form}</p>}
        </form>
      </div>
    </>
  );
}
