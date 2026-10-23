"""HTML versions of Intervwd's emails, built from their plain text.

Every email is written once, as plain text (which is still sent, for clients that want it). This
turns it into a branded, phone-friendly HTML email: the greeting, short paragraphs, links as
buttons, the company in the header, and sign-in codes in a big box. Inline styles and tables only,
because that is what email clients render reliably.
"""

from __future__ import annotations

import html
import re

URL = re.compile(r"https?://[^\s)]+")
CODE = re.compile(r"\b(\d{6})\b")

INK, MUTED, BRAND, LINE, BG = "#1b1f33", "#5b6380", "#5b6cff", "#e6e8f2", "#f4f5fa"


def _label(url: str) -> str:
    """What a link does, for its button."""
    if "/practice/" in url:
        return "Practise first"
    if "/app/call/" in url:
        return "Join the call"
    if "/app/candidates/" in url:
        return "Open profile and scorecard"
    if "/interview/" in url:
        return "Join your interview"
    if "?t=" in url or re.search(r"intervwd\.com/[\w-]+/[\w-]+", url):
        return "Finish your profile"
    if any(k in url for k in ("zoom.", "meet.google", "teams.microsoft", "chime.aws")):
        return "Join the video call"
    return "Open link"


def _button(url: str, label: str, primary: bool) -> str:
    style = (f"background:{BRAND};color:#ffffff;border:1px solid {BRAND};" if primary
             else f"background:#ffffff;color:{BRAND};border:1px solid {LINE};")
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="border-radius:10px;{style}">'
            f'<a href="{html.escape(url)}" style="display:inline-block;padding:12px 22px;font-weight:600;font-size:15px;text-decoration:none;'
            f'color:{"#ffffff" if primary else BRAND}">{html.escape(label)}</a></td></tr></table>')


def _text(s: str) -> str:
    s = html.escape(s.strip())
    s = re.sub(r"^(Address|Join the call|When|Where):", r"<b>\1:</b>", s, flags=re.M)
    return s.replace("\n", "<br>")


def render(subject: str, text: str) -> str:
    parts = [p for p in text.strip().split("\n\n") if p.strip()]
    org = "Intervwd"
    footer = ""
    if parts and parts[-1].strip().startswith("Intervwd"):
        footer = parts.pop().strip()
        if m := re.search(r"on behalf of (.+)$", footer):
            org = m.group(1).strip()
    body: list[str] = []
    buttons = 0
    code = CODE.search(subject) if "code" in subject.lower() else None
    for p in parts:
        if code and code.group(1) in p:
            body.append(f'<p style="margin:0 0 10px;color:{MUTED};font-size:15px">Your sign-in code</p>'
                        f'<div style="font-size:34px;letter-spacing:10px;font-weight:700;color:{INK};background:{BG};border-radius:12px;'
                        f'padding:16px 0;text-align:center;margin:0 0 18px">{code.group(1)}</div>')
            continue
        urls = URL.findall(p)
        words = URL.sub("", p).strip().rstrip(":").strip()
        if p.startswith("Hi ") and not urls:
            body.append(f'<p style="margin:0 0 16px;font-size:17px;font-weight:600;color:{INK}">{_text(p)}</p>')
            continue
        if words:
            body.append(f'<p style="margin:0 0 {10 if urls else 16}px;font-size:15px;line-height:1.6;color:{INK}">{_text(words)}</p>')
        for u in urls:
            body.append(_button(u, _label(u), primary=buttons == 0))
            buttons += 1
    foot = html.escape(footer or "Intervwd")
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(subject)}</title></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG};padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 6px 14px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:{BRAND};color:#fff;font-weight:700;font-size:12px;border-radius:7px;width:28px;height:28px;text-align:center">IV</td>
    <td style="padding-left:10px;font-weight:600;font-size:16px;color:{INK}">{html.escape(org)}</td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid {LINE};border-radius:16px;padding:28px 26px">{"".join(body)}</td></tr>
<tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.5;color:{MUTED}">{foot}<br>
AI interviews where a person makes every decision.</td></tr>
</table></td></tr></table></body></html>"""
