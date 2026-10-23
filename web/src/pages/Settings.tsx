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
      <OfficeSettings />
    </>
  );
}

function OfficeSettings() {
  const { data, error, setData } = useLoad(() => api.settings(), []);
  const [address, setAddress] = useState('');
  const [rooms, setRooms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!data) return;
    setAddress(data.office.address);
    setRooms(data.office.rooms.length ? data.office.rooms : ['Room 1']);
  }, [data]);
  if (!data) return <Loading error={error} />;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    setSaved(false);
    try {
      setData(await api.saveOffice(address, rooms.filter((r) => r.trim())));
      setSaved(true);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const kiosk = async () => {
    try {
      setData(await api.newKiosk());
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };
  const roomUrl = (r: string) => `${data.kiosk}/room/${encodeURIComponent(r)}`;

  return (
    <form className="card" style={{ maxWidth: 640, marginTop: 16 }} onSubmit={save} noValidate>
      <h2>Office and Echo Shows</h2>
      <p className="faint" style={{ margin: '4px 0 16px' }}>For rounds at the office: candidates check in with Alexa at reception and are interviewed on an Echo Show in an interview room.</p>
      <label className="field"><span>Office address</span><input value={address} disabled={data.locked} onChange={(e) => setAddress(e.target.value)} placeholder="4th floor, Prestige Tech Park, Bengaluru" /></label>
      <span className="small" style={{ fontWeight: 500, color: 'var(--text-2)' }}>Interview rooms (one Echo Show each)</span>
      {rooms.map((r, i) => (
        <div key={i} className="row" style={{ marginTop: 8 }}>
          <input value={r} disabled={data.locked} onChange={(e) => setRooms(rooms.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Room ${i + 1} name`} />
          {!data.locked && <button type="button" className="btn btn-ghost" onClick={() => setRooms(rooms.filter((_, j) => j !== i))} aria-label="Remove room"><Icon name="x" /></button>}
        </div>
      ))}
      {!data.locked && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setRooms([...rooms, `Room ${rooms.length + 1}`])}><Icon name="plus" size={15} /> Add room</button>}
      {!data.locked && <div style={{ marginTop: 14 }}><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save office'}</button></div>}
      {saved && <p className="small" style={{ color: 'var(--success)', marginTop: 10 }}>Saved.</p>}
      {err && <p className="error">{err}</p>}

      <div className="divider" style={{ margin: '18px 0' }} />
      <h3>Echo Show links</h3>
      <p className="faint" style={{ margin: '4px 0 10px' }}>Open these on the Echo Shows (or any tablet) at reception and in each room. Keep them private; anyone with the link can check people in.</p>
      {data.kiosk ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row"><span className="small" style={{ width: 90 }}>Reception</span><input readOnly value={data.kiosk} className="small" onFocus={(e) => e.target.select()} /><a className="btn btn-sm" href={data.kiosk} target="_blank" rel="noreferrer">Open</a></div>
          {data.office.rooms.map((r) => (
            <div key={r} className="row"><span className="small" style={{ width: 90 }}>{r}</span><input readOnly value={roomUrl(r)} className="small" onFocus={(e) => e.target.select()} /><a className="btn btn-sm" href={roomUrl(r)} target="_blank" rel="noreferrer">Open</a></div>
          ))}
          {!data.locked && <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={kiosk}>Make new links (the old ones stop working)</button>}
        </div>
      ) : (
        <button type="button" className="btn" onClick={kiosk} disabled={!data.office.rooms.length}>Create Echo Show links</button>
      )}
    </form>
  );
}
