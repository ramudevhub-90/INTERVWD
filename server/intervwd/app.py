"""HTTP entry point: /api/* for the web app, /mcp for Alexa+, /oauth/* and /.well-known/* for account linking."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
import urllib.parse
from typing import Any, Awaitable, Callable

from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from . import knowledge as knowledge_mod
from . import nova as nova_mod
from . import seed
from . import store as store_mod
from .assistant import Assistant
from .auth import DEMO_EMAIL, Auth, Mailer, OAuthError, current_session
from .faces import FaceMatcher, FakeMatcher, RekognitionMatcher
from .mcp_server import create_server
from .service import Problem, Service

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)

Doc = dict[str, Any]
Handler = Callable[[Request], Awaitable[Response]]
SIGNED_LINK_TTL = 3600


class OriginSecretMiddleware:
    """On AWS the Lambda URL is public; only CloudFront knows this header value.
    /health stays open for the Lambda Web Adapter's readiness check."""

    def __init__(self, app: Any, secret: str) -> None:
        self.app = app
        self.secret = secret.encode()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and scope["path"] != "/health":
            if not hmac.compare_digest(dict(scope["headers"]).get(b"x-origin-secret", b""), self.secret):
                await JSONResponse({"error": "forbidden"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class McpAuthMiddleware:
    """/mcp needs an OAuth access token; the 401 points MCP clients at our metadata to start linking."""

    def __init__(self, app: Any, auth: Auth) -> None:
        self.app = app
        self.auth = auth

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not (scope["path"] == "/mcp" or scope["path"].startswith("/mcp/")) or scope["method"] == "OPTIONS":
            await self.app(scope, receive, send)
            return
        header = dict(scope["headers"]).get(b"authorization", b"").decode()
        session = self.auth.authenticate(header)
        if not session:
            base = base_url(scope)
            await JSONResponse(
                {"error": "invalid_token", "error_description": "Link your Intervwd account."}, status_code=401,
                headers={"WWW-Authenticate": f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"'},
            )(scope, receive, send)
            return
        token = current_session.set(session)
        try:
            await self.app(scope, receive, send)
        finally:
            current_session.reset(token)


def base_url(scope: Any) -> str:
    if os.environ.get("APP_URL"):
        return os.environ["APP_URL"]
    headers = {k.decode(): v.decode() for k, v in scope["headers"]}
    host = headers.get("x-forwarded-host") or headers.get("host", "localhost")
    return f"{headers.get('x-forwarded-proto', 'http')}://{host}"


def create_app(store: store_mod.Store | None = None, blobs: store_mod.Blobs | None = None, nova: nova_mod.Nova | None = None,
               mailer: Mailer | None = None, demo_code: str | None = None, kb: knowledge_mod.Knowledge | None = None,
               faces: FaceMatcher | None = None) -> Starlette:
    if store is None or blobs is None:
        env_store, env_blobs = store_mod.from_env()
        store, blobs = store or env_store, blobs or env_blobs
    nova = nova or nova_mod.from_env()
    mailer = mailer or Mailer()
    faces = faces or (RekognitionMatcher() if os.environ.get("ORIGIN_SECRET") else FakeMatcher())
    svc = Service(store, blobs, nova, os.environ.get("APP_URL", "https://intervwd.com"), mailer, kb or knowledge_mod.from_env(), faces)
    auth = Auth(store, mailer, demo_code, slugs=svc.claim_slug)
    assistant = Assistant(svc, nova)
    mcp = create_server(svc)
    signing_key = (os.environ.get("ORIGIN_SECRET") or secrets.token_hex(16)).encode()

    def route(path: str, methods: list[str], recruiter: bool = False) -> Callable[[Callable[..., Awaitable[Any]]], Handler]:
        """Registers an API handler. Problems become {"error"} JSON; recruiter routes get the session."""

        def wrap(fn: Callable[..., Awaitable[Any]]) -> Handler:
            async def handler(request: Request) -> Response:
                try:
                    if recruiter:
                        session = auth.authenticate(request.headers.get("authorization"))
                        if not session or session.get("clientId"):  # MCP tokens only work on /mcp
                            raise Problem("Sign in to continue.", 401)
                        result = await fn(request, session)
                    else:
                        result = await fn(request)
                except Problem as e:
                    return JSONResponse({"error": str(e)}, status_code=e.status)
                except HTTPException as e:  # e.g. a malformed or oversized form upload
                    return JSONResponse({"error": e.detail or "That request wasn't valid."}, status_code=e.status_code)
                except Exception:
                    log.exception("Unhandled error on %s", request.url.path)
                    return JSONResponse({"error": "Something went wrong on our side. Try again."}, status_code=500)
                return result if isinstance(result, Response) else JSONResponse(result)

            mcp.custom_route(path, methods=methods)(handler)
            return handler

        return wrap

    async def body(request: Request) -> Doc:
        try:
            data = await request.json()
        except Exception as e:
            raise Problem("Send a JSON body.") from e
        if not isinstance(data, dict):
            raise Problem("Send a JSON object.")
        return data

    def tz(request: Request) -> int:
        """Minutes behind UTC, as the browser's Date.getTimezoneOffset() reports it."""
        try:
            return max(-840, min(840, int(request.headers.get("x-tz-offset", "0"))))
        except ValueError:
            return 0

    def sign(path: str) -> str:
        """Links for <img> and CV downloads, which can't send the bearer token."""
        exp = str(int(time.time()) + SIGNED_LINK_TTL)
        sig = hmac.new(signing_key, f"{path}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
        return f"{path}?exp={exp}&sig={sig}"

    def signed_ok(request: Request) -> bool:
        exp, sig = request.query_params.get("exp", "0"), request.query_params.get("sig", "")
        want = hmac.new(signing_key, f"{request.url.path}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
        return exp.isdigit() and int(exp) > time.time() and hmac.compare_digest(sig, want)

    # ---------- Health ----------

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse({"ok": True, "nova": "bedrock" if nova.enabled else "rules"})

    # ---------- Sign-in ----------

    @route("/api/session", ["GET"], recruiter=True)
    async def session_(_: Request, s: Doc) -> Doc:
        return s

    @route("/api/auth/code", ["POST"])
    async def auth_code(request: Request) -> Doc:
        email = str((await body(request)).get("email", ""))
        if email.strip().lower() == DEMO_EMAIL:
            seed.ensure_demo(svc)
        return auth.send_code(email)

    @route("/api/auth/verify", ["POST"])
    async def auth_verify(request: Request) -> Doc:
        data = await body(request)
        if str(data.get("email", "")).strip().lower() == DEMO_EMAIL:
            seed.ensure_demo(svc)
        return auth.verify(str(data.get("email", "")), str(data.get("code", "")))

    @route("/api/auth/signout", ["POST"])
    async def auth_signout(request: Request) -> Doc:
        auth.sign_out(request.headers.get("authorization"))
        return {"ok": True}

    @route("/api/orgs", ["POST"])
    async def create_org(request: Request) -> Doc:
        data = await body(request)
        return auth.create_org(str(data.get("orgName", "")), str(data.get("name", "")), str(data.get("email", "")))

    # ---------- Recruiter ----------

    @route("/api/dashboard", ["GET"], recruiter=True)
    async def dashboard(request: Request, s: Doc) -> Doc:
        if s["email"] == DEMO_EMAIL:
            seed.ensure_demo(svc)
        recruiter = store.get("recruiter", s["email"]) or {}
        if recruiter and recruiter.get("tzOffset") != tz(request):  # remembered for Alexa+, which sends no time zone
            store.put("recruiter", s["email"], {**recruiter, "tzOffset": tz(request)})
        return svc.dashboard(s["orgId"], tz(request))

    @route("/api/jobs", ["POST"], recruiter=True)
    async def create_job(request: Request, s: Doc) -> Doc:
        d = await body(request)
        return {"id": svc.create_job(s["orgId"], str(d.get("title", "")), str(d.get("location", "")), str(d.get("description", "")))}

    @route("/api/jobs/{job_id}", ["GET"], recruiter=True)
    async def job(request: Request, s: Doc) -> Doc:
        return svc.job_view(s["orgId"], request.path_params["job_id"])

    @route("/api/jobs/{job_id}/rounds", ["POST"], recruiter=True)
    async def create_round(request: Request, s: Doc) -> Doc:
        return svc.create_round(s["orgId"], request.path_params["job_id"], await body(request))

    @route("/api/jobs/{job_id}/knowledge", ["GET"], recruiter=True)
    async def knowledge(request: Request, s: Doc) -> Doc:
        return {"enabled": svc.kb.enabled, "documents": svc.knowledge(s["orgId"], request.path_params["job_id"])}

    @route("/api/jobs/{job_id}/knowledge", ["POST"], recruiter=True)
    async def add_knowledge(request: Request, s: Doc) -> Doc:
        async with request.form(max_files=1, max_fields=6, max_part_size=11 * 1024 * 1024) as form:
            kind = str(form.get("kind", ""))
            upload = form.get("file")
            if upload is not None and hasattr(upload, "read"):
                data, name, kind_of = await upload.read(), upload.filename or "document", upload.content_type or ""
            else:
                text = str(form.get("text", "")).strip()
                data, name, kind_of = text.encode(), str(form.get("name", "")).strip() or "Notes", "text/plain"
            return svc.add_knowledge(s["orgId"], request.path_params["job_id"], name, kind, data, kind_of)

    @route("/api/jobs/{job_id}/knowledge/{doc_id}", ["DELETE"], recruiter=True)
    async def remove_knowledge(request: Request, s: Doc) -> Doc:
        svc.remove_knowledge(s["orgId"], request.path_params["job_id"], request.path_params["doc_id"])
        return {"ok": True}

    @route("/api/rounds/{round_id}/slots", ["POST"], recruiter=True)
    async def add_slots(request: Request, s: Doc) -> Doc:
        starts = (await body(request)).get("starts", [])
        if not isinstance(starts, list) or not starts:
            raise Problem("Pick at least one time.")
        return svc.add_slots(s["orgId"], request.path_params["round_id"], [str(x) for x in starts])

    @route("/api/rounds/{round_id}/slots/{slot_id}", ["DELETE"], recruiter=True)
    async def remove_slot(request: Request, s: Doc) -> Doc:
        return svc.remove_slot(s["orgId"], request.path_params["round_id"], request.path_params["slot_id"])

    @route("/api/candidates/{candidate_id}", ["GET"], recruiter=True)
    async def candidate(request: Request, s: Doc) -> Doc:
        view = svc.candidate_view(s["orgId"], request.path_params["candidate_id"])
        for iv in view["interviews"]:
            for snap in iv["snapshots"]:
                snap["url"] = sign(snap["url"])
        c = view["candidate"] = dict(view["candidate"])
        if c.pop("cvKey", None):
            c["cvUrl"] = sign(f"/api/candidates/{c['id']}/cv")
        if c.get("hasPhoto"):
            c["photoUrl"] = sign(f"/api/candidates/{c['id']}/face/reference")
        for iv in view["interviews"]:
            if (iv.get("identity") or {}).get("hasLive"):
                iv["identity"]["liveUrl"] = sign(f"/api/candidates/{c['id']}/face/live")
        return view

    @route("/api/candidates/{candidate_id}/cv", ["GET"])
    async def candidate_cv(request: Request) -> Response:
        if not signed_ok(request):
            raise Problem("This link has expired. Reload the page.", 403)
        c = store.get("candidate", request.path_params["candidate_id"])
        got = blobs.load(c["cvKey"]) if c and c.get("cvKey") else None
        if not got:
            raise Problem("That CV is no longer available.", 404)
        name = urllib.parse.quote(c["cvName"])
        return Response(got[0], media_type=got[1], headers={"Content-Disposition": f"inline; filename*=UTF-8''{name}", "Cache-Control": "private, max-age=600"})

    @route("/api/jobs/{job_id}/candidates", ["POST"], recruiter=True)
    async def add_candidate(request: Request, s: Doc) -> Doc:
        async with request.form(max_files=1, max_fields=8, max_part_size=6 * 1024 * 1024) as form:
            cv, cv_name, cv_type = await upload(form, "cv")
            out = svc.add_candidate(s["orgId"], request.path_params["job_id"], str(form.get("roundId", "")), str(form.get("name", "")),
                                    str(form.get("email", "")), s["name"], cv, cv_name, cv_type)
        return {"id": out["candidate"]["id"], "link": out["link"]}

    @route("/api/candidates/{candidate_id}/signup", ["POST"], recruiter=True)
    async def review_signup(request: Request, s: Doc) -> Doc:
        c = svc.review_signup(s["orgId"], request.path_params["candidate_id"], bool((await body(request)).get("approve")), s["name"])
        return {"ok": True, "status": c["status"]}

    @route("/api/candidates/{candidate_id}/identity/approve", ["POST"], recruiter=True)
    async def approve_identity(request: Request, s: Doc) -> Doc:
        return svc.approve_identity(s["orgId"], request.path_params["candidate_id"], s["name"])

    @route("/api/candidates/{candidate_id}/face/{which}", ["GET"])
    async def face(request: Request) -> Response:
        if not signed_ok(request) or request.path_params["which"] not in ("reference", "live"):
            raise Problem("This link has expired. Reload the page.", 403)
        c = store.get("candidate", request.path_params["candidate_id"])
        if not c:
            raise Problem("That photo doesn't exist.", 404)
        data, kind = svc.face_image(c["orgId"], c["id"], request.path_params["which"])
        return Response(data, media_type=kind, headers={"Cache-Control": "private, no-store"})

    @route("/api/candidates/{candidate_id}/decision", ["POST"], recruiter=True)
    async def decision(request: Request, s: Doc) -> Doc:
        d = await body(request)
        out = svc.decide(s["orgId"], request.path_params["candidate_id"], str(d.get("action", "")), str(d.get("note", "")), s["name"])
        return {"ok": True, "status": out["candidate"]["status"]}

    @route("/api/assistant", ["POST"], recruiter=True)
    async def assistant_(request: Request, s: Doc) -> Doc:
        return assistant.reply(s, str((await body(request)).get("message", "")), tz(request))

    @route("/api/interviews/{interview_id}/snapshots/{n}", ["GET"])
    async def snapshot_image(request: Request) -> Response:
        if not signed_ok(request):
            raise Problem("This link has expired. Reload the page.", 403)
        iv = store.get("interview", request.path_params["interview_id"])
        if not iv or not request.path_params["n"].isdigit():
            raise Problem("That snapshot doesn't exist.", 404)
        data, kind = svc.snapshot(iv["orgId"], iv["id"], int(request.path_params["n"]))
        return Response(data, media_type=kind, headers={"Cache-Control": "private, max-age=3600"})

    # ---------- Candidate (the interview id is the candidate's secret link) ----------

    async def upload(form: Any, name: str) -> tuple[bytes, str, str]:
        f = form.get(name)
        if f is None or not hasattr(f, "read"):
            return b"", "", ""
        return await f.read(), f.filename or name, f.content_type or ""

    @route("/api/invites/{code}", ["GET"])
    async def invite(request: Request) -> Doc:
        return svc.invite(request.path_params["code"], request.query_params.get("t") or None)

    @route("/api/invites/{code}/join", ["POST"])
    async def join(request: Request) -> Doc:
        async with request.form(max_files=2, max_fields=14, max_part_size=6 * 1024 * 1024) as form:
            cv, cv_name, cv_type = await upload(form, "cv")
            photo, _, photo_type = await upload(form, "photo")
            yes = lambda k: str(form.get(k, "")).lower() == "true"  # noqa: E731
            out = svc.join(
                request.path_params["code"], str(form.get("name", "")), str(form.get("email", "")), str(form.get("slotId", "")),
                yes("consent"), cv, cv_name or "cv", cv_type, photo, photo_type, yes("faceConsent"), str(form.get("phone", "")),
                str(form.get("t", "")) or None,
            )
        return {"interviewId": out["interviewId"], "status": out["status"]}

    @route("/api/interviews/{interview_id}/verify", ["POST"])
    async def verify(request: Request) -> Doc:
        async with request.form(max_files=1, max_fields=2, max_part_size=2 * 1024 * 1024) as form:
            image, _, kind = await upload(form, "image")
            return svc.verify_identity(request.path_params["interview_id"], image, kind)

    @route("/api/interviews/{interview_id}", ["GET"])
    async def room(request: Request) -> Doc:
        return svc.room(request.path_params["interview_id"])

    @route("/api/interviews/{interview_id}/start", ["POST"])
    async def start(request: Request) -> Doc:
        return svc.start_interview(request.path_params["interview_id"])

    @route("/api/interviews/{interview_id}/answer", ["POST"])
    async def answer(request: Request) -> Doc:
        return svc.answer(request.path_params["interview_id"], str((await body(request)).get("text", "")))

    @route("/api/interviews/{interview_id}/snapshots", ["POST"])
    async def add_snapshot(request: Request) -> Doc:
        async with request.form(max_files=1, max_fields=2, max_part_size=500_000) as form:
            image = form.get("image")
            if image is None or not hasattr(image, "read"):
                raise Problem("Send an image.")
            svc.add_snapshot(request.path_params["interview_id"], await image.read(), image.content_type or "")
        return {"ok": True}

    @route("/api/speech", ["POST"])
    async def speech(request: Request) -> Response:
        """The interviewer's voice: Amazon Polly (neural), so every candidate hears the same voice."""
        text = str((await body(request)).get("text", "")).strip()[:1500]
        if not text:
            raise Problem("Nothing to say.")
        import boto3

        audio = boto3.client("polly").synthesize_speech(
            Text=text, OutputFormat="mp3", VoiceId=os.environ.get("POLLY_VOICE", "Kajal"), Engine="neural", LanguageCode="en-IN",
        )
        return Response(audio["AudioStream"].read(), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})

    # ---------- OAuth for Alexa+ and other MCP clients ----------

    async def resource_metadata(request: Request) -> Response:
        base = base_url(request.scope)
        return JSONResponse({"resource": f"{base}/mcp", "authorization_servers": [base], "bearer_methods_supported": ["header"],
                             "scopes_supported": ["mcp"], "resource_name": "Intervwd"})

    mcp.custom_route("/.well-known/oauth-protected-resource", methods=["GET"])(resource_metadata)
    mcp.custom_route("/.well-known/oauth-protected-resource/mcp", methods=["GET"])(resource_metadata)

    @mcp.custom_route("/.well-known/oauth-authorization-server", methods=["GET"])
    async def as_metadata(request: Request) -> Response:
        base = base_url(request.scope)
        return JSONResponse({
            "issuer": base, "authorization_endpoint": f"{base}/oauth/authorize", "token_endpoint": f"{base}/oauth/token",
            "registration_endpoint": f"{base}/oauth/register", "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"], "scopes_supported": ["mcp"],
        })

    def oauth_error(e: OAuthError) -> JSONResponse:
        return JSONResponse({"error": e.error, "error_description": e.description}, status_code=e.status)

    @mcp.custom_route("/oauth/register", methods=["POST"])
    async def register(request: Request) -> Response:
        try:
            return JSONResponse(auth.register_client(await request.json()), status_code=201)
        except OAuthError as e:
            return oauth_error(e)
        except Exception:
            return oauth_error(OAuthError("invalid_client_metadata", "Send client metadata as JSON."))

    @mcp.custom_route("/oauth/authorize", methods=["GET"])
    async def authorize(request: Request) -> Response:
        try:
            request_id = auth.start_authorize(dict(request.query_params))
        except OAuthError as e:
            return oauth_error(e)
        return RedirectResponse(f"{base_url(request.scope)}/connect?request={request_id}", status_code=302)

    @mcp.custom_route("/oauth/token", methods=["POST"])
    async def token(request: Request) -> Response:
        form = {k: str(v) for k, v in (await request.form()).items()}
        basic = None
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                cid, _, secret = base64.b64decode(header[6:]).decode().partition(":")
                basic = (urllib.parse.unquote(cid), urllib.parse.unquote(secret))
            except Exception:
                return oauth_error(OAuthError("invalid_client", "Bad basic credentials.", 401))
        try:
            return JSONResponse(auth.token(form, basic), headers={"Cache-Control": "no-store"})
        except OAuthError as e:
            return oauth_error(e)

    @route("/api/oauth/requests/{request_id}", ["GET"], recruiter=True)
    async def oauth_pending(request: Request, _: Doc) -> Doc:
        return auth.pending(request.path_params["request_id"])

    @route("/api/oauth/requests/{request_id}/approve", ["POST"], recruiter=True)
    async def oauth_approve(request: Request, s: Doc) -> Doc:
        return {"redirect": auth.approve(request.path_params["request_id"], s)}

    @route("/api/oauth/requests/{request_id}/deny", ["POST"], recruiter=True)
    async def oauth_deny(request: Request, _: Doc) -> Doc:
        return {"redirect": auth.deny(request.path_params["request_id"])}

    behind_cloudfront = bool(os.environ.get("ORIGIN_SECRET"))
    app = mcp.streamable_http_app(
        stateless_http=True,
        json_response=True,
        # Behind CloudFront the Host header is the Lambda URL's, and the origin secret limits callers.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False)
        if behind_cloudfront
        else TransportSecuritySettings(allowed_hosts=["localhost:*", "127.0.0.1:*", "testserver"], allowed_origins=["http://localhost:*", "http://127.0.0.1:*"]),
    )
    # The last middleware added runs first: CORS, origin secret, then MCP sign-in.
    app.add_middleware(McpAuthMiddleware, auth=auth)
    if behind_cloudfront:
        app.add_middleware(OriginSecretMiddleware, secret=os.environ["ORIGIN_SECRET"])
    app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?", allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                       allow_headers=["*"], expose_headers=["mcp-session-id"])
    app.state.svc = svc
    app.state.auth = auth
    app.state.mcp = mcp
    return app
