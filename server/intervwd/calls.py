"""Video calls for person-run rounds, hosted by Intervwd on the Amazon Chime SDK.

Each interview gets its own meeting, created when the first person joins and recreated if Chime has
ended it (meetings end a few minutes after everyone leaves). Each person joins with their own
attendee token. Nothing is recorded. Cost: about $0.0017 per attendee-minute.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Protocol

log = logging.getLogger(__name__)
Doc = dict[str, Any]


class Calls(Protocol):
    enabled: bool

    def join(self, meeting_id: str | None, external_id: str, user_id: str) -> tuple[Doc, Doc]: ...


class ChimeCalls:
    enabled = True

    def __init__(self, region: str = "us-east-1", client: Any = None) -> None:
        self.region = region
        self._client = client

    def _chime(self) -> Any:
        import boto3

        self._client = self._client or boto3.client("chime-sdk-meetings", region_name=self.region)
        return self._client

    def join(self, meeting_id, external_id, user_id):
        """Returns (meeting, attendee) for the browser SDK. Reuses the interview's meeting while it lasts."""
        chime = self._chime()
        meeting = None
        if meeting_id:
            try:
                meeting = chime.get_meeting(MeetingId=meeting_id)["Meeting"]
            except chime.exceptions.NotFoundException:
                meeting = None
        if not meeting:
            meeting = chime.create_meeting(ClientRequestToken=f"{external_id}-{os.urandom(4).hex()}", MediaRegion=self.region,
                                           ExternalMeetingId=external_id[:64])["Meeting"]
        attendee = chime.create_attendee(MeetingId=meeting["MeetingId"], ExternalUserId=user_id[:64])["Attendee"]
        return meeting, attendee


class FakeCalls:
    """Tests and local runs: shapes like Chime's, no network."""

    enabled = True

    def __init__(self) -> None:
        self.meetings: set[str] = set()

    def join(self, meeting_id, external_id, user_id):
        mid = meeting_id if meeting_id in self.meetings else f"mtg-{len(self.meetings) + 1}"
        self.meetings.add(mid)
        meeting = {"MeetingId": mid, "ExternalMeetingId": external_id, "MediaRegion": "us-east-1", "MediaPlacement": {"AudioHostUrl": "local"}}
        return meeting, {"AttendeeId": f"att-{user_id}", "ExternalUserId": user_id, "JoinToken": "local-token"}


def from_env() -> Calls:
    return ChimeCalls(os.environ.get("AWS_REGION", "us-east-1")) if os.environ.get("ORIGIN_SECRET") else FakeCalls()
