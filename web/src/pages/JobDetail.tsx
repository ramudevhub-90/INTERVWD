import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Round } from '../api/types';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { KnowledgeTab } from './KnowledgeTab';
import { Qr, downloadQr, qrLink } from '../components/Qr';
import { Loading, ScoreBadge, StatusBadge, copy, initials, invitePath, inviteUrl, useLoad, when } from '../lib/util';

function RoundCard({ round, onChange }: { round: Round; onChange: (r: Round) => void }) {
  const [start, setStart] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const url = inviteUrl(round);

  const add = async () => {
    if (!start) return setError('Pick a date and time first.');
    if (new Date(start) < new Date()) return setError('Pick a time in the future.');
    try {
      onChange(await api.addSlots(round.id, [new Date(start).toISOString()]));
      setStart('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (slotId: string) => {
    try {
      onChange(await api.removeSlot(round.id, slotId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2 className="row" style={{ gap: 8 }}>{round.name} <span className={`badge ${round.mode === 'human' ? 'badge-warning' : 'badge-accent'}`}>{round.mode === 'human' ? 'Person' : 'AI'}</span></h2>
          <p className="faint" style={{ marginTop: 4 }}>
            {round.mode === 'human'
              ? <>{round.location === 'office' ? 'In person at the office' : 'Video call'} with {round.interviewers?.map((i) => i.name).join(', ') || 'a person'} · about {round.durationMin} minutes · scorecard · a person decides</>
              : <>AI voice interview{round.location === 'office' ? ' at the office (Echo Show rooms)' : ' online'} · about {round.durationMin} minutes · {round.questions.length} core questions with follow-ups ·{' '}
                {round.decisionMode === 'auto' ? `AI fast-tracks clear passes (≥ ${round.autoAdvance?.minOverall.toFixed(1)})` : 'A person decides'}</>}
          </p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <h3 style={{ marginBottom: 8 }}>What's assessed</h3>
            {round.criteria.map((c) => (
              <div key={c.id} className="row" style={{ alignItems: 'flex-start', padding: '5px 0' }}>
                <span style={{ color: 'var(--success)', marginTop: 2 }}><Icon name="check" size={16} /></span>
                <div><div className="small" style={{ fontWeight: 500 }}>{c.name}</div><div className="faint">{c.description}</div></div>
              </div>
            ))}
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Core questions</h3>
            <ol style={{ margin: 0, paddingLeft: 18 }} className="small muted">
              {round.questions.map((q) => <li key={q} style={{ marginBottom: 6 }}>{q}</li>)}
            </ol>
            <p className="faint" style={{ marginTop: 6 }}>Each candidate gets these, worded to fit their CV, plus a follow-up on every answer.</p>
          </div>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          <div>
            <h3 style={{ marginBottom: 8 }}>Invite link</h3>
            <div className="row">
              <input readOnly value={url} onFocus={(e) => e.target.select()} className="small" />
              <button className="btn" onClick={() => { copy(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }} aria-label="Copy invite link">
                <Icon name={copied ? 'check' : 'copy'} />
              </button>
            </div>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <a className="btn btn-sm" target="_blank" rel="noreferrer"
                href={`https://wa.me/?text=${encodeURIComponent(`You're invited to interview for ${round.name.split(' · ')[1] ?? round.name}. Create your profile and pick a time here: ${url}`)}`}>
                Share on WhatsApp
              </a>
              <a className="btn btn-sm" href={`mailto:?subject=${encodeURIComponent('Interview invitation')}&body=${encodeURIComponent(`Create your profile and pick a time for your interview here: ${url}`)}`}>Share by email</a>
              <button className="btn btn-sm" onClick={() => setShowQr(!showQr)} aria-expanded={showQr}><Icon name="photo" size={14} /> QR code</button>
            </div>
            {showQr && (
              <div className="qr-panel">
                <Qr url={qrLink(url)} size={150} />
                <div className="stack" style={{ gap: 8 }}>
                  <p className="small" style={{ fontWeight: 500 }}>Scan to interview</p>
                  <p className="faint small">For walk-in drives, job fairs and your office: candidates scan, sign up on their phone{round.mode !== 'human' && round.location !== 'office' ? ' and can start the AI interview straight away' : ''}. Scans show up in Reports.</p>
                  <div className="row wrap">
                    <button className="btn btn-sm" onClick={() => downloadQr(qrLink(url), `intervwd-${round.publicPath?.replace('/', '-') ?? round.id}-qr`)}><Icon name="upload" size={14} /> Download</button>
                    <Link className="btn btn-sm btn-primary" to={`/app/jobs/${round.jobId}/rounds/${round.id}/poster`} target="_blank">Print poster</Link>
                  </div>
                </div>
              </div>
            )}
            <p className="faint" style={{ marginTop: 6 }}>
              Applicants create a profile{round.identityCheck ? ' with a face photo' : ''}, upload a CV and book a slot{round.requireApproval ? '; you approve profiles before they get the interview link' : ''}. <Link to={invitePath(round)} target="_blank">Preview as a candidate</Link>
            </p>
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Slots</h3>
            {round.slots.length === 0 && <p className="faint">No slots yet. Add a few times candidates can choose from.</p>}
            {round.slots.map((s) => (
              <div key={s.id} className="list-row" style={{ padding: '8px 0' }}>
                <Icon name="calendar" size={16} />
                <span className="grow small">{when(s.start)}</span>
                {s.candidateId ? (
                  <Link className="badge badge-accent" to={`/app/candidates/${s.candidateId}`}>Booked</Link>
                ) : (
                  <>
                    <span className="badge badge-success">Open</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(s.id)} aria-label="Remove slot"><Icon name="trash" size={15} /></button>
                  </>
                )}
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <input type="datetime-local" value={start} onChange={(e) => { setStart(e.target.value); setError(undefined); }} aria-label="New slot time" />
              <button className="btn" onClick={add}><Icon name="plus" /> Add</button>
            </div>
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddCandidate({ jobId, rounds, onDone }: { jobId: string; rounds: Round[]; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', roundId: rounds[0]?.id ?? '' });
  const [cv, setCv] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [sent, setSent] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.name.trim().length < 2) return setErr("Enter the candidate's full name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setErr("Enter the candidate's email.");
    if (!form.roundId) return setErr('Add a round first.');
    setBusy(true);
    setErr(undefined);
    try {
      const out = await api.addCandidate(jobId, { ...form, cv });
      setSent(out.link);
      setForm({ ...form, name: '', email: '' });
      setCv(undefined);
      onDone();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} noValidate style={{ marginBottom: 16 }}>
      <div className="card-head"><h3>Add a candidate</h3><span className="faint">They're approved already; we email them a personal link</span></div>
      <div className="grid cols-3" style={{ gap: 12 }}>
        <label className="field"><span>Full name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Asha Pillai" /></label>
        <label className="field"><span>Email</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="asha@example.com" /></label>
        <label className="field"><span>Round</span><select value={form.roundId} onChange={(e) => setForm({ ...form, roundId: e.target.value })}>{rounds.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      </div>
      <div className="row wrap">
        <label className="btn btn-sm" style={{ cursor: 'pointer' }}><Icon name={cv ? 'file' : 'upload'} size={15} /> {cv ? cv.name : 'Attach CV (optional)'}
          <input type="file" accept=".pdf,.doc,.docx,.txt,.md" className="sr-only" onChange={(e) => setCv(e.target.files?.[0])} />
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Sending…' : 'Add and email invite'}</button>
      </div>
      {err && <p className="error">{err}</p>}
      {sent && (
        <p className="small" style={{ marginTop: 10 }}>
          Invite sent. Their personal link: <a href={sent} target="_blank" rel="noreferrer">{sent}</a>{' · '}
          <a target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Here's your personal link to finish your profile and book your interview: ${sent}`)}`}>Send on WhatsApp</a>
        </p>
      )}
    </form>
  );
}

export function JobDetail() {
  const { jobId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'candidates';
  const { data, error, setData, reload } = useLoad(() => api.job(jobId), [jobId]);
  if (!data) return <Loading error={error} />;
  const { job, rounds, candidates } = data;

  return (
    <>
      <PageHead title={job.title} sub={`${job.location} · ${job.description}`} crumbs={[{ to: '/app/jobs', label: 'Jobs' }]}>
        <Link className="btn btn-primary" to={`/app/jobs/${job.id}/rounds/new`}><Icon name="plus" /> Add round</Link>
      </PageHead>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'candidates'} className={tab === 'candidates' ? 'on' : ''} onClick={() => setParams({ tab: 'candidates' })}>Candidates ({candidates.length})</button>
        <button role="tab" aria-selected={tab === 'rounds'} className={tab === 'rounds' ? 'on' : ''} onClick={() => setParams({ tab: 'rounds' })}>Rounds and scheduling ({rounds.length})</button>
        <button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'on' : ''} onClick={() => setParams({ tab: 'knowledge' })}>Knowledge base</button>
      </div>

      {tab === 'knowledge' ? (
        <KnowledgeTab jobId={job.id} />
      ) : tab === 'candidates' ? (
        <>
        {rounds.length > 0 && <AddCandidate jobId={job.id} rounds={rounds} onDone={reload} />}
        <div className="card">
          {candidates.length === 0 && (
            <div className="empty">
              <h3>No candidates yet</h3>
              <p className="muted small" style={{ margin: '6px 0 14px' }}>Share a round's invite link and candidates appear here as they book.</p>
              <button className="btn" onClick={() => setParams({ tab: 'rounds' })}>Get the invite link</button>
            </div>
          )}
          {candidates.map((c) => (
            <Link key={c.id} className="list-row" to={`/app/candidates/${c.id}`}>
              <div className="avatar">{initials(c.name)}</div>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{c.name}</div>
                <div className="faint ellipsis">{c.roundName} · {c.cvSummary}</div>
              </div>
              <ScoreBadge score={c.overall} />
              <StatusBadge status={c.status} />
            </Link>
          ))}
        </div>
        </>
      ) : (
        <div className="stack">
          {rounds.length === 0 && (
            <div className="card empty">
              <h3>Add the first round</h3>
              <p className="muted small" style={{ margin: '6px 0 14px' }}>Choose what to assess and the core questions.</p>
              <Link className="btn btn-primary" to={`/app/jobs/${job.id}/rounds/new`}>Add round</Link>
            </div>
          )}
          {rounds.map((r) => (
            <RoundCard key={r.id} round={r} onChange={(nr) => setData({ ...data, rounds: rounds.map((x) => (x.id === nr.id ? nr : x)) })} />
          ))}
        </div>
      )}
    </>
  );
}
