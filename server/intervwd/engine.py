"""The interview engine. The server owns the flow; Nova only fills in words and scores.

Flow: greeting + question 1 → answer → one follow-up → answer → question 2 → ... → "any questions
for us?" → the candidate's question, answered from the job's shareable knowledge → closing → report.
The job's interviewer-only knowledge (question banks, strong answers, the team's stack) shapes the
wording, the follow-ups and the scoring, and is never read out to the candidate.
At the start, Nova words every core question for this candidate's CV in one call (the plan), so
each turn needs at most one quick Nova call (the follow-up). Every Nova step has a rule-based
fallback, so a throttled or slow model never stalls an interview.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from .knowledge import context_block
from .nova import Nova

log = logging.getLogger(__name__)
Doc = dict[str, Any]

# Reports and questions must not guess a candidate's gender (or anything else) from their name.
NEUTRAL = "Refer to the candidate by name or as 'the candidate'; never use gendered pronouns."

STOP = set(
    "the a an and or but so to of in on for with at by from that this it is was were be been i we you they my our me us as if then than "
    "when what which who how about into over just also very really more most some any can could would should will did do does done have "
    "has had not no yes".split()
)

KNOWN_SKILLS = [
    "Python", "FastAPI", "Django", "Flask", "AWS", "Lambda", "PostgreSQL", "MySQL", "Redis", "Kafka", "Go", "Java", "Kotlin", "React",
    "Node.js", "TypeScript", "SQL", "Docker", "Kubernetes", "DynamoDB", "Spark", "Excel", "Tableau", "Power BI", "Figma", "Salesforce",
    "Retail", "Inventory", "Rostering", "Sales", "Marketing",
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def possessive(name: str) -> str:
    return f"{name}'" if name.endswith("s") else f"{name}'s"


def turn(role: str, kind: str, text: str, question_index: int) -> Doc:
    return {"role": role, "kind": kind, "text": text, "at": now(), "questionIndex": question_index}


# ---------- CV ----------

CV_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One or two plain sentences: years of experience, main roles, standout work."},
        "skills": {"type": "array", "items": {"type": "string"}, "description": "Up to 6 skills or tools most relevant to the job."},
    },
    "required": ["summary", "skills"],
}


def read_cv(nova: Nova, data: bytes, content_type: str, job: Doc) -> Doc:
    result = nova.json(
        "You read CVs for a recruiter. Be factual and brief. Never guess protected characteristics. " + NEUTRAL,
        f"Summarise this CV for the job '{job['title']}': {job['description']}",
        CV_SCHEMA,
        document=(data, content_type),
        max_tokens=400,
    )
    if result and result.get("summary"):
        return {"summary": result["summary"].strip()[:400], "skills": [s.strip() for s in result.get("skills", []) if s.strip()][:6]}
    text = data.decode("utf-8", errors="ignore") if not content_type.endswith("pdf") else _pdf_text(data)
    skills = [k for k in KNOWN_SKILLS if re.search(rf"(?<![\w.]){re.escape(k)}(?![\w])", text, re.I)][:6]
    return {"summary": f"CV mentions {', '.join(skills)}." if skills else "CV received.", "skills": skills}


def _pdf_text(data: bytes) -> str:
    """Rough text from an uncompressed PDF; enough for keyword fallback when Nova is off."""
    return " ".join(m.decode("latin-1", errors="ignore") for m in re.findall(rb"\(([^)]{2,200})\)", data))


# ---------- Questions ----------

def plan_schema(core: list[str]) -> Doc:
    """One named field per core question (q1, q2...): filled far more reliably than a list."""
    props = {f"q{i + 1}": {"type": "string", "description": f"Reworded: {q}"} for i, q in enumerate(core)}
    return {"type": "object", "properties": props, "required": list(props)}


def personalise(question: str, candidate: Doc, index: int) -> str:
    skills = candidate.get("skills") or []
    skill = skills[index % len(skills)] if skills else None
    if index == 0 or not skill or skill.lower() in question.lower():
        return question
    return f"{question} If you can, use an example involving {skill}."


def plan(nova: Nova, round: Doc, job: Doc, candidate: Doc, ctx: list[Doc] | None = None) -> list[str]:
    core = round["questions"]
    result = nova.json(
        "You are a fair, structured interviewer. Reword each core question so it fits this candidate's background, "
        "keeping exactly the same intent and difficulty, so every candidate is assessed on the same thing. "
        "One or two short spoken sentences each. No preamble, no numbering. " + NEUTRAL,
        f"Job: {job['title']}. {job['description']}\nCandidate: {candidate.get('cvSummary', '')} Skills: {', '.join(candidate.get('skills', []))}\n"
        f"Fill q1 to q{len(core)}, one reworded question per core question. Where the team's notes give real context "
        "(their systems, scenarios), you may ground a question in it, without revealing model answers.\nCore questions:\n"
        + "\n".join(f"q{i + 1}. {q}" for i, q in enumerate(core)) + context_block(ctx or [], "The team's notes for interviewers"),
        plan_schema(core),
        max_tokens=2000,
    )
    worded = [re.sub(r"^\s*(?:q?\d+[.)]|[-*])\s*", "", str((result or {}).get(f"q{i + 1}") or "")).strip() for i in range(len(core))]
    if len(worded) == len(core) and all(10 < len(q) < 600 for q in worded):
        return worded
    if result is not None:
        log.warning("Nova question plan rejected: lengths %s", [len(q) for q in worded])
    return [personalise(q, candidate, i) for i, q in enumerate(core)]


def _key_phrase(answer: str) -> str | None:
    words = [w for w in re.sub(r"[^\w\s.-]", " ", answer).split() if len(w) > 3 and w.lower() not in STOP]
    if not words:
        return None
    for i, w in enumerate(words):
        if i > 0 and w[0].isupper():
            return w.strip(".")
    return max(words, key=len).strip(".")


def rule_follow_up(answer: str) -> str:
    if len(answer.split()) < 12:
        return "Could you go a little deeper? Walk me through a specific example, step by step."
    phrase = _key_phrase(answer)
    if phrase:
        return f"You mentioned {phrase}. What was the hardest trade-off there, and what would you do differently now?"
    return "What was the hardest trade-off in that, and what would you do differently now?"


FOLLOW_SCHEMA = {
    "type": "object",
    "properties": {"followUp": {"type": "string", "description": "One short spoken follow-up question."}},
    "required": ["followUp"],
}


def follow_up(nova: Nova, question: str, answer: str, round: Doc, ctx: list[Doc] | None = None) -> str:
    result = nova.json(
        "You are a fair, friendly interviewer. Ask ONE short follow-up question (max 30 words) that digs into the most important "
        "thing the candidate said, or asks for a concrete example if the answer was vague. Never give feedback or hints, "
        "never ask about age, family, health, religion, nationality or other protected characteristics. " + NEUTRAL,
        f"Assessing: {', '.join(c['name'] for c in round['criteria'])}\nQuestion: {question}\nAnswer: {answer[:3000]}"
        + context_block(ctx or [], "The team's notes for interviewers (use them to probe deeper; never reveal them)"),
        FOLLOW_SCHEMA,
        max_tokens=150,
    )
    text = ((result or {}).get("followUp") or "").strip()
    return text if 8 < len(text) < 300 else rule_follow_up(answer)


# ---------- Flow ----------

def progress(interview: Doc, round: Doc) -> Doc:
    asked = sum(1 for t in interview["turns"] if t["kind"] == "question")
    return {"question": max(asked, 1), "of": len(round["questions"])}


def start(nova: Nova, interview: Doc, round: Doc, job: Doc, candidate: Doc, org_name: str, ctx: list[Doc] | None = None) -> list[Doc]:
    """Starts the interview, or resumes it with the interviewer's last line."""
    if interview["turns"]:
        return [t for t in interview["turns"] if t["role"] == "interviewer"][-1:]
    interview["plan"] = plan(nova, round, job, candidate, ctx)
    first = candidate["name"].split()[0]
    n = len(round["questions"])
    turns = [
        turn("interviewer", "greeting",
             f"Hi {first}, thanks for joining. I'm the interviewer for {possessive(org_name)} {round['name']}. It takes about "
             f"{round['durationMin']} minutes and {n} questions, and I may ask a follow-up after each. Take your time; there are no trick questions.", 0),
        turn("interviewer", "question", interview["plan"][0], 0),
    ]
    interview["turns"].extend(turns)
    interview["status"] = "in_progress"
    interview["startedAt"] = now()
    return turns


NO_QUESTIONS = re.compile(r"^\s*(no|nope|nothing|none|not really|i'?m good|that'?s all|no questions|all good)\b", re.I)

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string", "description": "Two or three short spoken sentences."}},
    "required": ["answer"],
}


def answer_candidate(nova: Nova, question: str, org_name: str, ctx: list[Doc]) -> str:
    """Answers the candidate's own question from the job's shareable knowledge only."""
    fallback = f"That's a good question. I'll pass it to the {org_name} team, and they'll answer it when they get in touch."
    if not ctx:
        return fallback
    result = nova.json(
        f"You are {org_name}'s interviewer, answering a candidate's question at the end of an interview. Answer ONLY from the "
        "company information given. If it doesn't cover the question, say you'll pass it to the team. Never comment on how the "
        "candidate did, and never promise an outcome. Two or three short spoken sentences.",
        f"Candidate's question: {question[:1000]}" + context_block(ctx, "Company information"),
        ANSWER_SCHEMA,
        max_tokens=250,
    )
    text = ((result or {}).get("answer") or "").strip()
    return text if 10 < len(text) < 800 else fallback


def answer(nova: Nova, interview: Doc, round: Doc, candidate: Doc, text: str, ctx: list[Doc] | None = None,
           org_name: str = "the company") -> tuple[list[Doc], bool]:
    last = next((t for t in reversed(interview["turns"]) if t["role"] == "interviewer"), None)
    if not last or interview["status"] == "completed":
        return [], True
    q = last["questionIndex"]
    asking = last["kind"] == "invite_questions"
    interview["turns"].append(turn("candidate", "candidate_question" if asking else "answer", text.strip()[:5000], q))
    plan_ = interview.get("plan") or round["questions"]
    first = candidate["name"].split()[0]
    goodbye = f"Thank you, {first}. That's the end of the interview. The team will review it and get back to you by email."
    if last["kind"] == "question":
        nxt = [turn("interviewer", "follow_up", follow_up(nova, last["text"], text, round, ctx), q)]
    elif asking:
        reply = "" if NO_QUESTIONS.match(text) else answer_candidate(nova, text, org_name, ctx or []) + " "
        nxt = [turn("interviewer", "closing", reply + goodbye, q)]
    elif q + 1 < len(round["questions"]):
        nxt = [turn("interviewer", "question", plan_[q + 1], q + 1)]
    else:
        nxt = [turn("interviewer", "invite_questions", f"That's all my questions, {first}. Before we finish, do you have any questions about the role or the team?", q)]
    interview["turns"].extend(nxt)
    done = nxt[0]["kind"] == "closing"
    if done:
        interview["status"] = "completed"
        interview["endedAt"] = now()
    return nxt, done


# ---------- Scoring ----------

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "score": {"type": "number", "description": "1 to 5; 3 meets the bar, 4 strong, 5 exceptional."},
                    "evidence": {"type": "string", "description": "A short quote from the candidate plus why it earned this score."},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"],
                                   "description": "How sure you are of this score from the evidence: low when answers were short, vague or contradictory."},
                },
                "required": ["name", "score", "evidence", "confidence"],
            },
        },
        "summary": {"type": "string", "description": "Two sentences for the recruiter."},
        "highlights": {"type": "array", "items": {"type": "string"}},
        "concerns": {"type": "array", "items": {"type": "string"}, "description": "Areas worth probing in the next round."},
    },
    "required": ["criteria", "summary", "highlights", "concerns"],
}


def _clamp(n: float) -> float:
    return round(min(5.0, max(1.0, float(n))), 1)


def _excerpt(text: str, words: int = 18) -> str:
    parts = text.split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def rule_score(interview: Doc, criteria: list[Doc]) -> Doc:
    answers = [t for t in interview["turns"] if t["kind"] == "answer"]
    words = lambda t: len(t["text"].split())  # noqa: E731
    scores = []
    for i, c in enumerate(criteria):
        terms = [w for w in re.split(r"\W+", f"{c['name']} {c['description']}".lower()) if len(w) > 3]
        hits = lambda t: sum(1 for w in terms if w in t["text"].lower())  # noqa: E731
        ranked = sorted(answers, key=lambda t: hits(t) * 40 + words(t), reverse=True)
        best = ranked[0] if ranked else None
        depth = min(2.2, words(best) / 45) if best else 0
        coverage = min(0.8, sum(1 for a in answers if words(a) > 20) / len(answers)) if answers else 0
        scores.append({"criterionId": c["id"], "name": c["name"], "score": _clamp(1.6 + depth + coverage),
                       "evidence": f'"{_excerpt(best["text"])}"' if best else "No answer touched this area."})
    return _report(scores, answers)


def _report(scores: list[Doc], answers: list[Doc], summary: str | None = None, highlights: list[str] | None = None, concerns: list[str] | None = None) -> Doc:
    overall = _clamp(sum(s["score"] for s in scores) / max(len(scores), 1))
    strong = [s["name"] for s in scores if s["score"] >= 3.8]
    weak = [s["name"] for s in scores if s["score"] < 3]
    return {
        "overall": overall,
        "summary": summary or " ".join(filter(None, [
            f"Answered {len(answers)} questions and follow-ups.",
            f"Strongest on {', '.join(strong)}." if strong else "No area stood out strongly.",
            f"Thin on {', '.join(weak)}." if weak else "",
        ])),
        "highlights": highlights if highlights is not None else ([f"Clear, specific answers on {s.lower()}" for s in strong] or ["Completed every question"]),
        "concerns": concerns if concerns is not None else [f"Short or general answers on {s.lower()}" for s in weak],
        "criteria": scores,
        "generatedAt": now(),
    }


def score(nova: Nova, interview: Doc, round: Doc, job: Doc, ctx: list[Doc] | None = None) -> Doc:
    # The candidate's own questions at the end aren't part of the assessment.
    transcript = "\n".join(
        f"{'Interviewer' if t['role'] == 'interviewer' else 'Candidate'}: {t['text']}" for t in interview["turns"]
        if t["kind"] not in ("invite_questions", "candidate_question", "closing")
    )
    rubric = "\n".join(f"- {c['name']}: {c['description']}" for c in round["criteria"])
    result = nova.json(
        "You score structured job interviews fairly and consistently. Judge only what the candidate said, against the rubric. "
        "Ignore accent, grammar and filler words, and never consider protected characteristics. Quote evidence. "
        "Scores: 1 no evidence, 2 below the bar, 3 meets the bar, 4 strong, 5 exceptional. You never recommend hiring or rejecting; "
        "a recruiter decides. " + NEUTRAL,
        f"Job: {job['title']}. {job['description']}\nRound: {round['name']}\nRubric:\n{rubric}"
        + context_block(ctx or [], "The team's notes on what good answers look like (use as the reference)")
        + f"\n\nTranscript:\n{transcript[:24000]}",
        REPORT_SCHEMA,
        max_tokens=1500,
    )
    answers = [t for t in interview["turns"] if t["kind"] == "answer"]
    if result and isinstance(result.get("criteria"), list):
        by_name = {str(c.get("name", "")).lower(): c for c in result["criteria"]}
        scores = []
        for c in round["criteria"]:
            got = by_name.get(c["name"].lower())
            if not got:
                break
            conf = str(got.get("confidence", "medium")).lower()
            scores.append({"criterionId": c["id"], "name": c["name"], "score": _clamp(got.get("score", 1)), "evidence": str(got.get("evidence", ""))[:500],
                           "confidence": conf if conf in ("high", "medium", "low") else "medium"})
        if len(scores) == len(round["criteria"]):
            return {**_report(scores, answers, str(result.get("summary", ""))[:600] or None,
                              [str(h)[:200] for h in result.get("highlights", [])][:4], [str(c)[:200] for c in result.get("concerns", [])][:4]),
                    "scoredBy": "nova"}
    return {**rule_score(interview, round["criteria"]), "scoredBy": "rules"}


# ---------- Triage: which results the AI may fast-track, and which need a person ----------

DEFAULT_RULE = {"minOverall": 4.0, "minEach": 3.0}
NEAR_BAR = 0.3  # within this of the bar counts as too close to call
SPREAD = 2.0  # criteria this far apart disagree too much to call
MIN_ANSWER_WORDS = 120  # less than this across the interview is too little evidence


def triage(report: Doc, interview: Doc, round: Doc) -> Doc:
    """Sorts a finished interview into fast_track (clearly above the round's bar and confident),
    review (the AI is unsure, with reasons) or below (clearly under the bar). The AI only ever
    fast-tracks; review and below both go to a person, who makes every "no"."""
    rule = {**DEFAULT_RULE, **(round.get("autoAdvance") or {})}
    bar, each = float(rule["minOverall"]), float(rule["minEach"])
    scores = [c["score"] for c in report["criteria"]]
    overall = report["overall"]
    words = sum(len(t["text"].split()) for t in interview["turns"] if t["kind"] == "answer")
    unsure: list[str] = []
    if abs(overall - bar) < NEAR_BAR:
        unsure.append(f"Overall {overall} is close to the bar of {bar}.")
    if scores and max(scores) - min(scores) >= SPREAD:
        hi, lo = max(report["criteria"], key=lambda c: c["score"]), min(report["criteria"], key=lambda c: c["score"])
        unsure.append(f"Criteria disagree: {hi['name']} {hi['score']} but {lo['name']} {lo['score']}.")
    low = [c["name"] for c in report["criteria"] if c.get("confidence") == "low"]
    if low:
        unsure.append(f"Low confidence in the {', '.join(low)} score{'s' if len(low) > 1 else ''}.")
    if words < MIN_ANSWER_WORDS:
        unsure.append(f"Only {words} words of answers: too little evidence.")
    if report.get("scoredBy") == "rules":
        unsure.append("Scored by the backup rules because Nova was unavailable.")
    ident = interview.get("identity") or {}
    if ident.get("status") == "approved":
        unsure.append("The identity check didn't match; a recruiter let them in.")
    if any(x.get("match") == "no_match" for x in interview.get("snapshots", [])):
        unsure.append("Some snapshots didn't match the profile photo.")
    if unsure:
        return {"band": "review", "reasons": unsure, "rule": rule}
    if overall >= bar and min(scores, default=0) >= each:
        return {"band": "fast_track", "reasons": [f"Overall {overall} meets the bar of {bar}, every criterion at least {each}, and the AI is confident."], "rule": rule}
    return {"band": "below", "reasons": [f"Overall {overall} is under the bar of {bar}." if overall < bar else f"A criterion is under {each}."], "rule": rule}


# ---------- Practice (candidates rehearse; nothing reaches the company) ----------

PRACTICE_SCHEMA = {
    "type": "object",
    "properties": {"q1": {"type": "string"}, "q2": {"type": "string"}, "q3": {"type": "string"}},
    "required": ["q1", "q2", "q3"],
}

COACH_SCHEMA = {
    "type": "object",
    "properties": {
        "strength": {"type": "string", "description": "One specific thing the answer did well."},
        "improve": {"type": "string", "description": "One specific way to make it stronger."},
        "tip": {"type": "string", "description": "A short, practical tip, e.g. a structure to use."},
    },
    "required": ["strength", "improve", "tip"],
}


def practice_questions(nova: Nova, round: Doc, job: Doc) -> list[str]:
    """Three practice questions on the round's criteria that are NOT the real questions."""
    real = "\n".join(f"- {q}" for q in round["questions"])
    result = nova.json(
        "You write practice interview questions so candidates can rehearse. Assess the same skills as the real round, "
        "but write completely different questions: never reuse, paraphrase or hint at the real questions. One spoken sentence each.",
        f"Job: {job['title']}. {job['description']}\nSkills assessed: {', '.join(c['name'] + ' (' + c['description'] + ')' for c in round['criteria'])}\n"
        f"Real questions, which you must NOT use or resemble:\n{real}",
        PRACTICE_SCHEMA,
        max_tokens=500,
    )
    got = [str((result or {}).get(k, "")).strip() for k in ("q1", "q2", "q3")]
    lowered = [q.lower() for q in round["questions"]]
    if all(10 < len(q) < 400 for q in got) and not any(q.lower() in lowered for q in got):
        return got
    crit = round["criteria"] or [{"name": "your experience", "description": ""}]
    return [f"Tell me about a time you showed {crit[i % len(crit)]['name'].lower()} at work. What happened, and what was the result?" for i in range(3)]


def coach(nova: Nova, question: str, answer: str) -> Doc:
    result = nova.json(
        "You are a friendly interview coach. Give honest, specific, encouraging feedback on one practice answer. "
        "Each field one short spoken sentence. " + NEUTRAL,
        f"Question: {question}\nAnswer: {answer[:3000]}",
        COACH_SCHEMA,
        max_tokens=300,
    )
    if result and all(result.get(k) for k in ("strength", "improve", "tip")):
        return {k: str(result[k])[:300] for k in ("strength", "improve", "tip")}
    words = len(answer.split())
    return {
        "strength": "You answered the question directly." if words >= 25 else "You kept it short and clear.",
        "improve": "Add a concrete example with a number or outcome." if words < 60 else "Trim the background and get to your part sooner.",
        "tip": "Try the STAR structure: Situation, Task, Action, Result.",
    }
