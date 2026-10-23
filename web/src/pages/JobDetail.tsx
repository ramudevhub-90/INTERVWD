import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Round } from '../api/types';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { KnowledgeTab } from './KnowledgeTab';
import { Loading, ScoreBadge, StatusBadge, copy, initials, inviteUrl, useLoad, when } from '../lib/util';

function RoundCard({ round, onChange }: { round: Round; onChange: (r: Round) => void }) {
  const [start, setStart] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const url = inviteUrl(round.inviteCode);

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
          <h2>{round.name}</h2>
          <p className="faint" style={{ marginTop: 4 }}>AI voice interview · about {round.durationMin} minutes · {round.questions.length} core questions with follow-ups</p>
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
            <p className="faint" style={{ marginTop: 6 }}>Send it to applicants. They sign up, upload a CV and book a slot. <Link to={`/i/${round.inviteCode}`} target="_blank">Preview as a candidate</Link></p>
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

export function JobDetail() {
  const { jobId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'candidates';
  const { data, error, setData } = useLoad(() => api.job(jobId), [jobId]);
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
