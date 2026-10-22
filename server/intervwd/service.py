"""Domain logic behind both the web API and the MCP tools. Shapes match web/src/api/types.ts.

Layout in the store (see store.py):
  org/<id>                          the company
  recruiter/<email>                 {email, name, orgId}
  job/<id>        listed under      org#<orgId>#jobs
  round/<id>      listed under      job#<jobId>#rounds          (sorted by round number)
  invite/<code>                     {roundId}
  candidate/<id>  listed under      job#<jobId>#candidates
  interview/<id>  listed under      org#<orgId>#interviews      (sorted by slot time; the id is the candidate's secret link)
  decision/<id>   listed under      candidate#<id>#decisions
  booking/<roundId>#<slotId>        guards a slot so two candidates can't book it at once
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import engine
from .nova import Nova
from .store import Blobs, Store

Doc = dict[str, Any]

MAX_CV_BYTES = 5 * 1024 * 1024
MAX_SNAPSHOTS = 8
CV_TYPES = {"application/pdf", "text/plain", "text/markdown", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


class Problem(Exception):
    """An error the person can act on; the message is shown to them as is."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


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
            },
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
        round = {"id": new_id("round"), "jobId": job_id, "orgId": org_id, "index": index, "name": f"Round {index} · {name[:60]}",
                 "durationMin": int(body.get("durationMin") or 20), "criteria": criteria, "questions": questions, "inviteCode": code, "slots": []}
        self.save_round(round)
        self.store.put("invite", code, {"roundId": round["id"]})
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
        out["snapshots"] = [{"at": s["at"], "url": f"/api/interviews/{iv['id']}/snapshots/{i}"} for i, s in enumerate(iv.get("snapshots", []))]
        return out

    def candidate_view(self, org_id: str, candidate_id: str) -> Doc:
        c = self._owned("candidate", candidate_id, org_id, "candidate")
        return {
            "candidate": c,
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
        nxt = self.next_round(c)
        if action == "advance" and nxt:
            org, job = self.org(org_id), self._get("job", c["jobId"], "job")
            self._email(c["email"], f"{org['name']}: you're through to {nxt['name'].split(' · ')[0]}",
                        f"Hi {c['name'].split()[0]},\n\nGood news: {org['name']} would like you to take the next step for {job['title']}, "
                        f"{nxt['name']}.\n\nBook a time here: {self.app_url}/i/{nxt['inviteCode']}\n\nIntervwd, on behalf of {org['name']}")
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

    # ---------- Candidate side ----------

    def _round_by_code(self, code: str) -> Doc:
        ref = self.store.get("invite", code)
        if not ref:
            raise Problem("This invite link isn't valid. Ask the company for a new one.", 404)
        return self._get("round", ref["roundId"], "round")

    def invite(self, code: str) -> Doc:
        round = self._round_by_code(code)
        cutoff = datetime.now(timezone.utc).timestamp() - 3600
        return {
            "orgName": self.org(round["orgId"])["name"],
            "job": self._get("job", round["jobId"], "job"),
            "round": {k: round[k] for k in ("id", "name", "index", "durationMin")},
            "openSlots": [s for s in round["slots"] if not s.get("candidateId") and _parse(s["start"]).timestamp() > cutoff],
        }

    def join(self, code: str, name: str, email: str, slot_id: str, consent: bool, cv: bytes, cv_name: str, cv_type: str) -> Doc:
        round = self._round_by_code(code)
        if len(name.strip()) < 2:
            raise Problem("Enter your full name.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email.strip()):
            raise Problem("Enter your email, like name@example.com.")
        if not consent:
            raise Problem("Agree to the recording terms to book.")
        if not cv:
            raise Problem("Upload your CV as a PDF or text file.")
        if len(cv) > MAX_CV_BYTES:
            raise Problem("Your CV is over 5 MB. Upload a smaller file.")
        cv_type = cv_type.split(";")[0].strip() or "application/octet-stream"
        if cv_type not in CV_TYPES:
            raise Problem("Upload your CV as a PDF, Word or text file.")
        slot = next((s for s in round["slots"] if s["id"] == slot_id), None)
        if not slot or slot.get("candidateId") or not self.store.create("booking", f"{round['id']}#{slot_id}", {"at": engine.now()}):
            raise Problem("That slot was just taken. Pick another.", 409)

        job = self._get("job", round["jobId"], "job")
        cid = new_id("cand")
        key = f"cv/{round['orgId']}/{cid}/{re.sub(r'[^A-Za-z0-9._-]', '_', cv_name)[-80:] or 'cv'}"
        self.blobs.save(key, cv, cv_type)
        read = engine.read_cv(self.nova, cv, cv_type, job)
        c = {"id": cid, "orgId": round["orgId"], "jobId": round["jobId"], "roundId": round["id"], "name": name.strip()[:120],
             "email": email.strip().lower()[:200], "cvName": cv_name[:120], "cvKey": key, "cvSummary": read["summary"], "skills": read["skills"],
             "status": "scheduled", "createdAt": engine.now()}
        self.save_candidate(c)
        iv = {"id": f"iv_{secrets.token_urlsafe(18)}", "orgId": round["orgId"], "jobId": round["jobId"], "roundId": round["id"], "candidateId": cid,
              "slotStart": slot["start"], "status": "scheduled", "turns": [], "snapshots": []}
        self.save_interview(iv)
        fresh = self._get("round", round["id"], "round")  # re-read so a concurrent slot edit isn't lost
        for s in fresh["slots"]:
            if s["id"] == slot_id:
                s["candidateId"] = cid
        self.save_round(fresh)
        org = self.org(round["orgId"])
        self._email(c["email"], f"Your {org['name']} interview is booked",
                    f"Hi {c['name'].split()[0]},\n\nYour interview for {job['title']} ({round['name']}) is booked for {slot['start'].replace('T', ' ')[:16]} UTC.\n\n"
                    f"Join here when you're ready (Chrome or Edge, in a quiet room): {self.app_url}/interview/{iv['id']}\n\n"
                    f"This link is personal to you; don't share it.\n\nIntervwd, on behalf of {org['name']}")
        return {"interviewId": iv["id"], "candidate": c, "interview": iv, "job": job, "round": fresh}

    def _ctx(self, interview_id: str) -> tuple[Doc, Doc, Doc, Doc, Doc]:
        iv = self._get("interview", interview_id, "interview")
        return iv, self._get("round", iv["roundId"], "round"), self._get("candidate", iv["candidateId"], "candidate"), self._get("job", iv["jobId"], "job"), self.org(iv["orgId"])

    def room(self, interview_id: str) -> Doc:
        iv, round, c, job, org = self._ctx(interview_id)
        public = self._public_interview(iv)
        public["snapshots"] = []  # candidates don't need their own snapshots back
        return {"interview": public, "candidateName": c["name"], "orgName": org["name"], "job": {"id": job["id"], "title": job["title"]},
                "round": {k: round[k] for k in ("id", "name", "durationMin", "questions")}}

    def start_interview(self, interview_id: str) -> Doc:
        iv, round, c, job, org = self._ctx(interview_id)
        if iv["status"] == "completed":
            raise Problem("This interview has already finished.", 409)
        turns = engine.start(self.nova, iv, round, job, c, org["name"])
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
        turns, done = engine.answer(self.nova, iv, round, c, text)
        if done:
            iv["report"] = engine.score(self.nova, iv, round, job)
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
        iv["snapshots"].append({"at": engine.now(), "key": key})
        self.save_interview(iv)

    def snapshot(self, org_id: str, interview_id: str, n: int) -> tuple[bytes, str]:
        iv = self._owned("interview", interview_id, org_id, "interview")
        snaps = iv.get("snapshots", [])
        if not 0 <= n < len(snaps):
            raise Problem("That snapshot doesn't exist.", 404)
        if snaps[n].get("url", "").startswith("data:"):  # seeded demo snapshots
            import base64

            head, b64 = snaps[n]["url"].split(",", 1)
            return base64.b64decode(b64), head[5:].split(";")[0]
        got = self.blobs.load(snaps[n]["key"])
        if not got:
            raise Problem("That snapshot has expired.", 404)
        return got
