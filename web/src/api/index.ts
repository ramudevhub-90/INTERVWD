import type {
  AssistantReply,
  CallJoin,
  CandidateView,
  DashboardView,
  DecisionAction,
  InterviewRoomView,
  InterviewStep,
  InviteView,
  JobView,
  JoinInput,
  JoinResult,
  NewCandidate,
  VerifyResult,
  KnowledgeDoc,
  KnowledgeView,
  NewJob,
  NewKnowledge,
  NewRound,
  OrgSettings,
  Round,
  Scorecard,
  Session,
} from './types';
import { MockApi } from './mock';
import { HttpApi } from './http';

/** Everything the UI can ask of the backend. MockApi and HttpApi both implement it. */
export interface Api {
  readonly mode: 'mock' | 'http';

  // Sign-in with a 6-digit code sent by email.
  session(): Promise<Session | null>;
  sendCode(email: string): Promise<{ hint?: string }>;
  verifyCode(email: string, code: string): Promise<Session>;
  signOut(): Promise<void>;
  createOrg(input: { orgName: string; name: string; email: string }): Promise<{ hint?: string }>;

  // Recruiter
  dashboard(): Promise<DashboardView>;
  settings(): Promise<OrgSettings>;
  saveSettings(slug: string): Promise<OrgSettings>;
  createJob(input: NewJob): Promise<string>;
  job(jobId: string): Promise<JobView>;
  createRound(jobId: string, input: NewRound): Promise<Round>;
  addSlots(roundId: string, starts: string[]): Promise<Round>;
  removeSlot(roundId: string, slotId: string): Promise<Round>;
  knowledge(jobId: string): Promise<KnowledgeView>;
  addKnowledge(jobId: string, input: NewKnowledge): Promise<KnowledgeDoc>;
  removeKnowledge(jobId: string, docId: string): Promise<void>;
  candidate(candidateId: string): Promise<CandidateView>;
  decide(candidateId: string, action: DecisionAction, note: string): Promise<void>;
  addCandidate(jobId: string, input: NewCandidate): Promise<{ id: string; link: string }>;
  reviewSignup(candidateId: string, approve: boolean): Promise<void>;
  approveIdentity(candidateId: string): Promise<void>;
  submitScorecard(interviewId: string, card: Scorecard): Promise<void>;
  hostCall(interviewId: string): Promise<CallJoin>;
  assistant(message: string): Promise<AssistantReply>;

  // Candidate
  invite(code: string, token?: string): Promise<InviteView>;
  join(code: string, input: JoinInput): Promise<JoinResult>;
  verifyIdentity(interviewId: string, image: Blob): Promise<VerifyResult>;
  joinCall(interviewId: string): Promise<CallJoin>;
  room(interviewId: string): Promise<InterviewRoomView>;
  startInterview(interviewId: string): Promise<InterviewStep>;
  answer(interviewId: string, text: string): Promise<InterviewStep>;
  snapshot(interviewId: string, image: Blob): Promise<void>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const mode = (import.meta.env.VITE_API_MODE as string | undefined) ?? 'mock';
export const api: Api = mode === 'http' ? new HttpApi() : new MockApi();
