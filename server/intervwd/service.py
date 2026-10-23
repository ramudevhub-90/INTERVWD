"""Domain logic behind both the web API and the MCP tools. Shapes match web/src/api/types.ts.

Layout in the store (see store.py):
  org/<id>                          the company
  recruiter/<email>                 {email, name, orgId}
  job/<id>        listed under      org#<orgId>#jobs
  round/<id>      listed under      job#<jobId>#rounds          (sorted by round number)
  invite/<code>                     {roundId}; code is the round's original code, or "<orgSlug>~<roundSlug>"
                                    for the public link intervwd.com/<orgSlug>/<roundSlug>
  org-slug/<slug>                   {orgId}: keeps company names in links unique
  candidate/<id>  listed under      job#<jobId>#candidates
  interview/<id>  listed under      org#<orgId>#interviews      (sorted by slot time; the id is the candidate's secret link)
  decision/<id>   listed under      candidate#<id>#decisions
  kdoc/<id>       listed under      job#<jobId>#knowledge       (the file itself lives in the knowledge base bucket)
  booking/<roundId>#<slotId>        guards a slot so two candidates can't book it at once
  candidate-invite/<token>          {candidateId}: the personal link for a candidate HR added
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import engine, ical
from .calls import Calls, FakeCalls
from .faces import FaceMatcher, FakeMatcher
from .knowledge import KINDS, Knowledge, NoKnowledge
from .nova import Nova
from .store import Blobs, Store

Doc = dict[str, Any]

MAX_CV_BYTES = 5 * 1024 * 1024
MAX_SNAPSHOTS = 8
MAX_KNOWLEDGE_BYTES = 10 * 1024 * 1024
MAX_KNOWLEDGE_DOCS = 25
KNOWLEDGE_TYPES = {"application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/html": "html", "text/csv": "csv",
                   "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"}
CV_TYPES = {"application/pdf", "text/plain", "text/markdown", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


class Problem(Exception):
    """An error the person can act on; the message is shown to them as is."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# First path segments the web app uses for its own pages; a company can't take these as its name.
RESERVED_SLUGS = {"app", "i", "interview", "echo", "connect", "signin", "signup", "api", "mcp", "oauth", "health", "assets",
                  "www", "admin", "about", "help", "support", "login", "logout", "pricing", "terms", "privacy", "favicon"}


def slugify(text: str, limit: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-") or "company"


def possessive_name(name: str) -> str:
    return f"{name}'" if name.endswith("s") else f"{name}'s"


def round_score(n: float) -> float:
    return round(min(5.0, max(1.0, float(n))), 1)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _same_day(a: str, b: datetime, tz_offset_min: int) -> bool:
    from datetime import timedelta

    shift = timedelta(minutes=-tz_offset_min)
    return (_parse(a) + shift).date() == (b + shift).date()


@dataclass
class Service:
    store: Store
    blobs: Blobs
    nova: Nova
    app_url: str = "https://intervwd.com"
    mailer: Any = None  # auth.Mailer; None skips candidate emails (tests)
    kb: Knowledge = NoKnowledge()  # type: ignore[assignment]
    faces: FaceMatcher = FakeMatcher()  # type: ignore[assignment]
    calls: Calls = FakeCalls()  # type: ignore[assignment]

    def _email(self, to: str, subject: str, text: str, invite: str | None = None) -> None:
        if self.mailer:
            self.mailer.send(to, subject, text, invite) if invite else self.mailer.send(to, subject, text)

    # ---------- Lookups ----------

    def _get(self, kind: str, id: str, what: str) -> Doc:
        doc = self.store.get(kind, id)
        if not doc:
            raise Problem(f"That {what} doesn't exist.", 404)
        return doc

    def _owned(self, kind: str, id: str, org_id: str, what: str) -> Doc:
        doc = self._get(kind, id, what)
        if doc.get("orgId") != org_id:
            raise Problem(f"That {what} doesn't exist.", 404)
        return doc

    def org(self, org_id: str) -> Doc:
        return self._get("org", org_id, "company")

    def claim_slug(self, org_id: str, name: str) -> str:
        """A unique, readable company name for links: northwind-labs, northwind-labs-2, ..."""
        base = slugify(name)
        for n in range(1, 50):
            slug = base if n == 1 else f"{base}-{n}"
            if slug not in RESERVED_SLUGS and self.store.create("org-slug", slug, {"orgId": org_id}):
                return slug
        return f"{base}-{secrets.token_hex(3)}"

    def org_slug(self, org: Doc) -> str:
        if not org.get("slug"):  # companies created before links had names
            org["slug"] = self.claim_slug(org["id"], org["name"])
            self.store.put("org", org["id"], org)
        return org["slug"]

    def settings(self, org_id: str) -> Doc:
        org = self.org(org_id)
        office = org.get("office") or {"address": "", "rooms": []}
        return {"orgName": org["name"], "slug": self.org_slug(org), "locked": org_id == "org_northwind", "office": office,
                "kiosk": f"{self.app_url}/kiosk/{org['kioskToken']}" if org.get("kioskToken") else None}

    def save_office(self, org_id: str, address: str, rooms: list[str]) -> Doc:
        org = self.org(org_id)
        rooms = [r.strip()[:40] for r in rooms if str(r).strip()][:20]
        if len(address.strip()) < 5:
            raise Problem("Enter the office address candidates should come to.")
        if not rooms:
            raise Problem("Add at least one interview room with an Echo Show.")
        if len(set(r.lower() for r in rooms)) != len(rooms):
            raise Problem("Give each interview room a different name.")
        org["office"] = {"address": address.strip()[:300], "rooms": rooms}
        self.store.put("org", org_id, org)
        return self.settings(org_id)

    def new_kiosk(self, org_id: str) -> Doc:
        """The secret link an Echo Show at reception (and in each room) opens. Making a new one retires the old."""
        org = self.org(org_id)
        if org.get("kioskToken"):
            self.store.delete("kiosk", org["kioskToken"])
        org["kioskToken"] = secrets.token_urlsafe(16)
        self.store.put("kiosk", org["kioskToken"], {"orgId": org_id})
        self.store.put("org", org_id, org)
        return self.settings(org_id)

    def change_slug(self, org_id: str, wanted: str) -> Doc:
        """Renames the company's links. Old links keep working, and the old name stays reserved for this
        company, so nobody else can take it and receive sign-ups from links already sent."""
        org = self.org(org_id)
        if org_id == "org_northwind":
            raise Problem("The demo company's link name can't be changed.", 403)
        slug = wanted.strip().lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])", slug) or "--" in slug:
            raise Problem("Use 3 to 40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number.")
        if slug in RESERVED_SLUGS:
            raise Problem("That name is used by Intervwd itself. Pick another.", 409)
        old = self.org_slug(org)
        if slug == old:
            return self.settings(org_id)
        owner = self.store.get("org-slug", slug)
        if owner and owner["orgId"] != org_id:
            raise Problem("Another company already uses that name. Pick another.", 409)
        if not owner and not self.store.create("org-slug", slug, {"orgId": org_id}):
            raise Problem("Another company already uses that name. Pick another.", 409)
        for job in self.jobs(org_id):
            for r in self.rounds(job["id"]):
                if not r.get("publicPath"):
                    continue
                round_slug = r["publicPath"].split("/", 1)[1]
                self.store.put("invite", f"{slug}~{round_slug}", {"roundId": r["id"]})  # old pointer stays too
                r["publicPath"] = f"{slug}/{round_slug}"
                self.save_round(r)
        org["slug"] = slug
        org.setdefault("previousSlugs", []).append(old)
        self.store.put("org", org_id, org)
        return self.settings(org_id)

    def invite_path(self, round: Doc) -> str:
        """The public link's path, e.g. northwind-labs/backend-engineer-r1."""
        return round.get("publicPath") or f"i/{round['inviteCode']}"

    def invite_url(self, round: Doc) -> str:
        return f"{self.app_url}/{self.invite_path(round)}"

    def jobs(self, org_id: str) -> list[Doc]:
        return self.store.listed(f"org#{org_id}#jobs")

    def rounds(self, job_id: str) -> list[Doc]:
        return sorted(self.store.listed(f"job#{job_id}#rounds"), key=lambda r: r["index"])

    def candidates(self, job_id: str) -> list[Doc]:
        return self.store.listed(f"job#{job_id}#candidates")

    def interviews(self, org_id: str) -> list[Doc]:
        return self.store.listed(f"org#{org_id}#interviews")

    def decisions(self, candidate_id: str) -> list[Doc]:
        return self.store.listed(f"candidate#{candidate_id}#decisions")

    # ---------- Writes ----------

    def save_job(self, job: Doc) -> None:
        self.store.put("job", job["id"], job, index=(f"org#{job['orgId']}#jobs", job["createdAt"]))

    def save_round(self, round: Doc) -> None:
        self.store.put("round", round["id"], round, index=(f"job#{round['jobId']}#rounds", f"{round['index']:03d}"))

    def save_candidate(self, c: Doc) -> None:
        self.store.put("candidate", c["id"], c, index=(f"job#{c['jobId']}#candidates", c["createdAt"]))

    def save_interview(self, iv: Doc) -> None:
        self.store.put("interview", iv["id"], iv, index=(f"org#{iv['orgId']}#interviews", iv["slotStart"]))

    # ---------- Recruiter views ----------

    def _row(self, iv: Doc, cache: dict[str, Doc]) -> Doc | None:
        def get(kind: str, id: str) -> Doc | None:
            key = f"{kind}#{id}"
            if key not in cache:
                cache[key] = self.store.get(kind, id)  # type: ignore[assignment]
            return cache[key]

        c, j, r = get("candidate", iv["candidateId"]), get("job", iv["jobId"]), get("round", iv["roundId"])
        return {"interview": self._public_interview(iv), "candidate": c, "job": j, "round": r} if c and j and r else None

    def dashboard(self, org_id: str, tz_offset_min: int = 0) -> Doc:
        org = self.org(org_id)
        jobs = self.jobs(org_id)
        ivs = self.interviews(org_id)
        now = datetime.now(timezone.utc)
        cache: dict[str, Doc] = {}
        cands = {c["id"]: c for j in jobs for c in self.candidates(j["id"])}
        for c in cands.values():
            cache[f"candidate#{c['id']}"] = c
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        upcoming = [r for iv in ivs if iv["status"] != "completed" and _parse(iv["slotStart"]) >= midnight and (r := self._row(iv, cache))][:6]
        awaiting = sorted(
            [r for iv in ivs if iv["status"] == "completed" and cands.get(iv["candidateId"], {}).get("status") == "completed" and (r := self._row(iv, cache))],
            key=lambda r: -(r["interview"].get("report") or {}).get("overall", 0),
        )
        pending = [{"candidate": c, "job": next((j for j in jobs if j["id"] == c["jobId"]), None), "round": self.store.get("round", c["roundId"])}
                   for c in cands.values() if c["status"] == "pending_approval"]
        locked = [r for iv in ivs if (iv.get("identity") or {}).get("status") == "locked" and iv["status"] != "completed" and (r := self._row(iv, cache))]
        job_rows = []
        for j in jobs:
            rs = self.rounds(j["id"])
            job_rows.append({**j, "candidateCount": sum(1 for c in cands.values() if c["jobId"] == j["id"]), "currentRound": rs[0]["name"] if rs else None})
        return {
            "org": org,
            "stats": {
                "openJobs": sum(1 for j in jobs if j["status"] == "open"),
                "interviewsToday": sum(1 for iv in ivs if _same_day(iv["slotStart"], now, tz_offset_min)),
                "awaitingDecision": len(awaiting),
                "candidates": len(cands),
                "pendingApproval": len(pending),
            },
            "week": self._week(org_id, ivs),
            "pending": pending,
            "identityLocked": locked,
            "jobs": job_rows,
            "upcoming": upcoming,
            "awaiting": awaiting,
        }

    def _week(self, org_id: str, ivs: list[Doc]) -> Doc:
        """The last 7 days at a glance, for the dashboard (the Reports page has the detail)."""
        from . import reports

        t = reports.build(self, org_id, 7)
        return {"liveNow": sum(1 for iv in ivs if iv["status"] == "in_progress"), "completed": t["totals"]["completed"],
                "avgScore": t["totals"]["avgScore"], "fastTracked": t["triage"]["fastTrack"], "advanced": t["totals"]["advanced"],
                "avgDecisionHours": t["totals"]["avgDecisionHours"], "aiAgreement": t["totals"]["aiAgreement"], "daily": t["daily"][-7:]}

    def reports(self, org_id: str, days: int = 30) -> Doc:
        from . import reports

        return reports.build(self, org_id, days)

    def create_job(self, org_id: str, title: str, location: str, description: str) -> str:
        if len(title.strip()) < 2:
            raise Problem("Enter a job title.")
        if len(description.strip()) < 20:
            raise Problem("Describe the role in a sentence or two. The interviewer uses it to shape questions.")
        job = {"id": new_id("job"), "orgId": org_id, "title": title.strip()[:120], "location": location.strip()[:120],
               "description": description.strip()[:2000], "status": "open", "createdAt": engine.now()}
        self.save_job(job)
        return job["id"]

    def job_view(self, org_id: str, job_id: str) -> Doc:
        job = self._owned("job", job_id, org_id, "job")
        rounds = self.rounds(job_id)
        names = {r["id"]: r["name"] for r in rounds}
        latest: dict[str, Doc] = {}
        for iv in self.interviews(org_id):
            latest[f"{iv['candidateId']}#{iv['roundId']}"] = iv
        rows = []
        for c in self.candidates(job_id):
            iv = latest.get(f"{c['id']}#{c['roundId']}")
            rows.append({**c, "overall": ((iv or {}).get("report") or {}).get("overall"), "roundName": names.get(c["roundId"], "")})
        rows.sort(key=lambda c: -(c["overall"] if c["overall"] is not None else -1))
        return {"job": job, "rounds": rounds, "candidates": rows}

    def create_round(self, org_id: str, job_id: str, body: Doc) -> Doc:
        job = self._owned("job", job_id, org_id, "job")
        name = str(body.get("name", "")).strip()
        criteria = [{"id": new_id("c"), "name": str(c.get("name", "")).strip()[:80], "description": str(c.get("description", "")).strip()[:300]}
                    for c in body.get("criteria", []) if str(c.get("name", "")).strip()][:8]
        questions = [str(q).strip()[:500] for q in body.get("questions", []) if str(q).strip()][:12]
        if not name:
            raise Problem('Name the round, for example "Technical interview".')
        if not criteria:
            raise Problem("Add at least one thing to assess.")
        if len(questions) < 2:
            raise Problem("Add at least two questions.")
        location = "office" if body.get("location") == "office" else "online"
        if location == "office" and not (self.org(org_id).get("office") or {}).get("rooms"):
            raise Problem("Add your office address and interview rooms in Settings first.", 409)
        meeting_url = str(body.get("meetingUrl") or "").strip()[:500]
        interviewers = [{"name": str(i.get("name", "")).strip()[:120], "email": str(i.get("email", "")).strip().lower()[:200]}
                        for i in (body.get("interviewers") or []) if str(i.get("name", "")).strip()][:5]
        if body.get("mode") == "human":
            if meeting_url and not re.fullmatch(r"https://\S+", meeting_url):
                raise Problem("The meeting link must start with https://")
            if not interviewers:
                raise Problem("Add at least one interviewer for a round run by a person.")
            if any(i["email"] and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", i["email"]) for i in interviewers):
                raise Problem("Check the interviewers' email addresses.")
        index = len(self.rounds(job_id)) + 1
        slug = re.sub(r"[^a-z0-9]+", "-", job["title"].lower()).strip("-")[:16]
        code = f"{slug}-r{index}-{secrets.token_hex(3)}"
        org_slug = self.org_slug(self.org(org_id))
        round_slug = f"{slugify(job['title'], 48)}-r{index}"
        for n in range(2, 50):  # two jobs with the same title in one company
            if not self.store.get("invite", f"{org_slug}~{round_slug}"):
                break
            round_slug = f"{slugify(job['title'], 48)}-{n}-r{index}"
        round = {"id": new_id("round"), "jobId": job_id, "orgId": org_id, "index": index, "name": f"Round {index} · {name[:60]}",
                 "durationMin": int(body.get("durationMin") or 20), "criteria": criteria, "questions": questions, "inviteCode": code, "slots": [],
                 "identityCheck": bool(body.get("identityCheck", True)) and body.get("mode") != "human",
                 "requireApproval": bool(body.get("requireApproval", True)),
                 "publicPath": f"{org_slug}/{round_slug}",
                 # Who interviews: the AI by voice, or a person over a video call with a scorecard.
                 "mode": "human" if body.get("mode") == "human" else "ai",
                 "location": location,
                 "meetingUrl": meeting_url,
                 "interviewers": interviewers,
                 "decisionMode": "auto" if body.get("decisionMode") == "auto" and body.get("mode") != "human" else "human",
                 "autoAdvance": {"minOverall": min(5.0, max(1.0, float((body.get("autoAdvance") or {}).get("minOverall", 4.0)))),
                                 "minEach": min(5.0, max(1.0, float((body.get("autoAdvance") or {}).get("minEach", 3.0))))}}
        self.save_round(round)
        self.store.put("invite", code, {"roundId": round["id"]})
        self.store.put("invite", f"{org_slug}~{round_slug}", {"roundId": round["id"]})
        return round

    def add_slots(self, org_id: str, round_id: str, starts: list[str]) -> Doc:
        round = self._owned("round", round_id, org_id, "round")
        for s in starts[:50]:
            try:
                when = _parse(s)
            except ValueError as e:
                raise Problem("That date and time isn't valid.") from e
            if when < datetime.now(timezone.utc):
                raise Problem("Pick a time in the future.")
            round["slots"].append({"id": new_id("s"), "start": when.isoformat().replace("+00:00", "Z")})
        round["slots"].sort(key=lambda x: x["start"])
        self.save_round(round)
        return round

    def remove_slot(self, org_id: str, round_id: str, slot_id: str) -> Doc:
        round = self._owned("round", round_id, org_id, "round")
        slot = next((s for s in round["slots"] if s["id"] == slot_id), None)
        if slot and slot.get("candidateId"):
            raise Problem("A candidate has booked that slot.", 409)
        round["slots"] = [s for s in round["slots"] if s["id"] != slot_id]
        self.save_round(round)
        return round

    def _public_interview(self, iv: Doc) -> Doc:
        """Snapshots are served through the API, never as raw S3 keys."""
        out = {k: v for k, v in iv.items() if k != "plan"}
        out["snapshots"] = [{"at": s["at"], "url": f"/api/interviews/{iv['id']}/snapshots/{i}", **({"match": s["match"], "similarity": s.get("similarity")} if s.get("match") else {})}
                            for i, s in enumerate(iv.get("snapshots", []))]
        if iv.get("identity"):
            out["identity"] = {k: v for k, v in iv["identity"].items() if k != "liveKey"} | {"hasLive": bool(iv["identity"].get("liveKey"))}
        return out

    def candidate_view(self, org_id: str, candidate_id: str) -> Doc:
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        return {
            "candidate": {k: v for k, v in c.items() if k != "photoKey"} | {"hasPhoto": bool(c.get("photoKey"))},
            "identityRequired": bool((self.store.get("round", c["roundId"]) or {}).get("identityCheck")),
            "job": self._get("job", c["jobId"], "job"),
            "rounds": self.rounds(c["jobId"]),
            "interviews": [self._public_interview(iv) for iv in self.interviews(org_id) if iv["candidateId"] == candidate_id],
            "decisions": self.decisions(candidate_id),
        }

    def decide(self, org_id: str, candidate_id: str, action: str, note: str, by: str, automatic: bool = False) -> Doc:
        if action not in ("advance", "hold", "reject"):
            raise Problem("Choose advance, hold or reject.")
        if automatic and action != "advance":
            raise Problem("Only a person can hold or reject a candidate.", 403)
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        if c["status"] not in ("completed", "on_hold"):
            raise Problem(f"{c['name']} has no finished interview waiting for a decision.", 409)
        d = {"id": new_id("d"), "candidateId": candidate_id, "roundId": c["roundId"], "action": action, "note": note.strip()[:1000], "by": by,
             "at": engine.now(), **({"automatic": True} if automatic else {})}
        self.store.put("decision", d["id"], d, index=(f"candidate#{candidate_id}#decisions", d["at"]))
        nxt = self.next_round(c)
        c["status"] = {"advance": "advanced", "hold": "on_hold", "reject": "rejected"}[action]
        token = None
        if action == "advance" and nxt:
            # Same candidate, next round: a personal link keeps their profile (CV, photo) and skips approval.
            token = secrets.token_urlsafe(18)
            self.store.put("candidate-invite", token, {"candidateId": c["id"]})
            c.update(roundId=nxt["id"], status="invited", roundsPassed=[*c.get("roundsPassed", []), d["roundId"]])
        self.save_candidate(c)
        if action == "reject" or (action == "advance" and not nxt):
            self._purge_faces(c, [i for i in self.interviews(org_id) if i["candidateId"] == candidate_id])  # final decision
        if token and nxt:
            org, job = self.org(org_id), self._get("job", c["jobId"], "job")
            self._email(c["email"], f"{org['name']}: you're through to {nxt['name'].split(' · ')[0]}",
                        f"Hi {c['name'].split()[0]},\n\nGood news: {org['name']} would like you to take the next step for {job['title']}, "
                        f"{nxt['name']}.\n\nPick a time here (your profile is already filled in): {self.invite_url(nxt)}?t={token}\n\n"
                        f"Intervwd, on behalf of {org['name']}")
        return {"decision": d, "candidate": c, "nextRound": nxt}

    def next_round(self, c: Doc) -> Doc | None:
        rounds = self.rounds(c["jobId"])
        cur = next((r for r in rounds if r["id"] == c["roundId"]), None)
        return next((r for r in rounds if cur and r["index"] == cur["index"] + 1), None)

    def latest_report(self, org_id: str, candidate_id: str) -> Doc | None:
        ivs = [iv for iv in self.interviews(org_id) if iv["candidateId"] == candidate_id and iv.get("report")]
        return ivs[-1]["report"] if ivs else None

    def all_candidates(self, org_id: str) -> list[Doc]:
        return [c for j in self.jobs(org_id) for c in self.candidates(j["id"])]

    # ---------- Knowledge base ----------

    def knowledge(self, org_id: str, job_id: str) -> list[Doc]:
        """The job's documents, with sync status brought up to date."""
        self._owned("job", job_id, org_id, "job")
        docs = self.store.listed(f"job#{job_id}#knowledge")
        status_of = getattr(self.kb, "job_status", None)
        pending = [d for d in docs if d["status"] == "pending"]
        if pending:
            started = self.kb.sync()
            if started:
                for d in pending:
                    d.update(status="syncing", ingestionJobId=started)
                    self._save_kdoc(d)
        for d in docs:
            if d["status"] == "syncing":
                state = status_of(d["ingestionJobId"]) if status_of and d.get("ingestionJobId") not in (None, "local") else "COMPLETE"
                if state in ("COMPLETE", "FAILED", "STOPPED"):
                    d["status"] = "ready" if state == "COMPLETE" else "failed"
                    self._save_kdoc(d)
        return [{k: v for k, v in d.items() if k not in ("key", "ingestionJobId")} for d in docs]

    def _save_kdoc(self, d: Doc) -> None:
        self.store.put("kdoc", d["id"], d, index=(f"job#{d['jobId']}#knowledge", d["createdAt"]))

    def add_knowledge(self, org_id: str, job_id: str, name: str, kind: str, data: bytes, content_type: str) -> Doc:
        self._owned("job", job_id, org_id, "job")
        if not self.kb.enabled:
            raise Problem("The knowledge base isn't set up on this server yet.", 503)
        if kind not in KINDS:
            raise Problem("Choose whether the interviewer only, or candidates too, can use this.")
        content_type = content_type.split(";")[0].strip()
        ext = KNOWLEDGE_TYPES.get(content_type)
        if not ext:
            raise Problem("Upload a PDF, Word, text, Markdown, HTML or CSV file.")
        if not data.strip():
            raise Problem("That document is empty.")
        if len(data) > MAX_KNOWLEDGE_BYTES:
            raise Problem("Documents can be up to 10 MB.")
        if len(self.store.listed(f"job#{job_id}#knowledge")) >= MAX_KNOWLEDGE_DOCS:
            raise Problem(f"A job can have up to {MAX_KNOWLEDGE_DOCS} documents. Remove one first.", 409)
        doc_id = new_id("kdoc")
        clean = re.sub(r"[^A-Za-z0-9._-]", "_", name.strip())[-80:] or "document"
        if not clean.lower().endswith(f".{ext}"):
            clean = f"{clean}.{ext}"
        key = f"{org_id}/{job_id}/{doc_id}/{clean}"
        self.kb.put(key, data, content_type, {"orgId": org_id, "jobId": job_id, "kind": kind, "docId": doc_id, "name": clean})
        d = {"id": doc_id, "orgId": org_id, "jobId": job_id, "name": name.strip()[:120] or clean, "kind": kind, "size": len(data),
             "key": key, "status": "pending", "createdAt": engine.now()}
        self._save_kdoc(d)
        self.knowledge(org_id, job_id)  # starts the sync
        return {k: v for k, v in (self.store.get("kdoc", doc_id) or d).items() if k not in ("key", "ingestionJobId")}

    def remove_knowledge(self, org_id: str, job_id: str, doc_id: str) -> None:
        d = self._get("kdoc", doc_id, "document")
        if d["orgId"] != org_id or d["jobId"] != job_id:
            raise Problem("That document doesn't exist.", 404)
        self.kb.delete(d["key"])
        self.store.delete("kdoc", doc_id)
        self.kb.sync()  # removes its passages from the index

    def search(self, iv: Doc, query: str, kinds: tuple[str, ...], k: int = 4) -> list[Doc]:
        if not self.kb.enabled or not self.store.listed(f"job#{iv['jobId']}#knowledge"):
            return []
        return self.kb.search(iv["orgId"], iv["jobId"], query, kinds, k)

    # ---------- Candidate profiles: sign-up by link, approval, HR-added candidates ----------

    def _round_by_code(self, code: str) -> Doc:
        ref = self.store.get("invite", code)
        if not ref:
            raise Problem("This invite link isn't valid. Ask the company for a new one.", 404)
        return self._get("round", ref["roundId"], "round")

    def _invited(self, round: Doc, token: str | None) -> Doc | None:
        """The candidate HR added, behind a personal link (/i/<code>?t=<token>)."""
        if not token:
            return None
        ref = self.store.get("candidate-invite", token)
        c = self.store.get("candidate", ref["candidateId"]) if ref else None
        if not c or c["roundId"] != round["id"]:
            raise Problem("This personal link isn't valid any more. Ask the company for a new one.", 404)
        if c["status"] != "invited":
            raise Problem("You've already completed your profile. Check your email for the interview link.", 409)
        return c

    def invite(self, code: str, token: str | None = None) -> Doc:
        round = self._round_by_code(code)
        invited = self._invited(round, token)
        cutoff = datetime.now(timezone.utc).timestamp() - 3600
        return {
            "orgName": self.org(round["orgId"])["name"],
            "job": self._get("job", round["jobId"], "job"),
            "round": {k: round.get(k) for k in ("id", "name", "index", "durationMin", "publicPath", "meetingUrl")}
            | {"mode": round.get("mode", "ai"), "interviewers": [i["name"] for i in round.get("interviewers", [])],
               "location": round.get("location", "online"),
               "address": (self.org(round["orgId"]).get("office") or {}).get("address", "") if round.get("location") == "office" else ""}
            | {"identityCheck": bool(round.get("identityCheck")), "requireApproval": bool(round.get("requireApproval")) and not invited},
            "openSlots": [s for s in round["slots"] if not s.get("candidateId") and _parse(s["start"]).timestamp() > cutoff],
            **({"invited": {"name": invited["name"], "email": invited["email"], "hasCv": bool(invited.get("cvKey")),
                         "hasPhoto": bool(invited.get("photoKey")), "returning": bool(invited.get("roundsPassed"))}} if invited else {}),
        }

    def _check_cv(self, cv: bytes, cv_type: str) -> str:
        if len(cv) > MAX_CV_BYTES:
            raise Problem("Your CV is over 5 MB. Upload a smaller file.")
        cv_type = cv_type.split(";")[0].strip() or "application/octet-stream"
        if cv_type not in CV_TYPES:
            raise Problem("Upload your CV as a PDF, Word or text file.")
        return cv_type

    def _save_cv(self, c: Doc, job: Doc, cv: bytes, cv_name: str, cv_type: str) -> None:
        key = f"cv/{c['orgId']}/{c['id']}/{re.sub(r'[^A-Za-z0-9._-]', '_', cv_name)[-80:] or 'cv'}"
        self.blobs.save(key, cv, cv_type)
        read = engine.read_cv(self.nova, cv, cv_type, job)
        c.update(cvName=cv_name[:120], cvKey=key, cvSummary=read["summary"], skills=read["skills"], nameOnCv=read.get("nameOnCv", ""))

    def add_candidate(self, org_id: str, job_id: str, round_id: str, name: str, email: str, by: str,
                      cv: bytes = b"", cv_name: str = "", cv_type: str = "") -> Doc:
        """HR adds a candidate; they get a personal link to finish their profile and book. Pre-approved."""
        round = self._owned("round", round_id, org_id, "round")
        if round["jobId"] != job_id:
            raise Problem("That round isn't part of this job.")
        if len(name.strip()) < 2:
            raise Problem("Enter the candidate's full name.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email.strip()):
            raise Problem("Enter the candidate's email, like name@example.com.")
        job = self._get("job", job_id, "job")
        c = {"id": new_id("cand"), "orgId": org_id, "jobId": job_id, "roundId": round_id, "name": name.strip()[:120], "email": email.strip().lower()[:200],
             "cvName": "", "cvSummary": "Profile not completed yet.", "skills": [], "status": "invited", "addedBy": by, "createdAt": engine.now()}
        if cv:
            self._save_cv(c, job, cv, cv_name or "cv", self._check_cv(cv, cv_type))
        token = secrets.token_urlsafe(18)
        self.store.put("candidate-invite", token, {"candidateId": c["id"]})
        self.save_candidate(c)
        org = self.org(org_id)
        link = f"{self.invite_url(round)}?t={token}"
        self._email(c["email"], f"{org['name']} invites you to interview for {job['title']}",
                    f"Hi {c['name'].split()[0]},\n\n{org['name']} would like to interview you for {job['title']} ({round['name']}).\n\n"
                    f"Finish your profile and pick a time here: {link}\n\nThe interview is by voice with an AI interviewer, about {round['durationMin']} minutes. "
                    f"A person at {org['name']} reviews it and makes every decision.\n\nIntervwd, on behalf of {org['name']}")
        return {"candidate": c, "link": link}

    def join(self, code: str, name: str, email: str, slot_id: str, consent: bool, cv: bytes, cv_name: str, cv_type: str,
             photo: bytes = b"", photo_type: str = "", face_consent: bool = False, phone: str = "", token: str | None = None,
             source: str = "") -> Doc:
        round = self._round_by_code(code)
        invited = self._invited(round, token)
        if len(name.strip()) < 2:
            raise Problem("Enter your full name.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email.strip()):
            raise Problem("Enter your email, like name@example.com.")
        if not consent:
            raise Problem("Agree to the recording terms to book.")
        if not cv and not (invited and invited.get("cvKey")):
            raise Problem("Upload your CV as a PDF or text file.")
        if cv:
            cv_type = self._check_cv(cv, cv_type)
        needs_face = bool(round.get("identityCheck"))
        if needs_face and not (invited and invited.get("photoKey")):
            if not photo:
                raise Problem("Upload a clear photo of your face for the identity check.")
            if not face_consent:
                raise Problem("Agree to the identity check to book.")
        if photo and (not photo_type.startswith("image/") or len(photo) > 5 * 1024 * 1024):
            raise Problem("Your photo must be a JPEG or PNG under 5 MB.")
        now_slot = slot_id == "now"
        if now_slot:  # the AI interviewer is always free: online AI rounds can start straight away
            if round.get("mode", "ai") != "ai" or round.get("location") == "office":
                raise Problem("Pick a time for your interview.")
            slot_id = new_id("s")
            round["slots"].append({"id": slot_id, "start": engine.now(), "instant": True})
        slot = next((s for s in round["slots"] if s["id"] == slot_id), None)
        if not slot or slot.get("candidateId") or not self.store.create("booking", f"{round['id']}#{slot_id}", {"at": engine.now()}):
            raise Problem("That slot was just taken. Pick another.", 409)

        job = self._get("job", round["jobId"], "job")
        approved = bool(invited) or not round.get("requireApproval")
        c = invited or {"id": new_id("cand"), "orgId": round["orgId"], "jobId": round["jobId"], "roundId": round["id"], "createdAt": engine.now()}
        c.update(name=name.strip()[:120], email=email.strip().lower()[:200], phone=phone.strip()[:30], status="scheduled" if approved else "pending_approval")
        if not invited:  # where self sign-ups came from: a scanned QR poster, or the shared link
            c["source"] = "qr" if source == "qr" else "link"
        if cv:
            self._save_cv(c, job, cv, cv_name, cv_type)
        if photo:
            c["photoKey"] = f"faces/{c['orgId']}/{c['id']}/reference"
            self.blobs.save(c["photoKey"], photo, photo_type)
        self.save_candidate(c)
        if invited:
            self.store.delete("candidate-invite", token or "")
        iv = {"id": f"iv_{secrets.token_urlsafe(18)}", "orgId": round["orgId"], "jobId": round["jobId"], "roundId": round["id"], "candidateId": c["id"],
              "slotStart": slot["start"], "status": "scheduled", "turns": [], "snapshots": []}
        self.save_interview(iv)
        fresh = self._get("round", round["id"], "round")  # re-read so a concurrent slot edit isn't lost
        if now_slot:
            fresh["slots"].append(slot)
        for x in fresh["slots"]:
            if x["id"] == slot_id:
                x["candidateId"] = c["id"]
        self.save_round(fresh)
        if approved:
            self._email_interview_link(c, iv, job, round)
        else:
            org = self.org(round["orgId"])
            self._email(c["email"], f"{org['name']} received your application",
                        f"Hi {c['name'].split()[0]},\n\nThanks for applying for {job['title']}. {org['name']}'s team will review your profile. "
                        f"Once they approve it, we'll email your interview link for {slot['start'].replace('T', ' ')[:16]} UTC.\n\nIntervwd, on behalf of {org['name']}")
        return {"interviewId": iv["id"] if approved else None, "status": c["status"], "candidate": c, "interview": iv, "job": job, "round": fresh}

    def _email_interview_link(self, c: Doc, iv: Doc, job: Doc, round: Doc) -> None:
        """Booking emails, each with a calendar invite for the slot."""
        org = self.org(c["orgId"])
        when = iv["slotStart"].replace("T", " ")[:16] + " UTC"
        minutes = int(round.get("durationMin") or 30)
        organizer = (org["name"], (self.mailer.sender.split("<")[-1].rstrip(">") if self.mailer and self.mailer.sender else "no-reply@intervwd.com"))
        title = f"{org['name']} interview: {job['title']}, {round['name'].split(' · ')[0]}"
        candidate_link = f"{self.app_url}/interview/{iv['id']}"
        if round.get("location") == "office":
            address = (org.get("office") or {}).get("address", "our office")
            with_whom = ", ".join(i["name"] for i in round.get("interviewers", [])) if round.get("mode") == "human" else "Alexa, our AI interviewer, on an Echo Show"
            invite = ical.invite(f"{iv['id']}@intervwd.com", iv["slotStart"], minutes, title,
                                 f"At {address}. When you arrive, say to the Echo Show at reception: \"Alexa, I'm here for my interview.\"", address,
                                 organizer, [(c["name"], c["email"])])
            check = " It checks your face against your profile photo, then shows you to your room." if round.get("identityCheck") else " It shows you to your room."
            self._email(c["email"], f"Your {org['name']} interview is booked",
                        f"Hi {c['name'].split()[0]},\n\nYour interview for {job['title']} ({round['name']}) is at our office on {when}, with {with_whom}.\n\n"
                        f"Address: {address}\n\nWhen you arrive, say to the Echo Show at reception: \"Alexa, I'm here for my interview.\"{check}\n\n"
                        f"The calendar invite is attached. Want to practise first? {self.app_url}/practice/{iv['id']}\n\nIntervwd, on behalf of {org['name']}", invite)
            return
        if round.get("mode") == "human":
            people = round.get("interviewers", [])
            names = ", ".join(i["name"] for i in people) or f"the {org['name']} team"
            # A pasted meeting link, or the call Intervwd hosts (Amazon Chime SDK) behind the candidate's link.
            where = round.get("meetingUrl") or candidate_link
            invite = ical.invite(f"{iv['id']}@intervwd.com", iv["slotStart"], minutes, f"{title} with {names}",
                                 f"Video call with {names}. Join: {where}", where, organizer, [(c["name"], c["email"]), *[(p["name"], p["email"]) for p in people]])
            self._email(c["email"], f"Your {org['name']} interview is booked",
                        f"Hi {c['name'].split()[0]},\n\nYour interview for {job['title']} ({round['name']}) is with {names}, on {when}.\n\n"
                        f"Join the video call here: {where}\n\nThe calendar invite is attached.\n\nIntervwd, on behalf of {org['name']}", invite)
            for person in people:
                if person.get("email"):
                    host = round.get("meetingUrl") or f"{self.app_url}/app/call/{iv['id']}"
                    self._email(person["email"], f"Interview: {c['name']} for {job['title']}, {when}",
                                f"Hi {person['name'].split()[0]},\n\nYou're interviewing {c['name']} for {job['title']} ({round['name']}) on {when}.\n"
                                f"Join the call: {host}\n\nTheir profile, earlier rounds and your scorecard: {self.app_url}/app/candidates/{c['id']}\n\n"
                                f"The calendar invite is attached.\n\nIntervwd",
                                ical.invite(f"{iv['id']}@intervwd.com", iv["slotStart"], minutes, f"Interview {c['name']}: {job['title']}",
                                            f"Join the call: {host}\nProfile and scorecard: {self.app_url}/app/candidates/{c['id']}", host, organizer,
                                            [(person["name"], person["email"])]))
            return
        check = " You'll be asked to look at the camera for a quick identity check first." if round.get("identityCheck") else ""
        invite = ical.invite(f"{iv['id']}@intervwd.com", iv["slotStart"], minutes, title,
                             f"AI voice interview. Join here (Chrome or Edge, in a quiet room): {candidate_link}", candidate_link, organizer, [(c["name"], c["email"])])
        self._email(c["email"], f"Your {org['name']} interview is booked",
                    f"Hi {c['name'].split()[0]},\n\nYour interview for {job['title']} ({round['name']}) is booked for {when}.\n\n"
                    f"Join here when you're ready (Chrome or Edge, in a quiet room):{check}\n{candidate_link}\n\n"
                    f"Want to warm up first? Practise with Alexa (not shared with {org['name']}): {self.app_url}/practice/{iv['id']}\n\n"
                    f"The calendar invite is attached. This link is personal to you; don't share it.\n\nIntervwd, on behalf of {org['name']}", invite)

    def review_signup(self, org_id: str, candidate_id: str, approve: bool, by: str) -> Doc:
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        if c["status"] != "pending_approval":
            raise Problem(f"{c['name']}'s profile isn't waiting for approval.", 409)
        iv = next((i for i in self.interviews(org_id) if i["candidateId"] == candidate_id and i["status"] == "scheduled"), None)
        round, job = self._get("round", c["roundId"], "round"), self._get("job", c["jobId"], "job")
        c.update(status="scheduled" if approve else "declined", reviewedBy=by, reviewedAt=engine.now())
        self.save_candidate(c)
        if approve and iv:
            self._email_interview_link(c, iv, job, round)
        elif not approve:
            org = self.org(org_id)
            if iv:  # free the slot for someone else
                round["slots"] = [{k: v for k, v in x.items() if not (k == "candidateId" and v == candidate_id)} for x in round["slots"]]
                self.save_round(round)
                self.store.delete("interview", iv["id"])
            self._purge_faces(c, [])
            self._email(c["email"], f"Your application to {org['name']}",
                        f"Hi {c['name'].split()[0]},\n\nThank you for your interest in {job['title']}. {org['name']} has decided not to move forward with an interview "
                        f"this time.\n\nIntervwd, on behalf of {org['name']}")
        return c

    # ---------- At the office: reception check-in and interview rooms (Echo Show kiosks) ----------

    def _kiosk_org(self, token: str) -> Doc:
        ref = self.store.get("kiosk", token)
        if not ref:
            raise Problem("This Echo Show isn't set up for any company. Ask HR for the kiosk link.", 404)
        return self.org(ref["orgId"])

    def _office_today(self, org_id: str, hours: float = 4) -> list[Doc]:
        now = datetime.now(timezone.utc).timestamp()
        rounds: dict[str, Doc] = {}
        out = []
        for iv in self.interviews(org_id):
            r = rounds.setdefault(iv["roundId"], self.store.get("round", iv["roundId"]) or {})
            if r.get("location") == "office" and abs(_parse(iv["slotStart"]).timestamp() - now) < hours * 3600:
                out.append(iv)
        return out

    def kiosk(self, token: str) -> Doc:
        org = self._kiosk_org(token)
        office = org.get("office") or {"address": "", "rooms": []}
        return {"orgName": org["name"], "address": office["address"], "rooms": office["rooms"]}

    def kiosk_checkin(self, token: str, name: str) -> Doc:
        """'Alexa, I'm here for my interview.' Finds today's office booking by the name they say."""
        org = self._kiosk_org(token)
        want = re.sub(r"[^a-z ]", "", name.lower()).strip()
        if len(want) < 2:
            raise Problem("Tell me your name and I'll find your interview.")
        matches = []
        for iv in self._office_today(org["id"]):
            if iv["status"] == "completed" or iv.get("arrivedAt"):
                continue
            c = self.store.get("candidate", iv["candidateId"]) or {}
            full = c.get("name", "").lower()
            if c.get("status") in ("pending_approval", "declined"):
                continue
            if want == full or want in full or full.split()[0] == want.split()[0]:
                matches.append((iv, c))
        if not matches:
            raise Problem("I couldn't find an interview for that name today. Please check with the front desk.", 404)
        if len(matches) > 1:
            exact = [m for m in matches if m[1]["name"].lower() == want]
            if len(exact) != 1:
                raise Problem("More than one interview matches that name. Please say your full name.", 409)
            matches = exact
        iv, c = matches[0]
        round = self._get("round", iv["roundId"], "round")
        job = self._get("job", iv["jobId"], "job")
        ident = (iv.get("identity") or {}).get("status", "pending")
        return {"interviewId": iv["id"], "firstName": c["name"].split()[0], "jobTitle": job["title"], "roundName": round["name"],
                "slotStart": iv["slotStart"], "identityRequired": bool(round.get("identityCheck")), "identityStatus": ident,
                "withPerson": round.get("mode") == "human", "interviewers": [i["name"] for i in round.get("interviewers", [])]}

    def kiosk_arrive(self, token: str, interview_id: str) -> Doc:
        """After the identity check: record the arrival and send them to a free room (or ask them to wait)."""
        org = self._kiosk_org(token)
        iv = self._owned("interview", interview_id, org["id"], "interview")
        round = self._get("round", iv["roundId"], "round")
        if round.get("identityCheck") and (iv.get("identity") or {}).get("status") not in ("matched", "approved"):
            raise Problem("Please finish the identity check first.", 403)
        if not iv.get("arrivedAt"):
            iv["arrivedAt"] = engine.now()
        if round.get("mode") == "human":
            iv["room"] = None  # an interviewer comes to collect them
            self.save_interview(iv)
            return {"room": None, "message": f"Thanks. {', '.join(i['name'] for i in round.get('interviewers', [])) or 'Your interviewer'} will come and collect you."}
        iv["room"] = iv.get("room") or self._free_room(org)
        self.save_interview(iv)
        if iv["room"]:
            return {"room": iv["room"], "message": f"Thanks. Please go to {iv['room']}. Alexa will interview you there."}
        return {"room": None, "message": "Thanks. All rooms are busy right now. Please take a seat; this screen will call you."}

    def _free_room(self, org: Doc) -> str | None:
        busy = {iv.get("room") for iv in self._office_today(org["id"]) if iv.get("room") and iv["status"] != "completed"}
        return next((r for r in (org.get("office") or {}).get("rooms", []) if r not in busy), None)

    def kiosk_room(self, token: str, room: str) -> Doc:
        """What an interview room's Echo Show should do now: run an interview, or wait for the next person."""
        org = self._kiosk_org(token)
        rooms = (org.get("office") or {}).get("rooms", [])
        if room not in rooms:
            raise Problem("That room isn't set up. Check the room names in Settings.", 404)
        today = self._office_today(org["id"])
        here = next((iv for iv in today if iv.get("room") == room and iv["status"] != "completed"), None)
        if not here:  # take the next person waiting at reception
            waiting = sorted((iv for iv in today if iv.get("arrivedAt") and not iv.get("room") and iv["status"] != "completed"
                              and (self.store.get("round", iv["roundId"]) or {}).get("mode") != "human"), key=lambda iv: iv["arrivedAt"])
            if waiting:
                here = waiting[0]
                here["room"] = room
                self.save_interview(here)
        if not here:
            return {"room": room, "orgName": org["name"], "interviewId": None}
        c = self.store.get("candidate", here["candidateId"]) or {}
        return {"room": room, "orgName": org["name"], "interviewId": here["id"], "firstName": c.get("name", "").split(" ")[0]}

    def hiring_day(self, org_id: str) -> Doc:
        """Today at the office: who arrived, who's in a room, who's done, who didn't come."""
        now = datetime.now(timezone.utc).timestamp()
        rows = []
        for iv in self._office_today(org_id, hours=12):
            c = self.store.get("candidate", iv["candidateId"]) or {}
            late = now - _parse(iv["slotStart"]).timestamp() > 30 * 60
            state = ("done" if iv["status"] == "completed" else "in_room" if iv.get("room") and iv["status"] == "in_progress" else
                     "arrived" if iv.get("arrivedAt") else "no_show" if late else "expected")
            rows.append({"interviewId": iv["id"], "candidateId": c.get("id"), "name": c.get("name"), "slotStart": iv["slotStart"],
                         "room": iv.get("room"), "state": state, "overall": (iv.get("report") or {}).get("overall")})
        rows.sort(key=lambda r: r["slotStart"])
        counts = {k: sum(1 for r in rows if r["state"] == k) for k in ("expected", "arrived", "in_room", "done", "no_show")}
        return {"counts": counts, "rows": rows}

    # ---------- Identity check (see faces.py) ----------

    def verify_identity(self, interview_id: str, image: bytes, content_type: str) -> Doc:
        from .faces import MAX_ATTEMPTS

        iv, round, c, _, _ = self._ctx(interview_id)
        if not round.get("identityCheck"):
            return {"status": "not_required"}
        ident = iv.get("identity") or {"status": "pending", "attempts": 0}
        if ident["status"] in ("matched", "approved"):
            return {"status": ident["status"], "similarity": ident.get("similarity")}
        if ident["status"] == "locked":
            return {"status": "locked", "message": "The identity check didn't match. The team has been told and can let you in."}
        if not content_type.startswith("image/") or not image or len(image) > 2 * 1024 * 1024:
            raise Problem("Send a camera image under 2 MB.")
        ref = self.blobs.load(c["photoKey"]) if c.get("photoKey") else None
        if not ref:
            raise Problem("Your profile photo is missing. Ask the company to let you in.", 409)
        result = self.faces.compare(ref[0], image)
        key = f"faces/{c['orgId']}/{c['id']}/live-{ident['attempts']}"
        self.blobs.save(key, image, content_type)
        ident.update(attempts=ident["attempts"] + 1, similarity=result.similarity, lastResult=result.status, checkedAt=engine.now(), liveKey=key)
        if result.status == "matched":
            ident["status"] = "matched"
        elif ident["attempts"] >= MAX_ATTEMPTS:
            ident["status"] = "locked"
            org = self.org(c["orgId"])
            self._email(c["email"], f"Your {org['name']} interview: identity check",
                        f"Hi {c['name'].split()[0]},\n\nThe camera check didn't match your profile photo. {org['name']}'s team can review it and let you in, "
                        f"or reschedule. You don't need to do anything else.\n\nIntervwd")
        iv["identity"] = ident
        self.save_interview(iv)
        left = max(0, MAX_ATTEMPTS - ident["attempts"])
        msg = {"matched": "Thanks, that's you.", "no_face": result.detail, "error": result.detail}.get(result.status, result.detail)
        if ident["status"] == "locked":
            msg = "The identity check didn't match. The team has been told and can let you in."
        return {"status": ident["status"], "result": result.status, "similarity": result.similarity, "attemptsLeft": left, "message": msg}

    def approve_identity(self, org_id: str, candidate_id: str, by: str) -> Doc:
        ivs = [i for i in self.interviews(org_id) if i["candidateId"] == candidate_id and i["status"] != "completed"]
        if not ivs:
            raise Problem("There's no upcoming interview to let them into.", 409)
        iv = ivs[-1]
        iv["identity"] = {**(iv.get("identity") or {"attempts": 0}), "status": "approved", "approvedBy": by, "approvedAt": engine.now()}
        self.save_interview(iv)
        return iv["identity"]

    def _purge_faces(self, c: Doc, ivs: list[Doc]) -> None:
        """Face images are kept only until a decision is made."""
        if c.pop("photoKey", None):
            self.blobs.delete(f"faces/{c['orgId']}/{c['id']}/reference")
            c["photoDeleted"] = True
            self.save_candidate(c)
        for iv in ivs:
            ident = iv.get("identity") or {}
            for n in range(int(ident.get("attempts", 0))):
                self.blobs.delete(f"faces/{c['orgId']}/{c['id']}/live-{n}")
            if ident.pop("liveKey", None):
                self.save_interview(iv)

    # ---------- Interview ----------

    def _ctx(self, interview_id: str) -> tuple[Doc, Doc, Doc, Doc, Doc]:
        iv = self._get("interview", interview_id, "interview")
        return iv, self._get("round", iv["roundId"], "round"), self._get("candidate", iv["candidateId"], "candidate"), self._get("job", iv["jobId"], "job"), self.org(iv["orgId"])

    def room(self, interview_id: str) -> Doc:
        iv, round, c, job, org = self._ctx(interview_id)
        public = self._public_interview(iv)
        public["snapshots"] = []  # candidates don't need their own snapshots back
        ident = iv.get("identity") or {}
        public.pop("identity", None)
        return {"interview": public, "candidateName": c["name"], "orgName": org["name"], "job": {"id": job["id"], "title": job["title"]},
                "round": {k: round[k] for k in ("id", "name", "durationMin", "questions")},
                "candidateStatus": c["status"],
                "mode": round.get("mode", "ai"),
                **({"meetingUrl": round.get("meetingUrl"), "interviewers": [i["name"] for i in round.get("interviewers", [])],
                    "slotStart": iv["slotStart"]} if round.get("mode") == "human" else {}),
                "identity": {"required": bool(round.get("identityCheck")), "status": ident.get("status", "pending"),
                             "attemptsLeft": max(0, 3 - int(ident.get("attempts", 0)))}}

    def start_interview(self, interview_id: str) -> Doc:
        iv, round, c, job, org = self._ctx(interview_id)
        if iv["status"] == "completed":
            raise Problem("This interview has already finished.", 409)
        if round.get("mode") == "human":
            raise Problem("This round is a video call with a person. Use the meeting link in your email.", 409)
        if c["status"] == "pending_approval":
            raise Problem(f"{org['name']} hasn't approved your profile yet. We'll email you when they do.", 403)
        if c["status"] == "declined":
            raise Problem("This interview was cancelled.", 403)
        if round.get("identityCheck") and (iv.get("identity") or {}).get("status") not in ("matched", "approved"):
            raise Problem("Complete the identity check first.", 403)
        ctx = self.search(iv, f"{job['title']} {' '.join(round['questions'])}", ("interviewer",), 6)
        turns = engine.start(self.nova, iv, round, job, c, org["name"], ctx)
        self.save_interview(iv)
        if c["status"] == "scheduled":
            c["status"] = "in_progress"
            self.save_candidate(c)
        return {"turns": turns, "done": False, "progress": engine.progress(iv, round)}

    def answer(self, interview_id: str, text: str) -> Doc:
        if not text.strip():
            raise Problem("Say or type an answer first.")
        iv, round, c, job, _ = self._ctx(interview_id)
        if iv["status"] != "in_progress":
            raise Problem("Start the interview first." if iv["status"] == "scheduled" else "This interview has already finished.", 409)
        live = self._live(interview_id)
        if live.get("paused"):
            raise Problem(f"{live['paused']['by'].split()[0]} from the team is talking with you now.", 409)
        last = next((t for t in reversed(iv["turns"]) if t["role"] == "interviewer" and t["kind"] != "handover"), {})
        if last.get("kind") == "invite_questions":
            ctx = self.search(iv, text, ("shareable",))
        else:
            ctx = self.search(iv, f"{last.get('text', '')} {text}", ("interviewer",), 3)
        team = list(live.get("teamQuestions") or [])  # a copy: the engine takes the first one it asks
        turns, done = engine.answer(self.nova, iv, round, c, text, ctx, org_name=self.org(iv["orgId"])["name"], team=team)
        if len(team) < len(live.get("teamQuestions") or []):
            fresh = self._live(interview_id)
            fresh["teamQuestions"] = (fresh.get("teamQuestions") or [])[1:]  # the one just asked
            self._save_live(interview_id, fresh)
        if done:
            rubric_ctx = self.search(iv, " ".join(f"{x['name']} {x['description']}" for x in round["criteria"]) + " " + " ".join(round["questions"]), ("interviewer",), 6)
            iv["report"] = engine.score(self.nova, iv, round, job, rubric_ctx)
            if engine.cv_name_differs(c["name"], c.get("nameOnCv", "")):
                iv["cvNameMismatch"] = c["nameOnCv"]
            iv["triage"] = engine.triage(iv["report"], iv, round)
            c["status"] = "completed"
            self.save_candidate(c)
        self.save_interview(iv)
        if done and round.get("decisionMode") == "auto" and iv["triage"]["band"] == "fast_track":
            self.decide(iv["orgId"], c["id"], "advance", f"Moved on automatically. {iv['triage']['reasons'][0]}", "Intervwd (automatic)", automatic=True)
        return {"turns": turns, "done": done, "progress": engine.progress(iv, round)}

    # ---------- Joining an AI interview live (watch, ask a question, take over) ----------
    # The AI leads; a recruiter can join the same Chime call. The candidate always sees who's watching.

    WATCH_SECONDS = 20

    def _live(self, interview_id: str) -> Doc:
        """Call and supervision state for an interview, kept apart from the transcript: answers and the
        watchers' heartbeats are written at the same time, and must never overwrite each other."""
        return self.store.get("live", interview_id) or {"meetingId": None, "paused": None, "teamQuestions": []}

    def _save_live(self, interview_id: str, doc: Doc) -> None:
        self.store.put("live", interview_id, doc)

    def _seat(self, iv: Doc, who: str) -> tuple[Doc, Doc]:
        live = self._live(iv["id"])
        meeting, attendee = self.calls.join(live.get("meetingId"), iv["id"], who)
        if live.get("meetingId") != meeting["MeetingId"]:
            live = self._live(iv["id"])  # re-read: someone may have joined at the same moment
            if live.get("meetingId") and live["meetingId"] != meeting["MeetingId"]:
                meeting, attendee = self.calls.join(live["meetingId"], iv["id"], who)  # join theirs instead
            else:
                live["meetingId"] = meeting["MeetingId"]
                self._save_live(iv["id"], live)
        return meeting, attendee

    def join_live(self, interview_id: str, who: str, org_id: str | None = None) -> Doc:
        iv = self._owned("interview", interview_id, org_id, "interview") if org_id else self._get("interview", interview_id, "interview")
        round = self._get("round", iv["roundId"], "round")
        if round.get("mode") == "human":
            raise Problem("This round is already a call with a person.", 409)
        if iv["status"] == "completed":
            raise Problem("This interview has finished.", 409)
        meeting, attendee = self._seat(iv, who)
        c = self._get("candidate", iv["candidateId"], "candidate")
        return {"meeting": meeting, "attendee": attendee, "candidateName": c["name"], "candidateId": c["id"],
                "jobTitle": self._get("job", iv["jobId"], "job")["title"], "roundName": round["name"], "orgName": self.org(iv["orgId"])["name"]}

    def _watchers(self, interview_id: str) -> list[str]:
        """Heartbeats live in their own small documents (one per watcher), so they never overwrite the
        pause or the queued questions."""
        return [w["name"] for w in self.store.listed(f"watchers#{interview_id}")]

    def _heartbeat(self, interview_id: str, name: str) -> None:
        self.store.put("watcher", f"{interview_id}#{name}", {"name": name}, index=(f"watchers#{interview_id}", name),
                       expires=int(datetime.now(timezone.utc).timestamp()) + self.WATCH_SECONDS)

    def live_status(self, interview_id: str) -> Doc:
        """What the candidate's screen shows: who is watching, and whether a person has taken over."""
        iv = self._get("interview", interview_id, "interview")
        live = self._live(interview_id)
        return {"watchers": self._watchers(interview_id), "takenOverBy": (live.get("paused") or {}).get("by"), "status": iv["status"]}

    def live_state(self, org_id: str, interview_id: str, by: str) -> Doc:
        """The recruiter's view, polled while watching: transcript, progress, and a heartbeat."""
        iv = self._owned("interview", interview_id, org_id, "interview")
        self._heartbeat(interview_id, by)
        live = self._live(interview_id)  # read only: heartbeats never write the live document
        round = self._get("round", iv["roundId"], "round")
        return {"status": iv["status"], "turns": iv["turns"], "progress": engine.progress(iv, round), "takenOverBy": (live.get("paused") or {}).get("by"),
                "pendingQuestions": [q["text"] for q in live.get("teamQuestions", [])], "watchers": self._watchers(interview_id)}

    def live_control(self, org_id: str, interview_id: str, action: str, by: str, question: str = "") -> Doc:
        iv = self._owned("interview", interview_id, org_id, "interview")
        if iv["status"] == "completed":
            raise Problem("This interview has finished.", 409)
        org = self.org(org_id)
        first = by.split()[0]
        live = self._live(interview_id)
        if action == "ask":
            if len(question.strip()) < 5:
                raise Problem("Type the question for the AI to ask.")
            live.setdefault("teamQuestions", []).append({"text": question.strip()[:400], "by": by})
            self._save_live(interview_id, live)
        elif action in ("take_over", "hand_back"):
            if action == "hand_back" and not live.get("paused"):
                raise Problem("The AI is already leading.", 409)
            if action == "take_over" and live.get("paused"):
                return self.live_state(org_id, interview_id, by)  # already taken over (a double click)
            live["paused"] = {"by": by, "at": engine.now()} if action == "take_over" else None
            self._save_live(interview_id, live)  # answers are refused from here on, so the transcript is safe to update
            iv = self._get("interview", interview_id, "interview")
            if action == "take_over":
                text, q = f"{first} from {org['name']} has joined and will take it from here.", (iv["turns"][-1]["questionIndex"] if iv["turns"] else 0)
            else:
                last_q = next((t for t in reversed(iv["turns"]) if t["role"] == "interviewer" and t["kind"] in ("question", "follow_up", "team_question")), None)
                text, q = f"Thanks, {first}. Let's carry on." + (f" {last_q['text']}" if last_q else ""), (last_q["questionIndex"] if last_q else 0)
            iv["turns"].append(engine.turn("interviewer", "handover", text, q))
            self.save_interview(iv)
        else:
            raise Problem("Choose ask, take over or hand back.")
        return self.live_state(org_id, interview_id, by)

    def join_call(self, interview_id: str, who: str, org_id: str | None = None) -> Doc:
        """A seat in the interview's video call: the candidate (by their link) or a recruiter (signed in)."""
        iv = self._owned("interview", interview_id, org_id, "interview") if org_id else self._get("interview", interview_id, "interview")
        round = self._get("round", iv["roundId"], "round")
        if round.get("mode") != "human":
            raise Problem("This round is an AI interview, not a video call.", 409)
        if round.get("meetingUrl"):
            raise Problem("This round uses its own meeting link.", 409)
        if iv["status"] == "completed":
            raise Problem("This interview has finished.", 409)
        c = self._get("candidate", iv["candidateId"], "candidate")
        if not org_id and c["status"] in ("pending_approval", "declined"):
            raise Problem("This interview isn't confirmed yet.", 403)
        meeting, attendee = self._seat(iv, who)
        job = self._get("job", iv["jobId"], "job")
        return {"meeting": meeting, "attendee": attendee, "candidateName": c["name"], "jobTitle": job["title"], "roundName": round["name"],
                "orgName": self.org(iv["orgId"])["name"], "interviewers": [i["name"] for i in round.get("interviewers", [])], "candidateId": c["id"]}

    # ---------- Practice: rehearse with Alexa before the real interview ----------
    # Kept apart from the interview: separate practice questions, coaching after each answer,
    # never shown to the company, deleted after a day.

    def _practice_ctx(self, interview_id: str) -> tuple[Doc, Doc, Doc, Doc]:
        iv = self._get("interview", interview_id, "interview")
        return iv, self._get("round", iv["roundId"], "round"), self._get("job", iv["jobId"], "job"), self._get("candidate", iv["candidateId"], "candidate")

    def practice_start(self, interview_id: str) -> Doc:
        iv, round, job, c = self._practice_ctx(interview_id)
        questions = (self.store.get("practice-questions", round["id"]) or {}).get("questions")  # shared by everyone in the round, for a day
        if not questions:
            questions = engine.practice_questions(self.nova, round, job)
            self.store.put("practice-questions", round["id"], {"questions": questions}, expires=int(datetime.now(timezone.utc).timestamp()) + 86400)
        self.store.put("practice", interview_id, {"questions": questions, "index": 0, "answers": []}, expires=int(datetime.now(timezone.utc).timestamp()) + 86400)
        org = self.org(iv["orgId"])
        return {"intro": f"Hi {c['name'].split()[0]}. Let's practise for {possessive_name(org['name'])} {round['name'].split(' · ')[0]}. "
                         f"These are practice questions, not the real ones, and nothing you say here is shared with {org['name']}. "
                         "I'll give you quick feedback after each answer.",
                "question": questions[0], "index": 1, "of": len(questions), "jobTitle": job["title"], "orgName": org["name"]}

    def practice_answer(self, interview_id: str, text: str) -> Doc:
        if not text.strip():
            raise Problem("Say or type an answer first.")
        doc = self.store.get("practice", interview_id)
        if not doc:
            raise Problem("Start a practice session first.", 409)
        q = doc["questions"][doc["index"]]
        feedback = engine.coach(self.nova, q, text)
        doc["index"] += 1
        self.store.put("practice", interview_id, doc, expires=int(datetime.now(timezone.utc).timestamp()) + 86400)
        nxt = doc["questions"][doc["index"]] if doc["index"] < len(doc["questions"]) else None
        return {"feedback": feedback, "question": nxt, "index": doc["index"] + 1, "of": len(doc["questions"])}

    def submit_scorecard(self, org_id: str, interview_id: str, body: Doc, by: str) -> Doc:
        """The interviewer's scorecard for a round run by a person. It becomes the round's report."""
        iv = self._owned("interview", interview_id, org_id, "interview")
        round = self._get("round", iv["roundId"], "round")
        if round.get("mode") != "human":
            raise Problem("Scorecards are for rounds run by a person. The AI scores its own interviews.", 409)
        if iv["status"] == "completed":
            raise Problem("A scorecard was already submitted for this interview.", 409)
        given = {str(x.get("criterionId")): x for x in body.get("criteria", [])}
        scores = []
        for crit in round["criteria"]:
            got = given.get(crit["id"])
            try:
                value = float((got or {}).get("score"))
            except (TypeError, ValueError):
                raise Problem(f"Score {crit['name']} from 1 to 5.") from None
            if not 1 <= value <= 5:
                raise Problem(f"Score {crit['name']} from 1 to 5.")
            scores.append({"criterionId": crit["id"], "name": crit["name"], "score": round_score(value), "evidence": str(got.get("notes", "")).strip()[:1000] or "No notes."})
        summary = str(body.get("summary", "")).strip()[:1200]
        if len(summary) < 10:
            raise Problem("Add a sentence or two summing up the interview.")
        iv.update(status="completed", startedAt=iv.get("startedAt") or iv["slotStart"], endedAt=engine.now())
        iv["report"] = {"overall": round_score(sum(x["score"] for x in scores) / len(scores)), "summary": summary,
                        "highlights": [h.strip()[:300] for h in str(body.get("highlights", "")).split("\n") if h.strip()][:5],
                        "concerns": [h.strip()[:300] for h in str(body.get("concerns", "")).split("\n") if h.strip()][:5],
                        "criteria": scores, "generatedAt": engine.now(), "scoredBy": "human", "scoredByName": by}
        self.save_interview(iv)
        c = self._get("candidate", iv["candidateId"], "candidate")
        if c["status"] in ("scheduled", "in_progress"):
            c["status"] = "completed"
            self.save_candidate(c)
        return iv["report"]

    def add_snapshot(self, interview_id: str, image: bytes, content_type: str) -> None:
        iv = self._get("interview", interview_id, "interview")
        if iv["status"] == "completed" or len(iv.get("snapshots", [])) >= MAX_SNAPSHOTS:
            return
        if not content_type.startswith("image/") or len(image) > 400_000:
            raise Problem("Snapshots must be small images.")
        key = f"snapshots/{iv['orgId']}/{iv['id']}/{len(iv['snapshots'])}.jpg"
        self.blobs.save(key, image, content_type)
        snap: Doc = {"at": engine.now(), "key": key}
        # Compare against the profile photo too, to catch someone else taking over mid-interview.
        c = self.store.get("candidate", iv["candidateId"]) or {}
        ref = self.blobs.load(c["photoKey"]) if c.get("photoKey") else None
        if ref:
            m = self.faces.compare(ref[0], image)
            snap.update(match=m.status, similarity=m.similarity)
        iv["snapshots"].append(snap)
        self.save_interview(iv)

    def snapshot(self, org_id: str, interview_id: str, n: int) -> tuple[bytes, str]:
        iv = self._owned("interview", interview_id, org_id, "interview")
        snaps = iv.get("snapshots", [])
        if not 0 <= n < len(snaps):
            raise Problem("That snapshot doesn't exist.", 404)
        got = self.blobs.load(snaps[n]["key"])
        if not got:
            raise Problem("That snapshot has expired.", 404)
        return got

    def face_image(self, org_id: str, candidate_id: str, which: str) -> tuple[bytes, str]:
        """The profile photo or the latest live identity check, for the recruiter to compare."""
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        if which == "reference":
            key = c.get("photoKey")
        else:
            ivs = [i for i in self.interviews(org_id) if i["candidateId"] == candidate_id and (i.get("identity") or {}).get("liveKey")]
            key = ivs[-1]["identity"]["liveKey"] if ivs else None
        got = self.blobs.load(key) if key else None
        if not got:
            raise Problem("That photo is no longer kept.", 404)
        return got
