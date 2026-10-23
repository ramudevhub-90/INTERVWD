import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { LiveView } from '../api/types';
import { Icon } from '../components/Icon';
import { PageHead, PublicTop } from '../components/Shell';
import { VideoCall } from '../components/VideoCall';
import { Loading, useLoad } from '../lib/util';
import { ScorecardForm } from './CandidateReport';

/** The candidate's side of a person-run round's video call (from their interview link). */
export function CandidateCall() {
  const { id = '' } = useParams();
  const { data, error } = useLoad(() => api.joinCall(id), [id]);
  const [left, setLeft] = useState(false);
  return (
    <>
      <PublicTop right={<span className="faint row"><Icon name="shield" size={16} /> Not recorded</span>} />
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px 40px' }}>
        {!data ? <Loading error={error} /> : (
          <>
            <p className="faint">{data.orgName} · {data.jobTitle}</p>
            <h2 style={{ marginBottom: 4 }}>{data.roundName}</h2>
            <p className="muted small" style={{ marginBottom: 14 }}>Interviewer: {data.interviewers.join(', ') || 'the team'}</p>
            {left ? <div className="card empty"><h3>You left the call</h3><p className="muted small" style={{ marginTop: 6 }}>Reload the page to rejoin. {data.orgName}'s team will email you about next steps.</p></div>
              : <VideoCall seat={data} otherName={data.interviewers[0] ?? 'the interviewer'} onLeave={() => setLeft(true)} />}
          </>
        )}
      </div>
    </>
  );
}

/** The interviewer's side: the call, with the scorecard next to it. */
export function HostCall() {
  const { id = '' } = useParams();
  const seat = useLoad(() => api.hostCall(id), [id]);
  const view = useLoad(() => (seat.data ? api.candidate(seat.data.candidateId) : Promise.resolve(undefined)), [seat.data]);
  const [submitted, setSubmitted] = useState(false);
  if (!seat.data) return <Loading error={seat.error} />;
  const interview = view.data?.interviews.find((i) => i.id === id);
  const round = view.data?.rounds.find((r) => r.id === interview?.roundId);
  return (
    <>
      <PageHead title={`Interview: ${seat.data.candidateName}`} sub={`${seat.data.jobTitle} · ${seat.data.roundName}`}
        crumbs={[{ to: `/app/candidates/${seat.data.candidateId}`, label: seat.data.candidateName }]} />
      <div className="split-wide">
        <VideoCall seat={seat.data} otherName={seat.data.candidateName} />
        <div className="card">
          <h2>Scorecard</h2>
          {submitted || interview?.report ? (
            <p className="muted small" style={{ marginTop: 8 }}>Scorecard saved. <Link to={`/app/candidates/${seat.data.candidateId}`}>See the report and decide</Link></p>
          ) : interview && round ? (
            <>
              {round.questions.length > 0 && (
                <details style={{ marginTop: 8 }}><summary className="small" style={{ cursor: 'pointer' }}>Interview guide</summary>
                  <ol className="small muted" style={{ paddingLeft: 18 }}>{round.questions.map((q) => <li key={q}>{q}</li>)}</ol>
                </details>
              )}
              <ScorecardForm interview={interview} round={round} onDone={() => setSubmitted(true)} />
            </>
          ) : <Loading error={view.error} />}
        </div>
      </div>
    </>
  );
}


/** A recruiter watching an AI interview live: the candidate's video, the transcript, and stepping in. */
export function WatchLive() {
  const { id = '' } = useParams();
  const seat = useLoad(() => api.liveHost(id), [id]);
  const [view, setView] = useState<LiveView>();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const poll = () => api.liveState(id).then((v) => live && setView(v)).catch((e: Error) => live && setErr(e.message));
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [view?.turns.length]);

  if (!seat.data) return <Loading error={seat.error} />;
  const act = async (action: 'ask' | 'take_over' | 'hand_back') => {
    if (action === 'ask' && question.trim().length < 5) return setErr('Type the question for the AI to ask.');
    setBusy(true);
    setErr(undefined);
    try {
      setView(await api.liveControl(id, action, question));
      if (action === 'ask') setQuestion('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const taken = !!view?.takenOverBy;
  const done = view?.status === 'completed';

  return (
    <>
      <PageHead title={`Live: ${seat.data.candidateName}`} sub={`${seat.data.jobTitle} · ${seat.data.roundName} · AI-led${view ? ` · question ${view.progress.question} of ${view.progress.of}` : ''}`}
        crumbs={[{ to: `/app/candidates/${seat.data.candidateId}`, label: seat.data.candidateName }]}>
        {done ? <span className="badge badge-success">Interview finished</span> : taken ? <span className="badge badge-warning">You're leading</span> : <span className="badge badge-accent">AI is leading</span>}
      </PageHead>
      <div className="split-wide">
        <div className="stack">
          {/* Turning your mic or camera on while the AI leads takes over, so nobody talks over the AI */}
          <VideoCall seat={seat.data} otherName={seat.data.candidateName} listenOnly unmuteSignal={taken} onTalk={() => { if (!taken && !done && !busy) act('take_over'); }} />
          {!done && view && (() => {
            const c = view.candidateCall;
            const label = !c ? 'not reported yet (their page may be an older version: ask them to reload)'
              : c.stage === 'connected' ? 'connected' : c.stage === 'joining' ? 'joining…' : c.stage === 'timeout' ? 'couldn’t connect, retrying' : `${c.stage}`;
            const bad = c && ['failed', 'timeout', 'stopped'].includes(c.stage);
            return (
              <p className={`small ${bad ? 'error' : 'faint'}`} style={{ marginTop: -6 }} title={c?.detail}>
                Candidate’s call: {label}{bad && c?.detail ? ` (${c.detail})` : ''}
              </p>
            );
          })()}
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Step in</h3>
            {done ? <p className="muted small">The interview has ended. <Link to={`/app/candidates/${seat.data.candidateId}`}>See the report</Link></p> : (
              <>
                <div className="row">
                  <input value={question} onChange={(e) => { setQuestion(e.target.value); setErr(undefined); }} placeholder="Ask this next: How do you handle a customer who won't calm down?" disabled={taken} />
                  <button className="btn" disabled={busy || taken} onClick={() => act('ask')}>Ask next</button>
                </div>
                <p className="faint" style={{ margin: '6px 0 12px' }}>The AI asks it in its own voice after the current answer, and it counts towards the report.</p>
                {taken
                  ? <button className="btn btn-primary" disabled={busy} onClick={() => act('hand_back')}>Hand back to the AI</button>
                  : <button className="btn btn-primary" disabled={busy} onClick={() => act('take_over')}>Take over (the AI pauses, your mic and camera turn on)</button>}
                {view?.pendingQuestions.length ? <p className="faint" style={{ marginTop: 8 }}>Waiting to be asked: {view.pendingQuestions.join(' · ')}</p> : null}
              </>
            )}
            {err && <p className="error">{err}</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Live transcript</h3><span className="faint">The candidate sees that you're watching</span></div>
          <div className="transcript" ref={log} style={{ maxHeight: 520 }}>
            {(view?.turns ?? []).map((t, i) => (
              <div key={i} className={`bubble ${t.role === 'interviewer' ? 'ai' : 'me'}`} style={{ maxWidth: '100%' }}>
                <div className="faint" style={{ marginBottom: 2 }}>{t.role === 'candidate' ? seat.data!.candidateName.split(' ')[0] : t.kind === 'team_question' ? 'AI · your team’s question' : t.kind === 'handover' ? 'Handover' : 'AI interviewer'}</div>
                {t.text}
              </div>
            ))}
            {!view?.turns.length && <p className="faint">Waiting for the interview to start…</p>}
          </div>
        </div>
      </div>
    </>
  );
}
