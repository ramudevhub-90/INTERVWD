// Sample-data backend that runs in the browser (localStorage). It keeps the whole app clickable
// before the server is deployed, and is what VITE_API_MODE=mock builds use.

import type { Api } from './index';
import { ApiError } from './index';
import type {
  AssistantReply,
  Candidate,
  CandidateView,
  DashboardView,
  Decision,
  DecisionAction,
  Interview,
  InterviewRoomView,
  InterviewStep,
  InviteView,
  Job,
  JobView,
  JoinInput,
  JoinResult,
  KnowledgeDoc,
  KnowledgeView,
  NewJob,
  NewCandidate,
  NewKnowledge,
  NewRound,
  Org,
  OrgSettings,
  Report,
  Round,
  Session,
  Slot,
  Turn,
  VerifyResult,
} from './types';
import * as engine from '../lib/engine';

interface Db {
  orgs: Org[];
  recruiters: { email: string; name: string; orgId: string }[];
  jobs: Job[];
  rounds: Round[];
  candidates: Candidate[];
  interviews: Interview[];
  decisions: Decision[];
  knowledge?: KnowledgeDoc[];
  session: Session | null;
  pending?: { action: DecisionAction; candidateId: string };
}

const KEY = 'intervwd-sample-v3';
export const DEMO_CODE = '246810';
const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const iso = (d: Date) => d.toISOString();

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return iso(d);
}

function crit(...pairs: [string, string][]) {
  return pairs.map(([name, description]) => ({ id: id('c'), name, description }));
}

function seed(): Db {
  const org: Org = { id: 'org_northwind', name: 'Northwind Labs', createdAt: at(-30, 9) };
  const jobs: Job[] = [
    { id: 'job_backend', orgId: org.id, title: 'Backend Engineer', location: 'Bengaluru · Hybrid', description: 'Build and run the APIs behind our payments and orders platform. Python, AWS, PostgreSQL.', status: 'open', createdAt: at(-20, 10) },
    { id: 'job_storeops', orgId: org.id, title: 'Store Operations Manager', location: 'Pune · On site', description: 'Run day-to-day operations for three stores: staffing, stock, customer experience.', status: 'open', createdAt: at(-14, 10) },
    { id: 'job_analyst', orgId: org.id, title: 'Data Analyst', location: 'Remote · India', description: 'Turn sales and supply data into decisions. SQL, dashboards, clear storytelling.', status: 'open', createdAt: at(-9, 10) },
  ];
  const r = (jobId: string, index: number, name: string, criteria: Round['criteria'], questions: string[], code: string, slots: Slot[]): Round => ({
    id: `round_${jobId.slice(4)}_${index}`, jobId, orgId: org.id, index, name, durationMin: 20, criteria, questions, inviteCode: code, slots,
    identityCheck: code === 'nw-backend-r1' || code === 'nw-storeops-r1', requireApproval: code === 'nw-storeops-r1',
    publicPath: `northwind-labs/${({ 'nw-backend-r1': 'backend-engineer-r1', 'nw-backend-r2': 'backend-engineer-r2', 'nw-storeops-r1': 'store-operations-manager-r1', 'nw-analyst-r1': 'data-analyst-r1' } as Record<string, string>)[code]}`,
  });
  const rounds: Round[] = [
    r('job_backend', 1, 'Round 1 · Technical screen',
      crit(['Python and APIs', 'Designs clean, reliable APIs; knows Python well'], ['System design', 'Reasons about scale, failure and data'], ['Problem solving', 'Breaks problems down and checks assumptions'], ['Communication', 'Clear, structured, direct answers']),
      ['Tell me about a backend service you built or owned end to end. What did it do, and what was your part?',
        'How do you make an API safe to retry, for example so a payment is never charged twice?',
        'Your service gets ten times the usual traffic during a sale. What breaks first, and what do you do?',
        'Describe a production bug you tracked down. How did you find the cause?',
        'How do you decide between a relational database and a key-value store for a new feature?'],
      'nw-backend-r1',
      [{ id: 's1', start: at(0, 10), candidateId: 'cand_ana' }, { id: 's2', start: at(0, 11), candidateId: 'cand_rahul' }, { id: 's3', start: at(0, 15), candidateId: 'cand_vikram' }, { id: 's4', start: at(1, 10) }, { id: 's5', start: at(1, 11) }, { id: 's6', start: at(2, 15) }]),
    r('job_backend', 2, 'Round 2 · System design deep dive',
      crit(['Architecture', 'Chooses fitting components and explains why'], ['Trade-offs', 'Weighs cost, latency and complexity'], ['Communication', 'Leads the discussion clearly']),
      ['Design an order-tracking service for a million daily orders. Start with the main pieces.', 'Where would this design fail first, and how would you know?', 'How would you roll out a breaking change to its API?'],
      'nw-backend-r2', [{ id: 's7', start: at(3, 11) }, { id: 's8', start: at(4, 11) }]),
    r('job_storeops', 1, 'Round 1 · Situational interview',
      crit(['Operations', 'Plans staffing, stock and daily routines'], ['People leadership', 'Coaches and handles conflict fairly'], ['Customer focus', 'Puts the customer experience first'], ['Communication', 'Clear and calm']),
      ['Walk me through how you would open a store on a busy festival morning.', 'Two team members have a conflict that is affecting customers. What do you do?', 'Stock of a top-selling item runs out at noon. What happens next?', 'Tell me about a time you improved a store metric. How did you measure it?'],
      'nw-storeops-r1', [{ id: 's9', start: at(0, 16), candidateId: 'cand_meera' }, { id: 's10', start: at(1, 16) }]),
    r('job_analyst', 1, 'Round 1 · SQL and reasoning',
      crit(['SQL', 'Writes correct, readable queries'], ['Analysis', 'Finds the real question behind the data'], ['Storytelling', 'Explains findings to non-analysts']),
      ['How would you find the top five products by repeat purchase rate last quarter? Talk me through the query.', 'Sales dropped 8% last week. How do you work out why?', 'Tell me about a dashboard or analysis that changed a decision.'],
      'nw-analyst-r1', [{ id: 's11', start: at(1, 12) }, { id: 's12', start: at(2, 12) }]),
  ];
  const cand = (cid: string, name: string, email: string, jobId: string, roundId: string, status: Candidate['status'], skills: string[], summary: string): Candidate => ({
    id: cid, orgId: org.id, jobId, roundId, name, email, cvName: `${name.replace(' ', '_')}_CV.pdf`, cvSummary: summary, skills, status, createdAt: at(-3, 12),
  });
  const candidates: Candidate[] = [
    cand('cand_rahul', 'Rahul Mehta', 'rahul.mehta@example.com', 'job_backend', 'round_backend_1', 'completed', ['FastAPI', 'AWS Lambda', 'PostgreSQL', 'Redis'], '5 years in Python backends; moved a payments API to FastAPI at a fintech; on-call lead.'),
    cand('cand_ana', 'Ana Silva', 'ana.silva@example.com', 'job_backend', 'round_backend_1', 'completed', ['Go', 'Kafka', 'DynamoDB', 'Python'], '6 years; event-driven order systems; strong on system design.'),
    cand('cand_vikram', 'Vikram Rao', 'vikram.rao@example.com', 'job_backend', 'round_backend_1', 'scheduled', ['Django', 'Celery', 'MySQL'], '3 years in Django; built internal tools and a reporting API.'),
    cand('cand_neha', 'Neha Kapoor', 'neha.kapoor@example.com', 'job_backend', 'round_backend_1', 'completed', ['Node.js', 'Express', 'MongoDB'], '2 years; mostly Node.js; some Python scripting.'),
    cand('cand_meera', 'Meera Iyer', 'meera.iyer@example.com', 'job_storeops', 'round_storeops_1', 'scheduled', ['Retail operations', 'Rostering', 'Inventory'], '7 years in retail; assistant store manager at a grocery chain.'),
    cand('cand_arjun', 'Arjun Nair', 'arjun.nair@example.com', 'job_storeops', 'round_storeops_1', 'advanced', ['Team leadership', 'Visual merchandising'], '5 years; led a 20-person store team.'),
  ];

  const report = (overall: number, summary: string, highlights: string[], concerns: string[], scores: [number, string][], round: Round): Report => ({
    overall, summary, highlights, concerns, generatedAt: at(0, 12),
    criteria: round.criteria.map((c, i) => ({ criterionId: c.id, name: c.name, score: scores[i][0], evidence: scores[i][1] })),
  });
  const be1 = rounds[0];
  const T = (role: Turn['role'], kind: Turn['kind'], text: string, q: number, h: number, m: number): Turn => ({ role, kind, text, questionIndex: q, at: at(0, h, m) });
  const interviews: Interview[] = [
    {
      id: 'iv_rahul', orgId: org.id, jobId: 'job_backend', roundId: be1.id, candidateId: 'cand_rahul', slotStart: at(0, 11), status: 'completed', startedAt: at(0, 11), endedAt: at(0, 11, 19), snapshots: [],
      turns: [
        T('interviewer', 'greeting', "Hi Rahul, thanks for joining. I'm the interviewer for Northwind Labs' Round 1 · Technical screen.", 0, 11, 0),
        T('interviewer', 'question', be1.questions[0], 0, 11, 0),
        T('candidate', 'answer', 'At my last company I owned the payments API. We moved it from a Flask monolith to FastAPI on AWS Lambda behind API Gateway. I designed the endpoints, the idempotency layer and the retry policy, and I was the on-call lead for it.', 0, 11, 2),
        T('interviewer', 'follow_up', 'You mentioned FastAPI on Lambda. What was the hardest trade-off there, and what would you do differently now?', 0, 11, 3),
        T('candidate', 'answer', 'Cold starts. P99 latency went up at night when traffic was low. We added provisioned concurrency for the checkout path only, which cost more but kept p99 under 300 milliseconds. Now I would measure cost per request earlier before deciding.', 0, 11, 4),
        T('interviewer', 'question', be1.questions[1], 1, 11, 5),
        T('candidate', 'answer', 'Every request carries an idempotency key. We store the key with the response in Redis with a 24 hour expiry, and in PostgreSQL inside the same transaction as the charge. A retry with the same key returns the stored response instead of charging again.', 1, 11, 7),
      ],
      report: report(4.1, 'Strong, specific answers on API design and reliability, with clear trade-offs. Less depth on scaling writes under load.', ['Designed an idempotency layer end to end', 'Measured p99 latency and chose a targeted fix', 'Owned on-call for a payments API'], ['Scaling strategy for write-heavy traffic stayed general'],
        [[4.5, '"Every request carries an idempotency key... stored in PostgreSQL inside the same transaction as the charge."'], [3.8, '"We added provisioned concurrency for the checkout path only..." Good on latency, vague on write scaling.'], [4.2, '"P99 latency went up at night when traffic was low." Found the cause from metrics.'], [4.0, 'Concise, answered every follow-up directly.']], be1),
    },
    {
      id: 'iv_ana', orgId: org.id, jobId: 'job_backend', roundId: be1.id, candidateId: 'cand_ana', slotStart: at(0, 10), status: 'completed', startedAt: at(0, 10), endedAt: at(0, 10, 21), snapshots: [], turns: [],
      report: report(3.9, 'Excellent system design reasoning with event-driven architecture; Python answers were lighter than the role needs.', ['Clear reasoning about failure modes with Kafka', 'Strong on partitioning DynamoDB tables'], ['Python-specific depth was limited'],
        [[3.4, '"Most of my recent work is in Go; in Python I have written internal services with Flask."'], [4.6, '"Partition by customer, not by order, so hot sales do not create a hot key."'], [3.9, 'Worked through the traffic spike question step by step.'], [3.8, 'Clear, slightly long answers.']], be1),
    },
    {
      id: 'iv_neha', orgId: org.id, jobId: 'job_backend', roundId: be1.id, candidateId: 'cand_neha', slotStart: at(-1, 15), status: 'completed', startedAt: at(-1, 15), endedAt: at(-1, 15, 16), snapshots: [], turns: [],
      report: report(2.7, 'Motivated and honest about gaps; limited experience with Python backends and retries.', ['Honest about gaps in experience'], ['Could not describe a retry-safe API', 'Little production debugging experience'],
        [[2.6, '"I have mostly built APIs in Express."'], [2.5, 'General answer about adding more servers.'], [3.0, 'Reasonable approach to the bug question.'], [2.9, 'Short answers.']], be1),
    },
    { id: 'iv_vikram', orgId: org.id, jobId: 'job_backend', roundId: be1.id, candidateId: 'cand_vikram', slotStart: at(0, 15), status: 'scheduled', snapshots: [], turns: [] },
    { id: 'iv_meera', orgId: org.id, jobId: 'job_storeops', roundId: 'round_storeops_1', candidateId: 'cand_meera', slotStart: at(0, 16), status: 'scheduled', snapshots: [], turns: [] },
    {
      id: 'iv_arjun', orgId: org.id, jobId: 'job_storeops', roundId: 'round_storeops_1', candidateId: 'cand_arjun', slotStart: at(-2, 16), status: 'completed', startedAt: at(-2, 16), endedAt: at(-2, 16, 18), snapshots: [], turns: [],
      report: report(4.3, 'Calm, practical operator with strong people leadership.', ['Concrete festival-day plan', 'Handled the team conflict fairly'], [],
        [[4.4, 'Detailed opening checklist with staffing by hour.'], [4.5, '"I talk to each of them separately first, then together."'], [4.1, 'Offered substitutes and a callback for the out-of-stock item.'], [4.2, 'Clear and calm.']], rounds[2]),
    },
  ];
  const decisions: Decision[] = [{ id: 'd1', candidateId: 'cand_arjun', roundId: 'round_storeops_1', action: 'advance', note: 'Strong on people leadership.', by: 'Priya Sharma', at: at(-1, 10) }];
  return { orgs: [org], recruiters: [{ email: 'demo@intervwd.com', name: 'Priya Sharma', orgId: org.id }], jobs, rounds, candidates, interviews, decisions, session: null };
}

function load(): Db {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    /* storage blocked or corrupt: start from the seed */
  }
  return seed();
}

const pause = (ms = 180) => new Promise((r) => setTimeout(r, ms));
const isToday = (s: string) => new Date(s).toDateString() === new Date().toDateString();

export class MockApi implements Api {
  readonly mode = 'mock' as const;
  private db = load();

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.db));
    } catch {
      /* quota or private mode: keep working in memory */
    }
  }

  private recruiter(): Session {
    const s = this.db.session;
    if (!s || s.role !== 'recruiter') throw new ApiError('Sign in as a recruiter first.', 401);
    return s;
  }

  private find<T extends { id: string }>(list: T[], key: string, what: string): T {
    const item = list.find((x) => x.id === key);
    if (!item) throw new ApiError(`That ${what} doesn't exist.`, 404);
    return item;
  }

  // ---------- Sign-in ----------

  async session() {
    return this.db.session;
  }

  async sendCode(email: string) {
    await pause();
    if (!this.db.recruiters.some((r) => r.email === email.trim().toLowerCase())) {
      throw new ApiError('No company account uses that email. Set up your company first.', 404);
    }
    return { hint: `Sample mode: the code is ${DEMO_CODE}.` };
  }

  async verifyCode(email: string, code: string) {
    await pause();
    const r = this.db.recruiters.find((x) => x.email === email.trim().toLowerCase());
    if (!r || code.trim() !== DEMO_CODE) throw new ApiError("That code isn't right. Check it and try again.", 401);
    const org = this.find(this.db.orgs, r.orgId, 'company');
    this.db.session = { userId: `u_${r.email}`, email: r.email, name: r.name, role: 'recruiter', orgId: org.id, orgName: org.name };
    this.save();
    return this.db.session;
  }

  async signOut() {
    this.db.session = null;
    this.save();
  }

  async createOrg(input: { orgName: string; name: string; email: string }) {
    await pause();
    const email = input.email.trim().toLowerCase();
    if (this.db.recruiters.some((r) => r.email === email)) throw new ApiError('That email already has a company account. Sign in instead.', 409);
    const org: Org = { id: id('org'), name: input.orgName.trim(), createdAt: iso(new Date()) };
    this.db.orgs.push(org);
    this.db.recruiters.push({ email, name: input.name.trim(), orgId: org.id });
    this.save();
    return { hint: `Sample mode: the code is ${DEMO_CODE}.` };
  }

  // ---------- Recruiter ----------

  private row(iv: Interview) {
    return {
      interview: iv,
      candidate: this.find(this.db.candidates, iv.candidateId, 'candidate'),
      job: this.find(this.db.jobs, iv.jobId, 'job'),
      round: this.find(this.db.rounds, iv.roundId, 'round'),
    };
  }

  async dashboard(): Promise<DashboardView> {
    await pause();
    const { orgId } = this.recruiter();
    const org = this.find(this.db.orgs, orgId!, 'company');
    const jobs = this.db.jobs.filter((j) => j.orgId === orgId);
    const ivs = this.db.interviews.filter((i) => i.orgId === orgId);
    const cands = this.db.candidates.filter((c) => c.orgId === orgId);
    const upcoming = ivs.filter((i) => i.status !== 'completed' && new Date(i.slotStart) >= new Date(new Date().setHours(0, 0, 0, 0)))
      .sort((a, b) => a.slotStart.localeCompare(b.slotStart)).slice(0, 6).map((i) => this.row(i));
    const awaiting = ivs.filter((i) => i.status === 'completed' && cands.find((c) => c.id === i.candidateId)?.status === 'completed')
      .sort((a, b) => (b.report?.overall ?? 0) - (a.report?.overall ?? 0)).map((i) => this.row(i));
    return {
      org,
      stats: { openJobs: jobs.filter((j) => j.status === 'open').length, interviewsToday: ivs.filter((i) => isToday(i.slotStart)).length, awaitingDecision: awaiting.length, candidates: cands.length },
      jobs: jobs.map((j) => {
        const rs = this.db.rounds.filter((r) => r.jobId === j.id).sort((a, b) => a.index - b.index);
        return { ...j, candidateCount: cands.filter((c) => c.jobId === j.id).length, currentRound: rs[0]?.name };
      }),
      upcoming,
      awaiting,
      week: { liveNow: ivs.filter((i) => i.status === 'in_progress').length, completed: ivs.filter((i) => i.status === 'completed').length,
        avgScore: 3.8, fastTracked: 1, advanced: 1, avgDecisionHours: 5.4, aiAgreement: 0.86,
        daily: Array.from({ length: 7 }, (_, k) => ({ date: new Date(Date.now() - (6 - k) * 864e5).toISOString().slice(0, 10), count: [1, 0, 2, 3, 1, 2, 1][k] })) },
    };
  }

  /** The Reports page from the sample data (the server computes the real one). */
  async reports(days: number): Promise<import('./types').ReportsView> {
    await pause();
    const { orgId } = this.recruiter();
    const since = days > 0 ? Date.now() - days * 864e5 : 0;
    const jobs = this.db.jobs.filter((j) => j.orgId === orgId);
    const ivs = this.db.interviews.filter((i) => i.orgId === orgId && new Date(i.slotStart).getTime() >= since);
    const cands = this.db.candidates.filter((c) => c.orgId === orgId);
    const done = ivs.filter((i) => i.status === 'completed');
    const overall = done.map((i) => i.report?.overall).filter((x): x is number => typeof x === 'number');
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
    const buckets: [number, number][] = [[1, 2], [2, 2.5], [2.5, 3], [3, 3.5], [3.5, 4], [4, 4.5], [4.5, 5.01]];
    const crit: Record<string, number[]> = {};
    for (const i of done) for (const c of i.report?.criteria ?? []) (crit[c.name] ??= []).push(c.score);
    const daily = Array.from({ length: 14 }, (_, k) => {
      const d = new Date(Date.now() - (13 - k) * 864e5).toISOString().slice(0, 10);
      return { date: d, count: done.filter((i) => (i.endedAt ?? i.slotStart).slice(0, 10) === d).length };
    });
    const status = (s: string) => cands.filter((c) => c.status === s).length;
    return {
      periodDays: days,
      totals: { candidates: cands.length, interviews: ivs.length, completed: done.length, completionRate: ivs.length ? Math.round((done.length / ivs.length) * 100) / 100 : null,
        avgScore: avg(overall), advanced: status('advanced'), rejected: status('rejected'), onHold: status('on_hold'), autoAdvanced: 1, awaiting: status('completed'),
        avgDecisionHours: 5.4, avgInterviewMin: 17.5, aiAgreement: 0.86, aiAgreementOf: 7, takeovers: 1, teamQuestions: 2 },
      funnel: [{ label: 'Applied or invited', count: cands.length }, { label: 'Booked', count: cands.filter((c) => c.status !== 'invited').length },
        { label: 'Interviewed', count: new Set(done.map((i) => i.candidateId)).size }, { label: 'Moved on', count: status('advanced') }],
      triage: { fastTrack: overall.filter((x) => x >= 4).length, review: overall.filter((x) => x >= 3 && x < 4).length, below: overall.filter((x) => x < 3).length },
      reasons: [{ label: 'Close to the bar', count: 2 }, { label: 'Mixed scores across skills', count: 1 }, { label: 'Too little to go on', count: 1 }],
      scores: buckets.map(([lo, hi]) => ({ label: `${lo}–${Math.min(hi, 5)}`, count: overall.filter((x) => x >= lo && x < hi).length })),
      daily,
      jobs: jobs.map((j) => {
        const jd = done.filter((i) => i.jobId === j.id);
        const jc = cands.filter((c) => c.jobId === j.id);
        return { id: j.id, title: j.title, candidates: jc.length, interviewed: jd.length, avgScore: avg(jd.map((i) => i.report?.overall ?? 0).filter(Boolean)),
          advanced: jc.filter((c) => c.status === 'advanced').length, awaiting: jc.filter((c) => c.status === 'completed').length };
      }),
      criteria: Object.entries(crit).map(([name, v]) => ({ name, avg: avg(v), n: v.length })).sort((a, b) => b.n - a.n).slice(0, 8),
      identity: { checked: 4, matched: 3, approvedByPerson: 1, locked: 0 },
      sources: { signedUp: cands.filter((c) => !(c as { addedBy?: string }).addedBy).length, addedByTeam: cands.filter((c) => (c as { addedBy?: string }).addedBy).length },
      modes: { ai: ivs.length, human: 0, office: 0 },
    };
  }

  async settings(): Promise<OrgSettings> {
    await pause();
    const { orgId } = this.recruiter();
    const org = this.find(this.db.orgs, orgId!, 'company');
    return { orgName: org.name, slug: (org as Org & { slug?: string }).slug ?? org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), locked: org.id === 'org_northwind',
      office: this.office, kiosk: `${location.origin}/kiosk/sample` };
  }

  async saveSettings(slug: string): Promise<OrgSettings> {
    await pause();
    const { orgId } = this.recruiter();
    if (orgId === 'org_northwind') throw new ApiError("The demo company's link name can't be changed.", 403);
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) throw new ApiError('Use 3 to 40 lowercase letters, numbers and single hyphens.');
    const org = this.find(this.db.orgs, orgId!, 'company') as Org & { slug?: string };
    const old = org.slug ?? org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    org.slug = slug;
    for (const r of this.db.rounds.filter((x) => x.orgId === orgId && x.publicPath)) r.publicPath = r.publicPath!.replace(`${old}/`, `${slug}/`);
    this.save();
    return this.settings();
  }

  private office = { address: 'Northwind Labs, 4th floor, Prestige Tech Park, Bengaluru 560103', rooms: ['Room 1', 'Room 2'] };

  async saveOffice(address: string, rooms: string[]) {
    this.office = { address, rooms };
    return this.settings();
  }

  async newKiosk() {
    return this.settings();
  }

  async hiringDay(): Promise<import('./types').HiringDay> {
    return { counts: { expected: 1, arrived: 0, in_room: 0, done: 1, no_show: 0 }, rows: [] };
  }

  async kiosk(): Promise<import('./types').KioskInfo> {
    return { orgName: 'Northwind Labs', ...this.office };
  }

  async kioskCheckin(): Promise<import('./types').CheckIn> {
    throw new ApiError('Reception check-in needs the live server.', 409);
  }

  async kioskArrive(): Promise<{ room: string | null; message: string }> {
    throw new ApiError('Reception check-in needs the live server.', 409);
  }

  async kioskRoom(_t: string, room: string) {
    return { room, orgName: 'Northwind Labs', interviewId: null };
  }

  async createJob(input: NewJob) {
    await pause();
    const { orgId } = this.recruiter();
    const job: Job = { id: id('job'), orgId: orgId!, title: input.title.trim(), location: input.location.trim(), description: input.description.trim(), status: 'open', createdAt: iso(new Date()) };
    this.db.jobs.push(job);
    this.save();
    return job.id;
  }

  async job(jobId: string): Promise<JobView> {
    await pause();
    const { orgId } = this.recruiter();
    const job = this.find(this.db.jobs, jobId, 'job');
    if (job.orgId !== orgId) throw new ApiError("That job doesn't exist.", 404);
    const rounds = this.db.rounds.filter((r) => r.jobId === jobId).sort((a, b) => a.index - b.index);
    const candidates = this.db.candidates.filter((c) => c.jobId === jobId).map((c) => {
      const iv = this.db.interviews.filter((i) => i.candidateId === c.id && i.roundId === c.roundId).pop();
      return { ...c, overall: iv?.report?.overall, roundName: rounds.find((r) => r.id === c.roundId)?.name ?? '' };
    }).sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
    return { job, rounds, candidates };
  }

  async createRound(jobId: string, input: NewRound) {
    await pause();
    const { orgId } = this.recruiter();
    const job = this.find(this.db.jobs, jobId, 'job');
    const index = this.db.rounds.filter((r) => r.jobId === jobId).length + 1;
    const slug = job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16);
    const named = `${(this.db.orgs.find((o) => o.id === orgId)?.name ?? 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-r${index}`;
    const round: Round = {
      id: id('round'), jobId, orgId: orgId!, index, name: `Round ${index} · ${input.name.trim()}`, durationMin: input.durationMin,
      criteria: input.criteria.map((c) => ({ id: id('c'), ...c })), questions: input.questions, inviteCode: `${slug}-r${index}-${Math.random().toString(36).slice(2, 6)}`, slots: [],
      identityCheck: input.identityCheck, requireApproval: input.requireApproval, publicPath: named,
      decisionMode: input.decisionMode, autoAdvance: input.autoAdvance, mode: input.mode, meetingUrl: input.meetingUrl, interviewers: input.interviewers, location: input.location,
    };
    this.db.rounds.push(round);
    this.save();
    return round;
  }

  async addSlots(roundId: string, starts: string[]) {
    await pause();
    this.recruiter();
    const round = this.find(this.db.rounds, roundId, 'round');
    round.slots.push(...starts.map((start) => ({ id: id('s'), start })));
    round.slots.sort((a, b) => a.start.localeCompare(b.start));
    this.save();
    return round;
  }

  async removeSlot(roundId: string, slotId: string) {
    await pause();
    this.recruiter();
    const round = this.find(this.db.rounds, roundId, 'round');
    if (round.slots.find((s) => s.id === slotId)?.candidateId) throw new ApiError('A candidate has booked that slot.', 409);
    round.slots = round.slots.filter((s) => s.id !== slotId);
    this.save();
    return round;
  }

  async knowledge(jobId: string): Promise<KnowledgeView> {
    await pause();
    this.recruiter();
    return { enabled: true, documents: (this.db.knowledge ?? []).filter((d) => d.jobId === jobId).map((d) => ({ ...d, status: 'ready' as const })) };
  }

  async addKnowledge(jobId: string, input: NewKnowledge) {
    await pause(400);
    this.recruiter();
    const file = 'file' in input ? input.file : undefined;
    if (!file && !('text' in input && input.text.trim())) throw new ApiError('Add some text or choose a file.');
    const doc: KnowledgeDoc = {
      id: id('kdoc'), jobId, kind: input.kind, status: 'syncing', createdAt: iso(new Date()),
      name: file ? file.name : ('name' in input && input.name.trim()) || 'Notes', size: file ? file.size : 'text' in input ? input.text.length : 0,
    };
    this.db.knowledge = [...(this.db.knowledge ?? []), doc];
    this.save();
    return doc;
  }

  async removeKnowledge(_jobId: string, docId: string) {
    await pause();
    this.recruiter();
    this.db.knowledge = (this.db.knowledge ?? []).filter((d) => d.id !== docId);
    this.save();
  }

  async candidate(candidateId: string): Promise<CandidateView> {
    await pause();
    this.recruiter();
    const candidate = this.find(this.db.candidates, candidateId, 'candidate');
    return {
      candidate,
      job: this.find(this.db.jobs, candidate.jobId, 'job'),
      rounds: this.db.rounds.filter((r) => r.jobId === candidate.jobId).sort((a, b) => a.index - b.index),
      interviews: this.db.interviews.filter((i) => i.candidateId === candidateId),
      decisions: this.db.decisions.filter((d) => d.candidateId === candidateId),
    };
  }

  async decide(candidateId: string, action: DecisionAction, note: string) {
    await pause();
    const s = this.recruiter();
    this.applyDecision(candidateId, action, note, s.name);
  }

  private applyDecision(candidateId: string, action: DecisionAction, note: string, by: string) {
    const c = this.find(this.db.candidates, candidateId, 'candidate');
    this.db.decisions.push({ id: id('d'), candidateId, roundId: c.roundId, action, note, by, at: iso(new Date()) });
    c.status = action === 'advance' ? 'advanced' : action === 'hold' ? 'on_hold' : 'rejected';
    this.save();
  }

  async addCandidate(jobId: string, input: NewCandidate) {
    await pause();
    this.recruiter();
    const round = this.find(this.db.rounds, input.roundId, 'round');
    const c: Candidate = {
      id: id('cand'), orgId: round.orgId, jobId, roundId: round.id, name: input.name.trim(), email: input.email.trim().toLowerCase(),
      cvName: input.cv?.name ?? '', cvSummary: 'Profile not completed yet.', skills: [], status: 'invited', createdAt: iso(new Date()),
    };
    this.db.candidates.push(c);
    this.save();
    return { id: c.id, link: `${location.origin}/${round.publicPath ?? `i/${round.inviteCode}`}?t=sample-${c.id}` };
  }

  async reviewSignup(candidateId: string, approve: boolean) {
    await pause();
    this.recruiter();
    const c = this.find(this.db.candidates, candidateId, 'candidate');
    c.status = approve ? 'scheduled' : 'declined';
    this.save();
  }

  async approveIdentity(candidateId: string) {
    await pause();
    this.recruiter();
    const iv = this.db.interviews.filter((i) => i.candidateId === candidateId).pop();
    if (iv) iv.identity = { status: 'approved', approvedBy: this.db.session?.name };
    this.save();
  }

  async submitScorecard(interviewId: string, card: import('./types').Scorecard) {
    await pause();
    const s = this.recruiter();
    const iv = this.find(this.db.interviews, interviewId, 'interview');
    const round = this.find(this.db.rounds, iv.roundId, 'round');
    const criteria = round.criteria.map((c) => {
      const got = card.criteria.find((x) => x.criterionId === c.id);
      return { criterionId: c.id, name: c.name, score: got?.score ?? 3, evidence: got?.notes || 'No notes.' };
    });
    iv.status = 'completed';
    iv.endedAt = iso(new Date());
    iv.report = { overall: Math.round((criteria.reduce((a, c) => a + c.score, 0) / criteria.length) * 10) / 10, summary: card.summary,
      highlights: card.highlights.split('\n').filter(Boolean), concerns: card.concerns.split('\n').filter(Boolean), criteria, generatedAt: iso(new Date()),
      scoredBy: 'human', scoredByName: s.name };
    this.find(this.db.candidates, iv.candidateId, 'candidate').status = 'completed';
    this.save();
  }

  private practiceAt = 0;

  async practiceStart() {
    await pause(400);
    this.practiceAt = 0;
    return { intro: "Let's practise. These aren't the real questions, and nothing is shared.", question: 'Tell me about a time you learned a new tool quickly.', index: 1, of: 2, jobTitle: 'Backend Engineer', orgName: 'Northwind Labs' };
  }

  async practiceAnswer() {
    await pause(500);
    this.practiceAt += 1;
    return { feedback: { strength: 'You answered directly.', improve: 'Add a number or outcome.', tip: 'Use Situation, Task, Action, Result.' },
      question: this.practiceAt < 2 ? 'Describe a time you disagreed with a teammate.' : null, index: this.practiceAt + 1, of: 2 };
  }

  async joinLive(): Promise<import('./types').CallJoin> {
    throw new ApiError('Watching live needs the live server (Amazon Chime SDK).', 409);
  }

  async liveStatus() {
    return { watchers: [], takenOverBy: null, status: 'in_progress' };
  }

  async liveReport() {
    return undefined;
  }

  async liveHost(): Promise<import('./types').CallJoin> {
    throw new ApiError('Watching live needs the live server (Amazon Chime SDK).', 409);
  }

  async liveState(): Promise<import('./types').LiveView> {
    throw new ApiError('Watching live needs the live server.', 409);
  }

  async liveControl(): Promise<import('./types').LiveView> {
    throw new ApiError('Watching live needs the live server.', 409);
  }

  async joinCall(): Promise<import('./types').CallJoin> {
    throw new ApiError('Video calls need the live server (Amazon Chime SDK).', 409);
  }

  async hostCall(): Promise<import('./types').CallJoin> {
    throw new ApiError('Video calls need the live server (Amazon Chime SDK).', 409);
  }

  async verifyIdentity(interviewId: string): Promise<VerifyResult> {
    await pause(600);
    const iv = this.find(this.db.interviews, interviewId, 'interview');
    iv.identity = { status: 'matched', similarity: 98.7, attempts: 1 };
    this.save();
    return { status: 'matched', result: 'matched', similarity: 98.7, attemptsLeft: 2, message: "Thanks, that's you. (Sample mode always matches.)" };
  }

  // ---------- Assistant (what Alexa+ does through the MCP tools) ----------

  async assistant(message: string): Promise<AssistantReply> {
    await pause(500);
    const s = this.recruiter();
    const text = message.toLowerCase().replace(/^alexa[,\s]*/, '').trim();
    const cands = this.db.candidates.filter((c) => c.orgId === s.orgId);
    const named = cands.find((c) => text.includes(c.name.split(' ')[0].toLowerCase()));
    const scoreOf = (c: Candidate) => this.db.interviews.filter((i) => i.candidateId === c.id).pop()?.report?.overall;

    if (this.db.pending && /^(yes|yeah|yep|confirm|do it|go ahead|sure)\b/.test(text)) {
      const { action, candidateId } = this.db.pending;
      this.db.pending = undefined;
      const c = this.find(this.db.candidates, candidateId, 'candidate');
      this.applyDecision(candidateId, action, 'Decided on Alexa+.', s.name);
      const next = this.db.rounds.find((r) => r.jobId === c.jobId && r.index === (this.db.rounds.find((x) => x.id === c.roundId)?.index ?? 0) + 1);
      return { tool: action === 'advance' ? 'advance_candidate' : action === 'reject' ? 'reject_candidate' : 'hold_candidate',
        text: action === 'advance' ? `Done. ${c.name} is moving on${next ? ` to ${next.name}, and has the booking link by email` : ''}.` : action === 'reject' ? `Done. ${c.name} is marked as not progressing. No email goes out until you send one.` : `Done. ${c.name} is on hold.` };
    }
    if (this.db.pending && /^(no|nope|cancel|stop|don't)\b/.test(text)) {
      this.db.pending = undefined;
      this.save();
      return { text: "Okay, I won't change anything." };
    }

    const decisionWord = /\b(move|advance|progress|next round|shortlist)\b/.test(text) ? 'advance' : /\b(reject|decline|not progress)\b/.test(text) ? 'reject' : /\bhold\b/.test(text) ? 'hold' : undefined;
    if (decisionWord && named) {
      this.db.pending = { action: decisionWord, candidateId: named.id };
      this.save();
      const job = this.find(this.db.jobs, named.jobId, 'job');
      const verb = decisionWord === 'advance' ? `move ${named.name} to the next ${job.title} round` : decisionWord === 'reject' ? `mark ${named.name} as not progressing for ${job.title}` : `put ${named.name} on hold for ${job.title}`;
      return { text: `To confirm: ${verb}. Shall I?`, pendingConfirmation: true };
    }
    const jobNamed = this.db.jobs.find((j) => j.orgId === s.orgId && text.includes(j.title.split(' ')[0].toLowerCase()));
    if (jobNamed && !/\b(invite|link)\b/.test(text)) {
      const jc = cands.filter((c) => c.jobId === jobNamed.id);
      const stage: Record<string, string> = { scheduled: 'booked', in_progress: 'interviewing', completed: 'waiting for you', advanced: 'moved on', on_hold: 'on hold', rejected: 'not progressing', invited: 'invited', pending_approval: 'waiting for approval' };
      const counts: Record<string, number> = {};
      jc.forEach((c) => { const k = stage[c.status] ?? c.status; counts[k] = (counts[k] ?? 0) + 1; });
      const waiting = jc.filter((c) => c.status === 'completed' && scoreOf(c) !== undefined).sort((a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0));
      const parts = [`${jobNamed.title}: ${jc.length} candidates. Round 1: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}.`,
        waiting.length ? `${waiting.length} waiting for your decision; the strongest is ${waiting[0].name} at ${scoreOf(waiting[0])}.` : '', 'The AI fast-tracked 2.'];
      return { tool: 'get_job_status', text: parts.filter(Boolean).join(' ') };
    }
    if (/\bcompare\b/.test(text)) {
      const ranked = cands.filter((c) => scoreOf(c) !== undefined && c.status === 'completed').sort((a, b) => (scoreOf(b) ?? 0) - (scoreOf(a) ?? 0)).slice(0, 2);
      if (ranked.length < 2) return { text: 'There are fewer than two finished interviews waiting for a decision, so there is nothing to compare yet.', tool: 'compare_candidates' };
      const [a, b] = ranked.map((c) => ({ c, r: this.db.interviews.filter((i) => i.candidateId === c.id).pop()!.report! }));
      const best = (r: Report) => [...r.criteria].sort((x, y) => y.score - x.score)[0].name;
      return { tool: 'compare_candidates', text: `${a.c.name} scored ${a.r.overall} and is strongest on ${best(a.r)}. ${b.c.name} scored ${b.r.overall}, strongest on ${best(b.r)}. ${a.r.concerns[0] ? `For ${a.c.name.split(' ')[0]}, watch: ${a.r.concerns[0].toLowerCase()}.` : ''}` };
    }
    if (named && /\b(how did|report|score|tell me about|summary)\b/.test(text)) {
      const r = this.db.interviews.filter((i) => i.candidateId === named.id).pop()?.report;
      if (!r) return { tool: 'get_candidate_report', text: `${named.name} hasn't finished an interview yet.` };
      return { tool: 'get_candidate_report', text: `${named.name} scored ${r.overall} out of 5. ${r.summary}` };
    }
    if (/\b(today|how did|interviews|schedule|who's|who is)\b/.test(text)) {
      const ivs = this.db.interviews.filter((i) => i.orgId === s.orgId && isToday(i.slotStart));
      const done = ivs.filter((i) => i.status === 'completed').map((i) => ({ c: this.find(this.db.candidates, i.candidateId, 'candidate'), r: i.report! })).sort((a, b) => b.r.overall - a.r.overall);
      const left = ivs.filter((i) => i.status !== 'completed').map((i) => `${this.find(this.db.candidates, i.candidateId, 'candidate').name} at ${new Date(i.slotStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      const parts = [
        done.length ? `${done.length} interview${done.length > 1 ? 's' : ''} finished today. ${done[0].c.name} scored highest, ${done[0].r.overall}.` : 'No interviews have finished today yet.',
        left.length ? `Still to come: ${left.join(', ')}.` : '',
        done.length > 1 ? 'Want me to compare the top two?' : '',
      ];
      return { tool: 'get_todays_interviews', text: parts.filter(Boolean).join(' ') };
    }
    if (/\b(jobs|roles|openings|positions)\b/.test(text)) {
      const jobs = this.db.jobs.filter((j) => j.orgId === s.orgId && j.status === 'open');
      return { tool: 'list_jobs', text: `You have ${jobs.length} open roles: ${jobs.map((j) => `${j.title} with ${cands.filter((c) => c.jobId === j.id).length} candidates`).join('; ')}.` };
    }
    if (/\b(invite|link)\b/.test(text)) {
      const job = this.db.jobs.find((j) => j.orgId === s.orgId && text.includes(j.title.split(' ')[0].toLowerCase())) ?? this.db.jobs.find((j) => j.orgId === s.orgId);
      const round = this.db.rounds.find((r) => r.jobId === job?.id);
      return { tool: 'get_invite_link', text: round ? `The invite link for ${job!.title}, ${round.name}, is on your screen: intervwd.com/${round.publicPath ?? `i/${round.inviteCode}`}. It has ${round.slots.filter((x) => !x.candidateId).length} open slots.` : 'That job has no rounds yet.' };
    }
    return { text: 'I can tell you how today\'s interviews went, read a candidate\'s report, compare candidates, share an invite link, or move someone to the next round. What would you like?' };
  }

  // ---------- Candidate ----------

  private byCode(code: string) {
    const round = this.db.rounds.find((r) => r.inviteCode === code || r.publicPath === code.replace('~', '/'));
    if (!round) throw new ApiError("This invite link isn't valid. Ask the company for a new one.", 404);
    return round;
  }

  async invite(code: string): Promise<InviteView> {
    await pause();
    const round = this.byCode(code);
    const org = this.find(this.db.orgs, round.orgId, 'company');
    return {
      orgName: org.name, job: this.find(this.db.jobs, round.jobId, 'job'),
      round: { id: round.id, name: round.name, index: round.index, durationMin: round.durationMin, identityCheck: !!round.identityCheck, requireApproval: !!round.requireApproval,
        mode: round.mode ?? 'ai', interviewers: (round.interviewers ?? []).map((i) => i.name), meetingUrl: round.meetingUrl },
      openSlots: round.slots.filter((s) => !s.candidateId && new Date(s.start) > new Date(Date.now() - 3600_000)),
    };
  }

  async join(code: string, input: JoinInput): Promise<JoinResult> {
    await pause(500);
    const round = this.byCode(code);
    if (!input.consent) throw new ApiError('Agree to the recording terms to book.', 400);
    if (input.slotId === 'now') {
      input = { ...input, slotId: id('s') };
      round.slots.push({ id: input.slotId, start: new Date().toISOString() });
    }
    const slot = round.slots.find((s) => s.id === input.slotId);
    if (!slot || slot.candidateId) throw new ApiError('That slot was just taken. Pick another.', 409);
    if (!input.cv) throw new ApiError('Upload your CV as a PDF or text file.', 400);
    const cvText = (await input.cv.text().catch(() => '')).slice(0, 20000);
    const known = ['Python', 'FastAPI', 'Django', 'Flask', 'AWS', 'Lambda', 'PostgreSQL', 'MySQL', 'Redis', 'Kafka', 'Go', 'Java', 'React', 'Node.js', 'SQL', 'Docker', 'Kubernetes', 'DynamoDB', 'Excel', 'Tableau', 'Retail', 'Inventory'];
    const skills = known.filter((k) => new RegExp(`\\b${k.replace('.', '\\.')}\\b`, 'i').test(cvText)).slice(0, 5);
    const c: Candidate = {
      id: id('cand'), orgId: round.orgId, jobId: round.jobId, roundId: round.id, name: input.name.trim(), email: input.email.trim().toLowerCase(),
      cvName: input.cv.name, cvSummary: skills.length ? `CV mentions ${skills.join(', ')}.` : 'CV received.', skills, status: 'scheduled', createdAt: iso(new Date()),
    };
    slot.candidateId = c.id;
    const iv: Interview = { id: id('iv'), orgId: round.orgId, jobId: round.jobId, roundId: round.id, candidateId: c.id, slotStart: slot.start, status: 'scheduled', turns: [], snapshots: [] };
    this.db.candidates.push(c);
    this.db.interviews.push(iv);
    this.save();
    return { interviewId: iv.id, status: c.status };
  }

  private ctx(interviewId: string) {
    const interview = this.find(this.db.interviews, interviewId, 'interview');
    const round = this.find(this.db.rounds, interview.roundId, 'round');
    const candidate = this.find(this.db.candidates, interview.candidateId, 'candidate');
    const org = this.find(this.db.orgs, interview.orgId, 'company');
    return { interview, round, candidate, org };
  }

  async room(interviewId: string): Promise<InterviewRoomView> {
    await pause();
    const { interview, round, candidate, org } = this.ctx(interviewId);
    const job = this.find(this.db.jobs, interview.jobId, 'job');
    return {
      interview, candidateName: candidate.name, orgName: org.name, job: { id: job.id, title: job.title },
      round: { id: round.id, name: round.name, durationMin: round.durationMin, questions: round.questions },
      candidateStatus: candidate.status,
      identity: { required: !!round.identityCheck, status: interview.identity?.status ?? 'pending', attemptsLeft: 3 },
    };
  }

  async startInterview(interviewId: string): Promise<InterviewStep> {
    await pause(400);
    const { interview, round, candidate, org } = this.ctx(interviewId);
    if (interview.status === 'completed') throw new ApiError('This interview has already finished.', 409);
    const turns = engine.start(interview, round, candidate, org.name);
    candidate.status = 'in_progress';
    this.save();
    return { turns, done: false, progress: engine.progress(interview, round) };
  }

  async answer(interviewId: string, text: string): Promise<InterviewStep> {
    await pause(700);
    const { interview, round, candidate } = this.ctx(interviewId);
    if (!text.trim()) throw new ApiError('Say or type an answer first.', 400);
    const { turns, done } = engine.answer(interview, round, candidate, text);
    if (done) candidate.status = 'completed';
    this.save();
    return { turns, done, progress: engine.progress(interview, round) };
  }

  async snapshot(interviewId: string, image: Blob) {
    const { interview } = this.ctx(interviewId);
    if (interview.snapshots.length >= 6) return;
    const url = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(image);
    });
    interview.snapshots.push({ at: iso(new Date()), url });
    this.save();
  }
}
