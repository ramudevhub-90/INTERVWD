"""Each job's knowledge base: documents the recruiter uploads so the interviewer can go deeper.

Two kinds of document:
  interviewer  question banks, what a strong answer looks like, the team's stack. Shapes questions,
               follow-ups and scoring; never read out or quoted to the candidate.
  shareable    about the company, team, benefits, process. Used to answer the candidate's questions.

Production uses Amazon Bedrock Knowledge Bases with an Amazon S3 Vectors index (BedrockKnowledge),
in the account where Bedrock is available, through a role that only Intervwd's server can assume.
One knowledge base serves every company: each file has a metadata sidecar (orgId, jobId, kind) and
every search filters on all three, so a company only ever retrieves its own job's documents.
Tests and local development use LocalKnowledge (in memory, keyword overlap).
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Protocol

log = logging.getLogger(__name__)
Doc = dict[str, Any]

KINDS = ("interviewer", "shareable")


class Knowledge(Protocol):
    enabled: bool

    def put(self, key: str, data: bytes, content_type: str, meta: Doc) -> None: ...
    def delete(self, key: str) -> None: ...
    def sync(self) -> str | None: ...
    def sync_status(self, job_id: str) -> str: ...
    def search(self, org_id: str, job_id: str, query: str, kinds: tuple[str, ...], k: int = 4) -> list[Doc]: ...


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 3}


class LocalKnowledge:
    """Splits text into paragraphs and ranks them by shared words. Good enough to test the flow."""

    enabled = True

    def __init__(self) -> None:
        self._docs: dict[str, tuple[Doc, list[str]]] = {}
        self._lock = threading.Lock()

    def put(self, key, data, content_type, meta):
        text = data.decode("utf-8", errors="ignore") if not content_type.endswith("pdf") else ""
        chunks = [c.strip() for c in re.split(r"\n\s*\n", text) if len(c.strip()) > 20] or ([text.strip()] if text.strip() else [])
        with self._lock:
            self._docs[key] = (meta, chunks)

    def delete(self, key):
        with self._lock:
            self._docs.pop(key, None)

    def sync(self):
        return "local"

    def sync_status(self, job_id):
        return "COMPLETE"

    def search(self, org_id, job_id, query, kinds, k=4):
        want = _words(query)
        scored = []
        for key, (meta, chunks) in list(self._docs.items()):
            if meta["orgId"] != org_id or meta["jobId"] != job_id or meta["kind"] not in kinds:
                continue
            for c in chunks:
                overlap = len(want & _words(c))
                if overlap:
                    scored.append((overlap, {"text": c[:1500], "source": meta.get("name", key), "kind": meta["kind"], "score": overlap}))
        return [d for _, d in sorted(scored, key=lambda x: -x[0])[:k]]


class BedrockKnowledge:
    """Bedrock Knowledge Base (S3 Vectors) in another account, reached by assuming KB_ROLE_ARN."""

    enabled = True

    def __init__(self, kb_id: str, data_source_id: str, bucket: str, role_arn: str | None, region: str = "us-east-1") -> None:
        self.kb_id, self.data_source_id, self.bucket, self.role_arn, self.region = kb_id, data_source_id, bucket, role_arn, region
        self._session: Any = None
        self._expires = 0.0
        self._lock = threading.Lock()

    def _client(self, service: str) -> Any:
        import boto3

        with self._lock:
            if not self._session or (self.role_arn and time.time() > self._expires - 300):
                if self.role_arn:
                    c = boto3.client("sts").assume_role(RoleArn=self.role_arn, RoleSessionName="intervwd-knowledge")["Credentials"]
                    self._session = boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"])
                    self._expires = c["Expiration"].timestamp()
                else:
                    self._session = boto3.Session()
            return self._session.client(service, region_name=self.region)

    def put(self, key, data, content_type, meta):
        s3 = self._client("s3")
        s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
        attrs = {"orgId": meta["orgId"], "jobId": meta["jobId"], "kind": meta["kind"], "docId": meta["docId"]}
        s3.put_object(Bucket=self.bucket, Key=f"{key}.metadata.json", Body=json.dumps({"metadataAttributes": attrs}).encode(), ContentType="application/json")

    def delete(self, key):
        s3 = self._client("s3")
        s3.delete_objects(Bucket=self.bucket, Delete={"Objects": [{"Key": key}, {"Key": f"{key}.metadata.json"}]})

    def sync(self):
        """Starts an ingestion job; None when one is already running (the next one picks up the rest)."""
        agent = self._client("bedrock-agent")
        try:
            job = agent.start_ingestion_job(knowledgeBaseId=self.kb_id, dataSourceId=self.data_source_id)
            return job["ingestionJob"]["ingestionJobId"]
        except agent.exceptions.ConflictException:
            return None

    def job_status(self, ingestion_job_id: str) -> str:
        agent = self._client("bedrock-agent")
        job = agent.get_ingestion_job(knowledgeBaseId=self.kb_id, dataSourceId=self.data_source_id, ingestionJobId=ingestion_job_id)
        return job["ingestionJob"]["status"]  # STARTING | IN_PROGRESS | COMPLETE | FAILED | STOPPING | STOPPED

    def sync_status(self, job_id):
        return "UNKNOWN"

    def search(self, org_id, job_id, query, kinds, k=4):
        rt = self._client("bedrock-agent-runtime")
        flt = {"andAll": [{"equals": {"key": "orgId", "value": org_id}}, {"equals": {"key": "jobId", "value": job_id}}, {"in": {"key": "kind", "value": list(kinds)}}]}
        try:
            res = rt.retrieve(
                knowledgeBaseId=self.kb_id,
                retrievalQuery={"text": query[:1000]},
                retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": k, "filter": flt}},
            )
        except Exception:
            log.exception("Knowledge search failed; continuing without it")
            return []
        out = []
        for r in res.get("retrievalResults", []):
            meta = r.get("metadata") or {}
            uri = (r.get("location", {}).get("s3Location") or {}).get("uri", "")
            out.append({"text": r["content"]["text"][:1500], "source": uri.rsplit("/", 1)[-1], "kind": meta.get("kind"), "score": r.get("score")})
        return out


class NoKnowledge:
    enabled = False

    def put(self, key, data, content_type, meta):
        raise RuntimeError("No knowledge base configured")

    def delete(self, key):
        pass

    def sync(self):
        return None

    def sync_status(self, job_id):
        return "COMPLETE"

    def search(self, org_id, job_id, query, kinds, k=4):
        return []


def from_env() -> Knowledge:
    kb = os.environ.get("KB_ID")
    if kb:
        return BedrockKnowledge(kb, os.environ["KB_DATA_SOURCE_ID"], os.environ["KB_BUCKET"], os.environ.get("KB_ROLE_ARN") or None, os.environ.get("KB_REGION", "us-east-1"))
    return LocalKnowledge() if os.environ.get("KB_LOCAL", "on") == "on" and not os.environ.get("ORIGIN_SECRET") else NoKnowledge()


def context_block(passages: list[Doc], title: str) -> str:
    """Formats retrieved passages for a prompt. Empty when nothing matched."""
    if not passages:
        return ""
    body = "\n\n".join(f"[{p['source']}] {p['text']}" for p in passages)
    return f"\n\n{title}:\n{body}"
