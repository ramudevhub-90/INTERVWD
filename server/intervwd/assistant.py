"""The recruiter's voice assistant behind the web Alexa+ simulator.

Nova reads the request and calls the same recruiter tools Alexa+ calls over MCP (tools.py). The
conversation lives in the store for 30 minutes, because Lambda runs several copies of the server.
When Nova is off, simple rules map common requests to the same tools, so the demo always answers.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

from . import tools
from .nova import Nova
from .service import Problem, Service

Doc = dict[str, Any]
KEEP_SECONDS = 30 * 60
MAX_STEPS = 4

SYSTEM = """You are Alexa+, helping a recruiter run their hiring pipeline with Intervwd.
Answer in at most three short spoken sentences (about 60 words), no lists, line breaks or markdown.
Refer to candidates by name, never with gendered pronouns.
Use the tools for every fact; never invent candidates, scores or times.
To move, hold or reject a candidate: first call the tool with confirm=false and read back what will happen;
only call it again with confirm=true after the recruiter clearly says yes in their next message.
You never recommend rejecting anyone; give scores and evidence and let the recruiter decide."""

_name = {"type": "string", "description": "Candidate's name as the recruiter said it, e.g. 'Rahul'."}
SPECS: list[Doc] = [
    {"name": "list_jobs", "description": "List open jobs with candidate counts and rounds.", "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "get_todays_interviews", "description": "Today's finished and upcoming interviews, best score first.", "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "list_awaiting_decision", "description": "Candidates whose interview is finished and who wait for the recruiter's decision.", "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "get_candidate_report", "description": "A candidate's latest interview report: overall score, per-criterion scores with evidence, concerns.",
     "inputSchema": {"json": {"type": "object", "properties": {"candidate_name": _name}, "required": ["candidate_name"]}}},
    {"name": "compare_candidates", "description": "Compare candidates' reports. Without names, compares the top two waiting for a decision.",
     "inputSchema": {"json": {"type": "object", "properties": {"candidate_names": {"type": "array", "items": {"type": "string"}}}}}},
    {"name": "get_job_status", "description": "How one job is going: candidates per round and stage, who's interviewing, who's waiting for a decision, fast-tracks, average score, next open slot. Use for 'how is the <job> job going', 'status of <job>'.",
     "inputSchema": {"json": {"type": "object", "properties": {"job_title": {"type": "string"}}, "required": ["job_title"]}}},
    {"name": "get_invite_link", "description": "The invite link candidates use to sign up and book a slot for a job's round.",
     "inputSchema": {"json": {"type": "object", "properties": {"job_title": {"type": "string"}, "round_number": {"type": "integer"}}}}},
    {"name": "add_interview_slots", "description": "Add interview time slots to a job's round. Times are ISO 8601 with time zone.",
     "inputSchema": {"json": {"type": "object", "properties": {"job_title": {"type": "string"}, "starts": {"type": "array", "items": {"type": "string"}}, "round_number": {"type": "integer"}},
                              "required": ["job_title", "starts"]}}},
    {"name": "get_briefing", "description": "What's new since the recruiter last asked: finished interviews, approvals waiting, identity problems, and the next interview. Use for 'what's new', 'good morning', 'any updates'.",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "get_hiring_day", "description": "Today at the office: candidates who arrived, who is interviewing in which room, who's done, and no-shows.",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "list_pending_approvals", "description": "Sign-ups waiting for the recruiter's approval, and interviews locked by a failed identity check.",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "review_signup", "description": "Approve or decline a candidate's sign-up. Call with confirm=false first to read back; confirm=true only after the recruiter says yes.",
     "inputSchema": {"json": {"type": "object", "properties": {"candidate_name": _name, "approve": {"type": "boolean"}, "confirm": {"type": "boolean"}}, "required": ["candidate_name", "approve", "confirm"]}}},
    {"name": "let_candidate_in", "description": "Let a candidate whose identity check failed start their interview anyway, after the recruiter checked the photos. confirm=false first, confirm=true after a yes.",
     "inputSchema": {"json": {"type": "object", "properties": {"candidate_name": _name, "confirm": {"type": "boolean"}}, "required": ["candidate_name", "confirm"]}}},
    *[
        {"name": f"{a}_candidate", "description": d + " Call with confirm=false first to read back; confirm=true only after the recruiter says yes.",
         "inputSchema": {"json": {"type": "object", "properties": {"candidate_name": _name, "confirm": {"type": "boolean"}, "note": {"type": "string"}}, "required": ["candidate_name", "confirm"]}}}
        for a, d in [("advance", "Move a candidate to the next round and email them its booking link."), ("hold", "Put a candidate on hold."),
                     ("reject", "Mark a candidate as not progressing.")]
    ],
]


def run_tool(svc: Service, session: Doc, name: str, args: Doc, tz_offset_min: int = 0) -> Doc:
    table: dict[str, Callable[[], Doc]] = {
        "list_jobs": lambda: tools.list_jobs(svc, session),
        "get_todays_interviews": lambda: tools.get_todays_interviews(svc, session, tz_offset_min),
        "list_awaiting_decision": lambda: tools.awaiting_decision(svc, session),
        "get_candidate_report": lambda: tools.get_candidate_report(svc, session, str(args.get("candidate_name", ""))),
        "compare_candidates": lambda: tools.compare_candidates(svc, session, args.get("candidate_names") or None),
        "get_job_status": lambda: tools.job_status(svc, session, str(args.get("job_title", "")), tz_offset_min),
        "get_invite_link": lambda: tools.get_invite_link(svc, session, args.get("job_title"), args.get("round_number")),
        "add_interview_slots": lambda: tools.add_interview_slots(svc, session, str(args.get("job_title", "")), list(args.get("starts", [])), int(args.get("round_number") or 1)),
        "get_briefing": lambda: tools.briefing(svc, session, tz_offset_min),
        "get_hiring_day": lambda: tools.hiring_day(svc, session, tz_offset_min),
        "list_pending_approvals": lambda: tools.pending_approvals(svc, session),
        "review_signup": lambda: tools.review_signup(svc, session, str(args.get("candidate_name", "")), bool(args.get("approve", True)), bool(args.get("confirm"))),
        "let_candidate_in": lambda: tools.let_in(svc, session, str(args.get("candidate_name", "")), bool(args.get("confirm"))),
        "advance_candidate": lambda: tools.decide(svc, session, str(args.get("candidate_name", "")), "advance", bool(args.get("confirm")), str(args.get("note", ""))),
        "hold_candidate": lambda: tools.decide(svc, session, str(args.get("candidate_name", "")), "hold", bool(args.get("confirm")), str(args.get("note", ""))),
        "reject_candidate": lambda: tools.decide(svc, session, str(args.get("candidate_name", "")), "reject", bool(args.get("confirm")), str(args.get("note", ""))),
    }
    if name not in table:
        return {"error": f"Unknown tool {name}"}
    try:
        return table[name]()
    except Problem as e:
        return {"error": str(e), "say": str(e)}


def spoken(text: str, sentences: int = 3) -> str:
    """Alexa reads replies aloud: one paragraph, at most a few sentences."""
    flat = re.sub(r"\s+", " ", re.sub(r"[*#`_]", "", text)).strip()
    parts = re.split(r"(?<=[.!?])\s+", flat)
    return " ".join(parts[:sentences])


class Assistant:
    def __init__(self, svc: Service, nova: Nova) -> None:
        self.svc = svc
        self.nova = nova

    def _load(self, session: Doc) -> Doc:
        doc = self.svc.store.get("chat", session["userId"]) or {}
        return doc if time.time() - doc.get("at", 0) < KEEP_SECONDS else {}

    def _save(self, session: Doc, doc: Doc) -> None:
        doc["at"] = time.time()
        doc["messages"] = doc.get("messages", [])[-16:]
        # A trimmed history must not start with a tool result whose call was cut off.
        while doc["messages"] and (doc["messages"][0]["role"] != "user" or any("toolResult" in b for b in doc["messages"][0]["content"])):
            doc["messages"].pop(0)
        self.svc.store.put("chat", session["userId"], doc, expires=int(time.time()) + KEEP_SECONDS)

    def reply(self, session: Doc, message: str, tz_offset_min: int = 0) -> Doc:
        message = re.sub(r"^\s*alexa[,\s]*", "", message.strip(), flags=re.I)[:1000]
        if not message:
            raise Problem("Say or type a request first.")
        doc = self._load(session)
        out = self._nova(session, doc, message, tz_offset_min) if self.nova.enabled else None
        if out is None:
            out = self._rules(session, doc, message, tz_offset_min)
        self._save(session, doc)
        return out

    # ---------- Nova agent ----------

    def _nova(self, session: Doc, doc: Doc, message: str, tz: int) -> Doc | None:
        msgs = doc.get("messages", []) + [{"role": "user", "content": [{"text": message}]}]
        used: list[str] = []
        for _ in range(MAX_STEPS):
            reply = self.nova.chat(SYSTEM, msgs, SPECS)
            if reply is None:
                return None
            msgs.append(reply)
            calls = [b["toolUse"] for b in reply["content"] if "toolUse" in b]
            if not calls:
                text = " ".join(b["text"] for b in reply["content"] if "text" in b).strip()
                text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.S).strip()
                doc["messages"] = msgs
                return {"text": spoken(text) or "Done.", **({"tool": ", ".join(used)} if used else {})}
            results = []
            for call in calls:
                used.append(call["name"])
                result = run_tool(self.svc, session, call["name"], call.get("input") or {}, tz)
                results.append({"toolResult": {"toolUseId": call["toolUseId"], "content": [{"json": json.loads(json.dumps(result))}]}})
            msgs.append({"role": "user", "content": results})
        doc["messages"] = msgs
        return {"text": "Sorry, that took too many steps. Try asking in a simpler way.", "tool": ", ".join(used)}

    # ---------- Rules (Nova off) ----------

    def _rules(self, session: Doc, doc: Doc, message: str, tz: int) -> Doc:
        text = message.lower()
        names = {c["name"].split()[0].lower(): c["name"] for c in self.svc.all_candidates(session["orgId"])}
        named = next((full for first, full in names.items() if re.search(rf"\b{re.escape(first)}\b", text)), None)

        def run(tool: str, **args: Any) -> Doc:
            r = run_tool(self.svc, session, tool, args, tz)
            return {"text": r.get("say") or r.get("error") or "Done.", "tool": tool}

        pending = doc.get("pending")
        if pending and re.match(r"^(yes|yeah|yep|confirm|do it|go ahead|sure|please do)\b", text):
            doc.pop("pending")
            return run(pending["tool"], candidate_name=pending["name"], confirm=True)
        if pending and re.match(r"^(no|nope|cancel|stop|don't|do not)\b", text):
            doc.pop("pending")
            return {"text": "Okay, I won't change anything."}

        if re.search(r"\b(hiring day|office|reception|rooms?|no.?shows?|walk.?ins?)\b", text):
            return run("get_hiring_day")
        if re.search(r"\b(what'?s new|good morning|any updates?|brief me|catch me up|what did i miss)\b", text):
            return run("get_briefing")
        if named and re.search(r"\b(approve|accept)\b", text):
            doc["pending"] = {"tool": "review_signup", "name": named}
            r = run_tool(self.svc, session, "review_signup", {"candidate_name": named, "approve": True}, tz)
            return {"text": r.get("say") or r.get("error"), "pendingConfirmation": True}
        if named and re.search(r"\blet .* in\b|\blet in\b", text):
            doc["pending"] = {"tool": "let_candidate_in", "name": named}
            r = run_tool(self.svc, session, "let_candidate_in", {"candidate_name": named}, tz)
            return {"text": r.get("say") or r.get("error"), "pendingConfirmation": True}
        if re.search(r"\b(approval|approve|sign-?ups?|locked|identity)\b", text):
            return run("list_pending_approvals")
        action = ("advance" if re.search(r"\b(move|advance|progress|next round|shortlist)\b", text)
                  else "reject" if re.search(r"\b(reject|decline|not progress)\b", text) else "hold" if re.search(r"\bhold\b", text) else None)
        if action and named:
            out = run(f"{action}_candidate", candidate_name=named, confirm=False)
            doc["pending"] = {"tool": f"{action}_candidate", "name": named}
            out.pop("tool", None)
            return {**out, "pendingConfirmation": True}
        job_named = next((j["title"] for j in self.svc.jobs(session["orgId"]) if j["title"].split()[0].lower() in text), None)
        if job_named and not re.search(r"\b(invite|link)\b", text):
            return run("get_job_status", job_title=job_named)
        if re.search(r"\bcompare\b", text):
            return run("compare_candidates")
        if named and re.search(r"\b(how did|report|score|tell me about|summary|how was)\b", text):
            return run("get_candidate_report", candidate_name=named)
        if re.search(r"\b(waiting|decision|pending|to review)\b", text):
            return run("list_awaiting_decision")
        if re.search(r"\b(today|how did|interviews|schedule|who's|who is)\b", text):
            return run("get_todays_interviews")
        if re.search(r"\b(jobs|roles|openings|positions|hiring for)\b", text):
            return run("list_jobs")
        if re.search(r"\b(invite|link)\b", text):
            job = next((j["title"] for j in self.svc.jobs(session["orgId"]) if j["title"].split()[0].lower() in text), None)
            return run("get_invite_link", job_title=job)
        return {"text": "I can tell you how today's interviews went, read a candidate's report, compare candidates, share an invite link, or move someone to the next round. What would you like?"}
