"""The Intervwd MCP server: the recruiter tools Alexa+ calls (Streamable HTTP at /mcp, OAuth-linked)."""

from __future__ import annotations

from typing import Any, Callable

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations

from . import tools
from .auth import current_session
from .service import Problem, Service

INSTRUCTIONS = """Intervwd runs structured AI voice interviews for a company's hiring rounds and scores each
candidate against the round's rubric. You help the signed-in recruiter run their pipeline.
- Use get_todays_interviews for "how did today go", list_awaiting_decision for who needs a decision,
  get_candidate_report and compare_candidates for scores and evidence.
- advance_candidate, hold_candidate and reject_candidate change a candidate's status: call them with
  confirm=false first and read back the result, then with confirm=true only after the recruiter says yes.
- Never recommend rejecting a candidate; report scores and evidence and let the recruiter decide.
- Each tool returns a `say` sentence that reads well aloud."""

READ = ToolAnnotations(read_only_hint=True)
CHANGE = ToolAnnotations(destructive_hint=False, idempotent_hint=False)


def create_server(svc: Service) -> MCPServer:
    mcp = MCPServer(
        name="intervwd",
        title="Intervwd",
        description="AI interviews for every hiring round: today's interviews, scored reports, and moving candidates on.",
        instructions=INSTRUCTIONS,
        version="0.1.0",
    )

    def call(fn: Callable[..., dict[str, Any]], *args: Any) -> dict[str, Any]:
        session = current_session.get()
        if not session:
            return {"error": "Sign in to Intervwd first.", "say": "Link your Intervwd account in the Alexa app first."}
        try:
            return fn(svc, session, *args)
        except Problem as e:
            return {"error": str(e), "say": str(e)}

    @mcp.tool(title="List open jobs", annotations=READ)
    def list_jobs() -> dict[str, Any]:
        """List the company's open jobs with candidate counts and interview rounds."""
        return call(tools.list_jobs)

    @mcp.tool(title="Today's interviews", annotations=READ)
    def get_todays_interviews() -> dict[str, Any]:
        """Today's finished interviews (best score first) and the ones still to come."""
        return call(tools.get_todays_interviews)

    @mcp.tool(title="Who needs a decision", annotations=READ)
    def list_awaiting_decision() -> dict[str, Any]:
        """Candidates whose interview is finished and who are waiting for the recruiter's decision."""
        return call(tools.awaiting_decision)

    @mcp.tool(title="Read a candidate's report", annotations=READ)
    def get_candidate_report(candidate_name: str) -> dict[str, Any]:
        """A candidate's latest interview report: overall score out of 5, each criterion's score with
        quoted evidence, and areas worth probing. candidate_name can be a first name."""
        return call(tools.get_candidate_report, candidate_name)

    @mcp.tool(title="Compare candidates", annotations=READ)
    def compare_candidates(candidate_names: list[str] | None = None) -> dict[str, Any]:
        """Compare candidates' interview reports side by side. Without names, compares the top two
        candidates waiting for a decision."""
        return call(tools.compare_candidates, candidate_names)

    @mcp.tool(title="Get an invite link", annotations=READ)
    def get_invite_link(job_title: str | None = None, round_number: int | None = None) -> dict[str, Any]:
        """The link candidates use to sign up, upload a CV and book an interview slot for a job's round."""
        return call(tools.get_invite_link, job_title, round_number)

    @mcp.tool(title="Add interview slots", annotations=CHANGE)
    def add_interview_slots(job_title: str, starts: list[str], round_number: int = 1) -> dict[str, Any]:
        """Add interview time slots candidates can book. starts are ISO 8601 date-times with a time
        zone offset, e.g. 2026-10-26T10:00:00+05:30."""
        return call(tools.add_interview_slots, job_title, starts, round_number)

    @mcp.tool(title="Move a candidate on", annotations=CHANGE)
    def advance_candidate(candidate_name: str, confirm: bool = False, note: str = "") -> dict[str, Any]:
        """Move a candidate to the next round and email them its booking link. Call with confirm=false
        first and read back the result; call with confirm=true only after the recruiter says yes."""
        return call(tools.decide, candidate_name, "advance", confirm, note)

    @mcp.tool(title="Put a candidate on hold", annotations=CHANGE)
    def hold_candidate(candidate_name: str, confirm: bool = False, note: str = "") -> dict[str, Any]:
        """Put a candidate on hold. confirm=false reads back; confirm=true after the recruiter says yes."""
        return call(tools.decide, candidate_name, "hold", confirm, note)

    @mcp.tool(title="Mark a candidate as not progressing", annotations=CHANGE)
    def reject_candidate(candidate_name: str, confirm: bool = False, note: str = "") -> dict[str, Any]:
        """Mark a candidate as not progressing (no email is sent). Only when the recruiter asks for it:
        confirm=false reads back; confirm=true after they say yes."""
        return call(tools.decide, candidate_name, "reject", confirm, note)

    return mcp
