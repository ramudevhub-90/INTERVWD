// The in-browser interview engine used by the sample-data backend. The server runs the same steps,
// with Amazon Nova writing the follow-ups and the report instead of these rules.
//
// Flow: greeting + question 1 → answer → one follow-up → answer → question 2 → ... → closing.

import type { Candidate, Criterion, Interview, InterviewStep, Report, Round, Turn } from '../api/types';

const now = () => new Date().toISOString();

const STOP = new Set(
  'the a an and or but so to of in on for with at by from that this it is was were be been i we you they my our me us as if then than when what which who how about into over just also very really more most some any can could would should will did do does done have has had not no yes'.split(' '),
);

function keyPhrase(answer: string): string | undefined {
  const words = answer.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));
  if (!words.length) return undefined;
  // Prefer a capitalised term (a tool or product name), else the longest word.
  return words.find((w, i) => i > 0 && /^[A-Z]/.test(w)) ?? [...words].sort((a, b) => b.length - a.length)[0];
}

export function personalise(question: string, candidate: Candidate, index: number): string {
  const skill = candidate.skills[index % Math.max(candidate.skills.length, 1)];
  if (index === 0 || !skill || question.toLowerCase().includes(skill.toLowerCase())) return question;
  return `${question} If you can, use an example involving ${skill}.`;
}

export function followUp(answer: string): string {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 12) return 'Could you go a little deeper? Walk me through a specific example, step by step.';
  const phrase = keyPhrase(answer);
  return phrase
    ? `You mentioned ${phrase}. What was the hardest trade-off there, and what would you do differently now?`
    : 'What was the hardest trade-off in that, and what would you do differently now?';
}

function turn(role: Turn['role'], kind: Turn['kind'], text: string, questionIndex: number): Turn {
  return { role, kind, text, at: now(), questionIndex };
}

export function progress(interview: Interview, round: Round): InterviewStep['progress'] {
  const asked = interview.turns.filter((t) => t.kind === 'question').length;
  return { question: Math.max(asked, 1), of: round.questions.length };
}

/** Starts (or resumes) the interview and returns what the interviewer says. */
export function start(interview: Interview, round: Round, candidate: Candidate, orgName: string): Turn[] {
  if (interview.turns.length) return interview.turns.filter((t) => t.role === 'interviewer').slice(-1);
  const first = candidate.name.split(' ')[0];
  const turns = [
    turn('interviewer', 'greeting', `Hi ${first}, thanks for joining. I'm the interviewer for ${orgName}'s ${round.name}. It takes about ${round.durationMin} minutes and ${round.questions.length} questions, and I may ask a follow-up after each. Take your time; there are no trick questions.`, 0),
    turn('interviewer', 'question', personalise(round.questions[0], candidate, 0), 0),
  ];
  interview.turns.push(...turns);
  interview.status = 'in_progress';
  interview.startedAt = now();
  return turns;
}

/** Records the candidate's answer and returns the interviewer's next turns. */
export function answer(interview: Interview, round: Round, candidate: Candidate, text: string): { turns: Turn[]; done: boolean } {
  const last = [...interview.turns].reverse().find((t) => t.role === 'interviewer');
  if (!last || interview.status === 'completed') return { turns: [], done: true };
  const q = last.questionIndex;
  interview.turns.push(turn('candidate', 'answer', text.trim(), q));

  let next: Turn[];
  if (last.kind === 'question') {
    next = [turn('interviewer', 'follow_up', followUp(text), q)];
  } else if (q + 1 < round.questions.length) {
    next = [turn('interviewer', 'question', personalise(round.questions[q + 1], candidate, q + 1), q + 1)];
  } else {
    next = [turn('interviewer', 'closing', `That's everything, ${candidate.name.split(' ')[0]}. Thank you. The team will review your interview and get back to you by email.`, q)];
  }
  interview.turns.push(...next);
  const done = next[0].kind === 'closing';
  if (done) {
    interview.status = 'completed';
    interview.endedAt = now();
    interview.report = score(interview, round.criteria);
  }
  return { turns: next, done };
}

// ---------- Sample scoring (the server asks Nova to score against the rubric) ----------

const clamp = (n: number) => Math.round(Math.min(5, Math.max(1, n)) * 10) / 10;

function excerpt(text: string, words = 18): string {
  const parts = text.split(/\s+/);
  return parts.slice(0, words).join(' ') + (parts.length > words ? '…' : '');
}

export function score(interview: Interview, criteria: Criterion[]): Report {
  const answers = interview.turns.filter((t) => t.kind === 'answer');
  const words = (t: Turn) => t.text.split(/\s+/).filter(Boolean).length;
  const scores = criteria.map((c, i) => {
    const terms = (c.name + ' ' + c.description).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const ranked = [...answers].sort((a, b) => {
      const hits = (t: Turn) => terms.filter((w) => t.text.toLowerCase().includes(w)).length;
      return hits(b) * 40 + words(b) - (hits(a) * 40 + words(a));
    });
    const best = ranked[0] ?? answers[i];
    const depth = best ? Math.min(2.2, words(best) / 45) : 0;
    const coverage = answers.length ? Math.min(0.8, answers.filter((a) => words(a) > 20).length / answers.length) : 0;
    return {
      criterionId: c.id,
      name: c.name,
      score: clamp(1.6 + depth + coverage),
      evidence: best ? `"${excerpt(best.text)}"` : 'No answer touched this area.',
    };
  });
  const overall = clamp(scores.reduce((s, c) => s + c.score, 0) / Math.max(scores.length, 1));
  const strong = scores.filter((s) => s.score >= 3.8).map((s) => s.name);
  const weak = scores.filter((s) => s.score < 3).map((s) => s.name);
  return {
    overall,
    summary: `Answered ${answers.length} questions and follow-ups. ${strong.length ? `Strongest on ${strong.join(', ')}.` : 'No area stood out strongly.'} ${weak.length ? `Thin on ${weak.join(', ')}.` : ''}`.trim(),
    highlights: strong.length ? strong.map((s) => `Clear, specific answers on ${s.toLowerCase()}`) : ['Completed every question'],
    concerns: weak.length ? weak.map((s) => `Short or general answers on ${s.toLowerCase()}`) : [],
    criteria: scores,
    generatedAt: now(),
  };
}
