"""Amazon Nova 2 Lite on Bedrock: reads CVs, words questions, writes follow-ups and scores answers.

Every call asks for JSON through a forced tool call, so replies always match a schema. When Nova is
off (NOVA_MODE=mock, tests) or a call fails, callers get None and fall back to rules: an interview
must never stall because the model is slow or throttled.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

log = logging.getLogger(__name__)


class Nova:
    """Interface; MockNova and BedrockNova implement it."""

    enabled = False

    def json(self, system: str, prompt: str, schema: dict[str, Any], document: tuple[bytes, str] | None = None, max_tokens: int = 1200) -> dict[str, Any] | None:
        return None

    def chat(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], max_tokens: int = 600) -> dict[str, Any] | None:
        """One Converse turn with tools; returns the assistant message, or None when Nova is off."""
        return None


class MockNova(Nova):
    pass


_FORMATS = {"application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/html": "html",
            "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"}


class BedrockNova(Nova):
    enabled = True

    def __init__(self, model_id: str, role_arn: str | None = None, region: str = "us-east-1") -> None:
        self.model_id = model_id
        self.role_arn = role_arn
        self.region = region
        self._client: Any = None
        self._expires = 0.0
        self._lock = threading.Lock()

    def _runtime(self) -> Any:
        import boto3

        with self._lock:
            if self._client and (not self.role_arn or time.time() < self._expires - 300):
                return self._client
            if self.role_arn:
                creds = boto3.client("sts").assume_role(RoleArn=self.role_arn, RoleSessionName="intervwd-nova")["Credentials"]
                session = boto3.Session(aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"], aws_session_token=creds["SessionToken"])
                self._expires = creds["Expiration"].timestamp()
            else:
                session = boto3.Session()
            from botocore.config import Config

            self._client = session.client("bedrock-runtime", region_name=self.region, config=Config(read_timeout=25, retries={"max_attempts": 2, "mode": "standard"}))
            return self._client

    def json(self, system, prompt, schema, document=None, max_tokens=1200):
        content: list[dict[str, Any]] = []
        if document:
            data, content_type = document
            fmt = _FORMATS.get(content_type.split(";")[0].strip(), "txt")
            content.append({"document": {"format": fmt, "name": "cv", "source": {"bytes": data}}})
        content.append({"text": prompt})
        try:
            res = self._runtime().converse(
                modelId=self.model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": max_tokens, "temperature": 0.3},
                toolConfig={
                    "tools": [{"toolSpec": {"name": "answer", "description": "Return the result.", "inputSchema": {"json": schema}}}],
                    "toolChoice": {"tool": {"name": "answer"}},
                },
            )
            blocks = res["output"]["message"]["content"]
            for block in blocks:
                if "toolUse" in block:
                    return block["toolUse"]["input"]
            # Sometimes the model writes the JSON as text instead of calling the tool.
            text = " ".join(b.get("text", "") for b in blocks)
            found = _json_in(text)
            if found is not None:
                return found
            log.warning("Nova returned no tool call (stop: %s): %s", res.get("stopReason"), text[:300])
        except Exception:
            log.exception("Nova call failed; falling back to rules")
        return None


    def chat(self, system, messages, tools, max_tokens=600):
        try:
            res = self._runtime().converse(
                modelId=self.model_id,
                system=[{"text": system}],
                messages=messages,
                inferenceConfig={"maxTokens": max_tokens, "temperature": 0.2},
                toolConfig={"tools": [{"toolSpec": t} for t in tools]},
            )
            return res["output"]["message"]
        except Exception:
            log.exception("Nova chat failed; falling back to rules")
            return None


def _json_in(text: str) -> dict[str, Any] | None:
    import json

    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def from_env() -> Nova:
    if os.environ.get("NOVA_MODE", "mock") != "bedrock":
        return MockNova()
    return BedrockNova(os.environ.get("NOVA_MODEL", "global.amazon.nova-2-lite-v1:0"), os.environ.get("NOVA_ROLE_ARN") or None)
