// The real backend: JSON over /api on the same origin (CloudFront routes /api and /mcp to Lambda).
// Recruiters sign in with an emailed code and get a bearer token; candidates use their interview ID,
// which is an unguessable token sent only to them.

import type { Api } from './index';
import { ApiError } from './index';
import type { DecisionAction, JoinInput, JoinResult, KnowledgeDoc, KnowledgeView, NewCandidate, NewJob, NewKnowledge, NewRound, Session, VerifyResult } from './types';

const TOKEN = 'intervwd-token';

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

function setToken(value: string | null) {
  try {
    if (value) localStorage.setItem(TOKEN, value);
    else localStorage.removeItem(TOKEN);
  } catch {
    /* private mode: the session lasts for this tab only */
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Minutes behind UTC, so "today" on the dashboard and Alexa means the recruiter's today.
  const headers: Record<string, string> = { 'x-tz-offset': String(new Date().getTimezoneOffset()) };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError((data as { error?: string } | undefined)?.error ?? 'Something went wrong. Try again.', res.status);
  }
  return data as T;
}

export class HttpApi implements Api {
  readonly mode = 'http' as const;

  async session() {
    if (!token()) return null;
    try {
      return await call<Session>('GET', '/session');
    } catch {
      return null;
    }
  }

  sendCode(email: string) {
    return call<{ hint?: string }>('POST', '/auth/code', { email });
  }

  async verifyCode(email: string, code: string) {
    const { token: t, session } = await call<{ token: string; session: Session }>('POST', '/auth/verify', { email, code });
    setToken(t);
    return session;
  }

  async signOut() {
    await call('POST', '/auth/signout').catch(() => undefined);
    setToken(null);
  }

  oauthRequest(id: string) {
    return call<{ clientName: string }>('GET', `/oauth/requests/${encodeURIComponent(id)}`);
  }

  async oauthDecide(id: string, approve: boolean) {
    return (await call<{ redirect: string }>('POST', `/oauth/requests/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`)).redirect;
  }

  /** The interviewer's voice from Amazon Polly. */
  async speech(text: string): Promise<Blob> {
    const res = await fetch('/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) throw new ApiError('No audio', res.status);
    return res.blob();
  }

  createOrg(input: { orgName: string; name: string; email: string }) {
    return call<{ hint?: string }>('POST', '/orgs', input);
  }

  settings() {
    return call<import('./types').OrgSettings>('GET', '/settings');
  }

  saveSettings(slug: string) {
    return call<import('./types').OrgSettings>('POST', '/settings', { slug });
  }

  saveOffice(address: string, rooms: string[]) {
    return call<import('./types').OrgSettings>('POST', '/settings/office', { address, rooms });
  }

  newKiosk() {
    return call<import('./types').OrgSettings>('POST', '/settings/kiosk');
  }

  hiringDay() {
    return call<import('./types').HiringDay>('GET', '/hiring-day');
  }

  kiosk(token: string) {
    return call<import('./types').KioskInfo>('GET', `/kiosk/${encodeURIComponent(token)}`);
  }

  kioskCheckin(token: string, name: string) {
    return call<import('./types').CheckIn>('POST', `/kiosk/${encodeURIComponent(token)}/checkin`, { name });
  }

  kioskArrive(token: string, interviewId: string) {
    return call<{ room: string | null; message: string }>('POST', `/kiosk/${encodeURIComponent(token)}/arrive`, { interviewId });
  }

  kioskRoom(token: string, room: string) {
    return call<{ room: string; orgName: string; interviewId: string | null; firstName?: string }>('GET', `/kiosk/${encodeURIComponent(token)}/room/${encodeURIComponent(room)}`);
  }

  reports(days: number) {
    return call<import('./types').ReportsView>('GET', `/reports?days=${days}`);
  }

  dashboard() {
    return call<import('./types').DashboardView>('GET', '/dashboard');
  }

  async createJob(input: NewJob) {
    return (await call<{ id: string }>('POST', '/jobs', input)).id;
  }

  job(jobId: string) {
    return call<import('./types').JobView>('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  createRound(jobId: string, input: NewRound) {
    return call<import('./types').Round>('POST', `/jobs/${encodeURIComponent(jobId)}/rounds`, input);
  }

  addSlots(roundId: string, starts: string[]) {
    return call<import('./types').Round>('POST', `/rounds/${encodeURIComponent(roundId)}/slots`, { starts });
  }

  removeSlot(roundId: string, slotId: string) {
    return call<import('./types').Round>('DELETE', `/rounds/${encodeURIComponent(roundId)}/slots/${encodeURIComponent(slotId)}`);
  }

  knowledge(jobId: string) {
    return call<KnowledgeView>('GET', `/jobs/${encodeURIComponent(jobId)}/knowledge`);
  }

  addKnowledge(jobId: string, input: NewKnowledge) {
    const form = new FormData();
    form.set('kind', input.kind);
    if ('file' in input) form.set('file', input.file, input.file.name);
    else {
      form.set('name', input.name);
      form.set('text', input.text);
    }
    return call<KnowledgeDoc>('POST', `/jobs/${encodeURIComponent(jobId)}/knowledge`, form);
  }

  async removeKnowledge(jobId: string, docId: string) {
    await call('DELETE', `/jobs/${encodeURIComponent(jobId)}/knowledge/${encodeURIComponent(docId)}`);
  }

  candidate(candidateId: string) {
    return call<import('./types').CandidateView>('GET', `/candidates/${encodeURIComponent(candidateId)}`);
  }

  async decide(candidateId: string, action: DecisionAction, note: string) {
    await call('POST', `/candidates/${encodeURIComponent(candidateId)}/decision`, { action, note });
  }

  addCandidate(jobId: string, input: NewCandidate) {
    const form = new FormData();
    form.set('roundId', input.roundId);
    form.set('name', input.name);
    form.set('email', input.email);
    if (input.cv) form.set('cv', input.cv, input.cv.name);
    return call<{ id: string; link: string }>('POST', `/jobs/${encodeURIComponent(jobId)}/candidates`, form);
  }

  async reviewSignup(candidateId: string, approve: boolean) {
    await call('POST', `/candidates/${encodeURIComponent(candidateId)}/signup`, { approve });
  }

  async approveIdentity(candidateId: string) {
    await call('POST', `/candidates/${encodeURIComponent(candidateId)}/identity/approve`);
  }

  async submitScorecard(interviewId: string, card: import('./types').Scorecard) {
    await call('POST', `/interviews/${encodeURIComponent(interviewId)}/scorecard`, card);
  }

  practiceStart(interviewId: string) {
    return call<{ intro: string; question: string; index: number; of: number; jobTitle: string; orgName: string }>('POST', `/practice/${encodeURIComponent(interviewId)}/start`);
  }

  practiceAnswer(interviewId: string, text: string) {
    return call<{ feedback: { strength: string; improve: string; tip: string }; question: string | null; index: number; of: number }>('POST', `/practice/${encodeURIComponent(interviewId)}/answer`, { text });
  }

  joinLive(interviewId: string) {
    return call<import('./types').CallJoin>('POST', `/interviews/${encodeURIComponent(interviewId)}/live`);
  }

  liveStatus(interviewId: string) {
    return call<{ watchers: string[]; takenOverBy: string | null; status: string }>('GET', `/interviews/${encodeURIComponent(interviewId)}/live/status`);
  }

  liveReport(interviewId: string, stage: string, detail = '') {
    return call<unknown>('POST', `/interviews/${encodeURIComponent(interviewId)}/live/report`, { stage, detail }).catch(() => undefined);
  }

  liveHost(interviewId: string) {
    return call<import('./types').CallJoin>('POST', `/interviews/${encodeURIComponent(interviewId)}/live/host`);
  }

  liveState(interviewId: string) {
    return call<import('./types').LiveView>('GET', `/interviews/${encodeURIComponent(interviewId)}/live/state`);
  }

  liveControl(interviewId: string, action: 'ask' | 'take_over' | 'hand_back', question = '') {
    return call<import('./types').LiveView>('POST', `/interviews/${encodeURIComponent(interviewId)}/live/control`, { action, question });
  }

  joinCall(interviewId: string) {
    return call<import('./types').CallJoin>('POST', `/interviews/${encodeURIComponent(interviewId)}/call`);
  }

  hostCall(interviewId: string) {
    return call<import('./types').CallJoin>('POST', `/interviews/${encodeURIComponent(interviewId)}/call/host`);
  }

  verifyIdentity(interviewId: string, image: Blob) {
    const form = new FormData();
    form.set('image', image, 'live.jpg');
    return call<VerifyResult>('POST', `/interviews/${encodeURIComponent(interviewId)}/verify`, form);
  }

  assistant(message: string) {
    return call<import('./types').AssistantReply>('POST', '/assistant', { message });
  }

  invite(code: string, token?: string) {
    return call<import('./types').InviteView>('GET', `/invites/${encodeURIComponent(code)}${token ? `?t=${encodeURIComponent(token)}` : ''}`);
  }

  join(code: string, input: JoinInput) {
    const form = new FormData();
    form.set('name', input.name);
    form.set('email', input.email);
    form.set('slotId', input.slotId);
    form.set('consent', String(input.consent));
    form.set('faceConsent', String(input.faceConsent));
    if (input.source) form.set('source', input.source);
    form.set('phone', input.phone);
    if (input.token) form.set('t', input.token);
    if (input.cv) form.set('cv', input.cv, input.cv.name);
    if (input.photo) form.set('photo', input.photo, input.photo.name);
    return call<JoinResult>('POST', `/invites/${encodeURIComponent(code)}/join`, form);
  }

  room(interviewId: string) {
    return call<import('./types').InterviewRoomView>('GET', `/interviews/${encodeURIComponent(interviewId)}`);
  }

  startInterview(interviewId: string) {
    return call<import('./types').InterviewStep>('POST', `/interviews/${encodeURIComponent(interviewId)}/start`);
  }

  answer(interviewId: string, text: string) {
    return call<import('./types').InterviewStep>('POST', `/interviews/${encodeURIComponent(interviewId)}/answer`, { text });
  }

  async snapshot(interviewId: string, image: Blob) {
    const form = new FormData();
    form.set('image', image, 'snapshot.jpg');
    await call('POST', `/interviews/${encodeURIComponent(interviewId)}/snapshots`, form);
  }
}
