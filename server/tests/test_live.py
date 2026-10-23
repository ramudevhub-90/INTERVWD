"""The same flows against the real AWS services (Nova, Chime, Polly), with in-memory storage.

Runs only with LIVE=1, inside AWS with the app's own role (see scripts/live-check.sh).
"""

from __future__ import annotations

import os
import re

import pytest
from starlette.testclient import TestClient

from intervwd.app import create_app
from intervwd.calls import ChimeCalls
from intervwd.knowledge import LocalKnowledge
from intervwd.nova import from_env
from intervwd.store import MemoryBlobs, MemoryStore

from test_flow import Outbox, demo_login, open_slot

pytestmark = pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="needs AWS (LIVE=1)")


@pytest.fixture()
def live():
    outbox = Outbox()
    calls = ChimeCalls(os.environ.get("AWS_REGION", "us-east-1"))
    app = create_app(MemoryStore(), MemoryBlobs(), from_env(), outbox, demo_code="424242", kb=LocalKnowledge(), calls=calls)
    with TestClient(app) as client:
        yield client, outbox, calls


ANSWERS = [
    "At my last store I handled returns and complaints at the service desk. One customer had been charged twice for a TV. "
    "I apologised, checked the receipts, refunded the duplicate charge on the spot and gave them my direct number. They came back the next week.",
    "I logged it in our tracker, told my manager, and we found the till had a double-scan bug, so IT fixed it across all six tills.",
    "I want to work somewhere with a real support team, where I can learn the systems properly and help customers who are stuck.",
    "Mostly I'd like to get faster with your order tools and learn how escalations work here.",
    "I stay calm, let them finish, repeat the problem back, and tell them exactly what I'll do next and when.",
    "Once a customer shouted about a late delivery. I tracked the parcel live, booked a redelivery for that evening and called to confirm it arrived.",
    "Nothing for now, thank you.",
]


def support_round(client, h):
    job = client.post("/api/jobs", headers=h, json={"title": "Customer Support Agent", "location": "Remote",
                                                    "description": "Help customers by chat and phone with orders, refunds and deliveries."}).json()["id"]
    rnd = client.post(f"/api/jobs/{job}/rounds", headers=h, json={
        "name": "First screen", "criteria": [{"name": "Empathy", "description": "Understands and calms customers"},
                                             {"name": "Ownership", "description": "Follows problems through to the end"}],
        "questions": ["Walk me through your most recent job.", "Tell me about a customer issue you resolved.", "What do you want to learn here?"],
        "identityCheck": False, "requireApproval": False, "decisionMode": "assist"}).json()
    return job, rnd


def book_with_cv(client, rnd, slot, name, email, cv):
    r = client.post(f"/api/invites/{rnd['publicPath'].replace('/', '~')}/join",
                    data={"name": name, "email": email, "slotId": slot, "consent": "true"}, files={"cv": ("cv.txt", cv, "text/plain")})
    assert r.status_code == 200, r.text
    return r.json()["interviewId"]


def finish(client, iv):
    for a in ANSWERS * 2:
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": a})
        assert out.status_code == 200, out.text
        if out.json()["done"]:
            return
    pytest.fail("the interview never finished")


def test_nova_interview_with_someone_elses_cv(live):
    """Neha books with Ravi Kumar's CV: the AI must never call her Ravi, and HR is told."""
    client, _, _ = live
    h = demo_login(client)
    job, rnd = support_round(client, h)
    cv = (b"RAVI KUMAR\nravi.kumar@example.com\nCustomer service assistant, City Mart, 2021-2024: handled complaints and returns, "
          b"ran tills at peak times, trained two new starters.")
    iv = book_with_cv(client, rnd, open_slot(client, h, rnd["id"]), "Neha Test", "neha@example.com", cv)
    svc = client.app.state.svc
    cand = svc.store.get("candidate", svc.store.get("interview", iv)["candidateId"])
    assert "ravi" in cand["nameOnCv"].lower(), cand
    assert "ravi" not in cand["cvSummary"].lower(), cand["cvSummary"]

    turns = client.post(f"/api/interviews/{iv}/start").json()["turns"]
    plan = svc.store.get("interview", iv)["plan"]
    print("PLAN:", plan)
    assert not any("ravi" in t["text"].lower() for t in turns)
    assert not any("ravi" in q.lower() for q in plan)
    assert turns[0]["text"].startswith("Hi Neha")

    finish(client, iv)
    done = svc.store.get("interview", iv)
    print("REPORT:", done["report"]["overall"], done["report"]["scoredBy"], done["triage"])
    assert done["report"]["scoredBy"] == "nova"
    assert all(c.get("confidence") in ("high", "medium", "low") for c in done["report"]["criteria"])
    assert done["triage"]["band"] == "review" and any("CV" in r for r in done["triage"]["reasons"])
    every = " ".join(t["text"] for t in done["turns"] if t["role"] == "interviewer")
    assert "ravi" not in every.lower()
    assert not re.search(r"\b(he|she|his|her|him)\b", done["report"]["summary"], re.I), done["report"]["summary"]


def test_live_takeover_on_real_chime(live):
    """Candidate and HR land in the same Chime meeting; ask, take over, hand back, finish."""
    client, _, calls = live
    h = demo_login(client)
    job, rnd = support_round(client, h)
    iv = book_with_cv(client, rnd, open_slot(client, h, rnd["id"]), "Asha Nair", "asha@example.com",
                      b"Asha Nair. 3 years in retail customer service, returns and complaints.")
    client.post(f"/api/interviews/{iv}/start")
    cand = client.post(f"/api/interviews/{iv}/live").json()
    host = client.post(f"/api/interviews/{iv}/live/host", headers=h).json()
    meeting = cand["meeting"]["MeetingId"]
    try:
        assert host["meeting"]["MeetingId"] == meeting and cand["attendee"]["AttendeeId"] != host["attendee"]["AttendeeId"]
        assert calls._chime().get_meeting(MeetingId=meeting)["Meeting"]["MediaRegion"]
        # A second device for the candidate (phone after laptop) joins the same meeting.
        again = client.post(f"/api/interviews/{iv}/live").json()
        assert again["meeting"]["MeetingId"] == meeting

        client.get(f"/api/interviews/{iv}/live/state", headers=h)
        assert client.get(f"/api/interviews/{iv}/live/status").json()["watchers"] == ["Priya Sharma"]
        ctl = lambda a, q="": client.post(f"/api/interviews/{iv}/live/control", headers=h, json={"action": a, "question": q}).json()  # noqa: E731
        ctl("ask", "How do you handle a customer who won't calm down?")
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": ANSWERS[0]}).json()
        assert out["turns"][0]["kind"] == "team_question" and "calm down" in out["turns"][0]["text"]
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": ANSWERS[4]}).json()
        assert all(t["kind"] != "team_question" for t in out["turns"])  # asked once only

        ctl("take_over")
        assert client.get(f"/api/interviews/{iv}/live/status").json()["takenOverBy"] == "Priya Sharma"
        assert client.post(f"/api/interviews/{iv}/answer", json={"text": "x"}).status_code == 409
        ctl("ask", "Queued while I'm talking: what hours suit you?")
        back = ctl("hand_back")
        assert back["takenOverBy"] is None
        # After hand-back the room resumes with the last real question, not the handover line.
        resumed = client.post(f"/api/interviews/{iv}/start").json()["turns"]
        assert resumed[-1]["kind"] != "handover"
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": ANSWERS[1]}).json()
        assert out["turns"][0]["kind"] == "team_question" and "hours" in out["turns"][0]["text"]
        finish(client, iv)
        done = client.app.state.svc.store.get("interview", iv)
        assert done["report"]["scoredBy"] == "nova"
        print("TAKEOVER TRANSCRIPT:", [(t["kind"], t["text"][:70]) for t in done["turns"]])
    finally:
        calls._chime().delete_meeting(MeetingId=meeting)


def test_human_round_video_call_on_real_chime(live):
    client, outbox, calls = live
    h = demo_login(client)
    slot = open_slot(client, h, "round_backend_2")
    r = client.post("/api/invites/northwind-labs~backend-engineer-r2/join",
                    data={"name": "Kiran Rao", "email": "kiran@example.com", "slotId": slot, "consent": "true"},
                    files={"cv": ("cv.txt", b"Kiran Rao. 5 years Python, Django, AWS.", "text/plain")})
    iv = r.json()["interviewId"]
    joined = client.post(f"/api/interviews/{iv}/call").json()
    host = client.post(f"/api/interviews/{iv}/call/host", headers=h).json()
    try:
        assert joined["meeting"]["MeetingId"] == host["meeting"]["MeetingId"]
        assert any(inv for to, inv in outbox.invites if to == "kiran@example.com" and "BEGIN:VEVENT" in inv)
    finally:
        calls._chime().delete_meeting(MeetingId=joined["meeting"]["MeetingId"])


def test_practice_with_nova_is_different_from_the_real_questions(live):
    client, _, _ = live
    h = demo_login(client)
    job, rnd = support_round(client, h)
    iv = book_with_cv(client, rnd, open_slot(client, h, rnd["id"]), "Asha Nair", "asha2@example.com", b"Asha Nair. Retail support.")
    p = client.post(f"/api/practice/{iv}/start").json()
    print("PRACTICE:", p)
    text = str(p).lower()
    assert "most recent job" not in text and "want to learn here" not in text
    fb = client.post(f"/api/practice/{iv}/answer", json={"text": ANSWERS[0]}).json()
    print("COACH:", fb)
    assert fb


def test_polly_voice_and_assistant(live):
    client, _, _ = live
    h = demo_login(client)
    audio = client.post("/api/speech", json={"text": "Hi Neha, thanks for joining."})
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg" and len(audio.content) > 2000
    reply = client.post("/api/assistant", headers=h, json={"message": "Who is waiting for a decision?"}).json()
    print("ASSISTANT:", reply)
    assert "Rahul" in str(reply) or "Ana" in str(reply)
