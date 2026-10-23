import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, useLoad } from '../lib/util';

export function Jobs() {
  const { data, error } = useLoad(() => api.dashboard(), []);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHead title="Jobs" sub="Each job has one or more interview rounds.">
        <Link className="btn btn-primary" to="/app/jobs/new"><Icon name="plus" /> New job</Link>
      </PageHead>
      <div className="card">
        {data.jobs.length === 0 && (
          <div className="empty">
            <h3>Create your first job</h3>
            <p className="muted small" style={{ margin: '6px 0 14px' }}>Add the role, then set up its interview rounds.</p>
            <Link className="btn btn-primary" to="/app/jobs/new">New job</Link>
          </div>
        )}
        {data.jobs.map((j) => (
          <Link key={j.id} className="list-row" to={`/app/jobs/${j.id}`}>
            <div className="avatar" style={{ borderRadius: 10 }}><Icon name="briefcase" /></div>
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{j.title}</div>
              <div className="faint ellipsis">{j.location}{j.currentRound ? ` · ${j.currentRound}` : ' · No rounds yet'}</div>
            </div>
            <span className="faint">{j.candidateCount} candidates</span>
            <span className={`badge ${j.status === 'open' ? 'badge-success' : ''}`}>{j.status === 'open' ? 'Open' : 'Closed'}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

export function NewJob() {
  const [form, setForm] = useState({ title: '', location: '', description: '', openings: 1 });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.title.trim().length < 2) return setError('Enter a job title.');
    if (form.description.trim().length < 20) return setError('Describe the role in a sentence or two. The interviewer uses it to shape questions.');
    setBusy(true);
    try {
      const id = await api.createJob(form);
      navigate(`/app/jobs/${id}/rounds/new`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="New job" crumbs={[{ to: '/app/jobs', label: 'Jobs' }]} />
      <form className="card" style={{ maxWidth: 640 }} onSubmit={submit} noValidate>
        <label className="field"><span>Job title</span><input value={form.title} onChange={(e) => { setForm({ ...form, title: e.target.value }); setError(undefined); }} placeholder="Backend Engineer" autoFocus /></label>
        <label className="field"><span>Location</span><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Bengaluru · Hybrid" /></label>
        <label className="field"><span>Openings</span><input type="number" min={1} max={500} value={form.openings} onChange={(e) => setForm({ ...form, openings: Math.max(1, Number(e.target.value) || 1) })} style={{ maxWidth: 140 }} /><span className="faint small">How many people you're hiring for this role</span></label>
        <label className="field">
          <span>About the role</span>
          <textarea value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); setError(undefined); }} placeholder="Build and run the APIs behind our payments platform. Python, AWS, PostgreSQL." rows={4} />
        </label>
        <div className="row">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create job and add a round'}</button>
          <Link className="btn btn-ghost" to="/app/jobs">Cancel</Link>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}
