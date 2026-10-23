"""End-to-end tests through the HTTP API with in-memory storage and Nova off (rules)."""

from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timedelta, timezone

import pytest
from starlette.testclient import TestClient

from intervwd.app import create_app
from intervwd.auth import Mailer
from intervwd.knowledge import LocalKnowledge
from intervwd.nova import MockNova
from intervwd.store import MemoryBlobs, MemoryStore

DEMO = "demo@intervwd.com"


class Outbox(Mailer):
    def __init__(self) -> None:
        super().__init__(sender="test@intervwd.com")
        self.sent: list[tuple[str, str, str]] = []

    def send(self, to: str, subject: str, text: str) -> bool:
        self.sent.append((to, subject, text))
        return True


@pytest.fixture()
def env():
    outbox = Outbox()
    app = create_app(MemoryStore(), MemoryBlobs(), MockNova(), outbox, demo_code="424242", kb=LocalKnowledge())
    with TestClient(app) as client:
        yield client, outbox


def demo_login(client: TestClient) -> dict[str, str]:
    assert client.post("/api/auth/code", json={"email": DEMO}).status_code == 200
    r = client.post("/api/auth/verify", json={"email": DEMO, "code": "424242"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_demo_dashboard(env):
    client, _ = env
    h = demo_login(client)
    d = client.get("/api/dashboard", headers=h).json()
    assert d["org"]["name"] == "Northwind Labs"
    assert d["stats"]["openJobs"] == 3
    assert [a["candidate"]["name"] for a in d["awaiting"]][:2] == ["Rahul Mehta", "Ana Silva"]
    assert client.get("/api/dashboard").status_code == 401


def test_wrong_code_and_signup_with_email_code(env):
    client, outbox = env
    assert client.post("/api/auth/verify", json={"email": DEMO, "code": "000000"}).status_code == 401
    assert client.post("/api/orgs", json={"orgName": "Acme", "name": "Sam Lee", "email": "sam@acme.test"}).status_code == 200
    code = re.search(r"\b(\d{6})\b", outbox.sent[-1][2]).group(1)
    r = client.post("/api/auth/verify", json={"email": "sam@acme.test", "code": code})
    assert r.status_code == 200 and r.json()["session"]["orgName"] == "Acme"
    # The code is single use, and a verified email can't be registered again.
    assert client.post("/api/auth/verify", json={"email": "sam@acme.test", "code": code}).status_code == 401
    assert client.post("/api/orgs", json={"orgName": "Other", "name": "X Y", "email": "sam@acme.test"}).status_code == 409


def test_full_interview(env):
    client, outbox = env
    h = demo_login(client)
    job_id = client.post("/api/jobs", headers=h, json={"title": "QA Engineer", "location": "Remote", "description": "Test our payments platform end to end."}).json()["id"]
    rnd = client.post(f"/api/jobs/{job_id}/rounds", headers=h, json={
        "name": "Screen", "durationMin": 15, "criteria": [{"name": "Testing", "description": "Plans and automates tests"}],
        "questions": ["How do you decide what to test first?", "Tell me about a bug you found late."], "identityCheck": False, "requireApproval": False}).json()
    assert rnd["name"] == "Round 1 · Screen"
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    rnd = client.post(f"/api/rounds/{rnd['id']}/slots", headers=h, json={"starts": [start]}).json()
    slot = rnd["slots"][0]["id"]

    inv = client.get(f"/api/invites/{rnd['inviteCode']}").json()
    assert inv["orgName"] == "Northwind Labs" and len(inv["openSlots"]) == 1
    cv = b"Kiran Rao. 4 years in Python, Docker and SQL testing payment APIs."
    r = client.post(f"/api/invites/{rnd['inviteCode']}/join", data={"name": "Kiran Rao", "email": "kiran@example.com", "slotId": slot, "consent": "true"},
                    files={"cv": ("cv.txt", cv, "text/plain")})
    assert r.status_code == 200, r.text
    iv = r.json()["interviewId"]
    assert any("kiran@example.com" == m[0] and iv in m[2] for m in outbox.sent)
    # The slot is gone for the next candidate.
    again = client.post(f"/api/invites/{rnd['inviteCode']}/join", data={"name": "B B", "email": "b@example.com", "slotId": slot, "consent": "true"},
                        files={"cv": ("cv.txt", cv, "text/plain")})
    assert again.status_code == 409

    step = client.post(f"/api/interviews/{iv}/start").json()
    assert step["turns"][0]["kind"] == "greeting" and step["turns"][1]["kind"] == "question"
    answers = ["I start with the riskiest flows, payments and refunds, and automate them with pytest against a staging API every night.",
               "Refund amounts and idempotency keys get property-based tests too.",
               "A currency rounding bug in Docker builds only; I bisected the image and found the locale setting.",
               "I added a test that runs in every container.",
               "What does the QA team's on-call look like?"]
    done = False
    for a in answers:
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": a}).json()
        done = out["done"]
    assert done
    assert client.post(f"/api/interviews/{iv}/answer", json={"text": "more"}).status_code == 409

    cands = client.get(f"/api/jobs/{job_id}", headers=h).json()["candidates"]
    assert cands[0]["name"] == "Kiran Rao" and cands[0]["status"] == "completed" and 1 <= cands[0]["overall"] <= 5
    view = client.get(f"/api/candidates/{cands[0]['id']}", headers=h).json()
    assert "Python" in view["candidate"]["skills"]
    assert client.get(view["candidate"]["cvUrl"]).content == cv
    assert client.post(f"/api/candidates/{cands[0]['id']}/decision", headers=h, json={"action": "hold", "note": ""}).json()["status"] == "on_hold"


def test_assistant_rules_need_a_yes(env):
    client, outbox = env
    h = demo_login(client)
    ask = lambda m: client.post("/api/assistant", headers=h, json={"message": m}).json()  # noqa: E731
    assert "Rahul Mehta scored 4.1" in ask("Compare the top two")["text"]
    confirm = ask("Alexa, move Rahul to the next round")
    assert confirm.get("pendingConfirmation") and "Shall I?" in confirm["text"]
    assert client.get("/api/candidates/cand_rahul", headers=h).json()["candidate"]["status"] == "completed"
    done = ask("yes")
    assert "Round 2" in done["text"]
    rahul = client.get("/api/candidates/cand_rahul", headers=h).json()["candidate"]
    assert rahul["status"] == "invited" and rahul["roundId"] == "round_backend_2"  # same candidate, now in Round 2
    mail = next(m[2] for m in outbox.sent if m[0] == "rahul.mehta@example.com")
    assert "northwind-labs/backend-engineer-r2?t=" in mail  # personal link: profile kept, no approval


def test_oauth_link_and_mcp_tools(env):
    client, _ = env
    h = demo_login(client)
    assert client.post("/mcp", json={}).status_code == 401
    meta = client.get("/.well-known/oauth-authorization-server").json()
    assert meta["code_challenge_methods_supported"] == ["S256"]
    reg = client.post("/oauth/register", json={"client_name": "Alexa", "redirect_uris": ["https://alexa.example/cb"]}).json()
    verifier = "v" * 50
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    r = client.get("/oauth/authorize", params={"client_id": reg["client_id"], "redirect_uri": "https://alexa.example/cb", "response_type": "code",
                                               "code_challenge": challenge, "code_challenge_method": "S256", "state": "xyz"}, follow_redirects=False)
    assert r.status_code == 302
    request_id = r.headers["location"].split("request=")[1]
    assert client.get(f"/api/oauth/requests/{request_id}", headers=h).json()["clientName"] == "Alexa"
    redirect = client.post(f"/api/oauth/requests/{request_id}/approve", headers=h).json()["redirect"]
    code = re.search(r"code=([^&]+)", redirect).group(1)
    assert "state=xyz" in redirect
    tok = client.post("/oauth/token", data={"grant_type": "authorization_code", "code": code, "redirect_uri": "https://alexa.example/cb",
                                            "client_id": reg["client_id"], "code_verifier": verifier}).json()
    assert tok["token_type"] == "Bearer"
    # The MCP token can't be used on the web API.
    assert client.get("/api/dashboard", headers={"Authorization": f"Bearer {tok['access_token']}"}).status_code == 401

    mh = {"Authorization": f"Bearer {tok['access_token']}", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"}
    init = client.post("/mcp", headers=mh, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
    assert init.status_code == 200, init.text
    listed = client.post("/mcp", headers=mh, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()
    names = {t["name"] for t in listed["result"]["tools"]}
    assert {"get_todays_interviews", "advance_candidate", "compare_candidates"} <= names
    called = client.post("/mcp", headers=mh, json={"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                                   "params": {"name": "get_candidate_report", "arguments": {"candidate_name": "Ana"}}}).json()
    assert "Ana Silva scored 3.9" in str(called["result"])
    refreshed = client.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": reg["client_id"]})
    assert refreshed.status_code == 200


def test_demo_reset_removes_visitor_data(env):
    from intervwd import seed

    client, _ = env
    h = demo_login(client)
    svc = client.app.state.svc
    job_id = client.post("/api/jobs", headers=h, json={"title": "Temp", "location": "", "description": "A temporary job added by a visitor."}).json()["id"]
    seed.reset_demo(svc)
    assert svc.store.get("job", job_id) is None
    assert {c["id"] for c in svc.all_candidates(seed.DEMO_ORG)} == seed.SEEDED_CANDIDATES


def test_demo_code_guesses_are_capped(env):
    client, _ = env
    for _ in range(30):
        assert client.post("/api/auth/verify", json={"email": DEMO, "code": "000000"}).status_code == 401
    # Even the right code is refused until the window passes.
    assert client.post("/api/auth/verify", json={"email": DEMO, "code": "424242"}).status_code == 429


def test_knowledge_base_shapes_the_interview(env):
    client, _ = env
    h = demo_login(client)
    kb = lambda: client.get("/api/jobs/job_backend/knowledge", headers=h).json()  # noqa: E731
    assert kb() == {"enabled": True, "documents": []}
    team = "Our checkout runs on DynamoDB and handles 50k orders an hour during sales.\n\nOn-call rotates weekly across six engineers, with a day off after each rotation."
    up = client.post("/api/jobs/job_backend/knowledge", headers=h, data={"kind": "shareable", "text": team, "name": "Team"})
    assert up.status_code == 200, up.text
    secret = client.post("/api/jobs/job_backend/knowledge", headers=h, data={"kind": "interviewer"},
                         files={"file": ("strong-answers.md", b"A strong retry answer names idempotency keys stored with the charge.", "text/markdown")})
    assert secret.status_code == 200
    docs = kb()["documents"]
    assert {d["kind"] for d in docs} == {"shareable", "interviewer"} and all(d["status"] == "ready" for d in docs)
    assert client.post("/api/jobs/job_backend/knowledge", headers=h, data={"kind": "other", "text": "x" * 40}).status_code == 400
    # Another company can't see or delete them.
    svc = client.app.state.svc
    assert svc.kb.search("org_other", "job_backend", "on-call rotation", ("shareable",)) == []

    # A candidate's question is answered from shareable knowledge only (rules: the fallback says it'll be passed on).
    iv = "iv_demo_vikram"
    client.post("/api/candidates/cand_vikram/identity/approve", headers=h)  # sample candidate has no photo
    assert client.post(f"/api/interviews/{iv}/start").status_code == 200
    for _ in range(10):
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": "I would use idempotency keys and retries with backoff on every payment call."}).json()
    assert out["turns"][0]["kind"] == "invite_questions"
    found = svc.search(svc.store.get("interview", iv), "What does on-call look like?", ("shareable",))
    assert "On-call rotates weekly" in found[0]["text"]
    assert svc.search(svc.store.get("interview", iv), "strong retry answer idempotency", ("shareable",)) == []
    done = client.post(f"/api/interviews/{iv}/answer", json={"text": "What does on-call look like?"}).json()
    assert done["done"] and done["turns"][0]["kind"] == "closing"
    report = svc.store.get("interview", iv)["report"]
    assert "on-call" not in " ".join(c["evidence"] for c in report["criteria"]).lower()

    client.delete(f"/api/jobs/job_backend/knowledge/{docs[0]['id']}", headers=h)
    assert len(kb()["documents"]) == 1


FACE = b"\xff\xd8 face of kiran"


def book(client, code, slot, **extra):
    files = {"cv": ("cv.txt", b"Kiran. Python and SQL.", "text/plain")}
    if extra.pop("photo", True):
        files["photo"] = ("me.jpg", FACE, "image/jpeg")
    data = {"name": "Kiran Rao", "email": "kiran@example.com", "slotId": slot, "consent": "true", "faceConsent": "true", **extra}
    return client.post(f"/api/invites/{code}/join", data=data, files=files)


def open_slot(client, h, round_id):
    start = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    return client.post(f"/api/rounds/{round_id}/slots", headers=h, json={"starts": [start]}).json()["slots"][-1]["id"]


def test_identity_check_gates_the_interview(env):
    client, outbox = env
    h = demo_login(client)
    slot = open_slot(client, h, "round_backend_1")
    assert book(client, "nw-backend-r1", slot, photo=False).status_code == 400  # photo required
    r = book(client, "nw-backend-r1", slot)
    assert r.status_code == 200 and r.json()["status"] == "scheduled", r.text
    iv = r.json()["interviewId"]
    assert client.get(f"/api/interviews/{iv}").json()["identity"] == {"required": True, "status": "pending", "attemptsLeft": 3}
    assert client.post(f"/api/interviews/{iv}/start").status_code == 403
    verify = lambda img: client.post(f"/api/interviews/{iv}/verify", files={"image": ("live.jpg", img, "image/jpeg")}).json()  # noqa: E731
    assert verify(b"someone else")["attemptsLeft"] == 2
    assert verify(b" ")["result"] == "no_face"
    locked = verify(b"someone else again")
    assert locked["status"] == "locked" and client.post(f"/api/interviews/{iv}/start").status_code == 403
    assert verify(FACE)["status"] == "locked"  # stays locked until a person lets them in

    cid = client.app.state.svc.store.get("interview", iv)["candidateId"]
    view = client.get(f"/api/candidates/{cid}", headers=h).json()
    assert view["identityRequired"] and view["interviews"][-1]["identity"]["status"] == "locked"
    assert client.get(view["candidate"]["photoUrl"]).content == FACE
    assert client.post(f"/api/candidates/{cid}/identity/approve", headers=h).json()["status"] == "approved"
    assert client.post(f"/api/interviews/{iv}/start").status_code == 200


def test_matching_face_starts_and_photos_are_deleted_after_decision(env):
    client, _ = env
    h = demo_login(client)
    iv = book(client, "nw-backend-r1", open_slot(client, h, "round_backend_1")).json()["interviewId"]
    assert client.post(f"/api/interviews/{iv}/verify", files={"image": ("live.jpg", FACE, "image/jpeg")}).json()["status"] == "matched"
    client.post(f"/api/interviews/{iv}/start")
    for _ in range(11):
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": "I use idempotency keys, retries with backoff and clear logging for every payment."}).json()
        if out["done"]:
            break
    svc = client.app.state.svc
    cid = svc.store.get("interview", iv)["candidateId"]
    assert client.post(f"/api/candidates/{cid}/decision", headers=h, json={"action": "reject", "note": ""}).status_code == 200
    c = svc.store.get("candidate", cid)
    assert c.get("photoDeleted") and "photoKey" not in c and svc.blobs.load(f"faces/{c['orgId']}/{cid}/reference") is None


def test_signup_needs_approval(env):
    client, outbox = env
    h = demo_login(client)
    r = book(client, "nw-storeops-r1", open_slot(client, h, "round_storeops_1"))
    assert r.json() == {"interviewId": None, "status": "pending_approval"}
    svc = client.app.state.svc
    cid = next(c["id"] for c in svc.candidates("job_storeops") if c["name"] == "Kiran Rao")
    iv = next(i for i in svc.interviews("org_northwind") if i["candidateId"] == cid)["id"]
    assert client.post(f"/api/interviews/{iv}/start").status_code == 403
    assert not any(iv in m[2] for m in outbox.sent)  # no interview link until approved
    assert client.post(f"/api/candidates/{cid}/signup", headers=h, json={"approve": True}).json()["status"] == "scheduled"
    assert any(iv in m[2] for m in outbox.sent)


def test_hr_adds_a_candidate_who_finishes_their_profile(env):
    client, outbox = env
    h = demo_login(client)
    open_slot(client, h, "round_storeops_1")
    r = client.post("/api/jobs/job_storeops/candidates", headers=h, data={"roundId": "round_storeops_1", "name": "Asha Pillai", "email": "asha@example.com"})
    assert r.status_code == 200, r.text
    link = r.json()["link"]
    assert any(m[0] == "asha@example.com" and link in m[2] for m in outbox.sent)
    token = link.split("t=")[1]
    inv = client.get(f"/api/invites/nw-storeops-r1?t={token}").json()
    assert inv["invited"]["name"] == "Asha Pillai" and inv["round"]["requireApproval"] is False
    slot = inv["openSlots"][-1]["id"]
    done = book(client, "nw-storeops-r1", slot, t=token, name="Asha Pillai", email="asha@example.com")
    assert done.json()["status"] == "scheduled"  # HR-added candidates are pre-approved
    assert client.get(f"/api/invites/nw-storeops-r1?t={token}").status_code == 404  # the personal link is single use


def test_briefing_only_tells_news(env):
    client, _ = env
    h = demo_login(client)
    ask = lambda m: client.post("/api/assistant", headers=h, json={"message": m}).json()  # noqa: E731
    first = ask("Alexa, what's new?")
    assert "scored highest" in first["text"] and first["tool"] == "get_briefing"
    assert "Nothing new" in ask("Any updates?")["text"] or "Next up" in ask("Any updates?")["text"]


def test_links_carry_the_company_name(env):
    client, outbox = env
    h = demo_login(client)
    svc = client.app.state.svc
    # The demo company's links, and the old code still works.
    assert client.get("/api/invites/northwind-labs~backend-engineer-r1").json()["job"]["title"] == "Backend Engineer"
    assert client.get("/api/invites/nw-backend-r1").status_code == 200
    # Two companies with the same name get different link names.
    for i in range(2):
        client.post("/api/orgs", json={"orgName": "Acme Retail", "name": "Sam Lee", "email": f"sam{i}@acme.test"})
    slugs = sorted(svc.store.get("org", svc.store.get("recruiter", f"sam{i}@acme.test")["orgId"])["slug"] for i in range(2))
    assert slugs == ["acme-retail", "acme-retail-2"]
    job = client.post("/api/jobs", headers=h, json={"title": "QA Engineer", "location": "", "description": "Test our payments platform end to end."}).json()["id"]
    r = client.post(f"/api/jobs/{job}/rounds", headers=h, json={"name": "Screen", "criteria": [{"name": "Testing", "description": "x"}], "questions": ["a?", "b?"]}).json()
    assert r["publicPath"] == "northwind-labs/qa-engineer-r1"
    assert client.get("/api/invites/northwind-labs~qa-engineer-r1").json()["round"]["id"] == r["id"]
    assert "northwind-labs/backend-engineer-r1" in client.post("/api/assistant", headers=h, json={"message": "share the backend invite link"}).json()["text"]


def test_company_can_rename_its_links(env):
    client, outbox = env
    h = demo_login(client)
    assert client.post("/api/settings", headers=h, json={"slug": "anything"}).status_code == 403  # demo is locked
    client.post("/api/orgs", json={"orgName": "Acme Retail", "name": "Sam Lee", "email": "sam@acme.test"})
    code = re.search(r"\b(\d{6})\b", outbox.sent[-1][2]).group(1)
    ah = {"Authorization": f"Bearer {client.post('/api/auth/verify', json={'email': 'sam@acme.test', 'code': code}).json()['token']}"}
    assert client.get("/api/settings", headers=ah).json()["slug"] == "acme-retail"
    job = client.post("/api/jobs", headers=ah, json={"title": "Cashier", "location": "", "description": "Serve customers at our flagship store."}).json()["id"]
    client.post(f"/api/jobs/{job}/rounds", headers=ah, json={"name": "Screen", "criteria": [{"name": "Service", "description": "x"}], "questions": ["a?", "b?"]})
    for bad, status in (("ab", 400), ("Has Spaces", 400), ("app", 409), ("northwind-labs", 409), ("-acme", 400)):
        assert client.post("/api/settings", headers=ah, json={"slug": bad}).status_code == status, bad
    assert client.post("/api/settings", headers=ah, json={"slug": "acme"}).json()["slug"] == "acme"
    assert client.get("/api/invites/acme~cashier-r1").status_code == 200
    assert client.get("/api/invites/acme-retail~cashier-r1").status_code == 200  # old links keep working
    assert client.get(f"/api/jobs/{job}", headers=ah).json()["rounds"][0]["publicPath"] == "acme/cashier-r1"
    # The old name stays with Acme: another company can't take it.
    client.post("/api/orgs", json={"orgName": "Other Co", "name": "Al Bo", "email": "al@other.test"})
    code = re.search(r"\b(\d{6})\b", outbox.sent[-1][2]).group(1)
    oh = {"Authorization": f"Bearer {client.post('/api/auth/verify', json={'email': 'al@other.test', 'code': code}).json()['token']}"}
    assert client.post("/api/settings", headers=oh, json={"slug": "acme-retail"}).status_code == 409


class ScoringNova(MockNova):
    """Nova stand-in that scores every criterion the same, with a chosen confidence."""

    enabled = True

    def __init__(self, score: float, confidence: str = "high") -> None:
        self.score, self.confidence = score, confidence

    def json(self, system, prompt, schema, document=None, max_tokens=1200):
        if "criteria" in schema.get("properties", {}):
            names = re.findall(r"^- ([^:]+):", prompt, re.M)
            return {"criteria": [{"name": n, "score": self.score, "evidence": "quote", "confidence": self.confidence} for n in names],
                    "summary": "Summary.", "highlights": ["h"], "concerns": []}
        return None

    def chat(self, *a, **k):
        return None


def run_interview(client, h, decision_mode="auto", rounds=2):
    job = client.post("/api/jobs", headers=h, json={"title": "Support Lead", "location": "", "description": "Lead our customer support team day to day."}).json()["id"]
    made = [client.post(f"/api/jobs/{job}/rounds", headers=h, json={
        "name": f"R{i}", "criteria": [{"name": "Empathy", "description": "Understands customers"}, {"name": "Ownership", "description": "Follows through"}],
        "questions": ["Tell me about a hard customer.", "How do you follow up?"], "identityCheck": False, "requireApproval": False,
        "decisionMode": decision_mode, "autoAdvance": {"minOverall": 4.0, "minEach": 3.0}}).json() for i in range(rounds)]
    slot = open_slot(client, h, made[0]["id"])
    iv = book(client, made[0]["publicPath"].replace("/", "~"), slot, photo=False).json()["interviewId"]
    client.post(f"/api/interviews/{iv}/start")
    long = "I listened first, repeated their problem back, fixed the billing error the same day, and called them back a week later to check. " * 2
    for _ in range(6):
        out = client.post(f"/api/interviews/{iv}/answer", json={"text": long}).json()
        if out["done"]:
            break
    svc = client.app.state.svc
    return svc, svc.store.get("interview", iv), made


def make_env(nova):
    outbox = Outbox()
    return TestClient(create_app(MemoryStore(), MemoryBlobs(), nova, outbox, demo_code="424242", kb=LocalKnowledge())), outbox


def test_clear_pass_is_fast_tracked_to_the_next_round():
    client, outbox = make_env(ScoringNova(4.6))
    with client:
        h = demo_login(client)
        svc, iv, rounds = run_interview(client, h)
        assert iv["triage"]["band"] == "fast_track"
        c = svc.store.get("candidate", iv["candidateId"])
        assert c["status"] == "invited" and c["roundId"] == rounds[1]["id"]
        d = svc.decisions(c["id"])[-1]
        assert d["automatic"] and d["action"] == "advance" and "automatically" in d["note"]


def test_unsure_and_below_go_to_a_person():
    for score, conf, band in ((4.1, "high", "review"), (4.6, "low", "review"), (2.4, "high", "below")):
        client, _ = make_env(ScoringNova(score, conf))
        with client:
            h = demo_login(client)
            svc, iv, _ = run_interview(client, h)
            assert iv["triage"]["band"] == band, (score, conf, iv["triage"])
            assert svc.store.get("candidate", iv["candidateId"])["status"] == "completed"  # waits for a person
    # Automatic decisions can only ever move people on.
    from intervwd.service import Problem
    with pytest.raises(Problem):
        svc.decide("org_northwind", iv["candidateId"], "reject", "", "Intervwd", automatic=True)


def test_human_mode_never_auto_advances():
    client, _ = make_env(ScoringNova(4.8))
    with client:
        h = demo_login(client)
        svc, iv, _ = run_interview(client, h, decision_mode="human")
        assert iv["triage"]["band"] == "fast_track" and svc.store.get("candidate", iv["candidateId"])["status"] == "completed"
