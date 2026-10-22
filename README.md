# Intervwd

**AI voice interviews for every hiring round, with the recruiter's pipeline on Alexa+.**

A company sets up a job and its interview rounds (what to assess, the core questions, time slots) and shares one invite link. Candidates sign up, upload a CV and book a slot. At the slot, an AI interviewer talks with them by voice: the same core questions for everyone, worded for their CV, with a follow-up after every answer. Each interview ends with a report that scores every criterion from 1 to 5 with quoted evidence. **The recruiter makes every decision**, on the web or hands-free on Alexa+: "Alexa, how did today's interviews go?", "Compare the top two", "Move Rahul to Round 2" (Alexa reads it back and waits for a yes).

- Live app: https://intervwd.com
- MCP endpoint for Alexa+: `https://intervwd.com/mcp` (Streamable HTTP, MCP spec 2025-11-25, OAuth 2.1 with PKCE and dynamic client registration)
- Demo recruiter: `demo@intervwd.com` (sign-in code in the submission's testing instructions)

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/), Alexa+ track.

## What it does

| Who | Where | What happens |
| --- | --- | --- |
| Recruiter | Web | Sign in with an emailed 6-digit code. Create jobs and rounds from templates (screen, technical, situational), edit the rubric and questions, add slots, copy the invite link. |
| Candidate | Invite link | Name, email, CV (PDF, Word or text), slot, and explicit consent to recording and snapshots. Gets an email with a personal interview link. |
| Candidate | Interview room | Camera preview, then a spoken interview (Amazon Polly voice). Answers are captioned live; typing works too. Repeat a question any time. A few camera snapshots go to the recruiter. |
| Amazon Nova | Server | Reads the CV, words each core question for the candidate (same intent for everyone), writes one follow-up per answer, and scores the transcript against the rubric with evidence. |
| Recruiter | Web or Alexa+ | Dashboard of today's interviews and who is waiting for a decision; per-candidate report with scores, evidence, transcript, snapshots and the CV; move on, hold or don't progress. Moving on emails the next round's booking link. |

### Fair by design

- Every candidate in a round gets the same core questions and the same rubric.
- The scoring prompt judges only what the candidate said, ignores accent and grammar, and never considers protected characteristics.
- The AI never recommends or makes a decision. Changes on Alexa+ need a spoken yes.
- Snapshots are for a person to check who took the interview. **There's no face recognition or emotion analysis.**
- CVs and snapshots are private (S3, encrypted) and deleted after 90 days.

## MCP tools (what Alexa+ calls)

| Tool | Purpose |
| --- | --- |
| `get_todays_interviews` | Finished interviews today (best score first) and those still to come |
| `list_awaiting_decision` | Candidates whose interview is done and who need a decision |
| `get_candidate_report` | Overall and per-criterion scores with evidence, and areas to probe |
| `compare_candidates` | Side-by-side comparison; defaults to the top two waiting |
| `list_jobs` | Open roles with candidate counts and rounds |
| `get_invite_link` | The booking link for a job's round, with open slots |
| `add_interview_slots` | Add bookable times to a round |
| `advance_candidate` / `hold_candidate` / `reject_candidate` | Change a candidate's status: `confirm=false` reads back, `confirm=true` after the recruiter says yes |

Every tool returns a `say` sentence written to be read aloud. The web app's **Alexa+ page** simulates the same experience: Nova calls these same tools (rules take over if Nova is unavailable), with push-to-talk and spoken replies.

## Architecture

```
Recruiter on Alexa+ ──MCP (Streamable HTTP, OAuth 2.1 + PKCE)──┐
Recruiter web app ─┐                                           ▼
Candidate web app ─┴─/api──► CloudFront ──► Lambda (Python 3.13, Starlette + MCP SDK, Lambda Web Adapter)
   React + Vite on S3                          ├─► DynamoDB: one table (orgs, jobs, rounds, candidates, interviews, sessions)
                                               ├─► S3: CVs and snapshots (private, 90-day expiry)
                                               ├─► Amazon Bedrock: Nova 2 Lite (CV reading, questions, follow-ups, scoring, assistant)
                                               ├─► Amazon Polly: the interviewer's voice
                                               └─► Amazon SES: sign-in codes, interview links, next-round invites
```

- `server/intervwd/`: `app.py` (HTTP routes, OAuth endpoints, MCP mount), `service.py` (domain logic), `engine.py` (interview flow and scoring), `nova.py` (Bedrock client with JSON tool output), `tools.py` and `mcp_server.py` (recruiter tools), `assistant.py` (web Alexa+ agent), `auth.py` (email codes, sessions, OAuth server), `store.py` (DynamoDB/S3 and in-memory versions), `seed.py` (demo company).
- `web/src/`: the React app. `api/http.ts` talks to the server; `api/mock.ts` is an in-browser sample backend for offline development.
- `infra/`: the AWS CDK stack (TypeScript). `.github/workflows/deploy.yml` tests and deploys on every push to `main` using GitHub OIDC (no stored AWS keys).

The server owns the interview flow; Nova only fills in words and scores. Every Nova step has a rule-based fallback, so a slow or throttled model never stalls a live interview.

## Run it locally

Requirements: Python 3.12+, Node.js 22+.

```bash
# Server: in-memory storage; Nova is off unless NOVA_MODE=bedrock and AWS credentials are set
cd server
python -m venv .venv && .venv/bin/pip install -e . pytest httpx
.venv/bin/pytest -q
DEMO_CODE=123456 .venv/bin/uvicorn --factory intervwd.app:create_app --port 8080
```

```bash
# Web app: proxies /api and /mcp to :8080
cd web
npm ci
VITE_API_MODE=http npm run dev
```

Open http://localhost:5173 and sign in as `demo@intervwd.com` with code `123456`. Without `MAIL_FROM`, other sign-in codes and emails are printed in the server log. `VITE_API_MODE=mock npm run dev` runs the web app on in-browser sample data with no server.

To try the MCP server, connect an MCP client (for example the MCP Inspector) to `http://localhost:8080/mcp`. It registers itself, opens `/connect` for you to approve, then lists the tools.

## Deploy

```bash
cd infra
npm ci
npm run deploy -- -c domain=intervwd.com     # add -c novaRole=<role ARN> to call Nova through another account
```

`domain` needs a Route 53 hosted zone in the account; the stack creates the certificate, CloudFront, DNS records and the SES identity. Pushes to `main` deploy through GitHub Actions (the workflow header lists the two repository secrets).

## License

MIT
