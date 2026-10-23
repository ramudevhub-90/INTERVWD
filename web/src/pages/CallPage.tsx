import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
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
            <h2 style={{ marginBottom: 14 }}>{data.roundName} with {data.interviewers.join(', ') || 'the team'}</h2>
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
