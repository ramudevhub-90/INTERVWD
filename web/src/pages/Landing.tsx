import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { useAuth } from '../lib/util';
import './landing.css';

// The product page at intervwd.com: what Intervwd does, for companies (and judges) seeing it first.

type IconName = Parameters<typeof Icon>[0]['name'];

/** The hero's live interview, replayed: the AI asks, the candidate answers, a recruiter joins. */
const SCRIPT: { who: 'ai' | 'cand' | 'team' | 'note'; text: string }[] = [
  { who: 'ai', text: 'Hi Asha, thanks for joining. Walk me through a serverless service you built on AWS.' },
  { who: 'cand', text: 'I built an orders API on Lambda and DynamoDB, deployed with CDK…' },
  { who: 'ai', text: 'How did you keep a retried request from charging twice?' },
  { who: 'note', text: 'Priya from Northwind Labs is watching' },
  { who: 'cand', text: 'Every request carries an idempotency key, written with the charge in one transaction.' },
  { who: 'team', text: 'Great answer. Let me ask about on-call next.' },
];

function LiveDemo() {
  const [shown, setShown] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setShown((n) => (n >= SCRIPT.length + 2 ? 1 : n + 1)), 1900);
    return () => clearInterval(t);
  }, []);
  const lines = SCRIPT.slice(0, Math.min(shown, SCRIPT.length));
  const watching = shown >= 4;
  const takeover = shown >= 6;
  return (
    <div className="lp-demo" aria-label="A live AI interview, as the recruiter sees it">
      <div className="lp-demo-top">
        <span className="lp-dot" /> <b>Live</b><span className="lp-hide-sm"> · Asha Nair · AWS Developer</span>
        <span className={`lp-chip ${takeover ? 'warn' : ''}`}>{takeover ? 'Priya has taken over' : 'AI is leading'}</span>
      </div>
      <div className="lp-demo-body">
        <div className="lp-cam">
          <div className="lp-face"><span>AN</span></div>
          {watching && <div className="lp-pip"><span>PS</span></div>}
          <span className="lp-cam-tag"><Icon name="check" size={12} /> Identity matched</span>
        </div>
        <div className="lp-lines">
          {lines.map((l, i) => (
            <div key={i} className={`lp-line ${l.who}`}>
              {l.who === 'note' ? <><Icon name="eye" size={13} /> {l.text}</> : (
                <>
                  <small>{l.who === 'ai' ? 'AI interviewer' : l.who === 'team' ? 'Priya (recruiter)' : 'Asha'}</small>
                  {l.text}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="lp-demo-foot">
        <span className="lp-wave" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 70}ms` }} />)}</span>
        <span className="faint small">{takeover ? 'Priya’s mic and camera are on' : 'Listening… the answer ends when Asha pauses'}</span>
      </div>
    </div>
  );
}

const FEATURES: { icon: IconName; title: string; text: string; tag: string }[] = [
  { icon: 'mic', title: 'A real conversation, by voice', text: 'Nova tailors each question to the role and the CV, asks a follow-up when an answer is thin, and carries on when the candidate pauses. No buttons to press.', tag: 'Amazon Nova · Polly' },
  { icon: 'eye', title: 'Join any AI interview live', text: 'Watch the video and live transcript, queue a question for the AI to ask, or take over with your own mic and camera, then hand back. The candidate always sees who is watching.', tag: 'Amazon Chime SDK' },
  { icon: 'shield', title: 'It’s really them', text: 'A live face check before the interview, against the photo on their profile. Three misses lock it until a recruiter looks. It never rejects anyone, and photos are deleted after the decision.', tag: 'Amazon Rekognition' },
  { icon: 'sparkle', title: 'AI fast-track, people decide', text: 'Clear passes can move on automatically. When the AI is unsure (close to the bar, mixed scores, thin answers, a CV in someone else’s name) it says why, and a person decides.', tag: 'Triage with reasons' },
  { icon: 'users', title: 'Mix AI and human rounds', text: 'Round 1 by AI, Round 2 a video call with your engineer, Round 3 AI again. Built-in calls, calendar invites and scorecards, every round in one profile.', tag: 'Any order' },
  { icon: 'alexa', title: 'Hiring day at the office', text: 'Candidates say “Alexa, I’m here for my interview” at reception. Alexa checks their face, sends them to a room, and the Echo Show there runs the interview.', tag: 'Alexa · Echo Show' },
  { icon: 'chart', title: 'Your pipeline on Alexa+', text: '“Alexa, how did today’s interviews go?” Hear who’s waiting, compare candidates and move them on hands-free, with a confirmation before anything changes.', tag: 'MCP for Alexa+' },
  { icon: 'play', title: 'Practice that never leaks', text: 'Candidates warm up with Alexa on different questions, checked so they never resemble the real ones, with coaching after each answer. Nothing is shared with the company.', tag: 'Fair to everyone' },
];

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'briefcase', title: 'Create a round', text: 'Pick what to assess, the core questions, AI or a person, online or at the office.' },
  { icon: 'link', title: 'Share one link', text: 'intervwd.com/your-company/role, on WhatsApp or email. Candidates sign up, add a CV, and start now or book a time.' },
  { icon: 'mic', title: 'The AI interviews', text: 'By voice, on a laptop, a phone or an Echo Show. Your team can watch and step in.' },
  { icon: 'check', title: 'You decide', text: 'A scored report with quoted evidence and the full transcript. Move people on from the web or Alexa+.' },
];

const STACK = ['Amazon Nova 2 Lite', 'Amazon Bedrock', 'Amazon Polly', 'Amazon Rekognition', 'Amazon Chime SDK', 'Alexa+ (MCP)', 'AWS Lambda', 'Amazon DynamoDB', 'Amazon S3', 'Amazon CloudFront', 'Amazon SES', 'AWS CDK'];

export function Landing() {
  const { session } = useAuth();
  const signedIn = session?.role === 'recruiter';
  const demo = signedIn ? '/app' : '/signin';
  return (
    <div className="lp">
      <PublicTop
        right={signedIn ? (
          <Link className="btn btn-primary" to="/app">Open dashboard</Link>
        ) : (
          <>
            <a className="btn btn-ghost lp-hide-sm" href="#features">Features</a>
            <Link className="btn btn-ghost" to="/signin">Sign in</Link>
            <Link className="btn btn-primary lp-hide-sm" to="/signup">Set up your company</Link>
          </>
        )}
      />

      <section className="lp-hero">
        <div className="lp-glow" aria-hidden="true" />
        <div className="lp-hero-text">
          <span className="eyebrow">AI interviews · built on AWS, ready for Alexa+</span>
          <h1>The first interview, done by AI. <span className="lp-grad">Every decision, made by people.</span></h1>
          <p className="lead">
            Intervwd interviews every candidate by voice, the same fair way, at any hour. Your team watches live when it wants, steps in when it matters, and decides from scored reports with quoted evidence.
          </p>
          <div className="row wrap">
            <Link className="btn btn-primary btn-lg" to={demo}>Try the live demo <Icon name="arrowRight" /></Link>
            <Link className="btn btn-lg" to="/signup">Set up your company</Link>
          </div>
          <p className="faint" style={{ marginTop: 14 }}>Demo company: Northwind Labs · sign in with demo@intervwd.com</p>
          <div className="lp-proof">
            <div><b>24/7</b><span>candidates start when they’re ready</span></div>
            <div><b>0</b><span>automatic rejections</span></div>
            <div><b>1 link</b><span>per round, in your company’s name</span></div>
          </div>
        </div>
        <LiveDemo />
      </section>

      <section className="lp-section">
        <p className="lp-kicker">How it works</p>
        <h2>From job post to shortlist in four steps</h2>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <div className="row" style={{ gap: 10 }}><span className="lp-step-n">{i + 1}</span><Icon name={s.icon} size={18} /></div>
              <h3>{s.title}</h3>
              <p className="muted small">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-section" id="features">
        <p className="lp-kicker">What makes it different</p>
        <h2>An AI interviewer your team can trust, and take over</h2>
        <div className="lp-features">
          {FEATURES.map((f) => (
            <article key={f.title} className="lp-feature">
              <div className="ico"><Icon name={f.icon} /></div>
              <h3>{f.title}</h3>
              <p className="muted small">{f.text}</p>
              <span className="lp-tag">{f.tag}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-split">
          <div>
            <p className="lp-kicker">The report</p>
            <h2>Scores you can check, not a black box</h2>
            <p className="muted" style={{ marginTop: 10 }}>Every criterion is scored 1 to 5 with a quote from the answer and the AI’s confidence. Everyone in a round gets the same core questions and rubric, reworded to fit their CV, so comparisons are fair.</p>
            <ul className="lp-ticks">
              <li><Icon name="check" size={16} /> Full transcript and camera snapshots</li>
              <li><Icon name="check" size={16} /> “AI unsure”, with the reasons, so you know where to look</li>
              <li><Icon name="check" size={16} /> No guesses about gender, or anything else, from a name</li>
            </ul>
          </div>
          <div className="card lp-report" aria-label="Example interview report">
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
            <p className="small muted">“Every request carries an idempotency key, stored with the charge in the same transaction…”</p>
            <div className="lp-triage"><Icon name="sparkle" size={14} /> Clear pass: fast-tracked to Round 2</div>
            <div className="row" style={{ marginTop: 14 }}>
              <span className="btn btn-primary btn-sm">Move to Round 2</span>
              <span className="btn btn-sm">Hold</span>
              <span className="faint" style={{ marginLeft: 'auto' }}>You decide</span>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <p className="lp-kicker">Fair by design</p>
        <h2>Built so candidates can trust it too</h2>
        <div className="lp-trust">
          <div><Icon name="shield" size={22} /><h3>People decide</h3><p className="muted small">The AI can only move someone forward. Rejections are always a person’s call.</p></div>
          <div><Icon name="eye" size={22} /><h3>No hidden watchers</h3><p className="muted small">Candidates see the moment anyone joins, and who it is.</p></div>
          <div><Icon name="trash" size={22} /><h3>Faces deleted</h3><p className="muted small">Identity photos are deleted once the company decides, or after 30 days.</p></div>
          <div><Icon name="keyboard" size={22} /><h3>Accessible</h3><p className="muted small">Type instead of speaking, repeat any question, or continue without a camera.</p></div>
        </div>
      </section>

      <section className="lp-section">
        <p className="lp-kicker">Built on AWS</p>
        <h2>Serverless, end to end</h2>
        <div className="lp-stack">{STACK.map((s) => <span key={s}>{s}</span>)}</div>
      </section>

      <section className="lp-section">
        <div className="lp-cta">
          <h2>See a whole interview in two minutes</h2>
          <p>Sign in to the Northwind Labs demo: watch an interview live, read the reports, and run the office hiring day.</p>
          <div className="row wrap" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-lg lp-cta-btn" to={demo}>Try the live demo <Icon name="arrowRight" /></Link>
            <Link className="btn btn-lg lp-cta-ghost" to="/signup">Set up your company</Link>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>Intervwd · Built for the Amazon Build, Ship, Shape hackathon</span>
        <span>Candidates: use the invite link your recruiter sent you.</span>
      </footer>
    </div>
  );
}
