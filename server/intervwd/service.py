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

from . import engine
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

    def _email(self, to: str, subject: str, text: str) -> None:
        if self.mailer:
            self.mailer.send(to, subject, text)

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
            "pending": pending,
            "identityLocked": locked,
            "jobs": job_rows,
            "upcoming": upcoming,
            "awaiting": awaiting,
        }

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
                 "identityCheck": bool(body.get("identityCheck", True)), "requireApproval": bool(body.get("requireApproval", True)),
                 "publicPath": f"{org_slug}/{round_slug}"}
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

    def decide(self, org_id: str, candidate_id: str, action: str, note: str, by: str) -> Doc:
        if action not in ("advance", "hold", "reject"):
            raise Problem("Choose advance, hold or reject.")
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        if c["status"] not in ("completed", "on_hold"):
            raise Problem(f"{c['name']} has no finished interview waiting for a decision.", 409)
        d = {"id": new_id("d"), "candidateId": candidate_id, "roundId": c["roundId"], "action": action, "note": note.strip()[:1000], "by": by, "at": engine.now()}
        self.store.put("decision", d["id"], d, index=(f"candidate#{candidate_id}#decisions", d["at"]))
        c["status"] = {"advance": "advanced", "hold": "on_hold", "reject": "rejected"}[action]
        self.save_candidate(c)
        if action != "hold":
            self._purge_faces(c, [i for i in self.interviews(org_id) if i["candidateId"] == candidate_id])
        nxt = self.next_round(c)
        if action == "advance" and nxt:
            org, job = self.org(org_id), self._get("job", c["jobId"], "job")
            self._email(c["email"], f"{org['name']}: you're through to {nxt['name'].split(' · ')[0]}",
                        f"Hi {c['name'].split()[0]},\n\nGood news: {org['name']} would like you to take the next step for {job['title']}, "
                        f"{nxt['name']}.\n\nBook a time here: {self.invite_url(nxt)}\n\nIntervwd, on behalf of {org['name']}")
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
            "round": {k: round.get(k) for k in ("id", "name", "index", "durationMin", "publicPath")}
            | {"identityCheck": bool(round.get("identityCheck")), "requireApproval": bool(round.get("requireApproval")) and not invited},
            "openSlots": [s for s in round["slots"] if not s.get("candidateId") and _parse(s["start"]).timestamp() > cutoff],
            **({"invited": {"name": invited["name"], "email": invited["email"], "hasCv": bool(invited.get("cvKey"))}} if invited else {}),
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
        c.update(cvName=cv_name[:120], cvKey=key, cvSummary=read["summary"], skills=read["skills"])

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
             photo: bytes = b"", photo_type: str = "", face_consent: bool = False, phone: str = "", token: str | None = None) -> Doc:
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
        if needs_face:
            if not photo:
                raise Problem("Upload a clear photo of your face for the identity check.")
            if not face_consent:
                raise Problem("Agree to the identity check to book.")
        if photo and (not photo_type.startswith("image/") or len(photo) > 5 * 1024 * 1024):
            raise Problem("Your photo must be a JPEG or PNG under 5 MB.")
        slot = next((s for s in round["slots"] if s["id"] == slot_id), None)
        if not slot or slot.get("candidateId") or not self.store.create("booking", f"{round['id']}#{slot_id}", {"at": engine.now()}):
            raise Problem("That slot was just taken. Pick another.", 409)

        job = self._get("job", round["jobId"], "job")
        approved = bool(invited) or not round.get("requireApproval")
        c = invited or {"id": new_id("cand"), "orgId": round["orgId"], "jobId": round["jobId"], "roundId": round["id"], "createdAt": engine.now()}
        c.update(name=name.strip()[:120], email=email.strip().lower()[:200], phone=phone.strip()[:30], status="scheduled" if approved else "pending_approval")
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
        org = self.org(c["orgId"])
        check = " You'll be asked to look at the camera for a quick identity check first." if round.get("identityCheck") else ""
        self._email(c["email"], f"Your {org['name']} interview is booked",
                    f"Hi {c['name'].split()[0]},\n\nYour interview for {job['title']} ({round['name']}) is booked for {iv['slotStart'].replace('T', ' ')[:16]} UTC.\n\n"
                    f"Join here when you're ready (Chrome or Edge, in a quiet room):{check}\n{self.app_url}/interview/{iv['id']}\n\n"
                    f"This link is personal to you; don't share it.\n\nIntervwd, on behalf of {org['name']}")

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
                "identity": {"required": bool(round.get("identityCheck")), "status": ident.get("status", "pending"),
                             "attemptsLeft": max(0, 3 - int(ident.get("attempts", 0)))}}

    def start_interview(self, interview_id: str) -> Doc:
        iv, round, c, job, org = self._ctx(interview_id)
        if iv["status"] == "completed":
            raise Problem("This interview has already finished.", 409)
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
        last = next((t for t in reversed(iv["turns"]) if t["role"] == "interviewer"), {})
        if last.get("kind") == "invite_questions":
            ctx = self.search(iv, text, ("shareable",))
        else:
            ctx = self.search(iv, f"{last.get('text', '')} {text}", ("interviewer",), 3)
        turns, done = engine.answer(self.nova, iv, round, c, text, ctx, org_name=self.org(iv["orgId"])["name"])
        if done:
            rubric_ctx = self.search(iv, " ".join(f"{x['name']} {x['description']}" for x in round["criteria"]) + " " + " ".join(round["questions"]), ("interviewer",), 6)
            iv["report"] = engine.score(self.nova, iv, round, job, rubric_ctx)
            c["status"] = "completed"
            self.save_candidate(c)
        self.save_interview(iv)
        return {"turns": turns, "done": done, "progress": engine.progress(iv, round)}

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
