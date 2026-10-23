# Intervwd: friction log

Notes from building Intervwd for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track). Each entry lists the task, the steps, expected vs. actual result, severity, the workaround we used and a suggestion.

| # | Area | Severity |
|---|---|---|
| 1 | Amazon Chime SDK on iPhone Safari | High |
| 2 | Lambda function URLs rename `WWW-Authenticate` | High |
| 3 | CloudFront Functions don't run on 4xx responses | Medium |
| 4 | AWS CLI default region changed after `aws login` | Medium |
| 5 | Amazon Nova structured output for lists | Medium |

## 1. Amazon Chime SDK on iPhone Safari

- **Task:** Let a recruiter join a candidate's AI interview live on a phone.
- **Steps:** The candidate's interview page already had a camera stream from `getUserMedia`; joined a Chime meeting and called `startVideoInput(deviceId)`.
- **Expected:** The candidate's video is shared into the meeting.
- **Actual:** Video input failed silently on iOS, because a page can capture the camera only once.
- **Severity:** High
- **Workaround:** Pass the existing `MediaStream` to the SDK instead of a device ID.
- **Suggestion:** Call this out in the Chime SDK docs for mobile web, with an example.

## 2. Lambda function URLs rename `WWW-Authenticate`

- **Task:** OAuth discovery for the MCP server (an MCP client reads the `WWW-Authenticate` header on a 401).
- **Steps:** Returned a 401 with `WWW-Authenticate` from Lambda behind a function URL.
- **Expected:** The header reaches the client.
- **Actual:** The header arrives as `x-amzn-remapped-www-authenticate`, which breaks MCP and OAuth discovery.
- **Severity:** High
- **Workaround:** Rely on the well-known metadata endpoints (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`).
- **Suggestion:** Pass `WWW-Authenticate` through unchanged, or document the remapping prominently with the MCP use case.

## 3. CloudFront Functions don't run on 4xx responses

- **Task:** Restore the `WWW-Authenticate` header at the edge.
- **Steps:** Tried a CloudFront Function on the viewer response.
- **Expected:** Rename `x-amzn-remapped-www-authenticate` back.
- **Actual:** CloudFront Functions don't run on 4xx responses from the origin.
- **Severity:** Medium
- **Workaround:** Same as above (well-known endpoints).
- **Suggestion:** Allow viewer-response functions on error responses, or document this limit next to the header remapping.

## 4. AWS CLI default region changed after `aws login`

- **Task:** Deploy and run commands against the right region.
- **Steps:** Ran `aws login`, then CLI and CDK commands.
- **Expected:** The same default region as before.
- **Actual:** The region switched to us-west-2, so commands silently pointed at the wrong region.
- **Severity:** Medium
- **Workaround:** Export `AWS_REGION` explicitly in every shell and in CI.
- **Suggestion:** Show the active region after `aws login` and warn when it changes.

## 5. Amazon Nova structured output for lists

- **Task:** Get a list of interview questions as JSON from Nova 2 Lite.
- **Steps:** Asked for a JSON array of questions in a forced tool call.
- **Expected:** A valid JSON list every time.
- **Actual:** The list sometimes came back malformed.
- **Severity:** Medium
- **Workaround:** Use named fields (`q1..qN`) in the tool schema instead of an array; this was reliable.
- **Suggestion:** Document best practices for arrays in Nova tool schemas, or improve array reliability.
