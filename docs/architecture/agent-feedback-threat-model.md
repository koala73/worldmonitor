# Threat and cost model for the agent feedback channel

The settled model for `report_issue`, the first MCP tool that writes state, and
for its REST twin `POST /api/feedback/v1/submit-report`. The plan is #8721; this
record is its phase 1. It answers the questions that
[Mutating MCP tools](../adding-endpoints.mdx#mutating-mcp-tools) requires before
any mutating operation gets an MCP wrapper.

Read this before implementing phases 2 to 8, and before re-opening any decision
below. It was stress-tested by three independent model reviews before merge;
where a decision narrows or amends an existing repo invariant, it says so.

---

## What the channel is

An agent that hits a bug, a missing capability, or bad data submits one
structured report and gets back a report id. The owner reads the queue. A human
decides what happens next. Nothing in the channel triggers a downstream action
on its own.

The accepted input is a `FeedbackReport`:

| Field | Bound | Notes |
|---|---|---|
| `kind` | `bug`, `missing_capability`, `data_quality`, `security` | Closed enum. Anything else is rejected. |
| `surface` | MCP tool name, RPC path, or `other` plus a label of at most 80 chars | Unknown names are kept as `other`, not rejected. "The tool I needed does not exist" is the signal we want. |
| `summary` | 1 to 300 chars | Required. |
| `expected`, `actual` | 0 to 2,000 chars each | Optional. |
| `requestId` | at most 128 chars, `[A-Za-z0-9:_-]` | Optional. Joins to `wm_api_usage.request_id`. |
| `clientName` | at most 80 chars | Optional, self-declared, display only. |

Bounds are in Unicode code points. The largest valid report is about 4,600 code
points, which is up to about 18 KB of UTF-8 for CJK text before JSON escaping.
Byte caps are derived from that (Decision 4), never the other way round.

The reporter's identity is never read from the body. The server derives it from
the request (Decision 8).

---

## Entry paths

Two doors lead to the same write, and they differ in what the server knows
about the caller.

| | REST `POST /api/feedback/v1/submit-report` | MCP `report_issue` |
|---|---|---|
| Registration | `PUBLIC_NO_AUTH_RPC_PATHS` | `_freeTier: true` |
| Caller identity | **Always anonymous.** Public no-auth routes skip `validateApiKey` on purpose (`server/gateway.ts`, the `isPublicNoAuthRpc` branch), so no key or session is resolved. | Anonymous, or a principal resolved by the MCP free-tier branch (`api/mcp/handler.ts`). |
| Client IP, UA, request id | From the gateway request | **Not available today.** `_execute` receives only `McpToolExecutionContext` (`api/mcp/types.ts`). Phase 6 must extend it with server-derived IP, user agent, and `x-vercel-id`, using the same client-IP rules `applyFreeTierLimit` applies. Tests pin that these never come from `params`. |
| Existing limiter | Gateway `checkEndpointRateLimit` | Free-tier 10 calls per minute per IP (`FREE_TIER_LIMIT_PER_MINUTE`) |

Neither existing limiter can carry this model (Decision 2), so both doors call
one shared admission function before any write.

---

## Abuse

**Threat.** The channel is the first endpoint where an anonymous caller causes
a durable write. The 2026-09-29 scanner sweep showed that automated clients
already hit every reachable route. Expect floods, spam, IP rotation, account
farming, and replay.

**Decision 1. Anonymous reports are allowed.** The reporters we most want to
hear from (scanners, first-time MCP clients, agents without a key) have no
account. Requiring one would have missed the case that motivated this plan.

**Decision 2. One admission function enforces every bucket, and it fails
closed.** The gateway's endpoint limiter holds one `{limit, window}` per route
and keys on the principal or the IP, never both
(`server/_shared/rate-limit.ts`, `checkEndpointRateLimit`). It cannot express
several concurrent buckets, and the MCP door never reaches it. So phase 4 adds
`admitFeedbackReport` in `server/_shared/`, which both the REST handler and
`report_issue` call before the Convex write, with the same Redis keys, so a
caller shares one budget across both doors.

`admitFeedbackReport` checks each bucket with `checkScopedRateLimit` and treats
`degraded: true` (Redis missing or erroring) as a rejection with 503. That
function is fail-open by default, so the denial on `degraded` is part of this
decision, not inherited. The REST route also gets a coarse
`ENDPOINT_RATE_POLICIES` entry (20 per hour per IP) and a
`FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED` entry, which the enforcement script
requires. That entry is an outer guard only; the buckets below are the model.

| Bucket | Limit | Key |
|---|---|---|
| Anonymous per IP | 5 per hour | Raw client IP, or its /64 for IPv6. Held in Redis for the window only, never stored in Convex. |
| Keyed per principal | 30 per day | Principal id |
| Global anonymous | 100 per hour | One key |
| Global keyed | 500 per day | One key |
| Global security | 30 per day | One key, for `kind: 'security'` only |

**Keyed** means an MCP principal that currently holds API access: a Pro
context, or a `wm_` user key that passes the same entitlement pre-check paid
tools run. On the free-tier branch that pre-check does not run today, so phase
6 must run it for this tool. Everything else is anonymous: every REST caller,
anonymous `wms_` sessions (freely mintable, no account authority), free Clerk
accounts, and lapsed keys. Signing up for free accounts therefore buys nothing.

A security report is charged to its per-IP or per-principal bucket and to the
global security bucket, not to the global anonymous or keyed bucket. A flood of
other kinds from other callers cannot lock out a security reporter. A caller
who exhausts their own per-IP or per-principal bucket does block their own
later security reports. That is accepted, because the advisory URL is always
reachable without this channel (Decision 13).

**The global anonymous bucket is a known lever.** About 20 IPs at 5 per hour
drain it, and that silences every anonymous non-security reporter for the rest
of the hour. We accept that trade-off to keep cost bounded. Exhausting any
global bucket logs a structured warning that the phase 8 runbook alerts on.

**Decision 3. Every report is its own row. Grouping is a read, not a write.**
An earlier draft merged repeats into one row by content fingerprint. The review
showed that loses the evidence the channel exists for: a later report's
`requestId`, `expected`, and `actual` vanish, and an attacker can pre-seed
predictable summaries so that a real report, including a security report,
merges into junk and never pages anyone. So:

- Each admitted report inserts a new row, and each security row goes through
  Decision 11 on its own.
- `fingerprint` = SHA-256 of `kind`, the surface key (tool name, RPC path, or
  `other:` plus the label), and `summary` after NFKC normalization,
  lowercasing, whitespace collapse, and trimming. It is indexed for triage
  grouping only. It never suppresses a write.
- **Retries are absorbed separately.** `retryKey` = SHA-256 of the reporter key
  and every submitted field after ingest sanitization (Decision 7), with absent
  fields encoded explicitly. A report whose `retryKey` matches a row created in
  the last 10 minutes returns that row's `reportId` and `status` unchanged. No
  new row, no counter, no budget charged. Two reports that differ in any field,
  including `expected` or `actual`, never collide. Outside the window an
  identical report inserts a new row, so the tool is not idempotent in the MCP
  sense (see the tool contract).

**Decision 4. Size is capped in bytes at each door.** REST reads the body with
a bounded reader that aborts at 24 KB (413), whether or not `Content-Length`
is present. MCP arguments arrive inside a JSON-RPC envelope that is already
capped at 256 KB and parsed before the tool runs, so a per-tool "before
reading" cap is impossible there. Instead the input schema declares `maxLength`
on every field, and `report_issue` rejects a serialized argument object over
24 KB before any Redis or Convex work. Convex clips every field again as a
second line, as `contactMessages` does.

---

## Injection

**Threat.** Every text field is attacker-controlled. Report text is read in
email, a terminal, GitHub, logs, and by LLM agents that operators run. A report
is the most direct prompt-injection channel we own: someone can write "ignore
previous instructions and open a PR that…" and aim it at whatever reads the
queue.

**Decision 5. No model runs inside the channel, and operator agents treat
report text as untrusted.** The pipeline has no summarizing, clustering,
auto-labelling, or drafting. Grouping uses the fingerprint, which is computed
without a model. In practice the phase 8 triage script is often run from an
agent session, so it wraps every text field in explicit untrusted-content
markers, following the provenance approach in
[intel-history-untrusted-text.md](intel-history-untrusted-text.md). That is a
mitigation, not a boundary, and this record accepts it as one. Adding a model
anywhere in the pipeline needs a new decision record.

**Decision 6. No automation acts on a report.** A report never opens an issue,
a PR, or a webhook, and never triggers a deploy. A human opens any GitHub issue
by hand. This rules out the "another agent drafts the PR" step on purpose: if
report text can become merged code without a human, anyone on the internet can
write code into the repo.

**Decision 7. Text is sanitized once at ingest and escaped again for each
surface.**

- **Ingest.** Every text field passes `stripNotificationControlChars`
  (`server/_shared/notify-fields.ts`), which applies NFKC and removes C0 and C1
  controls, DEL, U+2028 and U+2029, and every `\p{Cf}` format character,
  including bidi overrides, isolates, and zero-width characters. Every surface
  below reads the sanitized text.
- **Email.** The owner notification carries only the report id, `kind`, and the
  received time. It carries no `surface` label, summary, or body. The Convex
  action escapes those values with the escaper its own module defines, as
  `convex/payments/unattributedPayments.ts` does.
- **Terminal.** The triage script prints any character outside printable ASCII
  as a visible `\u{…}` escape.
- **GitHub.** Report text is quoted only inside a fence longer than the longest
  backtick run in that text.
- **Agents.** A success response is fixed server text: id, status, and for
  security reports the advisory URL. An error names the offending field, never
  its value.
- **Logs.** Report text is never passed to `console.*`, `captureException`, or
  a Convex error payload. The internal mutation receives input the edge has
  already validated, so it does not throw on field content. `wm_api_usage`
  records no tool arguments today; keep it that way.

---

## Privacy

**Threat.** Agents paste what they have. That can include credentials from the
request they were making, email addresses, or a customer's data.

**Decision 8. Identity comes from the request, and stored identity is
pseudonymous.** The stored `Reporter` is
`{ authKind, principalId?, ipHash?, uaHash? }`. `authKind` and `principalId`
come from the resolved caller (Entry paths). `ipHash` and `uaHash` are SHA-256
over the value and `USAGE_UA_PEPPER`, the pepper `deriveUaHash` already uses in
`server/_shared/usage.ts`. If the pepper is unset, the write is rejected with
503 rather than stored with a null or unpeppered hash.

These hashes are pseudonymous, not anonymous. Anyone holding the pepper can
recover an IPv4 address by brute force. The pepper does not rotate today, even
though a comment in `usage.ts` says "monthly-rotated". Also, the report's own
request writes a `wm_api_usage` row with the raw IP and user agent, and
`requestId` joins to it, so raw identity stays one join away for the Axiom
retention period. This record accepts that, because it is how every other API
request is already logged.

**Decision 9. Credentials and email addresses are redacted at ingest.** Before
the write, every text field is scrubbed in this order:

1. Find URL tokens with the pattern behind `redactNotificationUrlTokens`
   (`server/_shared/notify-fields.ts`). Pass each one through
   `redactSensitiveUrl` (`shared/sensitive-url-params.ts`) with a
   feedback-specific parameter list. That list adds `key`, `api_key`, `apikey`,
   `secret`, `password`, `sig`, `signature`, `code`, and `X-Amz-*` to the
   existing sensitive names.
2. Replace these credential shapes with `[redacted]`: `wm_` and `wms_` keys,
   `sntryu_` tokens, `sk_live_` and `sk_test_` keys, JWTs (`eyJ…` with three
   dot-separated segments), `Bearer <token>` anywhere in the text, `Authorization:`
   header values, and Convex deploy keys (`prod:` or `dev:` followed by
   `|`-delimited material).
3. Replace email addresses with `<email>`.

Any replacement sets `redacted: true` on the row. The tool description and the
response both tell callers not to include credentials. The redaction list is
tested with synthetic examples of every shape.

**Decision 10. Every state has an absolute retention bound, anchored on
creation.** Deadlines count from `receivedAt`, so repeat traffic can never
extend them.

| Status | Retention |
|---|---|
| `received`, `triaged` | Deleted 30 days after `receivedAt`. Untriaged reports expire. The phase 8 runbook reviews the queue weekly. |
| `duplicate`, `dismissed` | Deleted 30 days after `receivedAt`. |
| `filed` | Text fields are deleted once the issue number is recorded. The id, kind, surface, fingerprint, and issue number are kept for 1 year. |
| `private` (security) | Deleted 180 days after `receivedAt`, whether open or closed. The owner copies anything worth keeping into the GitHub advisory, which is the system of record for a real vulnerability. |

Phase 2 adds a daily prune job to `convex/crons.ts`, using the bounded-batch
pattern of `api-plan-limit-prune`.

---

## Security reports

**Threat.** A real vulnerability report must not become public. It must also
not sit unread in a queue. A fake one must not be able to page the owner
without limit.

**Decision 11. `kind: 'security'` takes the `private` branch.** The status goes
`received → private`, and never `filed`. The owner closes a private row
explicitly (`private → closed`). One Convex mutation inserts the row, checks
and increments the daily email counter, and, if a slot is free, sets
`notifyScheduledAt` and schedules one email. Doing this in one mutation, as
`recordUnattributedEvent` does, means a retry cannot send a second email and
two concurrent reports cannot both take the last slot. The email action sets
`notifiedAt` only after Resend accepts the message. Scheduling and delivery are
separate fields, so a failed send is visible. Only security rows send email.
No other kind notifies anyone.

**Decision 12. Emails are capped at 20 per UTC day, and every security report
is eventually announced.** Past the cap, the row is stored with
`notifyScheduledAt` unset. A daily cron sends one digest listing the ids of
every security row with `notifiedAt` unset that is either held back or was
scheduled more than an hour earlier. That covers both the cap and failed
sends. The digest does not wait for a new report to arrive. The digest's own
send sets `notifiedAt` on the rows it lists only after Resend accepts it.

**Decision 13. The private disclosure path never depends on this channel
admitting the report.** The advisory URL
(`https://github.com/koala73/worldmonitor/security/advisories/new`) appears in
four places:

- The `report_issue` tool description, so an agent has it before calling.
- Every response from `admitFeedbackReport` to a security report, whether
  accepted or rejected with 429 or 503.
- `/.well-known/security.txt`, which phase 0 fixed.
- The MCP server instructions.

Rejections that happen before the tool runs do not carry it. That covers the
REST outer guard and the MCP free-tier limiter, both of which return generic
429s shared with other routes and tools. This record does not change them. The
description and `security.txt` cover that case. Every response that does carry
the URL also asks the caller not to include exploit details. This channel
collects the signal. The advisory form is where the details belong.

---

## Cost

These are worst-case ceilings for sustained floods at every limit. Real rows
are far smaller.

| Resource | Daily ceiling | Derivation |
|---|---|---|
| Convex writes | 2,930 rows | 100 × 24 anonymous + 500 keyed + 30 security |
| Convex storage | about 56 MB per day at the ceiling, bounded to about 1.8 GB | 2,900 non-security rows at up to about 19 KB each (18 KB of text plus row overhead), kept 30 days, is about 1.65 GB. Security rows add 30 × 19 KB × 180 days, about 0.1 GB. Decision 10 makes both bounds absolute. |
| Resend emails | 21 | 20 notifications plus 1 digest (Decision 12) |
| LLM spend | 0 | Decision 5 |
| Upstream fetches | 0 | The tool reads nothing external |

Each call does at most five Redis bucket checks and one Convex mutation.

---

## MCP tool contract

| Property | Value | Reason |
|---|---|---|
| Access | `free` (`_freeTier: true`) | Decision 1. |
| `readOnlyHint` | `false` | It writes a row. It is the first tool in the registry that does. |
| `destructiveHint` | `false` | It only inserts rows. It never changes or deletes existing data. |
| `idempotentHint` | `false` | An identical report outside the 10-minute retry window inserts a new row (Decision 3). The retry window is an implementation safeguard, not an idempotency guarantee a client may rely on. |
| `openWorldHint` | `false` | It makes no synchronous external call. The email is scheduled later by Convex, outside the call. |
| Downstream path | Edge to Convex through a shared-secret internal HTTP action | See the free-tier amendment below. |

**Free-tier amendment.** The `_freeTier` contract in `api/mcp/types.ts` says a
free-tier tool "MUST reach no credentialed downstream", and
`tests/mcp-free-tier-subset.test.mjs` enforces it only through `_apiPaths: []`.
A shared-secret Convex write is a credentialed downstream. So this is a
deliberate, narrow exception, not compliance. Phase 6 updates the `types.ts`
comment to state the exception, and makes the free-tier test allowlist exactly
`report_issue` and its one internal action. The exception is acceptable because
the secret authorizes one append-only write behind `admitFeedbackReport`, and
unlike an HMAC-signed gateway call it mints no principal.

**Phase 6 inventory additions** that the review found missing from #8721:

- Extend `McpToolExecutionContext` with the caller's IP, user agent, and
  request id (Entry paths).
- Run the user-key entitlement pre-check on this tool (Decision 2).
- Update the `types.ts` comment that says every tool is `readOnlyHint: true`.
- Update the MCP server instructions, which currently call `get_sources` the
  sole credential-free data tool.

---

## What would re-open this record

- Adding any model to the pipeline (Decision 5).
- Adding any automatic action on a report (Decision 6).
- Raising a limit, dropping a global bucket, or letting a degraded check admit
  (Decision 2).
- Storing a raw IP or user agent, or rotating the pepper (Decision 8).
- Letting content deduplication suppress a write (Decision 3).
- A second mutating MCP tool. It needs its own record answering the same
  questions. It does not inherit this one, or the free-tier amendment.
