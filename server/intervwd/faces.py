"""Identity check: is the person on camera the person who applied?

A one-to-one comparison (Amazon Rekognition CompareFaces) between the photo the candidate uploaded
when booking and a live webcam frame. Nothing is searched against a gallery, and Rekognition keeps
no face data for this call. The result goes to a person: a failed check locks the interview until
a recruiter lets the candidate in, and never rejects anyone by itself. No emotion or attribute analysis.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

log = logging.getLogger(__name__)

MATCH_AT = 90.0  # similarity (0-100) that counts as the same person
MAX_ATTEMPTS = 3


@dataclass
class Match:
    status: str  # matched | no_match | no_face | error
    similarity: float | None = None
    detail: str = ""


class FaceMatcher(Protocol):
    def compare(self, reference: bytes, live: bytes) -> Match: ...


class RekognitionMatcher:
    def __init__(self, region: str = "us-east-1", client: Any = None) -> None:
        self.region = region
        self._client = client

    def compare(self, reference: bytes, live: bytes) -> Match:
        import boto3

        self._client = self._client or boto3.client("rekognition", region_name=self.region)
        try:
            res = self._client.compare_faces(SourceImage={"Bytes": reference}, TargetImage={"Bytes": live}, SimilarityThreshold=50, QualityFilter="AUTO")
        except self._client.exceptions.InvalidParameterException:
            # Rekognition raises this when it finds no face in one of the images.
            return Match("no_face", detail="No face found. Face the camera in good light.")
        except Exception:
            log.exception("Face comparison failed")
            return Match("error", detail="The identity check couldn't run. Try again.")
        best = max((m["Similarity"] for m in res.get("FaceMatches", [])), default=None)
        if best is None:
            if not res.get("UnmatchedFaces"):
                return Match("no_face", detail="No face found. Face the camera in good light.")
            return Match("no_match", 0.0, "That doesn't look like the photo you uploaded.")
        best = round(best, 1)
        return Match("matched", best) if best >= MATCH_AT else Match("no_match", best, "That doesn't look like the photo you uploaded.")


class FakeMatcher:
    """For tests and local runs: identical bytes match, anything else doesn't; empty bytes have no face."""

    def compare(self, reference: bytes, live: bytes) -> Match:
        if not live.strip():
            return Match("no_face", detail="No face found. Face the camera in good light.")
        return Match("matched", 99.0) if reference == live else Match("no_match", 12.0, "That doesn't look like the photo you uploaded.")
