import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { DecisionAction, Interview, Round } from '../api/types';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, ScoreBadge, StatusBadge, initials, useLoad, when } from '../lib/util';

function InterviewReport({ interview, round }: { interview: Interview; round?: Round }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const r = interview.report;
  if (!r) {
    return (
      <div className="card">
        <div className="card-head"><h2>{round?.name}</h2><span className="badge">{interview.status === 'in_progress' ? 'In progress' : 'Booked'}</span></div>
        <p className="muted">{interview.status === 'in_progress' ? 'The interview is happening now. The report appears as soon as it ends.' : `Booked for ${when(interview.slotStart)}. The report appears here after the interview.`}</p>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{round?.name}</h2>
          <p className="faint" style={{ marginTop: 4 }}>{when(interview.startedAt ?? interview.slotStart)}{interview.endedAt && interview.startedAt ? ` · ${Math.max(1, Math.round((+new Date(interview.endedAt) - +new Date(interview.startedAt)) / 60000))} min` : ''}</p>
        </div>
        <ScoreBadge score={r.overall} />
      </div>
      <p style={{ marginBottom: 18 }}>{r.summary}</p>

      <div className="stack" style={{ gap: 14 }}>
        {r.criteria.map((c) => (
          <div key={c.criterionId}>
            <div className="row">
              <span className="small" style={{ fontWeight: 500, width: 170 }}>{c.name}</span>
              <span className="meter"><i style={{ width: `${(c.score / 5) * 100}%` }} /></span>
              <span className="score small" style={{ width: 30, textAlign: 'right' }}>{c.score.toFixed(1)}</span>
            </div>
            <p className="faint evidence">{c.evidence}</p>
          </div>
        ))}
      </div>

      <div className="grid cols-2" style={{ marginTop: 20 }}>
        <div>
          <h3 style={{ marginBottom: 8 }}>Highlights</h3>
          {r.highlights.map((h) => <p key={h} className="small row" style={{ alignItems: 'flex-start', marginBottom: 6 }}><span style={{ color: 'var(--success)' }}><Icon name="check" size={16} /></span>{h}</p>)}
        </div>
        <div>
          <h3 style={{ marginBottom: 8 }}>Worth probing</h3>
          {r.concerns.length === 0 && <p className="faint">Nothing stood out.</p>}
          {r.concerns.map((h) => <p key={h} className="small row" style={{ alignItems: 'flex-start', marginBottom: 6 }}><span style={{ color: 'var(--warning)' }}><Icon name="sparkle" size={16} /></span>{h}</p>)}
        </div>
      </div>

      <div className="divider" style={{ margin: '20px 0 16px' }} />
      <h3 style={{ marginBottom: 8 }}>Camera snapshots</h3>
      {interview.snapshots.length === 0 ? (
        <p className="faint">No snapshots for this interview.</p>
      ) : (
        <div className="row wrap">
          {interview.snapshots.map((s) => (
            <figure key={s.at} style={{ margin: 0 }}>
              <img src={s.url} alt={`Snapshot at ${when(s.at, { date: false })}`} style={{ width: 132, height: 99, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }} />
              <figcaption className="faint">{when(s.at, { date: false })}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="faint" style={{ marginTop: 6 }}>For your team to check who took the interview. Intervwd doesn't analyse faces.</p>

      {interview.turns.length > 0 && (
        <>
          <button className="btn btn-sm" style={{ marginTop: 16 }} onClick={() => setShowTranscript(!showTranscript)}>
            {showTranscript ? 'Hide transcript' : `Show transcript (${interview.turns.length} turns)`}
          </button>
          {showTranscript && (
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              {interview.turns.map((t, i) => (
                <div key={i} className={`bubble ${t.role === 'interviewer' ? 'ai' : 'me'}`} style={{ maxWidth: '100%', marginLeft: t.role === 'candidate' ? 40 : 0 }}>
                  <div className="faint" style={{ marginBottom: 2 }}>{t.role === 'interviewer' ? (t.kind === 'follow_up' ? 'Interviewer · follow-up' : 'Interviewer') : t.kind === 'candidate_question' ? "Candidate's question (not scored)" : 'Candidate'}</div>
                  {t.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IdentityPanel({ photoUrl, photoDeleted, interview, required, onLetIn, busy }: {
  photoUrl?: string; photoDeleted?: boolean; interview?: Interview; required: boolean; onLetIn: () => void; busy: boolean;
}) {
  if (!required && !photoUrl) return null;
  const id = interview?.identity;
  const status = id?.status ?? 'pending';
  const label = { pending: ['Not checked yet', ''], matched: [`Matched${id?.similarity ? ` (${Math.round(id.similarity)}%)` : ''}`, 'badge-success'],
    locked: ['Didn’t match: interview locked', 'badge-danger'], approved: [`Let in by ${id?.approvedBy ?? 'the team'}`, 'badge-accent'] }[status];
  const flagged = (interview?.snapshots ?? []).filter((x) => x.match && x.match !== 'matched').length;
  return (
    <div className="card">
      <div className="card-head"><h3 className="row" style={{ gap: 8 }}><Icon name="shield" /> Identity check</h3><span className={`badge ${label[1]}`}>{label[0]}</span></div>
      {photoDeleted ? (
        <p className="faint">Face photos were deleted after your decision.</p>
      ) : (
        <div className="row" style={{ gap: 10 }}>
          {[['Profile photo', photoUrl], ['Live check', id?.liveUrl]].map(([t, u]) => (
            <figure key={t} style={{ margin: 0, flex: 1 }}>
              {u ? <img src={u} alt={t} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }} />
                : <div className="empty faint" style={{ aspectRatio: '1', display: 'grid', placeItems: 'center', border: '1px dashed var(--border)', borderRadius: 10, padding: 6 }}>None yet</div>}
              <figcaption className="faint" style={{ marginTop: 4 }}>{t}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {flagged > 0 && <p className="small" style={{ color: 'var(--warning)', marginTop: 10 }}>{flagged} snapshot{flagged > 1 ? 's' : ''} during the interview didn’t match the profile photo.</p>}
      {status === 'locked' && (
        <>
          <p className="small muted" style={{ marginTop: 10 }}>Face matching can fail on the right person in poor light or on a different camera. Compare the photos yourself.</p>
          <button className="btn btn-primary btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={onLetIn}>Let them in</button>
        </>
      )}
      <p className="faint" style={{ marginTop: 10 }}>One-to-one match with Amazon Rekognition. Never used to reject anyone.</p>
    </div>
  );
}

export function CandidateReport() {
  const { candidateId = '' } = useParams();
  const { data, error, reload } = useLoad(() => api.candidate(candidateId), [candidateId]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<DecisionAction>();
  const [err, setErr] = useState<string>();
  if (!data) return <Loading error={error} />;
  const { candidate, job, rounds, interviews, decisions } = data;
  const round = rounds.find((r) => r.id === candidate.roundId);
  const next = rounds.find((r) => r.index === (round?.index ?? 0) + 1);
  const finished = interviews.some((i) => i.roundId === candidate.roundId && i.status === 'completed');

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key as DecisionAction);
    setErr(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const current = [...interviews].reverse().find((i) => i.roundId === candidate.roundId);

  const decide = async (action: DecisionAction) => {
    setBusy(action);
    setErr(undefined);
    try {
      await api.decide(candidate.id, action, note.trim());
      setNote('');
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHead title={candidate.name} crumbs={[{ to: '/app/jobs', label: 'Jobs' }, { to: `/app/jobs/${job.id}`, label: job.title }]}>
        <StatusBadge status={candidate.status} />
      </PageHead>

      <div className="split">
        <div className="stack">
          {[...interviews].reverse().map((iv) => <InterviewReport key={iv.id} interview={iv} round={rounds.find((r) => r.id === iv.roundId)} />)}
        </div>

        <div className="stack">
          <div className="card">
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="avatar">{initials(candidate.name)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{candidate.name}</div>
                <div className="faint ellipsis">{candidate.email}</div>
              </div>
            </div>
            <p className="small row"><Icon name="file" size={16} /> {candidate.cvUrl ? <a href={candidate.cvUrl} target="_blank" rel="noreferrer">{candidate.cvName}</a> : candidate.cvName}</p>
            <p className="small muted" style={{ marginTop: 8 }}>{candidate.cvSummary}</p>
            {candidate.skills.length > 0 && (
              <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>{candidate.skills.map((s) => <span key={s} className="badge">{s}</span>)}</div>
            )}
          </div>

          {candidate.status === 'pending_approval' && (
            <div className="card">
              <h3>Approve this profile?</h3>
              <p className="faint" style={{ margin: '4px 0 12px' }}>{candidate.name.split(' ')[0]} signed up through the invite link{current ? ` and booked ${when(current.slotStart)}` : ''}. Approving emails their interview link.</p>
              <button className="btn btn-primary btn-block" disabled={!!busy} onClick={() => act('advance', () => api.reviewSignup(candidate.id, true))}>Approve</button>
              <button className="btn btn-sm btn-danger btn-block" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => act('reject', () => api.reviewSignup(candidate.id, false))}>Decline</button>
            </div>
          )}

          <IdentityPanel photoUrl={candidate.photoUrl} photoDeleted={candidate.photoDeleted} interview={current} required={!!data.identityRequired}
            busy={!!busy} onLetIn={() => act('hold', () => api.approveIdentity(candidate.id))} />

          <div className="card">
            <h3>Your decision</h3>
            <p className="faint" style={{ margin: '4px 0 12px' }}>{round?.name}. The AI never decides for you.</p>
            {finished && candidate.status === 'completed' ? (
              <>
                <textarea rows={2} placeholder="Note for your team (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 0, marginBottom: 10 }} />
                <button className="btn btn-primary btn-block" disabled={!!busy} onClick={() => decide('advance')}>{busy === 'advance' ? 'Saving…' : next ? `Move to ${next.name.split(' · ')[0]}` : 'Move forward'}</button>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" style={{ flex: 1 }} disabled={!!busy} onClick={() => decide('hold')}>Hold</button>
                  <button className="btn btn-sm btn-danger" style={{ flex: 1 }} disabled={!!busy} onClick={() => decide('reject')}>Don't progress</button>
                </div>
                {next && <p className="faint" style={{ marginTop: 10 }}>Moving on emails {candidate.name.split(' ')[0]} the {next.name.split(' · ')[0]} booking link.</p>}
              </>
            ) : (
              <p className="small muted">{finished ? 'Decision recorded. See the history below.' : 'Available once the interview is finished.'}</p>
            )}
            {err && <p className="error">{err}</p>}
          </div>

          {decisions.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: 6 }}>History</h3>
              {decisions.map((d) => (
                <div key={d.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 500 }}>{d.action === 'advance' ? 'Moved on' : d.action === 'hold' ? 'Put on hold' : 'Not progressing'}</div>
                    <div className="faint">{d.by} · {when(d.at)}</div>
                    {d.note && <div className="small muted" style={{ marginTop: 4 }}>{d.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
