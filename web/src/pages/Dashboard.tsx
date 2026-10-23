import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Bars } from './Reports';
import { Loading, ScoreBadge, initials, useAuth, useLoad, when } from '../lib/util';

export function Dashboard() {
  const { session } = useAuth();
  const { data, error } = useLoad(() => api.dashboard(), []);
  const day = useLoad(() => api.hiringDay().catch(() => undefined), []);
  if (!data) return <Loading error={error} />;
  const first = session?.name.split(' ')[0];

  return (
    <>
      <PageHead title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${first}`} sub={`${data.org.name} · here's where hiring stands today.`}>
        <Link className="btn" to="/app/alexa"><Icon name="alexa" /> Ask Alexa+</Link>
        <Link className="btn btn-primary" to="/app/jobs/new"><Icon name="plus" /> New job</Link>
      </PageHead>

      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <div className="stat"><span className="faint">Open jobs</span><b>{data.stats.openJobs}</b></div>
        <div className="stat"><span className="faint">Interviews today</span><b>{data.stats.interviewsToday}</b></div>
        <div className="stat"><span className="faint">Waiting for your decision</span><b>{data.stats.awaitingDecision}</b></div>
        <div className="stat"><span className="faint">Candidates</span><b>{data.stats.candidates}</b></div>
      </div>

      {data.week && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>This week</h2><Link className="btn btn-sm btn-ghost" to="/app/reports"><Icon name="chart" size={14} /> All reports</Link></div>
          <div className="wk">
            <div className={`stat ${data.week.liveNow ? 'wk-live' : ''}`}><span className="faint">Interviewing now</span><b>{data.week.liveNow}</b></div>
            <div className="stat"><span className="faint">Completed</span><b>{data.week.completed}</b></div>
            <div className="stat"><span className="faint">Average score</span><b>{data.week.avgScore == null ? '–' : data.week.avgScore.toFixed(1)}</b></div>
            <div className="stat"><span className="faint">Fast-tracked by AI</span><b>{data.week.fastTracked}</b></div>
            <div className="stat"><span className="faint">Time to decision</span><b>{data.week.avgDecisionHours == null ? '–' : data.week.avgDecisionHours < 1 ? `${Math.round(data.week.avgDecisionHours * 60)}m` : `${data.week.avgDecisionHours.toFixed(1)}h`}</b></div>
            <div className="stat"><span className="faint">Interviews per day</span><Bars data={data.week.daily} height={44} label={((d: { date: string }) => new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'narrow' })) as never} /></div>
          </div>
        </div>
      )}

      {day.data && day.data.rows.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Today at the office</h2><span className="faint">Reception check-ins and Echo Show rooms</span></div>
          <div className="grid cols-4" style={{ gap: 10, marginBottom: 10 }}>
            {([['Interviewed', day.data.counts.done], ['In a room', day.data.counts.in_room], ['Waiting at reception', day.data.counts.arrived], ['No-shows', day.data.counts.no_show]] as const).map(([k, v]) => (
              <div key={k} className="stat" style={{ padding: '10px 12px' }}><span className="faint">{k}</span><b style={{ fontSize: 22 }}>{v}</b></div>
            ))}
          </div>
          {day.data.rows.map((r) => (
            <Link key={r.interviewId} className="list-row" to={`/app/candidates/${r.candidateId}`}>
              <Icon name="clock" />
              <div className="grow"><div style={{ fontWeight: 500 }}>{r.name}</div><div className="faint">{when(r.slotStart)}{r.room ? ` · ${r.room}` : ''}</div></div>
              {(r.state === 'in_room' || r.state === 'arrived') && <Link className="btn btn-sm" to={`/app/live/${r.interviewId}`} onClick={(e) => e.stopPropagation()}><Icon name="eye" size={14} /> Watch</Link>}
              <span className={`badge ${r.state === 'done' ? 'badge-success' : r.state === 'in_room' ? 'badge-accent' : r.state === 'no_show' ? 'badge-danger' : r.state === 'arrived' ? 'badge-warning' : ''}`}>
                {{ expected: 'Expected', arrived: 'At reception', in_room: 'Interviewing', done: 'Done', no_show: 'No-show' }[r.state]}
              </span>
            </Link>
          ))}
        </div>
      )}

      {((data.pending?.length ?? 0) > 0 || (data.identityLocked?.length ?? 0) > 0) && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
          <div className="card-head"><h2>Needs you</h2><span className="faint">Approvals and identity checks</span></div>
          {data.pending?.map(({ candidate, job }) => (
            <Link key={candidate.id} className="list-row" to={`/app/candidates/${candidate.id}`}>
              <div className="avatar">{initials(candidate.name)}</div>
              <div className="grow"><div style={{ fontWeight: 500 }}>{candidate.name}</div><div className="faint ellipsis">Signed up for {job?.title}</div></div>
              <span className="badge badge-warning">Approve profile</span>
            </Link>
          ))}
          {data.identityLocked?.map(({ candidate, job }) => (
            <Link key={candidate.id} className="list-row" to={`/app/candidates/${candidate.id}`}>
              <div className="avatar">{initials(candidate.name)}</div>
              <div className="grow"><div style={{ fontWeight: 500 }}>{candidate.name}</div><div className="faint ellipsis">{job.title} · identity check didn't match</div></div>
              <span className="badge badge-danger">Review photos</span>
            </Link>
          ))}
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><h2>Waiting for your decision</h2><span className="faint">Highest score first</span></div>
          {data.awaiting.length === 0 && <p className="empty">You're all caught up. New reports land here after each interview.</p>}
          {data.awaiting.map(({ interview, candidate, job, round }) => (
            <Link key={interview.id} className="list-row" to={`/app/candidates/${candidate.id}`}>
              <div className="avatar">{initials(candidate.name)}</div>
              <div className="grow">
                <div style={{ fontWeight: 500 }}>{candidate.name}</div>
                <div className="faint ellipsis">{job.title} · {round.name}</div>
              </div>
              {interview.triage?.band === 'review' && <span className="badge badge-warning" title={interview.triage.reasons.join(' ')}>AI unsure</span>}
              <ScoreBadge score={interview.report?.overall} />
            </Link>
          ))}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Coming up</h2></div>
            {data.upcoming.length === 0 && <p className="empty">No interviews booked yet. Share a round's invite link to fill slots.</p>}
            {data.upcoming.map(({ interview, candidate, job, round }) => (
              <div key={interview.id} className="list-row">
                <Icon name="clock" />
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{candidate.name}</div>
                  <div className="faint ellipsis">{job.title} · {round.mode === 'human' ? 'with a person' : 'AI'}</div>
                </div>
                {interview.status === 'in_progress' && round.mode !== 'human'
                  ? <Link className="btn btn-sm btn-primary" to={`/app/live/${interview.id}`}><Icon name="eye" size={14} /> Live now · watch</Link>
                  : <span className="small muted">{when(interview.slotStart)}</span>}
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-head"><h2>Jobs</h2><Link to="/app/jobs" className="small">All jobs</Link></div>
            {data.jobs.map((j) => (
              <Link key={j.id} className="list-row" to={`/app/jobs/${j.id}`}>
                <Icon name="briefcase" />
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{j.title}</div>
                  <div className="faint ellipsis">{j.location}</div>
                </div>
                <span className="faint">{j.candidateCount} candidates</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
