"""Hiring reports for a company: the funnel, scores, how the AI's triage compares with people's
decisions, live joining, identity checks and activity, for the last 7 or 30 days or all time."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .service import Service

Doc = dict[str, Any]

# Triage reasons, grouped into a few labels a recruiter can scan.
REASONS = [
    (r"close to the bar", "Close to the bar"),
    (r"Criteria disagree", "Mixed scores across skills"),
    (r"Low confidence", "AI not confident"),
    (r"words of answers", "Too little to go on"),
    (r"backup rules", "Scored without Nova"),
    (r"identity check|snapshots", "Identity question"),
    (r"name on the CV", "CV in another name"),
    (r"below", "Below the bar"),
]
BUCKETS = [(1.0, 2.0), (2.0, 2.5), (2.5, 3.0), (3.0, 3.5), (3.5, 4.0), (4.0, 4.5), (4.5, 5.01)]


def _at(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")) if iso else None
    except ValueError:
        return None


def _avg(xs: list[float]) -> float | None:
    return round(sum(xs) / len(xs), 2) if xs else None


def build(svc: Service, org_id: str, days: int = 30) -> Doc:
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days) if days > 0 else None
    jobs = svc.jobs(org_id)
    rounds = {r["id"]: r for j in jobs for r in svc.rounds(j["id"])}
    cands = {c["id"]: c for j in jobs for c in svc.candidates(j["id"])}
    in_period = lambda iso: since is None or ((t := _at(iso)) is not None and t >= since)  # noqa: E731
    ivs = [iv for iv in svc.interviews(org_id) if in_period(iv.get("slotStart"))]
    done = [iv for iv in ivs if iv["status"] == "completed"]
    decisions = [d for c in cands.values() for d in svc.decisions(c["id"]) if in_period(d.get("at"))]

    # Scores
    scored = [iv for iv in done if (iv.get("report") or {}).get("overall") is not None]
    overall = [float(iv["report"]["overall"]) for iv in scored]
    hist = [{"label": f"{lo:g}–{min(hi, 5):g}", "count": sum(1 for s in overall if lo <= s < hi)} for lo, hi in BUCKETS]

    # Triage, and whether people agreed with it
    bands = Counter((iv.get("triage") or {}).get("band") for iv in done if iv.get("triage"))
    reasons: Counter[str] = Counter()
    for iv in done:
        t = iv.get("triage") or {}
        if t.get("band") == "review":
            for r in t.get("reasons", []):
                reasons[next((label for pat, label in REASONS if re.search(pat, r, re.I)), "Other")] += 1
    latest_iv = {}
    for iv in done:
        key = (iv["candidateId"], iv["roundId"])
        if key not in latest_iv or str(iv.get("endedAt", "")) > str(latest_iv[key].get("endedAt", "")):
            latest_iv[key] = iv
    agree = total = 0
    hours: list[float] = []
    for d in decisions:
        iv = latest_iv.get((d["candidateId"], d.get("roundId")))
        if not iv:
            continue
        if (end := _at(iv.get("endedAt"))) and (at := _at(d.get("at"))) and at >= end:
            hours.append((at - end).total_seconds() / 3600)
        band = (iv.get("triage") or {}).get("band")
        if not d.get("automatic") and band in ("fast_track", "below"):
            total += 1
            agree += (band == "fast_track" and d["action"] == "advance") or (band == "below" and d["action"] != "advance")

    # Interview length, live joining, identity
    minutes = [(e - s).total_seconds() / 60 for iv in done if (s := _at(iv.get("startedAt"))) and (e := _at(iv.get("endedAt"))) and 0 < (e - s).total_seconds() < 4 * 3600]
    takeovers = sum(1 for iv in ivs if any(t.get("kind") == "handover" and "joined" in t.get("text", "") for t in iv.get("turns", [])))
    team_qs = sum(1 for iv in ivs for t in iv.get("turns", []) if t.get("kind") == "team_question")
    idents = [iv.get("identity") or {} for iv in ivs if rounds.get(iv["roundId"], {}).get("identityCheck")]
    ident = {"checked": sum(1 for i in idents if i.get("status") in ("matched", "approved", "locked")),
             "matched": sum(1 for i in idents if i.get("status") == "matched"),
             "approvedByPerson": sum(1 for i in idents if i.get("status") == "approved"),
             "locked": sum(1 for i in idents if i.get("status") == "locked")}

    # Funnel (candidates first seen in the period)
    people = [c for c in cands.values() if in_period(c.get("createdAt"))]
    reached = lambda c, *s: c.get("status") in s  # noqa: E731
    interviewed_ids = {iv["candidateId"] for iv in done}
    funnel = [
        {"label": "Applied or invited", "count": len(people)},
        {"label": "Booked", "count": sum(1 for c in people if not reached(c, "invited", "pending_approval", "declined"))},
        {"label": "Interviewed", "count": sum(1 for c in people if c["id"] in interviewed_ids or reached(c, "advanced", "rejected", "on_hold"))},
        {"label": "Moved on", "count": sum(1 for c in people if reached(c, "advanced") or c.get("roundsPassed"))},
    ]

    # Activity per day (last 14 days)
    by_day = Counter((_at(iv.get("endedAt")) or now).date().isoformat() for iv in done)
    daily = [{"date": (now - timedelta(days=i)).date().isoformat(), "count": by_day.get((now - timedelta(days=i)).date().isoformat(), 0)} for i in range(13, -1, -1)]

    # Per job and per skill
    job_rows = []
    for j in jobs:
        jd = [iv for iv in scored if iv["jobId"] == j["id"]]
        jc = [c for c in cands.values() if c["jobId"] == j["id"]]
        job_rows.append({"id": j["id"], "title": j["title"], "candidates": len(jc), "interviewed": len([iv for iv in done if iv["jobId"] == j["id"]]),
                         "avgScore": _avg([float(iv["report"]["overall"]) for iv in jd]),
                         "advanced": sum(1 for c in jc if c["status"] == "advanced"), "awaiting": sum(1 for c in jc if c["status"] == "completed")})
    crit: dict[str, list[float]] = {}
    for iv in scored:
        for c in iv["report"].get("criteria", []):
            if c.get("score") is not None:
                crit.setdefault(c["name"], []).append(float(c["score"]))
    criteria = sorted(({"name": n, "avg": _avg(v), "n": len(v)} for n, v in crit.items()), key=lambda x: -x["n"])[:8]

    actions = Counter(d["action"] for d in decisions)
    modes = Counter("office" if r.get("location") == "office" else r.get("mode", "ai") for iv in ivs if (r := rounds.get(iv["roundId"])))
    return {
        "periodDays": days,
        "totals": {
            "candidates": len(people), "interviews": len(ivs), "completed": len(done),
            "completionRate": round(len(done) / len(past), 2) if (past := [iv for iv in ivs if (t := _at(iv.get("slotStart"))) and t < now]) else None,
            "avgScore": _avg(overall), "advanced": actions.get("advance", 0), "rejected": actions.get("reject", 0), "onHold": actions.get("hold", 0),
            "autoAdvanced": sum(1 for d in decisions if d.get("automatic")),
            "awaiting": sum(1 for c in cands.values() if c["status"] == "completed"),
            "avgDecisionHours": _avg(hours), "avgInterviewMin": _avg(minutes),
            "aiAgreement": round(agree / total, 2) if total else None, "aiAgreementOf": total,
            "takeovers": takeovers, "teamQuestions": team_qs,
        },
        "funnel": funnel,
        "triage": {"fastTrack": bands.get("fast_track", 0), "review": bands.get("review", 0), "below": bands.get("below", 0)},
        "reasons": [{"label": k, "count": v} for k, v in reasons.most_common()],
        "scores": hist,
        "daily": daily,
        "jobs": job_rows,
        "criteria": criteria,
        "identity": ident,
        "sources": {"signedUp": sum(1 for c in people if not c.get("addedBy")), "addedByTeam": sum(1 for c in people if c.get("addedBy"))},
        "modes": {"ai": modes.get("ai", 0), "human": modes.get("human", 0), "office": modes.get("office", 0)},
    }
