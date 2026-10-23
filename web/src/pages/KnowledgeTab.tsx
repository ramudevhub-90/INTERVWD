import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { KnowledgeKind } from '../api/types';
import { Icon } from '../components/Icon';
import { Loading, useLoad, when } from '../lib/util';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.doc,.docx,.txt,.md,.html,.csv';

const KIND: Record<KnowledgeKind, { label: string; hint: string; tone: string }> = {
  interviewer: { label: 'Interviewer only', hint: 'Question banks, what a strong answer looks like, your systems and real scenarios. Shapes questions, follow-ups and scoring. Never shown to candidates.', tone: 'badge-accent' },
  shareable: { label: 'Candidates can ask', hint: 'About the company, team, benefits and hiring process. Used to answer candidates\' questions at the end of the interview.', tone: 'badge-success' },
};

const STATUS = { pending: ['Waiting to sync', ''], syncing: ['Syncing', 'badge-warning'], ready: ['Ready', 'badge-success'], failed: ['Sync failed', 'badge-danger'] } as const;

const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function KnowledgeTab({ jobId }: { jobId: string }) {
  const { data, error, reload } = useLoad(() => api.knowledge(jobId), [jobId]);
  const [kind, setKind] = useState<KnowledgeKind>('interviewer');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  // Bedrock syncs in the background; check again until every document is ready.
  const syncing = data?.documents.some((d) => d.status === 'pending' || d.status === 'syncing');
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [syncing, data, reload]);

  if (!data) return <Loading error={error} />;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setErr(undefined);
    if (mode === 'file') {
      if (!file) return setErr('Choose a file first.');
      if (file.size > MAX_BYTES) return setErr('Documents can be up to 10 MB.');
    } else if (text.trim().length < 20) return setErr('Write or paste at least a sentence or two.');
    setBusy(true);
    try {
      await api.addKnowledge(jobId, mode === 'file' ? { kind, file: file! } : { kind, name: name.trim() || 'Notes', text });
      setFile(undefined);
      setName('');
      setText('');
      reload();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (docId: string) => {
    try {
      await api.removeKnowledge(jobId, docId);
      reload();
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <form className="card" onSubmit={add} noValidate>
        <h2>Add knowledge</h2>
        <p className="faint" style={{ margin: '4px 0 14px' }}>Every round of this job uses it. Stored with Amazon Bedrock Knowledge Bases on S3 Vectors.</p>
        {!data.enabled && <p className="notice" style={{ marginBottom: 14 }}>The knowledge base isn't connected on this server yet.</p>}

        <div className="stack" style={{ gap: 8, marginBottom: 14 }} role="radiogroup" aria-label="Who can use it">
          {(Object.keys(KIND) as KnowledgeKind[]).map((k) => (
            <label key={k} className="row" style={{ alignItems: 'flex-start', cursor: 'pointer', padding: '10px 12px', borderRadius: 'var(--radius)', border: `1px solid ${kind === k ? 'var(--accent)' : 'var(--border)'}` }}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} style={{ width: 16, marginTop: 3 }} />
              <span><span className="small" style={{ fontWeight: 600 }}>{KIND[k].label}</span><br /><span className="faint">{KIND[k].hint}</span></span>
            </label>
          ))}
        </div>

        <div className="tabs" style={{ marginBottom: 12 }}>
          <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>Upload a file</button>
          <button type="button" className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Paste text</button>
        </div>
        {mode === 'file' ? (
          <label style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', padding: 14, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: 14 }}>
            <Icon name={file ? 'file' : 'upload'} />
            <span className="small" style={{ flex: 1 }}>{file ? `${file.name} · ${size(file.size)}` : 'PDF, Word, text, Markdown, HTML or CSV (up to 10 MB)'}</span>
            <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => { setFile(e.target.files?.[0]); setErr(undefined); }} />
          </label>
        ) : (
          <>
            <label className="field"><span>Title</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team and stack" /></label>
            <label className="field"><span>Text</span><textarea rows={6} value={text} onChange={(e) => { setText(e.target.value); setErr(undefined); }} placeholder="Our checkout runs on DynamoDB and handles 50k orders an hour during sales…" /></label>
          </>
        )}
        <button className="btn btn-primary" disabled={busy || !data.enabled}>{busy ? 'Adding…' : 'Add to knowledge base'}</button>
        {err && <p className="error">{err}</p>}
      </form>

      <div className="card">
        <div className="card-head"><h2>Documents</h2><span className="faint">{data.documents.length} of 25</span></div>
        {data.documents.length === 0 && (
          <div className="empty">
            <h3>No documents yet</h3>
            <p className="muted small" style={{ marginTop: 6 }}>Without them, the interviewer works from the job description, the rubric and each CV.</p>
          </div>
        )}
        {data.documents.map((d) => (
          <div key={d.id} className="list-row">
            <Icon name="file" />
            <div className="grow">
              <div className="small ellipsis" style={{ fontWeight: 500 }}>{d.name}</div>
              <div className="faint">{size(d.size)} · added {when(d.createdAt)}</div>
            </div>
            <span className={`badge ${KIND[d.kind].tone}`}>{KIND[d.kind].label}</span>
            <span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => remove(d.id)} aria-label={`Remove ${d.name}`}><Icon name="trash" size={15} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
