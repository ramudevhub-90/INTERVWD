"""Calendar invites (iCalendar, RFC 5545) attached to booking emails.

Gmail, Outlook and Apple Calendar show METHOD:REQUEST invites with Add/Accept buttons, so the
interview lands in the candidate's and the interviewers' calendars without anyone copying times.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _fold(line: str) -> str:
    """Lines longer than 75 octets continue on the next line after a space."""
    out, data = [], line.encode()
    while len(data) > 75:
        cut = 75
        while (data[cut] & 0xC0) == 0x80:  # don't split a UTF-8 character
            cut -= 1
        out.append(data[:cut].decode())
        data = b" " + data[cut:]
    out.append(data.decode())
    return "\r\n".join(out)


def _utc(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)


def invite(uid: str, start_iso: str, minutes: int, summary: str, description: str, location: str,
           organizer: tuple[str, str], attendees: list[tuple[str, str]], sequence: int = 0, cancel: bool = False) -> str:
    start = _utc(start_iso)
    end = start + timedelta(minutes=minutes)
    fmt = "%Y%m%dT%H%M%SZ"
    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//Intervwd//Interviews//EN",
        "VERSION:2.0",
        f"METHOD:{'CANCEL' if cancel else 'REQUEST'}",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"SEQUENCE:{sequence}",
        f"DTSTAMP:{datetime.now(timezone.utc).strftime(fmt)}",
        f"DTSTART:{start.strftime(fmt)}",
        f"DTEND:{end.strftime(fmt)}",
        f"SUMMARY:{_esc(summary)}",
        f"DESCRIPTION:{_esc(description)}",
        f"LOCATION:{_esc(location)}",
        f"URL:{location}" if location.startswith("http") else "",
        f"ORGANIZER;CN={_esc(organizer[0])}:mailto:{organizer[1]}",
        *[f"ATTENDEE;CN={_esc(name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{email}" for name, email in attendees if email],
        f"STATUS:{'CANCELLED' if cancel else 'CONFIRMED'}",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:Interview in 15 minutes",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(_fold(line) for line in lines if line) + "\r\n"


def google_link(start_iso: str, minutes: int, title: str, details: str, location: str) -> str:
    """An "Add to Google Calendar" link, for clients that don't show attached invites."""
    from urllib.parse import urlencode

    start = _utc(start_iso)
    end = start + timedelta(minutes=minutes)
    fmt = "%Y%m%dT%H%M%SZ"
    return "https://calendar.google.com/calendar/render?" + urlencode(
        {"action": "TEMPLATE", "text": title, "dates": f"{start.strftime(fmt)}/{end.strftime(fmt)}", "details": details, "location": location})
