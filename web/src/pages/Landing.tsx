import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { useAuth } from '../lib/util';

export function Landing() {
  const { session } = useAuth();
  return (
    <>
      <PublicTop
        right={session?.role === 'recruiter' ? (
          <Link className="btn btn-primary" to="/app">Open dashboard</Link>
        ) : (
          <>
            <Link className="btn btn-ghost" to="/signin">Sign in</Link>
            <Link className="btn btn-primary" to="/signup">Set up your company</Link>
          </>
        )}
      />

      <section className="hero">
        <div>
          <span className="eyebrow">AI interviews · built for Alexa+</span>
          <h1>Every candidate gets a fair, structured first interview.</h1>
          <p className="lead">
            Set up a round, share one link, and Intervwd's AI interviewer talks with each candidate by voice, asking questions shaped by the role and their CV. You get scored reports with evidence. You make every decision.
          </p>
          <div className="row wrap">
            <Link className="btn btn-primary btn-lg" to="/signup">Set up your company <Icon name="arrowRight" /></Link>
            <Link className="btn btn-lg" to="/signin">Try the demo</Link>
          </div>
          <p className="faint" style={{ marginTop: 14 }}>Demo sign-in: demo@intervwd.com</p>
        </div>

        <div className="card" aria-label="Example interview report">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row">
              <div className="avatar">RM</div>
              <div>
                <div style={{ fontWeight: 600 }}>Rahul Mehta</div>
                <div className="faint">Backend Engineer · Round 1</div>
              </div>
            </div>
            <span className="badge badge-success score">4.1 / 5</span>
          </div>
          {[['Python and APIs', 4.5], ['System design', 3.8], ['Problem solving', 4.2], ['Communication', 4.0]].map(([n, s]) => (
            <div className="row" key={n} style={{ padding: '7px 0' }}>
              <span className="small" style={{ width: 130 }}>{n}</span>
              <span className="meter"><i style={{ width: `${(Number(s) / 5) * 100}%` }} /></span>
              <span className="small score" style={{ width: 28, textAlign: 'right' }}>{Number(s).toFixed(1)}</span>
            </div>
          ))}
          <div className="divider" style={{ margin: '12px 0' }} />
          <p className="small muted">"Every request carries an idempotency key, stored with the charge in the same transaction…"</p>
          <div className="row" style={{ marginTop: 14 }}>
            <span className="btn btn-primary btn-sm">Move to Round 2</span>
            <span className="btn btn-sm">Hold</span>
            <span className="faint" style={{ marginLeft: 'auto' }}>You decide</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2 style={{ marginBottom: 18 }}>How it works</h2>
        <ol className="steps" style={{ padding: 0, margin: 0 }}>
          <li><h3>Create a round</h3><p className="muted small" style={{ marginTop: 6 }}>Pick what to assess and the core questions. Any round: screen, technical, situational.</p></li>
          <li><h3>Share one link</h3><p className="muted small" style={{ marginTop: 6 }}>Candidates sign up, upload their CV and book a slot that suits them.</p></li>
          <li><h3>AI interviews by voice</h3><p className="muted small" style={{ marginTop: 6 }}>Questions follow the role and the CV, with a follow-up on every answer.</p></li>
          <li><h3>You decide</h3><p className="muted small" style={{ marginTop: 6 }}>Read the scored report and transcript, then move people on, on the web or on Alexa+.</p></li>
        </ol>
      </section>

      <section className="section">
        <div className="grid cols-3">
          <div className="feature"><div className="ico"><Icon name="alexa" /></div><h3>Your pipeline on Alexa+</h3><p className="muted small" style={{ marginTop: 6 }}>"Alexa, how did today's interviews go?" Compare candidates and move them on hands-free, with a confirmation before anything changes.</p></div>
          <div className="feature"><div className="ico"><Icon name="shield" /></div><h3>Humans make the call</h3><p className="muted small" style={{ marginTop: 6 }}>The AI scores and quotes evidence. It never rejects anyone. Camera snapshots are for your team to review; there's no face recognition.</p></div>
          <div className="feature"><div className="ico"><Icon name="chart" /></div><h3>Same questions, same rubric</h3><p className="muted small" style={{ marginTop: 6 }}>Every candidate in a round gets the same core questions and is scored on the same criteria, so comparisons are fair.</p></div>
        </div>
      </section>

      <footer className="footer">
        <span>Intervwd · Built for the Amazon Build, Ship, Shape hackathon</span>
        <span>Candidates: use the invite link your recruiter sent you.</span>
      </footer>
    </>
  );
}
