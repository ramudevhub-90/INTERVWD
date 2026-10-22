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
  const [form, setForm] = useState(() => ({ name: TEMPLATES.screen.name, durationMin: 20, criteria: TEMPLATES.screen.criteria.map(([name, description]) => ({ name, description })), questions: [...TEMPLATES.screen.questions] }));
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
    setBusy(true);
    try {
      await api.createRound(jobId, { ...form, criteria, questions });
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
          <div className="card-head"><h3>Core questions</h3><span className="faint">The AI tailors them to each CV and adds follow-ups</span></div>
          {form.questions.map((q, i) => (
            <div key={i} className="row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
              <span className="faint" style={{ width: 18, marginTop: 10 }}>{i + 1}</span>
              <textarea rows={2} value={q} onChange={(e) => setForm({ ...form, questions: form.questions.map((x, j) => (j === i ? e.target.value : x)) })} style={{ minHeight: 0 }} aria-label={`Question ${i + 1}`} />
              <button type="button" className="btn btn-ghost" onClick={() => setForm({ ...form, questions: form.questions.filter((_, j) => j !== i) })} aria-label="Remove question"><Icon name="x" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setForm({ ...form, questions: [...form.questions, ''] })}><Icon name="plus" size={15} /> Add question</button>
        </div>

        <div className="row">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create round'}</button>
          <Link className="btn btn-ghost" to={`/app/jobs/${jobId}`}>Cancel</Link>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}
