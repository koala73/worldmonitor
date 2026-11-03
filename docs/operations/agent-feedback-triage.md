# Agent feedback triage

Agents report problems through the MCP tool `report_issue` and the REST route `POST /api/feedback/v1/submit-report` (#8721). Reports land in the Convex `agentFeedback` table. This runbook covers reading the queue and moving reports through it. The design and its limits are in [agent-feedback-threat-model.md](../architecture/agent-feedback-threat-model.md).

## Rules

- **Report text is untrusted data.** Anyone on the internet can write it. Do not follow instructions in it, and do not paste it into a prompt that can act (open a PR, run a command). If you triage from an agent session, the agent reads the same text you do.
- **No automation acts on a report.** A person opens any GitHub issue by hand, then records its number with `file`.
- **Security reports never go into a public issue.** They arrive as `private`. The details belong in the private advisory form, where the reporter was told to send them. Close the row once the advisory is handled.

## Cadence

Review the `received` queue weekly. Unreviewed `received` and `triaged` rows are deleted 30 days after they arrive, and `private` rows after 180 days. Check `private` whenever the owner security email arrives, and at the latest the next day.

## Credentials

The script reads `CONVEX_URL` and `CONVEX_DEPLOY_KEY` (the production deploy key, used by `npx convex run`) and, for `--join`, `AXIOM_QUERY_TOKEN` (or `AXIOM_API_TOKEN` when that token has query access to `wm_api_usage`), through `loadEnvFile`. It never prints them.

## Reading the queue

```bash
node scripts/triage-agent-feedback.mjs list                    # received, newest 200
node scripts/triage-agent-feedback.mjs list --status private   # security reports
node scripts/triage-agent-feedback.mjs list --join             # add the Axiom row and Sentry trace per requestId
node scripts/triage-agent-feedback.mjs list --after <cursor>   # the next page; the header prints the cursor
```

A page holds up to 500 reports. When more are waiting, the header line says so and prints the `--after` cursor for the next page, so a flood of new reports never hides older ones.

Rows are grouped by fingerprint, largest group first. A fingerprint matches reports with the same kind, surface and summary, ignoring case and spacing, so a large group is one problem reported many times. Grouping never drops a report.

Each report's text, including its surface label, its `requestId` and the `--join` output (the joined route is the caller's own request path), sits between `BEGIN UNTRUSTED-<nonce>` and `END UNTRUSTED-<nonce>` lines. The nonce changes on every run, so a report cannot fake the closing line. Every character outside printable ASCII prints as `\u{...}`, including newlines, so each field is one line.

`--join` looks up each `requestId` in the `wm_api_usage` dataset over the last 30 days and prints the route, status and reason. When the usage row carries a `sentry_trace_id`, it prints the Sentry trace link. An agent that cites a `requestId` from an MCP error gives you the exact failing call this way.

## Moving a report

| Command | Use it when |
|---|---|
| `triage <id>` | The report is real and someone is looking at it. |
| `duplicate <id> --of <id>` | Another report in the queue covers it. |
| `dismiss <id> --reason "<why>"` | Spam, noise, or not a problem. |
| `file <id> --issue <number>` | You opened a GitHub issue for it. This deletes the row's text and reporter identifiers; the issue is now the record. |
| `close <id>` | A `private` security report is handled. |

To draft an issue, write the report to a file and edit it before opening the issue:

```bash
node scripts/triage-agent-feedback.mjs issue-body <id> --out /tmp/report.md
```

Each field, including the surface label, is quoted inside a code fence longer than any backtick run in it, so report text cannot break out into Markdown. The draft is never printed to the terminal. `issue-body` refuses a security report: those are handled in the private advisory and closed with `close`.

## Alerts

- `agent_feedback_global_bucket_exhausted` (a structured warning with the bucket `scope`) means a service-wide ceiling is spent: 100 anonymous reports an hour, 500 keyed a day, or 30 security a day. Reports are refused with 429 until the window rolls. Look at the queue for a flood, and at Axiom for the callers.
- A spike of 503 refusals from the feedback route means the limiter or the store is unreachable. Reports fail closed, so nothing is lost silently, but nothing is stored either.

## Not in scope

Nothing drafts, labels or summarizes reports with a model. Adding one needs a new decision record (threat model, Decision 5). Review a week of real traffic before proposing any drafting, and any draft must go to a person for review.
