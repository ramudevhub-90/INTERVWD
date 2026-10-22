"""The interview engine. The server owns the flow; Nova only fills in words and scores.

Flow: greeting + question 1 → answer → one follow-up → answer → question 2 → ... → closing → report.
At the start, Nova words every core question for this candidate's CV in one call (the plan), so
each turn needs at most one quick Nova call (the follow-up). Every Nova step has a rule-based
fallback, so a throttled or slow model never stalls an interview.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

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

PLAN_SCHEMA = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["questions"],
}


def personalise(question: str, candidate: Doc, index: int) -> str:
    skills = candidate.get("skills") or []
    skill = skills[index % len(skills)] if skills else None
    if index == 0 or not skill or skill.lower() in question.lower():
        return question
    return f"{question} If you can, use an example involving {skill}."


def plan(nova: Nova, round: Doc, job: Doc, candidate: Doc) -> list[str]:
    core = round["questions"]
    result = nova.json(
        "You are a fair, structured interviewer. Reword each core question so it fits this candidate's background, "
        "keeping exactly the same intent and difficulty, so every candidate is assessed on the same thing. "
        "One or two short spoken sentences each. No preamble, no numbering. " + NEUTRAL,
        f"Job: {job['title']}. {job['description']}\nCandidate: {candidate.get('cvSummary', '')} Skills: {', '.join(candidate.get('skills', []))}\n"
        f"Return exactly {len(core)} questions, one per core question, in the same order.\nCore questions:\n"
        + "\n".join(f"{i + 1}. {q}" for i, q in enumerate(core)),
        PLAN_SCHEMA,
        max_tokens=2000,
    )
    worded = [re.sub(r"^\s*(?:\d+[.)]|[-*])\s*", "", q).strip() for q in (result or {}).get("questions") or [] if isinstance(q, str)]
    if len(worded) == len(core) and all(10 < len(q) < 600 for q in worded):
        return worded
    if result is not None:
        log.warning("Nova question plan rejected: %d of %d questions, lengths %s", len(worded), len(core), [len(q) for q in worded])
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


def follow_up(nova: Nova, question: str, answer: str, round: Doc) -> str:
    result = nova.json(
        "You are a fair, friendly interviewer. Ask ONE short follow-up question (max 30 words) that digs into the most important "
        "thing the candidate said, or asks for a concrete example if the answer was vague. Never give feedback or hints, "
        "never ask about age, family, health, religion, nationality or other protected characteristics. " + NEUTRAL,
        f"Assessing: {', '.join(c['name'] for c in round['criteria'])}\nQuestion: {question}\nAnswer: {answer[:3000]}",
        FOLLOW_SCHEMA,
        max_tokens=150,
    )
    text = ((result or {}).get("followUp") or "").strip()
    return text if 8 < len(text) < 300 else rule_follow_up(answer)


# ---------- Flow ----------

def progress(interview: Doc, round: Doc) -> Doc:
    asked = sum(1 for t in interview["turns"] if t["kind"] == "question")
    return {"question": max(asked, 1), "of": len(round["questions"])}


def start(nova: Nova, interview: Doc, round: Doc, job: Doc, candidate: Doc, org_name: str) -> list[Doc]:
    """Starts the interview, or resumes it with the interviewer's last line."""
    if interview["turns"]:
        return [t for t in interview["turns"] if t["role"] == "interviewer"][-1:]
    interview["plan"] = plan(nova, round, job, candidate)
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


def answer(nova: Nova, interview: Doc, round: Doc, candidate: Doc, text: str) -> tuple[list[Doc], bool]:
    last = next((t for t in reversed(interview["turns"]) if t["role"] == "interviewer"), None)
    if not last or interview["status"] == "completed":
        return [], True
    q = last["questionIndex"]
    interview["turns"].append(turn("candidate", "answer", text.strip()[:5000], q))
    plan_ = interview.get("plan") or round["questions"]
    if last["kind"] == "question":
        nxt = [turn("interviewer", "follow_up", follow_up(nova, last["text"], text, round), q)]
    elif q + 1 < len(round["questions"]):
        nxt = [turn("interviewer", "question", plan_[q + 1], q + 1)]
    else:
        first = candidate["name"].split()[0]
        nxt = [turn("interviewer", "closing", f"That's everything, {first}. Thank you. The team will review your interview and get back to you by email.", q)]
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
                },
                "required": ["name", "score", "evidence"],
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


def score(nova: Nova, interview: Doc, round: Doc, job: Doc) -> Doc:
    transcript = "\n".join(
        f"{'Interviewer' if t['role'] == 'interviewer' else 'Candidate'}: {t['text']}" for t in interview["turns"]
    )
    rubric = "\n".join(f"- {c['name']}: {c['description']}" for c in round["criteria"])
    result = nova.json(
        "You score structured job interviews fairly and consistently. Judge only what the candidate said, against the rubric. "
        "Ignore accent, grammar and filler words, and never consider protected characteristics. Quote evidence. "
        "Scores: 1 no evidence, 2 below the bar, 3 meets the bar, 4 strong, 5 exceptional. You never recommend hiring or rejecting; "
        "a recruiter decides. " + NEUTRAL,
        f"Job: {job['title']}. {job['description']}\nRound: {round['name']}\nRubric:\n{rubric}\n\nTranscript:\n{transcript[:24000]}",
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
            scores.append({"criterionId": c["id"], "name": c["name"], "score": _clamp(got.get("score", 1)), "evidence": str(got.get("evidence", ""))[:500]})
        if len(scores) == len(round["criteria"]):
            return _report(scores, answers, str(result.get("summary", ""))[:600] or None,
                           [str(h)[:200] for h in result.get("highlights", [])][:4], [str(c)[:200] for c in result.get("concerns", [])][:4])
    return rule_score(interview, round["criteria"])
