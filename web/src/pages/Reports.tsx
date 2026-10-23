import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { DayCount, ReportsView } from '../api/types';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Shell';
import { Loading, useLoad } from '../lib/util';

// Hiring reports: the funnel, scores, how the AI's triage compares with people's decisions,
// live joining, identity checks and activity. Charts are plain CSS, so they follow the theme.

const PERIODS = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 0, label: 'All time' }];

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const num = (x: number | null, digits = 1) => (x == null ? '–' : x.toFixed(digits));
const hours = (h: number | null) => (h == null ? '–' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

function Kpi({ label, value, hint, icon }: { label: string; value: string | number; hint?: string; icon: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="stat rp-kpi">
      <span className="faint row" style={{ gap: 6 }}><Icon name={icon} size={14} /> {label}</span>
      <b>{value}</b>
      {hint && <span className="faint small">{hint}</span>}
    </div>
  );
}

export function Bars({ data, height = 120, label }: { data: DayCount[] | { label: string; count: number }[]; height?: number; label: (d: never) => string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="rp-bars" style={{ height: height + 24 }}>
      {data.map((d, i) => (
        <div key={i} className="rp-bar" title={`${label(d as never)}: ${d.count}`}>
          <span className="rp-bar-n">{d.count || ''}</span>
          <i style={{ height: `${(d.count / max) * height}px` }} />
          <span className="rp-bar-l">{label(d as never)}</span>
        </div>
      ))}
    </div>
  );
}

const dayLabel = (d: DayCount) => new Date(`${d.date}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }).replace(' ', ' ');

function Funnel({ steps }: { steps: ReportsView['funnel'] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map((s, i) => (
        <div key={s.label}>
          <div className="row between small"><span>{s.label}</span><span><b>{s.count}</b>{i > 0 && <span className="faint"> · {pct(steps[i - 1].count ? s.count / steps[i - 1].count : null)} of previous</span>}</span></div>
          <div className="rp-funnel"><i style={{ width: `${Math.max(2, (s.count / top) * 100)}%`, opacity: 1 - i * 0.15 }} /></div>
        </div>
      ))}
    </div>
  );
}

function Triage({ t }: { t: ReportsView['triage'] }) {
  const all = t.fastTrack + t.review + t.below || 1;
  const parts = [
    { k: 'Clear pass', v: t.fastTrack, c: 'var(--success)' },
    { k: 'AI unsure: a person decides', v: t.review, c: 'var(--warning)' },
    { k: 'Below the bar', v: t.below, c: 'var(--text-3)' },
  ];
  return (
    <>
      <div className="rp-stack">{parts.map((p) => p.v > 0 && <i key={p.k} style={{ width: `${(p.v / all) * 100}%`, background: p.c }} title={`${p.k}: ${p.v}`} />)}</div>
      <div className="stack" style={{ gap: 6, marginTop: 12 }}>
        {parts.map((p) => (
          <div key={p.k} className="row small"><span className="rp-dot" style={{ background: p.c }} /><span className="grow">{p.k}</span><b>{p.v}</b><span className="faint" style={{ width: 42, textAlign: 'right' }}>{pct(p.v / all)}</span></div>
        ))}
      </div>
    </>
  );
}

function Ring({ value, label }: { value: number | null; label: string }) {
  const v = value ?? 0;
  return (
    <div className="rp-ring" style={{ background: `conic-gradient(var(--accent) ${v * 360}deg, var(--surface-2) 0)` }}>
      <div><b>{pct(value)}</b><span className="faint small">{label}</span></div>
    </div>
  );
}

export function Reports() {
  const [days, setDays] = useState(30);
  const { data, error } = useLoad(() => api.reports(days), [days]);

  return (
    <>
      <PageHead title="Reports" sub="How hiring is going: the funnel, scores, and how the AI's calls compare with your team's.">
        <div className="seg" role="tablist" aria-label="Period">
          {PERIODS.map((p) => <button key={p.days} role="tab" aria-selected={days === p.days} className={days === p.days ? 'on' : ''} onClick={() => setDays(p.days)}>{p.label}</button>)}
        </div>
      </PageHead>
      {!data ? <Loading error={error} /> : <Body r={data} />}
    </>
  );
}

function Body({ r }: { r: ReportsView }) {
  const t = r.totals;
  const decided = t.advanced + t.rejected + t.onHold;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid cols-4">
        <Kpi icon="users" label="Candidates" value={t.candidates} hint={`${r.sources.signedUp} signed up (${r.sources.scannedQr ?? 0} by QR) · ${r.sources.addedByTeam} added by your team`} />
        <Kpi icon="mic" label="Interviews completed" value={t.completed} hint={`${pct(t.completionRate)} of booked interviews that are due`} />
        <Kpi icon="chart" label="Average score" value={num(t.avgScore)} hint="Out of 5, across every round" />
        <Kpi icon="clock" label="Time to decision" value={hours(t.avgDecisionHours)} hint="From interview end to your call" />
        <Kpi icon="check" label="Hired" value={`${t.hired ?? 0} of ${t.openings ?? 0}`} hint={`positions filled · ${t.advanced} moved on (${t.autoAdvanced} fast-tracked by the AI)`} />
        <Kpi icon="pause" label="Waiting for you" value={t.awaiting} hint={`${t.onHold} on hold · ${t.rejected} not progressed`} />
        <Kpi icon="sparkle" label="People agree with the AI" value={pct(t.aiAgreement)} hint={t.aiAgreementOf ? `On ${t.aiAgreementOf} clear passes and clear misses` : 'No decisions to compare yet'} />
        <Kpi icon="calendar" label="Average interview" value={t.avgInterviewMin == null ? '–' : `${Math.round(t.avgInterviewMin)} min`} hint={`${r.modes.ai} AI · ${r.modes.human} with a person · ${r.modes.office} at the office`} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Hiring funnel</h2><span className="faint">Candidates first seen in this period</span></div>
          <Funnel steps={r.funnel} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Interviews completed</h2><span className="faint">Last 14 days</span></div>
          <Bars data={r.daily} label={dayLabel as never} />
        </div>
      </div>

      <div className="grid cols-3">
        <div className="card">
          <div className="card-head"><h2>AI triage</h2></div>
          <Triage t={r.triage} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Why the AI was unsure</h2></div>
          {r.reasons.length === 0 ? <p className="faint small">Nothing needed a second look.</p> : (
            <div className="stack" style={{ gap: 8 }}>
              {r.reasons.map((x) => {
                const max = r.reasons[0].count || 1;
                return (
                  <div key={x.label}>
                    <div className="row between small"><span>{x.label}</span><b>{x.count}</b></div>
                    <div className="meter" style={{ marginTop: 4 }}><i style={{ width: `${(x.count / max) * 100}%`, background: 'var(--warning)' }} /></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="card rp-center">
          <div className="card-head" style={{ alignSelf: 'stretch' }}><h2>Your team vs the AI</h2></div>
          <Ring value={t.aiAgreement} label="agreement" />
          <p className="faint small" style={{ textAlign: 'center', marginTop: 10 }}>How often a person's decision matched the AI's clear pass or clear miss. Only people reject.</p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Score spread</h2><span className="faint">Overall score, out of 5</span></div>
          <Bars data={r.scores} label={((d: { label: string }) => d.label) as never} height={110} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Skills</h2><span className="faint">Average score per criterion</span></div>
          {r.criteria.length === 0 ? <p className="faint small">No scored interviews yet.</p> : (
            <div className="stack" style={{ gap: 8 }}>
              {r.criteria.map((c) => (
                <div key={c.name} className="row">
                  <span className="small ellipsis" style={{ width: 170 }}>{c.name}</span>
                  <span className="meter"><i style={{ width: `${((c.avg ?? 0) / 5) * 100}%` }} /></span>
                  <span className="small score" style={{ width: 34, textAlign: 'right' }}>{num(c.avg)}</span>
                  <span className="faint small" style={{ width: 44, textAlign: 'right' }}>{c.n}×</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>By job</h2></div>
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr><th>Job</th><th>Candidates</th><th>Interviewed</th><th>Average score</th><th>Moved on</th><th>Filled</th><th>Waiting for you</th></tr></thead>
            <tbody>
              {r.jobs.map((j) => (
                <tr key={j.id}>
                  <td><Link to={`/app/jobs/${j.id}`}>{j.title}</Link></td>
                  <td>{j.candidates}</td><td>{j.interviewed}</td><td>{num(j.avgScore)}</td><td>{j.advanced}</td><td>{j.hired ?? 0} of {j.openings ?? 1}</td>
                  <td>{j.awaiting > 0 ? <span className="badge badge-warning">{j.awaiting}</span> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Live joining</h2><span className="faint">People stepping into AI interviews</span></div>
          <div className="grid cols-2" style={{ gap: 10 }}>
            <div className="stat"><span className="faint">Taken over</span><b>{t.takeovers}</b></div>
            <div className="stat"><span className="faint">Questions added live</span><b>{t.teamQuestions}</b></div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Identity checks</h2><span className="faint">Amazon Rekognition</span></div>
          <div className="grid cols-3" style={{ gap: 10 }}>
            <div className="stat"><span className="faint">Matched</span><b>{r.identity.matched}</b></div>
            <div className="stat"><span className="faint">Let in by a person</span><b>{r.identity.approvedByPerson}</b></div>
            <div className="stat"><span className="faint">Locked now</span><b>{r.identity.locked}</b></div>
          </div>
        </div>
      </div>
      {decided === 0 && <p className="faint small">Decisions will show here once your team starts moving candidates on.</p>}
    </div>
  );
}
