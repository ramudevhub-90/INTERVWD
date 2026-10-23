"""Sign-in for recruiters, and the OAuth 2.1 server Alexa+ uses to link a recruiter's account.

Recruiters sign in with a 6-digit code sent to their work email. A verified code gives a session
token (random, stored only as a SHA-256 hash, 30 days). The demo account (demo@intervwd.com) also
accepts the fixed DEMO_CODE so judges can sign in without a mailbox.

Alexa+ (or any MCP client) links an account with the authorization-code flow and PKCE:
  /oauth/register   dynamic client registration (RFC 7591)
  /oauth/authorize  checks the client, then sends the browser to /connect on the web app, where the
                    signed-in recruiter approves; the web app calls /api/oauth/requests/<id>/approve
  /oauth/token      code + PKCE verifier → access token (1 hour) and refresh token (60 days)
MCP access tokens are sessions too, marked with the client they were issued to.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import hmac
import logging
import os
import secrets
import time
import urllib.parse
from typing import Any

from .service import Problem, new_id
from .store import Store

log = logging.getLogger(__name__)
Doc = dict[str, Any]

DEMO_EMAIL = "demo@intervwd.com"
CODE_TTL = 10 * 60
CODE_ATTEMPTS = 5
DEMO_MAX_FAILS = 30
DEMO_FAIL_WINDOW = 15 * 60
SESSION_TTL = 30 * 24 * 3600
ACCESS_TTL = 3600
REFRESH_TTL = 60 * 24 * 3600

current_session: contextvars.ContextVar[Doc | None] = contextvars.ContextVar("current_session", default=None)


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def normal_email(email: str) -> str:
    return email.strip().lower()


class Mailer:
    """Sends email with Amazon SES. Logs instead when MAIL_FROM isn't set (local development).

    With SES_ROLE_ARN, mail goes out through SES in another account (one out of the SES sandbox),
    by assuming a send-only role there, the same way Pantry Pilot sends its email."""

    def __init__(self, sender: str | None = None, client: Any = None, role_arn: str | None = None) -> None:
        self.sender = sender if sender is not None else os.environ.get("MAIL_FROM", "")
        self.role_arn = role_arn if role_arn is not None else os.environ.get("SES_ROLE_ARN") or None
        self._client = client
        self._expires = 0.0

    def _ses(self) -> Any:
        import boto3

        if self._client and (not self.role_arn or time.time() < self._expires - 300):
            return self._client
        if self.role_arn:
            creds = boto3.client("sts").assume_role(RoleArn=self.role_arn, RoleSessionName="intervwd-mail")["Credentials"]
            self._expires = creds["Expiration"].timestamp()
            self._client = boto3.client("sesv2", region_name=os.environ.get("SES_REGION", "us-east-1"), aws_access_key_id=creds["AccessKeyId"],
                                        aws_secret_access_key=creds["SecretAccessKey"], aws_session_token=creds["SessionToken"])
        else:
            self._client = boto3.client("sesv2")
        return self._client

    def send(self, to: str, subject: str, text: str, invite: str | None = None) -> bool:
        """`invite` is an iCalendar REQUEST; mail clients show it as a calendar invite."""
        if not self.sender:
            log.info("Email to %s: %s\n%s%s", to, subject, text, "\n[calendar invite attached]" if invite else "")
            return True
        try:
            if invite:
                self._ses().send_email(FromEmailAddress=self.sender, Destination={"ToAddresses": [to]},
                                       Content={"Raw": {"Data": _with_invite(self.sender, to, subject, text, invite)}})
            else:
                self._ses().send_email(
                    FromEmailAddress=self.sender,
                    Destination={"ToAddresses": [to]},
                    Content={"Simple": {"Subject": {"Data": subject}, "Body": {"Text": {"Data": text}}}},
                )
            return True
        except Exception:
            log.exception("Couldn't email %s", to)
            return False


def _with_invite(sender: str, to: str, subject: str, text: str, invite: str) -> bytes:
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    msg = MIMEMultipart("mixed")
    msg["Subject"], msg["From"], msg["To"] = subject, sender, to
    body = MIMEMultipart("alternative")
    body.attach(MIMEText(text, "plain", "utf-8"))
    body.attach(MIMEText(invite, "calendar;method=REQUEST", "utf-8"))  # shown inline as an invite
    msg.attach(body)
    part = MIMEText(invite, "calendar", "utf-8")
    part.set_param("method", "REQUEST")
    part.add_header("Content-Disposition", "attachment", filename="invite.ics")
    msg.attach(part)
    return msg.as_bytes()


class Auth:
    def __init__(self, store: Store, mailer: Mailer, demo_code: str | None = None, slugs: Any = None) -> None:
        self.store = store
        self.slugs = slugs  # Service.claim_slug: gives each company a unique name for its links
        self.mailer = mailer
        self.demo_code = demo_code if demo_code is not None else os.environ.get("DEMO_CODE") or None

    # ---------- Email codes ----------

    def _send_code(self, email: str, purpose: str) -> Doc:
        if email == DEMO_EMAIL and self.demo_code:
            return {"hint": "Demo account: use the code from the submission's testing instructions."}
        code = f"{secrets.randbelow(1_000_000):06d}"
        self.store.put("code", email, {"hash": _h(code), "attempts": 0}, expires=int(time.time()) + CODE_TTL)
        sent = self.mailer.send(email, f"{code} is your Intervwd code",
                                f"Your Intervwd sign-in code is {code}.\n\nIt works for 10 minutes. If you didn't ask to {purpose}, ignore this email.")
        if not sent:
            raise Problem("We couldn't email that address just now. Try again in a minute, or use the demo account.", 502)
        return {}

    def create_org(self, org_name: str, name: str, email: str) -> Doc:
        email = normal_email(email)
        if len(org_name.strip()) < 2 or len(name.strip()) < 2 or "@" not in email:
            raise Problem("Enter your company name, your name and your work email.")
        existing = self.store.get("recruiter", email)
        if existing and existing.get("verified"):
            raise Problem("That email already has a company account. Sign in instead.", 409)
        # Unverified sign-ups can be replaced, so nobody can squat someone else's email.
        org = {"id": new_id("org"), "name": org_name.strip()[:120], "createdAt": _iso()}
        if self.slugs:
            org["slug"] = self.slugs(org["id"], org["name"])
        self.store.put("org", org["id"], org)
        self.store.put("recruiter", email, {"email": email, "name": name.strip()[:120], "orgId": org["id"], "verified": False})
        return self._send_code(email, "set up a company on Intervwd")

    def send_code(self, email: str) -> Doc:
        email = normal_email(email)
        if not self.store.get("recruiter", email):
            raise Problem("No company account uses that email. Set up your company first.", 404)
        return self._send_code(email, "sign in to Intervwd")

    def verify(self, email: str, code: str) -> Doc:
        email = normal_email(email)
        code = code.strip()
        recruiter = self.store.get("recruiter", email)
        ok = False
        if recruiter and email == DEMO_EMAIL and self.demo_code:
            # The demo code is shared and fixed, so wrong guesses are capped for everyone at once.
            fails = self.store.get("demo-fails", "window") or {"n": 0}
            if fails["n"] >= DEMO_MAX_FAILS:
                raise Problem("Too many wrong codes for the demo account. Try again in 15 minutes.", 429)
            ok = hmac.compare_digest(code, self.demo_code)
            if not ok:
                self.store.put("demo-fails", "window", {"n": fails["n"] + 1}, expires=int(time.time()) + DEMO_FAIL_WINDOW)
        elif recruiter:
            saved = self.store.get("code", email)
            if saved and saved["attempts"] < CODE_ATTEMPTS:
                ok = hmac.compare_digest(saved["hash"], _h(code))
                if ok:
                    self.store.delete("code", email)
                else:
                    saved["attempts"] += 1
                    self.store.put("code", email, saved, expires=int(time.time()) + CODE_TTL)
        if not ok:
            raise Problem("That code isn't right. Check it and try again.", 401)
        if not recruiter.get("verified"):
            recruiter["verified"] = True
            self.store.put("recruiter", email, recruiter)
        return self.new_session(recruiter)

    # ---------- Sessions ----------

    def session_doc(self, recruiter: Doc, client_id: str | None = None) -> Doc:
        org = self.store.get("org", recruiter["orgId"]) or {}
        return {"userId": f"u_{_h(recruiter['email'])[:16]}", "email": recruiter["email"], "name": recruiter["name"], "role": "recruiter",
                "orgId": recruiter["orgId"], "orgName": org.get("name", ""), **({"clientId": client_id} if client_id else {})}

    def new_session(self, recruiter: Doc) -> Doc:
        token = secrets.token_urlsafe(32)
        session = self.session_doc(recruiter)
        self.store.put("session", _h(token), session, expires=int(time.time()) + SESSION_TTL)
        return {"token": token, "session": {k: v for k, v in session.items() if k != "clientId"}}

    def authenticate(self, header: str | None) -> Doc | None:
        if not header or not header.lower().startswith("bearer "):
            return None
        token = header[7:].strip()
        return self.store.get("session", _h(token)) if token else None

    def sign_out(self, header: str | None) -> None:
        if header and header.lower().startswith("bearer "):
            self.store.delete("session", _h(header[7:].strip()))

    # ---------- OAuth for MCP clients ----------

    def register_client(self, body: Doc) -> Doc:
        uris = [u for u in body.get("redirect_uris", []) if isinstance(u, str)]
        if not uris or not all(_allowed_redirect(u) for u in uris):
            raise OAuthError("invalid_redirect_uri", "Redirect URIs must be https (or localhost for development).")
        client_id = new_id("client")
        confidential = body.get("token_endpoint_auth_method") in ("client_secret_post", "client_secret_basic")
        secret = secrets.token_urlsafe(32) if confidential else None
        doc = {"clientId": client_id, "name": str(body.get("client_name", "MCP client"))[:100], "redirectUris": uris,
               "secretHash": _h(secret) if secret else None, "createdAt": _iso()}
        self.store.put("client", client_id, doc)
        out = {"client_id": client_id, "client_name": doc["name"], "redirect_uris": uris, "grant_types": ["authorization_code", "refresh_token"],
               "response_types": ["code"], "token_endpoint_auth_method": body.get("token_endpoint_auth_method", "none"), "client_id_issued_at": int(time.time())}
        if secret:
            out["client_secret"] = secret
        return out

    def start_authorize(self, params: dict[str, str]) -> str:
        """Checks an /oauth/authorize request and returns the id the consent page approves."""
        client = self.store.get("client", params.get("client_id", ""))
        redirect = params.get("redirect_uri", "")
        if not client or redirect not in client["redirectUris"]:
            raise OAuthError("invalid_client", "Unknown client or redirect URI.")
        if params.get("response_type") != "code" or params.get("code_challenge_method", "S256") != "S256" or not params.get("code_challenge"):
            raise OAuthError("invalid_request", "Use response_type=code with a PKCE S256 code_challenge.")
        request_id = secrets.token_urlsafe(16)
        self.store.put("oauth-request", request_id, {"clientId": client["clientId"], "clientName": client["name"], "redirectUri": redirect,
                                                     "state": params.get("state", ""), "challenge": params["code_challenge"]}, expires=int(time.time()) + 900)
        return request_id

    def pending(self, request_id: str) -> Doc:
        req = self.store.get("oauth-request", request_id)
        if not req:
            raise Problem("This connection request has expired. Start again from Alexa.", 404)
        return {"clientName": req["clientName"]}

    def approve(self, request_id: str, session: Doc) -> str:
        req = self.store.get("oauth-request", request_id)
        if not req:
            raise Problem("This connection request has expired. Start again from Alexa.", 404)
        self.store.delete("oauth-request", request_id)
        code = secrets.token_urlsafe(24)
        self.store.put("oauth-code", _h(code), {"clientId": req["clientId"], "redirectUri": req["redirectUri"], "challenge": req["challenge"],
                                                "email": session["email"]}, expires=int(time.time()) + 300)
        return _with_query(req["redirectUri"], code=code, state=req["state"])

    def deny(self, request_id: str) -> str:
        req = self.store.get("oauth-request", request_id)
        if not req:
            raise Problem("This connection request has expired.", 404)
        self.store.delete("oauth-request", request_id)
        return _with_query(req["redirectUri"], error="access_denied", state=req["state"])

    def _check_client(self, client_id: str, secret: str | None) -> Doc:
        client = self.store.get("client", client_id)
        if not client:
            raise OAuthError("invalid_client", "Unknown client.", 401)
        if client.get("secretHash") and not (secret and hmac.compare_digest(client["secretHash"], _h(secret))):
            raise OAuthError("invalid_client", "Wrong client secret.", 401)
        return client

    def _tokens(self, email: str, client_id: str) -> Doc:
        recruiter = self.store.get("recruiter", email)
        if not recruiter:
            raise OAuthError("invalid_grant", "That account no longer exists.")
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.store.put("session", _h(access), self.session_doc(recruiter, client_id), expires=int(time.time()) + ACCESS_TTL)
        self.store.put("refresh", _h(refresh), {"email": email, "clientId": client_id}, expires=int(time.time()) + REFRESH_TTL)
        return {"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_TTL, "refresh_token": refresh, "scope": "mcp"}

    def token(self, form: dict[str, str], basic: tuple[str, str] | None) -> Doc:
        client_id, secret = basic if basic else (form.get("client_id", ""), form.get("client_secret"))
        self._check_client(client_id, secret)
        grant = form.get("grant_type")
        if grant == "authorization_code":
            saved = self.store.get("oauth-code", _h(form.get("code", "")))
            if not saved or saved["clientId"] != client_id or saved["redirectUri"] != form.get("redirect_uri"):
                raise OAuthError("invalid_grant", "The code is invalid or expired.")
            verifier = form.get("code_verifier", "")
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if not hmac.compare_digest(challenge, saved["challenge"]):
                raise OAuthError("invalid_grant", "PKCE verification failed.")
            self.store.delete("oauth-code", _h(form["code"]))
            return self._tokens(saved["email"], client_id)
        if grant == "refresh_token":
            saved = self.store.get("refresh", _h(form.get("refresh_token", "")))
            if not saved or saved["clientId"] != client_id:
                raise OAuthError("invalid_grant", "The refresh token is invalid or expired.")
            self.store.delete("refresh", _h(form["refresh_token"]))
            return self._tokens(saved["email"], client_id)
        raise OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.")


class OAuthError(Exception):
    def __init__(self, error: str, description: str, status: int = 400) -> None:
        super().__init__(description)
        self.error, self.description, self.status = error, description, status


def _allowed_redirect(uri: str) -> bool:
    p = urllib.parse.urlparse(uri)
    return p.scheme == "https" and bool(p.netloc) or (p.scheme == "http" and p.hostname in ("localhost", "127.0.0.1"))


def _with_query(uri: str, **params: str) -> str:
    sep = "&" if "?" in uri else "?"
    return uri + sep + urllib.parse.urlencode({k: v for k, v in params.items() if v})


def _iso() -> str:
    from .engine import now

    return now()
