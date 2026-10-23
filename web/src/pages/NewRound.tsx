import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, useLoad } from '../lib/util';

// Starting points so a recruiter can create a sensible round in one click, then edit.
const TEMPLATES: Record<string, { name: string; criteria: [string, string][]; questions: string[] }> = {
  screen: {
    name: 'First screen',
    criteria: [['Relevant experience', 'Has done work close to this role'], ['Motivation', 'Knows why this role and this company'], ['Communication', 'Clear, structured answers']],
    questions: ['Tell me about your current or most recent role, and what you were responsible for.', 'What made you apply for this role?', 'Describe a piece of work you are proud of. What was your part in it?', 'What would you want to learn in your first three months here?'],
  },
  technical: {
    name: 'Technical interview',
    criteria: [['Technical depth', 'Knows the core tools of the role well'], ['Problem solving', 'Breaks problems down and checks assumptions'], ['Communication', 'Explains technical ideas clearly']],
    questions: ['Walk me through a technical problem you solved recently, step by step.', 'How do you make sure your work is correct before it ships?', 'Tell me about a time something you built failed. What did you learn?', 'How would you explain your last project to someone non-technical?'],
  },
  situational: {
    name: 'Situational interview',
    criteria: [['Judgement', 'Makes sound decisions under pressure'], ['People skills', 'Handles conflict and feedback well'], ['Ownership', 'Follows through and takes responsibility']],
    questions: ['Tell me about a time you had to make a decision with incomplete information.', 'Describe a disagreement with a colleague. How did you resolve it?', 'Tell me about a time you missed a goal. What did you do next?'],
  },
};

export function NewRound() {
  const { jobId = '' } = useParams();
  const { data, error: loadError } = useLoad(() => api.job(jobId), [jobId]);
  const [form, setForm] = useState(() => ({
    name: TEMPLATES.screen.name, durationMin: 20, criteria: TEMPLATES.screen.criteria.map(([name, description]) => ({ name, description })),
    questions: [...TEMPLATES.screen.questions], identityCheck: true, requireApproval: true,
    decisionMode: 'human' as 'human' | 'auto', autoAdvance: { minOverall: 4.0, minEach: 3.0 },
    mode: 'ai' as 'ai' | 'human', meetingUrl: '', interviewers: [{ name: '', email: '' }],
    location: 'online' as 'online' | 'office',
  }));
  const office = form.location === 'office';
  const human = form.mode === 'human';
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!data) return <Loading error={loadError} />;

  const use = (key: string) => {
    const t = TEMPLATES[key];
    setForm({ ...form, name: t.name, criteria: t.criteria.map(([name, description]) => ({ name, description })), questions: [...t.questions] });
    setError(undefined);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const criteria = form.criteria.filter((c) => c.name.trim());
    const questions = form.questions.map((q) => q.trim()).filter(Boolean);
    if (!form.name.trim()) return setError('Name the round, for example "Technical interview".');
    if (criteria.length < 1) return setError('Add at least one thing to assess.');
    if (questions.length < 2) return setError('Add at least two questions.');
    const interviewers = form.interviewers.filter((i) => i.name.trim());
    if (human && !interviewers.length) return setError('Add the person who runs this round.');
    if (human && form.meetingUrl.trim() && !/^https:\/\/\S+$/.test(form.meetingUrl.trim())) return setError('The meeting link must start with https://');
    setBusy(true);
    try {
      await api.createRound(jobId, { ...form, criteria, questions, interviewers: form.interviewers.filter((i) => i.name.trim()), meetingUrl: office ? '' : form.meetingUrl.trim() });
      navigate(`/app/jobs/${jobId}?tab=rounds`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const nextIndex = data.rounds.length + 1;

  return (
    <>
      <PageHead title={`Add Round ${nextIndex}`} sub={data.job.title} crumbs={[{ to: '/app/jobs', label: 'Jobs' }, { to: `/app/jobs/${jobId}`, label: data.job.title }]} />
      <form onSubmit={submit} noValidate className="stack" style={{ maxWidth: 820 }}>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Start from</h3>
          <div className="row wrap">
            {Object.entries(TEMPLATES).map(([k, t]) => (
              <button type="button" key={k} className={`chip ${form.name === t.name ? 'badge-accent' : ''}`} onClick={() => use(k)}>{t.name}</button>
            ))}
          </div>
          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <label className="field"><span>Round name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">
              <span>Length</span>
              <select value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })}>
                {[10, 15, 20, 30, 45].map((m) => <option key={m} value={m}>About {m} minutes</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Who interviews</h3>
          <div className="grid cols-2" style={{ gap: 10 }}>
            {([
              ['ai', 'AI voice interview', 'Nova interviews by voice, tailored to each CV, and scores it. Candidates take it any time in their slot.'],
              ['human', 'A person, by video call', 'Someone from your team runs it on Meet, Zoom, Teams or Chime and fills in a scorecard.'],
            ] as const).map(([m, label, hint]) => (
              <label key={m} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer', padding: '10px 12px', borderRadius: 'var(--radius)', border: `1px solid ${form.mode === m ? 'var(--accent)' : 'var(--border)'}` }}>
                <input type="radio" name="mode" checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} style={{ width: 16, marginTop: 3 }} />
                <span><span className="small" style={{ fontWeight: 600 }}>{label}</span><br /><span className="faint">{hint}</span></span>
              </label>
            ))}
          </div>
          <h3 style={{ margin: '18px 0 10px' }}>Where</h3>
          <div className="grid cols-2" style={{ gap: 10 }}>
            {([
              ['online', 'Online', human ? 'A video call: Intervwd hosts it, or use your own meeting link.' : 'Candidates take it on their laptop or phone, or their own Echo Show.'],
              ['office', 'At the office', human ? 'Candidates check in with Alexa at reception; the interviewer collects them.' : 'Candidates check in with Alexa at reception and are interviewed by Alexa on an Echo Show in an interview room.'],
            ] as const).map(([w, label, hint]) => (
              <label key={w} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer', padding: '10px 12px', borderRadius: 'var(--radius)', border: `1px solid ${form.location === w ? 'var(--accent)' : 'var(--border)'}` }}>
                <input type="radio" name="location" checked={form.location === w} onChange={() => setForm({ ...form, location: w })} style={{ width: 16, marginTop: 3 }} />
                <span><span className="small" style={{ fontWeight: 600 }}>{label}</span><br /><span className="faint">{hint}</span></span>
              </label>
            ))}
          </div>
          {office && <p className="faint" style={{ marginTop: 8 }}>Uses the office address and Echo Show rooms in <Link to="/app/settings">Settings</Link>.</p>}
          {human && (
            <div style={{ marginTop: 14 }}>
              {!office && <label className="field"><span>Meeting link (optional: leave empty and Intervwd hosts the call)</span>
                <input value={form.meetingUrl} onChange={(e) => setForm({ ...form, meetingUrl: e.target.value })} placeholder="https://meet.google.com/abc-defg-hij" />
              </label>}
              <span className="small" style={{ fontWeight: 500, color: 'var(--text-2)' }}>Interviewers</span>
              {form.interviewers.map((p, i) => (
                <div key={i} className="row" style={{ marginTop: 8 }}>
                  <input value={p.name} onChange={(e) => setForm({ ...form, interviewers: form.interviewers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Dana Lee" aria-label="Interviewer name" />
                  <input type="email" value={p.email} onChange={(e) => setForm({ ...form, interviewers: form.interviewers.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })} placeholder="dana@company.com" aria-label="Interviewer email" />
                  <button type="button" className="btn btn-ghost" onClick={() => setForm({ ...form, interviewers: form.interviewers.filter((_, j) => j !== i) })} aria-label="Remove interviewer"><Icon name="x" /></button>
                </div>
              ))}
              <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setForm({ ...form, interviewers: [...form.interviewers, { name: '', email: '' }] })}><Icon name="plus" size={15} /> Add interviewer</button>
              <p className="faint" style={{ marginTop: 8 }}>They're emailed each booking with the candidate's profile, earlier rounds and a scorecard link.</p>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h3>What to assess</h3><span className="faint">Each is scored 1 to 5 with quoted evidence</span></div>
          {form.criteria.map((c, i) => (
            <div key={i} className="row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
              <input value={c.name} onChange={(e) => setForm({ ...form, criteria: form.criteria.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Problem solving" style={{ flex: 1 }} aria-label="Criterion name" />
              <input value={c.description} onChange={(e) => setForm({ ...form, criteria: form.criteria.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} placeholder="What good looks like" style={{ flex: 2 }} aria-label="What good looks like" />
              <button type="button" className="btn btn-ghost" onClick={() => setForm({ ...form, criteria: form.criteria.filter((_, j) => j !== i) })} aria-label="Remove criterion"><Icon name="x" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, criteria: [...form.criteria, { name: '', description: '' }] })}><Icon name="plus" size={15} /> Add criterion</button>
        </div>

        <div className="card">
          <div className="card-head"><h3>{human ? 'Interview guide' : 'Core questions'}</h3><span className="faint">{human ? 'Suggested questions for the interviewer' : 'The AI tailors them to each CV and adds follow-ups'}</span></div>
          {form.questions.map((q, i) => (
            <div key={i} className="row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
              <span className="faint" style={{ width: 18, marginTop: 10 }}>{i + 1}</span>
              <textarea rows={2} value={q} onChange={(e) => setForm({ ...form, questions: form.questions.map((x, j) => (j === i ? e.target.value : x)) })} style={{ minHeight: 0 }} aria-label={`Question ${i + 1}`} />
              <button type="button" className="btn btn-ghost" onClick={() => setForm({ ...form, questions: form.questions.filter((_, j) => j !== i) })} aria-label="Remove question"><Icon name="x" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, questions: [...form.questions, ''] })}><Icon name="plus" size={15} /> Add question</button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Who gets in</h3>
          {([
            ['requireApproval', 'Approve sign-ups first', 'People who sign up through the invite link wait for your approval before they get their interview link. Candidates you add yourself are approved already.'],
            ...(human ? [] : [['identityCheck', 'Identity check required', 'Candidates upload a face photo with their profile. Before the interview starts, a live camera check must match it (Amazon Rekognition). After 3 failed tries the interview is locked until you let them in. It never rejects anyone by itself.'] as const]),
          ] as const).map(([key, label, hint]) => (
            <label key={key} className="row" style={{ alignItems: 'flex-start', padding: '8px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
              <span><span className="small" style={{ fontWeight: 600 }}>{label}</span><br /><span className="faint">{hint}</span></span>
            </label>
          ))}
        </div>

        {!human && <div className="card">
          <h3 style={{ marginBottom: 4 }}>Decisions</h3>
          <p className="faint" style={{ marginBottom: 10 }}>Who moves candidates to the next round after this one.</p>
          {([
            ['human', 'A person decides everything', 'Every finished interview waits for you.'],
            ['auto', 'AI fast-tracks clear passes', 'Candidates clearly above your bar, where the AI is confident, move on straight away. If the AI is unsure (close to the bar, mixed scores, thin answers, an identity problem) or the score is below the bar, a person decides. The AI never rejects anyone.'],
          ] as const).map(([mode, label, hint]) => (
            <label key={mode} className="row" style={{ alignItems: 'flex-start', padding: '8px 0', cursor: 'pointer' }}>
              <input type="radio" name="decisionMode" checked={form.decisionMode === mode} onChange={() => setForm({ ...form, decisionMode: mode })} style={{ width: 16, marginTop: 3 }} />
              <span><span className="small" style={{ fontWeight: 600 }}>{label}</span><br /><span className="faint">{hint}</span></span>
            </label>
          ))}
          {form.decisionMode === 'auto' && (
            <div className="grid cols-2" style={{ gap: 12, marginTop: 6 }}>
              <label className="field"><span>Overall score at least</span>
                <select value={form.autoAdvance.minOverall} onChange={(e) => setForm({ ...form, autoAdvance: { ...form.autoAdvance, minOverall: Number(e.target.value) } })}>
                  {[3.5, 3.8, 4.0, 4.2, 4.5].map((v) => <option key={v} value={v}>{v.toFixed(1)} / 5</option>)}
                </select>
              </label>
              <label className="field"><span>Every criterion at least</span>
                <select value={form.autoAdvance.minEach} onChange={(e) => setForm({ ...form, autoAdvance: { ...form.autoAdvance, minEach: Number(e.target.value) } })}>
                  {[2.5, 3.0, 3.5, 4.0].map((v) => <option key={v} value={v}>{v.toFixed(1)} / 5</option>)}
                </select>
              </label>
            </div>
          )}
        </div>}

        <div className="row">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create round'}</button>
          <Link className="btn btn-ghost" to={`/app/jobs/${jobId}`}>Cancel</Link>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}
