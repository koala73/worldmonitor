---
title: "OAuth refresh rotation revoked the whole token family on benign same-client retries; a bounded grace window now returns the successor pair"
date: 2026-11-06
category: security-issues
module: api/oauth/token.ts
problem_type: logic_error
component: oauth
severity: medium
symptoms:
  - "MCP connectors (Claude, Cursor, VS Code) intermittently report 'connection expired' and need Reconnect even though the user refreshed within the 30-day idle window"
  - "A refresh that answered 503 + Retry-After: 5 is retried with the same refresh token, and the retry answers 400 invalid_grant with oauth:famrev:<family> written"
  - "Two concurrent refreshes of one token from the same host: the winner gets 200, the loser 503, and the loser's Retry-After retry revokes the winner's fresh tokens"
root_cause: ambiguous_failure_indistinguishable_from_replay
resolution_type: code_fix
related_components: [redis, testing_framework]
tags: [oauth, refresh-token-rotation, replay-detection, family-revocation, GHSA-f6gj, retry-after, idempotency, grace-window, SM-092]
---

# OAuth refresh retries inside a 60-second grace window return the successor pair instead of revoking the family

## Symptom

`POST /oauth/token` with `grant_type=refresh_token` rotates the token and, on
reuse of a rotated token, revokes the whole family (GHSA-f6gj). Ambiguous
failures answer `503` with `Retry-After: 5`, which tells the client to present
the same token again. Three reachable interleavings turned that retry into
"proven replay" and signed the connector out:

1. The consume script committed in Redis but the edge never saw the response
   (3-second timeout). The handler returned 503. The client retried; once the
   60-second in-flight claim expired, the miss had live family evidence and no
   active attempt, so the family was revoked.
2. The rotated tokens were stored and the finalize script committed, but its
   response was lost. The handler returned 503 without delivering the pair.
   The immediate retry was a miss with family evidence: revoked.
3. Duplicate concurrent refreshes, which MCP hosts issue: R1 consumed and
   rotated, R2 overlapped and correctly got 503. R2 obeyed `Retry-After` with
   its token after R1 finished. The family, including R1's fresh tokens, was
   revoked. `tests/oauth-token.test.mjs` asserted this as the desired outcome.

## Root cause

A miss on a token with a live `oauth:famptr:<token>` and no live
`oauth:famattempt:<token>` was the only replay signal, and a benign retry of a
rotation whose response was lost is indistinguishable from reuse in that
state. The 60-second attempt claim covered in-flight attempts only; nothing
recorded "this token was rotated a moment ago, and here is what replaced it".

## Fix

`api/oauth/_refresh-recovery.ts` and `api/oauth/token.ts`:

- `REFRESH_REPLAY_GRACE_SECONDS = 60`. Every rotation writes
  `oauth:famsucc:<sha256(oldToken)>` in the same pipeline as the rotated
  tokens, with the grace TTL. The record is `{kind:'refresh_successor',
  client_id, access_token, refresh_token, scope, issued_at}`.
- On a miss, before anything else, the handler reads that record. If it
  exists, the presenting `client_id` matches, and the successor refresh token
  is still a live record (not consumed, not an in-flight marker), the handler
  answers 200 with the same pair and `expires_in` reduced by the elapsed time.
  A transport failure on that read stays 503, never a revoke on a guess.
- The in-flight marker at `oauth:refresh:<token>` now outlives the attempt
  claim by the grace window (`REFRESH_ATTEMPT_MARKER_TTL_SECONDS = 120`). The
  consume script reports whether the marker was present; a miss with the
  marker but no claim is an orphaned attempt (lost consume response: nothing
  rotated, nobody holds a successor) and answers `invalid_grant` without
  revoking. The token is gone either way; the family is not branded replayed.

## What still revokes (the security trade-off, stated plainly)

The window allows: a presentation of a rotated refresh token, by the same
`client_id`, within 60 seconds of the rotation, while the successor has not
itself been used. That presentation receives the successor pair.

Reuse still revokes the family when any of these holds:

- the presentation arrives after the 60-second window (the record expired);
- the presentation carries a different `client_id`;
- the successor refresh token has already been consumed, even mid-rotation
  (two generations behind is never a retry);
- the grace record is missing or malformed.

What an attacker gains: with a stolen refresh token and the public
`client_id`, presenting the token within 60 seconds after the victim rotates
it (or vice versa) hands both parties the same pair instead of revoking the
family. An attacker who manages to interleave every one of their rotations
inside a 60-second window of the victim's can coexist with the victim across
generations, undetected, for as long as that timing holds; a lazily
refreshing MCP host does not make the victim's timing predictable, and the
first rotation outside the window revokes the family as before. Previously an
attacker who rotated first was contained at the victim's next refresh, with
no timing to get right. The window trades that guarantee for not signing out
every connector whose retry crossed a lost response.

A restore (the rotation did not happen) deletes the grace record its storage
pipeline may have committed before the response was lost. Without that, a
later consumer of the restored token and an overlapping grace replay would
hand out two different live pairs and fork the family into two chains.

Storage exposure: the successor pair sits in a Redis value. The raw tokens are
already the key names of `oauth:token:<uuid>`, `oauth:refresh:<uuid>` and
`oauth:famptr:<uuid>`, so a reader of Redis gains nothing new; the record key
is the old token's hash so the record is not found from the token alone
without the key scheme.

## Verification

`tests/oauth-token.test.mjs`: the three interleavings above were ported as
failing cases first (each failed on the family-revoke assertion against the
previous handler), then the window hardening cases (different client, successor
used, successor in flight, unreadable record, malformed record, successor gone,
record shape and TTL, remaining `expires_in`, code exchange writes none). The
GHSA-f6gj cases that asserted an immediate replay revokes now close the window
first (`closeReplayGrace`) and keep asserting revocation; the production
contract case checks the new script ARGV and the four-element miss reply.

## Prevention

- Any endpoint that answers an ambiguous failure with `Retry-After` must
  tolerate the retry it invites. A retry of an idempotent operation that
  already committed should return the committed result, not a security
  verdict.
- Replay detection needs positive evidence of a completed, delivered rotation
  before it treats a presentation as reuse; "the token is not on file" alone
  conflates lost responses with replay.
