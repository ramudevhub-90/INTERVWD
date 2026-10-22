// Domain types shared by every page. The server returns exactly these shapes (JSON, camelCase).

export type Role = 'recruiter' | 'candidate';

export interface Session {
  userId: string;
  email: string;
  name: string;
  role: Role;
  orgId?: string;
  orgName?: string;
}

export interface Org {
  id: string;
  name: string;
  createdAt: string;
}

export interface Job {
  id: string;
  orgId: string;
  title: string;
  location: string;
  description: string;
  status: 'open' | 'closed';
  createdAt: string;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
}

export interface Slot {
  id: string;
  start: string; // ISO date-time
  candidateId?: string;
}

export interface Round {
  id: string;
  jobId: string;
  orgId: string;
  index: number; // 1-based: Round 1, Round 2...
  name: string;
  durationMin: number;
  criteria: Criterion[];
  questions: string[];
  inviteCode: string;
  slots: Slot[];
}

export type CandidateStatus =
  | 'scheduled' // booked a slot, interview not started
  | 'in_progress'
  | 'completed' // interview done, waiting for a recruiter
  | 'advanced'
  | 'on_hold'
  | 'rejected';

export interface Candidate {
  id: string;
  orgId: string;
  jobId: string;
  roundId: string; // current round
  name: string;
  email: string;
  cvName: string;
  cvSummary: string;
  cvUrl?: string; // short-lived link to the uploaded CV (server only)
  skills: string[];
  status: CandidateStatus;
  createdAt: string;
}

export type TurnKind = 'greeting' | 'question' | 'follow_up' | 'answer' | 'closing';

export interface Turn {
  role: 'interviewer' | 'candidate';
  kind: TurnKind;
  text: string;
  at: string;
  questionIndex: number;
}

export interface CriterionScore {
  criterionId: string;
  name: string;
  score: number; // 1 to 5, one decimal
  evidence: string;
}

export interface Report {
  overall: number;
  summary: string;
  highlights: string[];
  concerns: string[];
  criteria: CriterionScore[];
  generatedAt: string;
}

export interface Snapshot {
  at: string;
  url: string;
}

export interface Interview {
  id: string;
  orgId: string;
  jobId: string;
  roundId: string;
  candidateId: string;
  slotStart: string;
  status: 'scheduled' | 'in_progress' | 'completed';
  turns: Turn[];
  snapshots: Snapshot[];
  report?: Report;
  startedAt?: string;
  endedAt?: string;
}

export type DecisionAction = 'advance' | 'hold' | 'reject';

export interface Decision {
  id: string;
  candidateId: string;
  roundId: string;
  action: DecisionAction;
  note: string;
  by: string;
  at: string;
}

// ---------- Composite views ----------

export interface DashboardView {
  org: Org;
  stats: { openJobs: number; interviewsToday: number; awaitingDecision: number; candidates: number };
  jobs: (Job & { candidateCount: number; currentRound?: string })[];
  upcoming: { interview: Interview; candidate: Candidate; job: Job; round: Round }[];
  awaiting: { interview: Interview; candidate: Candidate; job: Job; round: Round }[];
}

export interface JobView {
  job: Job;
  rounds: Round[];
  candidates: (Candidate & { overall?: number; roundName: string })[];
}

export interface InviteView {
  orgName: string;
  job: Job;
  round: Pick<Round, 'id' | 'name' | 'index' | 'durationMin'>;
  openSlots: Slot[];
}

export interface CandidateView {
  candidate: Candidate;
  job: Job;
  rounds: Round[];
  interviews: Interview[];
  decisions: Decision[];
}

export interface InterviewRoomView {
  interview: Interview;
  candidateName: string;
  orgName: string;
  job: Pick<Job, 'id' | 'title'>;
  round: Pick<Round, 'id' | 'name' | 'durationMin' | 'questions'>;
}

// Each answer returns the interviewer's next turn; `done` when the interview has closed.
export interface InterviewStep {
  turns: Turn[];
  done: boolean;
  progress: { question: number; of: number };
}

export interface AssistantReply {
  text: string;
  tool?: string; // the MCP tool the assistant called, shown in the Alexa+ simulator
  pendingConfirmation?: boolean;
}

// ---------- Inputs ----------

export interface NewJob {
  title: string;
  location: string;
  description: string;
}

export interface NewRound {
  name: string;
  durationMin: number;
  criteria: { name: string; description: string }[];
  questions: string[];
}

export interface JoinInput {
  name: string;
  email: string;
  cv: File; // PDF or text; the server stores it and Nova reads it
  slotId: string;
  consent: boolean;
}
