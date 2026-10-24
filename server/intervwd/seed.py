"""Sample company for the demo account (demo@intervwd.com), so judges see a working pipeline.

Created on first use, and rebuilt by reset_demo(); interview times are relative to "now" so the
dashboard always has finished interviews today, ones still to come, and open slots this week.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from .auth import DEMO_EMAIL
from .engine import now
from .service import Service

Doc = dict[str, Any]
DEMO_ORG = "org_northwind"
DEMO_KIOSK = "northwind-demo-kiosk"  # the demo company's reception and room screens: /kiosk/northwind-demo-kiosk


def _at(hours: float) -> str:
    t = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=hours)
    return t.isoformat().replace("+00:00", "Z")


def _crit(prefix: str, *pairs: tuple[str, str]) -> list[Doc]:
    return [{"id": f"{prefix}_c{i}", "name": n, "description": d} for i, (n, d) in enumerate(pairs)]


def _turns(q: list[str], rows: list[tuple[str, str, str, int]]) -> list[Doc]:
    return [{"role": r, "kind": k, "text": t, "questionIndex": i, "at": now()} for r, k, t, i in rows]


def _report(round: Doc, overall: float, summary: str, highlights: list[str], concerns: list[str], scores: list[tuple[float, str]]) -> Doc:
    return {"overall": overall, "summary": summary, "highlights": highlights, "concerns": concerns, "generatedAt": now(),
            "criteria": [{"criterionId": c["id"], "name": c["name"], "score": s, "evidence": e} for c, (s, e) in zip(round["criteria"], scores)]}


REFRESH_AFTER = timedelta(hours=8)


def ensure_demo(svc: Service) -> None:
    """Rebuilds the sample company when it's missing or its times have gone stale."""
    org = svc.store.get("org", DEMO_ORG)
    seeded = org and org.get("seededAt")
    if not seeded or datetime.fromisoformat(seeded.replace("Z", "+00:00")) < datetime.now(timezone.utc) - REFRESH_AFTER:
        reset_demo(svc)
    if not svc.store.get("recruiter", DEMO_EMAIL):
        svc.store.put("recruiter", DEMO_EMAIL, {"email": DEMO_EMAIL, "name": "Priya Sharma", "orgId": DEMO_ORG, "verified": True})


# Decided candidates from the last two weeks, so Reports has a history: (id, name, job, round, overall, band, triage reason,
# decision, automatic, days ago, minutes, source, identity, live takeover)
HISTORY = [
    ("cand_h_karan", "Karan Shah", "job_backend", "be1", 4.4, "fast_track", "", "advance", True, 2, 18, "qr", "matched", False),
    ("cand_h_divya", "Divya Menon", "job_backend", "be1", 4.2, "fast_track", "", "advance", False, 3, 21, "link", "matched", False),
    ("cand_h_rohan", "Rohan Gupta", "job_backend", "be1", 2.4, "below", "", "reject", False, 4, 15, "link", "matched", False),
    ("cand_h_sana", "Sana Qureshi", "job_backend", "be1", 3.6, "review", "The identity check didn't match; a recruiter let them in.", "hold", False, 5, 19, "team", "approved", False),
    ("cand_h_imran", "Imran Khan", "job_backend", "be1", 3.1, "below", "", "reject", False, 6, 14, "qr", "matched", False),
    ("cand_h_lakshmi", "Lakshmi Rao", "job_backend", "be1", 4.6, "fast_track", "", "advance", True, 8, 23, "link", "matched", True),
    ("cand_h_tom", "Tom Fernandes", "job_backend", "be1", 3.9, "review", "Only 96 words of answers: too little evidence.", "advance", False, 9, 12, "link", "matched", False),
    ("cand_h_sid", "Siddharth Bose", "job_backend", "be1", 4.3, "fast_track", "", "hold", False, 11, 20, "team", "matched", False),
    ("cand_h_pooja", "Pooja Desai", "job_storeops", "so1", 4.0, "fast_track", "", "advance", False, 1, 17, "qr", "matched", False),
    ("cand_h_manoj", "Manoj Pillai", "job_storeops", "so1", 2.9, "below", "", "reject", False, 3, 16, "qr", "matched", False),
    ("cand_h_kavya", "Kavya Reddy", "job_storeops", "so1", 3.7, "review", "Criteria disagree: Operations 4.4 but Customer focus 2.9.", "advance", False, 7, 19, "qr", "matched", True),
    ("cand_h_farah", "Farah Ali", "job_analyst", "an1", 4.1, "fast_track", "", "advance", False, 2, 18, "link", "", False),
    ("cand_h_nikhil", "Nikhil Joshi", "job_analyst", "an1", 3.4, "review", "Low confidence in the SQL score.", "hold", False, 10, 15, "team", "", False),
    ("cand_h_aditi", "Aditi Verma", "job_analyst", "an1", 2.2, "below", "", "reject", False, 12, 13, "link", "", False),
]
SEEDED_CANDIDATES = {"cand_rahul", "cand_ana", "cand_vikram", "cand_neha", "cand_meera", "cand_arjun", *(h[0] for h in HISTORY)}


def _clear_extras(svc: Service) -> None:
    """Removes candidates and interviews visitors added, so every demo starts from the same company."""
    for iv in svc.interviews(DEMO_ORG):
        if iv["candidateId"] not in SEEDED_CANDIDATES:
            svc.store.delete("interview", iv["id"])
    for job in svc.jobs(DEMO_ORG):
        if job["id"] not in ("job_backend", "job_storeops", "job_analyst"):
            for r in svc.rounds(job["id"]):
                svc.store.delete("round", r["id"])
            svc.store.delete("job", job["id"])
        for c in svc.candidates(job["id"]):
            if c["id"] not in SEEDED_CANDIDATES:
                for d in svc.decisions(c["id"]):
                    svc.store.delete("decision", d["id"])
                svc.store.delete("candidate", c["id"])


def reset_demo(svc: Service) -> None:
    s = svc.store
    _clear_extras(svc)
    tag = secrets.token_hex(2)  # fresh slot ids each time, so old bookings never block reseeded slots
    s.put("org", DEMO_ORG, {"id": DEMO_ORG, "name": "Northwind Labs", "slug": "northwind-labs", "createdAt": _at(-24 * 30), "seededAt": now(),
                            "office": {"address": "Northwind Labs, 4th floor, Prestige Tech Park, Bengaluru 560103", "rooms": ["Room 1", "Room 2"]},
                            "kioskToken": DEMO_KIOSK})
    s.put("kiosk", DEMO_KIOSK, {"orgId": DEMO_ORG})
    s.put("org-slug", "northwind-labs", {"orgId": DEMO_ORG})
    s.put("recruiter", DEMO_EMAIL, {"email": DEMO_EMAIL, "name": "Priya Sharma", "orgId": DEMO_ORG, "verified": True})

    jobs = [
        {"id": "job_backend", "title": "Backend Engineer", "location": "Bengaluru · Hybrid", "description": "Build and run the APIs behind our payments and orders platform. Python, AWS, PostgreSQL."},
        {"id": "job_storeops", "title": "Store Operations Manager", "location": "Pune · On site", "description": "Run day-to-day operations for three stores: staffing, stock, customer experience."},
        {"id": "job_analyst", "title": "Data Analyst", "location": "Remote · India", "description": "Turn sales and supply data into decisions. SQL, dashboards, clear storytelling."},
    ]
    for i, j in enumerate(jobs):
        svc.save_job({**j, "orgId": DEMO_ORG, "status": "open", "openings": {"job_backend": 2, "job_storeops": 3, "job_analyst": 1}[j["id"]],
                      "createdAt": _at(-24 * (20 - i * 5))})

    def round_(rid: str, job: str, index: int, name: str, criteria: list[Doc], questions: list[str], code: str, slots: list[tuple[str, float, str | None]]) -> Doc:
        path = {"round_backend_1": "backend-engineer-r1", "round_backend_2": "backend-engineer-r2",
                "round_storeops_1": "store-operations-manager-r1", "round_analyst_1": "data-analyst-r1"}[rid]
        r = {"id": rid, "jobId": job, "orgId": DEMO_ORG, "index": index, "name": name, "durationMin": 20, "criteria": criteria, "questions": questions,
             # Store Ops is a hiring day at the office (reception check-in, Echo Show rooms); Data Analyst shows approvals.
             "identityCheck": rid in ("round_backend_1", "round_storeops_1"), "requireApproval": rid == "round_analyst_1",
             "location": "office" if rid == "round_storeops_1" else "online",
             "publicPath": f"northwind-labs/{path}",
             "decisionMode": "auto" if rid == "round_backend_1" else "human", "autoAdvance": {"minOverall": 4.0, "minEach": 3.0},
             # Backend: Round 1 by the AI, Round 2 a system design call with a person.
             "mode": "human" if rid == "round_backend_2" else "ai",
             "interviewers": [{"name": "Priya Sharma", "email": ""}] if rid == "round_backend_2" else [], "meetingUrl": "",
             "inviteCode": code, "slots": [{"id": f"{sid}_{tag}", "start": _at(h), **({"candidateId": c} if c else {})} for sid, h, c in slots]}
        svc.save_round(r)
        s.put("invite", code, {"roundId": rid})
        s.put("invite", f"northwind-labs~{path}", {"roundId": rid})
        return r

    be1 = round_("round_backend_1", "job_backend", 1, "Round 1 · Technical screen",
                 _crit("be1", ("Python and APIs", "Designs clean, reliable APIs; knows Python well"), ("System design", "Reasons about scale, failure and data"),
                       ("Problem solving", "Breaks problems down and checks assumptions"), ("Communication", "Clear, structured, direct answers")),
                 ["Tell me about a backend service you built or owned end to end. What did it do, and what was your part?",
                  "How do you make an API safe to retry, for example so a payment is never charged twice?",
                  "Your service gets ten times the usual traffic during a sale. What breaks first, and what do you do?",
                  "Describe a production bug you tracked down. How did you find the cause?",
                  "How do you decide between a relational database and a key-value store for a new feature?"],
                 "nw-backend-r1", [("s1", -4, "cand_ana"), ("s2", -3, "cand_rahul"), ("s3", 2, "cand_vikram"), ("s4", 24, None), ("s5", 25, None), ("s6", 50, None)])
    round_("round_backend_2", "job_backend", 2, "Round 2 · System design with Priya",
           _crit("be2", ("Architecture", "Chooses fitting components and explains why"), ("Trade-offs", "Weighs cost, latency and complexity"), ("Communication", "Leads the discussion clearly")),
           ["Design an order-tracking service for a million daily orders. Start with the main pieces.", "Where would this design fail first, and how would you know?",
            "How would you roll out a breaking change to its API?"],
           "nw-backend-r2", [("s7", 72, None), ("s8", 96, None)])
    so1 = round_("round_storeops_1", "job_storeops", 1, "Round 1 · Hiring day at the office",
                 _crit("so1", ("Operations", "Plans staffing, stock and daily routines"), ("People leadership", "Coaches and handles conflict fairly"),
                       ("Customer focus", "Puts the customer experience first"), ("Communication", "Clear and calm")),
                 ["Walk me through how you would open a store on a busy festival morning.", "Two team members have a conflict that is affecting customers. What do you do?",
                  "Stock of a top-selling item runs out at noon. What happens next?", "Tell me about a time you improved a store metric. How did you measure it?"],
                 "nw-storeops-r1", [("s9", 3, "cand_meera"), ("s10", 27, None)])
    an1 = round_("round_analyst_1", "job_analyst", 1, "Round 1 · SQL and reasoning",
           _crit("an1", ("SQL", "Writes correct, readable queries"), ("Analysis", "Finds the real question behind the data"), ("Storytelling", "Explains findings to non-analysts")),
           ["How would you find the top five products by repeat purchase rate last quarter? Talk me through the query.", "Sales dropped 8% last week. How do you work out why?",
            "Tell me about a dashboard or analysis that changed a decision."],
           "nw-analyst-r1", [("s11", 26, None), ("s12", 50, None)])

    def cand(cid: str, name: str, job: str, rid: str, status: str, skills: list[str], summary: str) -> None:
        svc.save_candidate({"id": cid, "orgId": DEMO_ORG, "jobId": job, "roundId": rid, "name": name, "email": f"{name.split()[0].lower()}.{name.split()[1].lower()}@example.com",
                            "cvName": f"{name.replace(' ', '_')}_CV.pdf", "cvSummary": summary, "skills": skills, "status": status, "createdAt": _at(-72)})

    cand("cand_rahul", "Rahul Mehta", "job_backend", be1["id"], "completed", ["FastAPI", "AWS Lambda", "PostgreSQL", "Redis"], "5 years in Python backends; moved a payments API to FastAPI at a fintech; on-call lead.")
    cand("cand_ana", "Ana Silva", "job_backend", be1["id"], "completed", ["Go", "Kafka", "DynamoDB", "Python"], "6 years; event-driven order systems; strong on system design.")
    cand("cand_vikram", "Vikram Rao", "job_backend", be1["id"], "scheduled", ["Django", "Celery", "MySQL"], "3 years in Django; built internal tools and a reporting API.")
    cand("cand_neha", "Neha Kapoor", "job_backend", be1["id"], "completed", ["Node.js", "Express", "MongoDB"], "2 years; mostly Node.js; some Python scripting.")
    cand("cand_meera", "Meera Iyer", "job_storeops", so1["id"], "scheduled", ["Retail operations", "Rostering", "Inventory"], "7 years in retail; assistant store manager at a grocery chain.")
    cand("cand_arjun", "Arjun Nair", "job_storeops", so1["id"], "hired", ["Team leadership", "Visual merchandising"], "5 years; led a 20-person store team.")

    q = be1["questions"]

    def iv(iid: str, cid: str, job: str, round: Doc, start_h: float, status: str, turns: list[Doc] | None = None, report: Doc | None = None) -> None:
        svc.save_interview({"id": iid, "orgId": DEMO_ORG, "jobId": job, "roundId": round["id"], "candidateId": cid, "slotStart": _at(start_h), "status": status,
                            "turns": turns or [], "snapshots": [], **({"report": report, "startedAt": _at(start_h), "endedAt": _at(start_h + 0.33)} if report else {})})

    iv("iv_demo_rahul", "cand_rahul", "job_backend", be1, -3, "completed", _turns(q, [
        ("interviewer", "greeting", "Hi Rahul, thanks for joining. I'm the interviewer for Northwind Labs' Round 1 · Technical screen.", 0),
        ("interviewer", "question", q[0], 0),
        ("candidate", "answer", "At my last company I owned the payments API. We moved it from a Flask monolith to FastAPI on AWS Lambda behind API Gateway. I designed the endpoints, the idempotency layer and the retry policy, and I was the on-call lead for it.", 0),
        ("interviewer", "follow_up", "You mentioned FastAPI on Lambda. What was the hardest trade-off there, and what would you do differently now?", 0),
        ("candidate", "answer", "Cold starts. P99 latency went up at night when traffic was low. We added provisioned concurrency for the checkout path only, which cost more but kept p99 under 300 milliseconds. Now I would measure cost per request earlier before deciding.", 0),
        ("interviewer", "question", q[1], 1),
        ("candidate", "answer", "Every request carries an idempotency key. We store the key with the response in Redis with a 24 hour expiry, and in PostgreSQL inside the same transaction as the charge. A retry with the same key returns the stored response instead of charging again.", 1),
    ]), _report(be1, 4.1, "Strong, specific answers on API design and reliability, with clear trade-offs. Less depth on scaling writes under load.",
                ["Designed an idempotency layer end to end", "Measured p99 latency and chose a targeted fix", "Owned on-call for a payments API"],
                ["Scaling strategy for write-heavy traffic stayed general"],
                [(4.5, '"Every request carries an idempotency key... stored in PostgreSQL inside the same transaction as the charge."'),
                 (3.8, '"We added provisioned concurrency for the checkout path only..." Good on latency, vague on write scaling.'),
                 (4.2, '"P99 latency went up at night when traffic was low." Found the cause from metrics.'),
                 (4.0, "Concise, answered every follow-up directly.")]))
    iv("iv_demo_ana", "cand_ana", "job_backend", be1, -4, "completed", None, _report(
        be1, 3.9, "Excellent system design reasoning with event-driven architecture; Python answers were lighter than the role needs.",
        ["Clear reasoning about failure modes with Kafka", "Strong on partitioning DynamoDB tables"], ["Python-specific depth was limited"],
        [(3.4, '"Most of my recent work is in Go; in Python I have written internal services with Flask."'), (4.6, '"Partition by customer, not by order, so hot sales do not create a hot key."'),
         (3.9, "Worked through the traffic spike question step by step."), (3.8, "Clear, slightly long answers.")]))
    iv("iv_demo_neha", "cand_neha", "job_backend", be1, -26, "completed", None, _report(
        be1, 2.7, "Motivated and honest about gaps; limited experience with Python backends and retries.", ["Honest about gaps in experience"],
        ["Could not describe a retry-safe API", "Little production debugging experience"],
        [(2.6, '"I have mostly built APIs in Express."'), (2.5, "General answer about adding more servers."), (3.0, "Reasonable approach to the bug question."), (2.9, "Short answers.")]))
    iv("iv_demo_vikram", "cand_vikram", "job_backend", be1, 2, "scheduled")
    iv("iv_demo_meera", "cand_meera", "job_storeops", so1, 3, "scheduled")
    iv("iv_demo_arjun", "cand_arjun", "job_storeops", so1, -50, "completed", None, _report(
        so1, 4.3, "Calm, practical operator with strong people leadership.", ["Concrete festival-day plan", "Handled the team conflict fairly"], [],
        [(4.4, "Detailed opening checklist with staffing by hour."), (4.5, '"I talk to each of them separately first, then together."'),
         (4.1, "Offered substitutes and a callback for the out-of-stock item."), (4.2, "Clear and calm.")]))
    _history(svc, {"be1": be1, "so1": so1, "an1": an1})
    for iid, band, why in (("iv_demo_rahul", "review", "Low confidence in the System design score."),
                           ("iv_demo_ana", "review", "Criteria disagree: System design 4.6 but Python and APIs 3.4."),
                           ("iv_demo_neha", "below", "Below the bar."), ("iv_demo_arjun", "fast_track", "Clear pass.")):
        doc = s.get("interview", iid)
        if doc:
            doc["triage"] = {"band": band, "reasons": [why], "rule": {"minOverall": 4.0, "minEach": 3.0}}
            svc.save_interview(doc)
    for cid in ("cand_rahul", "cand_ana", "cand_neha", "cand_vikram", "cand_meera"):
        for d in svc.decisions(cid):
            s.delete("decision", d["id"])
    s.put("decision", "d_demo_arjun", {"id": "d_demo_arjun", "candidateId": "cand_arjun", "roundId": so1["id"], "action": "hire", "note": "Strong on people leadership. Offer made.",
                                       "by": "Priya Sharma", "at": _at(-24)}, index=("candidate#cand_arjun#decisions", _at(-24)))


def _history(svc: Service, rounds: dict[str, Doc]) -> None:
    """Two weeks of finished, decided interviews (see HISTORY), with triage, decisions and timings."""
    s = svc.store
    notes = {"advance": "Strong answers with real examples. Moving on.", "hold": "Good, but let's compare with this week's other candidates first.",
             "reject": "Not enough depth for this role right now."}
    for n, (cid, name, job, rk, overall, band, reason, action, auto, days, minutes, source, ident, takeover) in enumerate(HISTORY):
        r = rounds[rk]
        start = -24 * days - 6 + (n % 5)
        end_h = start + minutes / 60
        first, last = name.split()
        svc.save_candidate({"id": cid, "orgId": DEMO_ORG, "jobId": job, "roundId": r["id"], "name": name, "email": f"{first.lower()}.{last.lower()}@example.com",
                            "cvName": f"{first}_{last}_CV.pdf", "cvSummary": "Experience relevant to the role.", "skills": [],
                            "status": {"advance": "advanced", "hold": "on_hold", "reject": "rejected"}[action], "createdAt": _at(start - 30),
                            **({"addedBy": "Priya Sharma"} if source == "team" else {"source": source})})
        spread = [0.3, -0.2, 0.1, -0.2]
        scores = [(max(1.0, min(5.0, round(overall + spread[i % 4], 1))), "Quoted from the answer.") for i in range(len(r["criteria"]))]
        if reason.startswith("Criteria disagree"):
            scores = [(4.4, "Detailed staffing plan."), (3.8, "Fair, calm approach."), (2.9, "Little about the customer."), (3.7, "Clear.")]
        report = _report(r, overall, f"{first} gave {'clear, specific' if overall >= 4 else 'reasonable' if overall >= 3 else 'thin'} answers for the role.",
                         ["Specific examples"] if overall >= 3.5 else [], [] if overall >= 3.5 else ["Answers stayed general"], scores)
        report["scoredBy"] = "nova"
        for c in report["criteria"]:
            c["confidence"] = "low" if "Low confidence" in reason and c["name"] == "SQL" else "high"
        q = r["questions"]
        turns = [("interviewer", "greeting", f"Hi {first}, thanks for joining.", 0), ("interviewer", "question", q[0], 0),
                 ("candidate", "answer", "I led the work end to end and measured the result.", 0)]
        if takeover:
            turns += [("interviewer", "team_question", "How do you handle a customer who won't calm down?", 1),
                      ("candidate", "answer", "I listen first, repeat the problem back and say exactly what I'll do next.", 1),
                      ("interviewer", "handover", "Priya from Northwind Labs has joined and will take it from here.", 1),
                      ("interviewer", "handover", "Thanks, Priya. Let's carry on.", 1)]
        turns += [("interviewer", "question", q[1], 1), ("candidate", "answer", "I would check the data first, then decide.", 1)]
        iid = f"iv_{cid[5:]}"
        svc.save_interview({"id": iid, "orgId": DEMO_ORG, "jobId": job, "roundId": r["id"], "candidateId": cid, "slotStart": _at(start), "status": "completed",
                            "turns": _turns(q, turns), "snapshots": [], "report": report, "startedAt": _at(start), "endedAt": _at(end_h),
                            "triage": {"band": band, "reasons": [reason] if reason else (["Clear pass."] if band == "fast_track" else ["Below the bar."]),
                                       "rule": r.get("autoAdvance") or {"minOverall": 4.0, "minEach": 3.0}},
                            **({"identity": {"status": ident}} if ident else {})})
        for d in svc.decisions(cid):
            s.delete("decision", d["id"])
        at = _at(end_h + (0.02 if auto else 2 + n % 9))
        s.put("decision", f"d_{cid[5:]}", {"id": f"d_{cid[5:]}", "candidateId": cid, "roundId": r["id"], "action": action,
                                          "note": "Moved on automatically: a clear pass." if auto else notes[action],
                                          "by": "Intervwd (automatic)" if auto else "Priya Sharma", "at": at, **({"automatic": True} if auto else {})},
              index=(f"candidate#{cid}#decisions", at))
