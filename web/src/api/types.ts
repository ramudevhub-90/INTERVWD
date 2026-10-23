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
  publicPath?: string; // the invite link's path: <company>/<job>-r<round>, e.g. northwind-labs/backend-engineer-r1
  identityCheck?: boolean; // face must match the profile photo before the interview starts
  requireApproval?: boolean; // HR approves sign-ups before the interview link goes out
  mode?: 'ai' | 'human'; // who interviews: the AI by voice, or a person over a video call with a scorecard
  meetingUrl?: string; // person-run rounds: the video call link
  interviewers?: { name: string; email: string }[];
  location?: 'online' | 'office'; // at the office: reception check-in with Alexa, interview in an Echo Show room
  decisionMode?: 'human' | 'auto'; // auto: the AI fast-tracks clear, confident passes; everything else goes to a person
  autoAdvance?: { minOverall: number; minEach: number };
}

export type CandidateStatus =
  | 'invited' // added by HR, hasn't finished their profile
  | 'pending_approval' // signed up through the link, waiting for HR
  | 'declined' // HR declined the sign-up
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
  phone?: string;
  hasPhoto?: boolean;
  photoUrl?: string; // short-lived link to the profile photo (server only)
  photoDeleted?: boolean;
  skills: string[];
  status: CandidateStatus;
  createdAt: string;
}

export type TurnKind = 'greeting' | 'question' | 'follow_up' | 'answer' | 'invite_questions' | 'candidate_question' | 'closing';

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
  confidence?: 'high' | 'medium' | 'low';
}

export interface Report {
  overall: number;
  summary: string;
  highlights: string[];
  concerns: string[];
  criteria: CriterionScore[];
  generatedAt: string;
  scoredBy?: 'nova' | 'rules' | 'human';
  scoredByName?: string; // the interviewer, for person-run rounds
}

/** Where a finished interview goes: fast-tracked by the AI, or to a person (unsure, or below the bar). */
export interface Triage {
  band: 'fast_track' | 'review' | 'below';
  reasons: string[];
  rule: { minOverall: number; minEach: number };
}

export interface Snapshot {
  at: string;
  url: string;
  match?: 'matched' | 'no_match' | 'no_face' | 'error';
  similarity?: number | null;
}

export interface Identity {
  status: 'pending' | 'matched' | 'locked' | 'approved';
  attempts?: number;
  similarity?: number | null;
  lastResult?: string;
  approvedBy?: string;
  liveUrl?: string;
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
  triage?: Triage;
  identity?: Identity;
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
  automatic?: boolean;
}

// ---------- Composite views ----------

export interface DashboardView {
  org: Org;
  stats: { openJobs: number; interviewsToday: number; awaitingDecision: number; candidates: number; pendingApproval?: number };
  jobs: (Job & { candidateCount: number; currentRound?: string })[];
  upcoming: { interview: Interview; candidate: Candidate; job: Job; round: Round }[];
  awaiting: { interview: Interview; candidate: Candidate; job: Job; round: Round }[];
  pending?: { candidate: Candidate; job: Job; round: Round }[];
  identityLocked?: { interview: Interview; candidate: Candidate; job: Job; round: Round }[];
}

export interface JobView {
  job: Job;
  rounds: Round[];
  candidates: (Candidate & { overall?: number | null; roundName: string })[];
}

export interface InviteView {
  orgName: string;
  job: Job;
  round: Pick<Round, 'id' | 'name' | 'index' | 'durationMin' | 'publicPath' | 'meetingUrl'> & {
    identityCheck: boolean; requireApproval: boolean; mode: 'ai' | 'human'; interviewers: string[];
    location?: 'online' | 'office'; address?: string;
  };
  openSlots: Slot[];
  invited?: { name: string; email: string; hasCv: boolean; hasPhoto?: boolean; returning?: boolean }; // on a personal link
}

export interface CandidateView {
  candidate: Candidate;
  job: Job;
  rounds: Round[];
  interviews: Interview[];
  decisions: Decision[];
  identityRequired?: boolean;
}

export interface InterviewRoomView {
  interview: Interview;
  candidateName: string;
  orgName: string;
  job: Pick<Job, 'id' | 'title'>;
  round: Pick<Round, 'id' | 'name' | 'durationMin' | 'questions'>;
  candidateStatus?: CandidateStatus;
  mode?: 'ai' | 'human';
  meetingUrl?: string | null;
  interviewers?: string[];
  slotStart?: string;
  identity?: { required: boolean; status: Identity['status']; attemptsLeft: number };
}

export interface VerifyResult {
  status: Identity['status'] | 'not_required';
  result?: 'matched' | 'no_match' | 'no_face' | 'error';
  similarity?: number | null;
  attemptsLeft?: number;
  message?: string;
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
  identityCheck: boolean;
  requireApproval: boolean;
  decisionMode: 'human' | 'auto';
  autoAdvance: { minOverall: number; minEach: number };
  mode: 'ai' | 'human';
  meetingUrl: string;
  interviewers: { name: string; email: string }[];
  location: 'online' | 'office';
}

export interface Scorecard {
  criteria: { criterionId: string; score: number; notes: string }[];
  summary: string;
  highlights: string; // one per line
  concerns: string;
}

export interface JoinInput {
  name: string;
  email: string;
  cv?: File; // PDF or text; the server stores it and Nova reads it (optional when HR already added one)
  photo?: File; // face photo for the identity check
  faceConsent: boolean;
  phone: string;
  token?: string; // personal link of a candidate HR added
  slotId: string;
  consent: boolean;
}

export interface JoinResult {
  interviewId: string | null; // null until HR approves the sign-up
  status: CandidateStatus;
}

export interface NewCandidate {
  roundId: string;
  name: string;
  email: string;
  cv?: File;
}

// ---------- Knowledge base ----------

/** interviewer: shapes questions and scoring, never shown to candidates. shareable: answers candidates' questions. */
export type KnowledgeKind = 'interviewer' | 'shareable';

export interface KnowledgeDoc {
  id: string;
  jobId: string;
  name: string;
  kind: KnowledgeKind;
  size: number;
  status: 'pending' | 'syncing' | 'ready' | 'failed';
  createdAt: string;
}

export interface KnowledgeView {
  enabled: boolean;
  documents: KnowledgeDoc[];
}

export type NewKnowledge = { kind: KnowledgeKind } & ({ file: File } | { name: string; text: string });

export interface OrgSettings {
  orgName: string;
  slug: string; // the company's name in invite links: intervwd.com/<slug>/<round>
  locked: boolean; // the demo company can't rename its links
  office: { address: string; rooms: string[] };
  kiosk: string | null; // the reception Echo Show's link; rooms add /room/<name>
}

export interface KioskInfo {
  orgName: string;
  address: string;
  rooms: string[];
}

export interface CheckIn {
  interviewId: string;
  firstName: string;
  jobTitle: string;
  roundName: string;
  slotStart: string;
  identityRequired: boolean;
  identityStatus: string;
  withPerson: boolean;
  interviewers: string[];
}

export interface HiringDay {
  counts: { expected: number; arrived: number; in_room: number; done: number; no_show: number };
  rows: { interviewId: string; candidateId: string; name: string; slotStart: string; room: string | null; state: 'expected' | 'arrived' | 'in_room' | 'done' | 'no_show'; overall: number | null }[];
}

/** A seat in an interview's video call (Amazon Chime SDK meeting + this person's attendee). */
export interface CallJoin {
  meeting: unknown;
  attendee: unknown;
  candidateName: string;
  candidateId: string;
  jobTitle: string;
  roundName: string;
  orgName: string;
  interviewers: string[];
}
