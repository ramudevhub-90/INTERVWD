import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, useLoad } from '../lib/util';

const VALID = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function Settings() {
  const { data, error, setData } = useLoad(() => api.settings(), []);
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setSlug(data.slug);
  }, [data]);

  if (!data) return <Loading error={error} />;

  const tidy = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 40);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (!VALID.test(slug) || slug.includes('--')) return setErr('Use 3 to 40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.');
    setBusy(true);
    setErr(undefined);
    try {
      setData(await api.saveSettings(slug));
      setSaved(true);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Settings" sub={data.orgName} />
      <form className="card" style={{ maxWidth: 640 }} onSubmit={submit} noValidate>
        <h2>Invite link name</h2>
        <p className="faint" style={{ margin: '4px 0 16px' }}>Your company's name in every invite link candidates see.</p>
        <label className="field">
          <span>Link name</span>
          <div className="row" style={{ gap: 0 }}>
            <span className="small muted" style={{ padding: '9px 10px', border: '1px solid var(--border-strong)', borderRight: 0, borderRadius: 'var(--radius) 0 0 var(--radius)', background: 'var(--surface-2)' }}>intervwd.com/</span>
            <input value={slug} disabled={data.locked} onChange={(e) => { setSlug(tidy(e.target.value)); setErr(undefined); setSaved(false); }}
              style={{ borderRadius: '0 var(--radius) var(--radius) 0' }} aria-label="Link name" />
          </div>
        </label>
        <p className="small" style={{ marginBottom: 14 }}>
          <Icon name="link" size={14} /> Links will look like <b>intervwd.com/{slug || 'your-company'}/backend-engineer-r1</b>
        </p>
        {data.locked ? (
          <p className="notice">The demo company's link name is fixed, so links shared with other visitors keep working.</p>
        ) : (
          <>
            <p className="faint" style={{ marginBottom: 14 }}>Links you've already sent keep working after a change, and your old name stays yours.</p>
            <button className="btn btn-primary" disabled={busy || slug === data.slug}>{busy ? 'Saving…' : 'Save link name'}</button>
          </>
        )}
        {saved && <p className="small" style={{ color: 'var(--success)', marginTop: 10 }}>Saved. New links use intervwd.com/{data.slug}/…</p>}
        {err && <p className="error">{err}</p>}
      </form>
    </>
  );
}
