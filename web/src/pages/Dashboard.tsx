import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, ScoreBadge, initials, useAuth, useLoad, when } from '../lib/util';

export function Dashboard() {
  const { session } = useAuth();
  const { data, error } = useLoad(() => api.dashboard(), []);
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
              <ScoreBadge score={interview.report?.overall} />
            </Link>
          ))}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Coming up</h2></div>
            {data.upcoming.length === 0 && <p className="empty">No interviews booked yet. Share a round's invite link to fill slots.</p>}
            {data.upcoming.map(({ interview, candidate, job }) => (
              <div key={interview.id} className="list-row">
                <Icon name="clock" />
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{candidate.name}</div>
                  <div className="faint ellipsis">{job.title}</div>
                </div>
                <span className="small muted">{when(interview.slotStart)}</span>
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
