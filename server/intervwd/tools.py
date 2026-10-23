"""Recruiter tools: what Alexa+ calls over MCP, and what the web Alexa+ simulator's agent calls.

Each tool takes the Service, the signed-in recruiter's session and plain arguments, and returns a
small dict with a `say` sentence Alexa can read out. Changes to a candidate need confirm=true,
which the agent may only send after the recruiter has said yes to the read-back.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .service import Problem, Service, _parse

Doc = dict[str, Any]


def _time(iso: str, tz_offset_min: int) -> str:
    from datetime import timedelta

    t = _parse(iso) - timedelta(minutes=tz_offset_min)
    return t.strftime("%-I:%M %p").replace(":00 ", " ")


def find_candidate(svc: Service, org_id: str, name: str) -> Doc:
    want = name.strip().lower()
    if not want:
        raise Problem("Say which candidate.")
    cands = svc.all_candidates(org_id)
    exact = [c for c in cands if c["name"].lower() == want]
    matches = exact or [c for c in cands if want in c["name"].lower() or c["name"].lower().split()[0] == want.split()[0]]
    if not matches:
        raise Problem(f"I couldn't find a candidate called {name}.", 404)
    if len(matches) > 1:
        raise Problem(f"More than one candidate matches {name}: {', '.join(c['name'] for c in matches[:4])}. Which one?", 409)
    return matches[0]


def find_job(svc: Service, org_id: str, title: str | None) -> Doc:
    jobs = svc.jobs(org_id)
    if not jobs:
        raise Problem("You don't have any jobs yet.", 404)
    if not title:
        return jobs[0]
    want = title.lower()
    match = [j for j in jobs if want in j["title"].lower() or j["title"].lower().split()[0] in want]
    if not match:
        raise Problem(f"I couldn't find a job like {title}. Your jobs are {', '.join(j['title'] for j in jobs)}.", 404)
    return match[0]


def list_jobs(svc: Service, s: Doc) -> Doc:
    jobs = [j for j in svc.jobs(s["orgId"]) if j["status"] == "open"]
    rows = [{"title": j["title"], "location": j["location"], "candidates": len(svc.candidates(j["id"])),
             "rounds": [r["name"] for r in svc.rounds(j["id"])]} for j in jobs]
    say = f"You have {len(rows)} open roles: " + "; ".join(f"{r['title']} with {r['candidates']} candidates" for r in rows) + "." if rows else "You have no open roles."
    return {"say": say, "jobs": rows}


def get_todays_interviews(svc: Service, s: Doc, tz_offset_min: int = 0) -> Doc:
    from .service import _same_day

    now = datetime.now(timezone.utc)
    today = [iv for iv in svc.interviews(s["orgId"]) if _same_day(iv["slotStart"], now, tz_offset_min)]
    names = {c["id"]: c["name"] for c in svc.all_candidates(s["orgId"])}
    done = sorted([iv for iv in today if iv.get("report")], key=lambda iv: -iv["report"]["overall"])
    left = [iv for iv in today if iv["status"] != "completed"]
    parts = []
    if done:
        top = done[0]
        parts.append(f"{len(done)} interview{'s' if len(done) > 1 else ''} finished today. {names.get(top['candidateId'])} scored highest, {top['report']['overall']}.")
    else:
        parts.append("No interviews have finished today yet.")
    if left:
        parts.append("Still to come: " + ", ".join(f"{names.get(iv['candidateId'])} at {_time(iv['slotStart'], tz_offset_min)}" for iv in left) + ".")
    if len(done) > 1:
        parts.append("Want me to compare the top two?")
    return {
        "say": " ".join(parts),
        "finished": [{"candidate": names.get(iv["candidateId"]), "score": iv["report"]["overall"]} for iv in done],
        "upcoming": [{"candidate": names.get(iv["candidateId"]), "at": iv["slotStart"]} for iv in left],
    }


def awaiting_decision(svc: Service, s: Doc) -> Doc:
    rows = []
    for c in svc.all_candidates(s["orgId"]):
        if c["status"] == "completed":
            r = svc.latest_report(s["orgId"], c["id"])
            rows.append({"candidate": c["name"], "score": r["overall"] if r else None})
    rows.sort(key=lambda r: -(r["score"] or 0))
    say = ("Waiting for your decision: " + ", ".join(f"{r['candidate']} ({r['score']})" for r in rows) + ".") if rows else "Nobody is waiting for a decision."
    return {"say": say, "candidates": rows}


def get_candidate_report(svc: Service, s: Doc, candidate_name: str) -> Doc:
    c = find_candidate(svc, s["orgId"], candidate_name)
    r = svc.latest_report(s["orgId"], c["id"])
    if not r:
        return {"say": f"{c['name']} hasn't finished an interview yet.", "candidate": c["name"], "status": c["status"]}
    best = max(r["criteria"], key=lambda x: x["score"])
    return {
        "say": f"{c['name']} scored {r['overall']} out of 5, strongest on {best['name']}. {r['summary']}",
        "candidate": c["name"], "status": c["status"], "overall": r["overall"], "summary": r["summary"],
        "criteria": [{"name": x["name"], "score": x["score"], "evidence": x["evidence"]} for x in r["criteria"]],
        "concerns": r["concerns"],
    }


def compare_candidates(svc: Service, s: Doc, candidate_names: list[str] | None = None) -> Doc:
    if candidate_names:
        cands = [find_candidate(svc, s["orgId"], n) for n in candidate_names[:4]]
    else:
        cands = [c for c in svc.all_candidates(s["orgId"]) if c["status"] == "completed"]
    rows = [(c, r) for c in cands if (r := svc.latest_report(s["orgId"], c["id"]))]
    rows.sort(key=lambda x: -x[1]["overall"])
    if not candidate_names:
        rows = rows[:2]
    if len(rows) < 2:
        return {"say": "There aren't two finished interviews to compare yet."}
    parts = []
    for c, r in rows:
        best = max(r["criteria"], key=lambda x: x["score"])
        parts.append(f"{c['name']} scored {r['overall']}, strongest on {best['name']}")
    worry = rows[0][1]["concerns"][:1]
    say = ". ".join(parts) + "." + (f" For {rows[0][0]['name'].split()[0]}, worth probing: {worry[0][0].lower() + worry[0][1:]}." if worry else "")
    return {"say": say, "candidates": [{"candidate": c["name"], "overall": r["overall"], "criteria": {x["name"]: x["score"] for x in r["criteria"]}} for c, r in rows]}


def get_invite_link(svc: Service, s: Doc, job_title: str | None = None, round_number: int | None = None) -> Doc:
    job = find_job(svc, s["orgId"], job_title)
    rounds = svc.rounds(job["id"])
    r = next((x for x in rounds if x["index"] == round_number), rounds[0] if rounds else None)
    if not r:
        return {"say": f"{job['title']} has no interview rounds yet. Add one on the web dashboard."}
    url = f"{svc.app_url}/i/{r['inviteCode']}"
    open_slots = sum(1 for x in r["slots"] if not x.get("candidateId"))
    return {"say": f"The invite link for {job['title']}, {r['name']}, is {url}. It has {open_slots} open slots.", "url": url, "openSlots": open_slots}


def add_interview_slots(svc: Service, s: Doc, job_title: str, starts: list[str], round_number: int = 1) -> Doc:
    job = find_job(svc, s["orgId"], job_title)
    r = next((x for x in svc.rounds(job["id"]) if x["index"] == round_number), None)
    if not r:
        raise Problem(f"{job['title']} has no Round {round_number}.", 404)
    svc.add_slots(s["orgId"], r["id"], starts)
    return {"say": f"Added {len(starts)} slot{'s' if len(starts) != 1 else ''} to {job['title']}, {r['name']}.", "added": len(starts)}


_VERBS = {"advance": "move {name} to the next round", "hold": "put {name} on hold", "reject": "mark {name} as not progressing"}


def decide(svc: Service, s: Doc, candidate_name: str, action: str, confirm: bool = False, note: str = "") -> Doc:
    c = find_candidate(svc, s["orgId"], candidate_name)
    job = svc._get("job", c["jobId"], "job")
    verb = _VERBS[action].format(name=c["name"])
    if not confirm:
        return {"say": f"To confirm: {verb} for {job['title']}. Shall I?", "needsConfirmation": True}
    out = svc.decide(s["orgId"], c["id"], action, note or "Decided by voice on Alexa+.", s["name"])
    nxt = out["nextRound"]
    if action == "advance":
        say = f"Done. {c['name']} is moving on" + (f" to {nxt['name']}, and I've emailed the booking link." if nxt else ".")
    elif action == "hold":
        say = f"Done. {c['name']} is on hold."
    else:
        say = f"Done. {c['name']} is marked as not progressing. No email goes out until your team sends one."
    return {"say": say, "done": True, "nextRound": nxt["name"] if nxt else None}


def pending_approvals(svc: Service, s: Doc) -> Doc:
    """Sign-ups waiting for approval, and interviews locked by a failed identity check."""
    d = svc.dashboard(s["orgId"])
    names = [f"{p['candidate']['name']} for {p['job']['title']}" for p in d["pending"] if p["job"]]
    locked = [r["candidate"]["name"] for r in d["identityLocked"]]
    parts = [f"{len(names)} sign-up{'s' if len(names) != 1 else ''} waiting for approval: {', '.join(names)}." if names else "No sign-ups are waiting for approval."]
    if locked:
        parts.append(f"{', '.join(locked)} failed the identity check and can't start until you let them in.")
    return {"say": " ".join(parts), "signups": names, "identityLocked": locked}


def review_signup(svc: Service, s: Doc, candidate_name: str, approve: bool, confirm: bool = False) -> Doc:
    c = find_candidate(svc, s["orgId"], candidate_name)
    verb = f"approve {c['name']}'s profile and email their interview link" if approve else f"decline {c['name']}'s sign-up and let them know"
    if not confirm:
        return {"say": f"To confirm: {verb}. Shall I?", "needsConfirmation": True}
    svc.review_signup(s["orgId"], c["id"], approve, s["name"])
    return {"say": f"Done. {c['name']} has their interview link." if approve else f"Done. {c['name']} has been told.", "done": True}


def let_in(svc: Service, s: Doc, candidate_name: str, confirm: bool = False) -> Doc:
    c = find_candidate(svc, s["orgId"], candidate_name)
    if not confirm:
        return {"say": f"To confirm: let {c['name']} start the interview without a matching identity check. Have you checked the photos? Shall I?", "needsConfirmation": True}
    svc.approve_identity(s["orgId"], c["id"], s["name"])
    return {"say": f"Done. {c['name']} can start the interview now.", "done": True}
