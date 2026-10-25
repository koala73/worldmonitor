---
title: Diagnose history relay disconnects with HTTP phase timing
module: Intel history
problem_type: integration-issues
component: Convex HTTP relay
tags: [convex, axiom, timeout, observability]
---

# History relay phase timing

The October 23 incident had `Client disconnected` HTTP actions while recorded
`intelHistory:append` mutations completed in 103–613 ms with no retries. One
mutation completed after its parent HTTP action disconnected. A disconnect does
not prove that the batch was never committed. Existing execution logs do not
separate authentication, request-body reading and mutation dispatch.

`POST /relay/intel-history` now emits `intel_history_phase` JSON console messages.
Convex supplies the request ID in the surrounding log-stream event. No request
body, run ID, secret, embedding or exception text is included in these messages.
A successful request emits seven messages; rejection paths emit fewer.

| Phase | Meaning |
| --- | --- |
| `handler_enter` | Application handler began. It does not measure edge arrival or startup delay. |
| `auth_complete` | Secret comparison completed, before any body read. |
| `body_complete` | Body read and JSON parsing settled, including invalid JSON. |
| `validation_complete` | The batch passed the existing validation. |
| `mutation_started` | Immediately before awaiting the append mutation. |
| `mutation_complete` / `mutation_failed` | The append promise settled. |
| `response_ready` | Response object constructed, with HTTP status. This is not proof of network delivery. |

`elapsedMs` is cumulative wall-clock time since handler entry, clamped at zero.
Subtract adjacent values to estimate each phase. Clock adjustment can distort
these durations; use Convex execution timing as a cross-check. A cancelled
handler may never emit a terminal message. Use its last recorded phase together
with the platform failure, not absence alone, to locate the unobserved interval.

## Read the evidence

Use the existing Axiom query access to `convex-logs`. Set `startTime` and `endTime`
to the incident window. Select the request ID from the execution record, then
query all topics for that same ID, including console events:

```text
['convex-logs']
| where ['data.function.request_id'] == '<request-id>'
| order by _time asc
```

Inspect `data.message` for `intel_history_phase` and compare the HTTP execution
with its `intelHistory:append` execution. Request IDs correlate retries separately;
do not combine them into a single handler duration. Missing `handler_enter` does
not establish a startup failure unless log delivery and deployed revision are
also verified. These logs cannot expose provider-internal edge spans.

After an explicitly approved future deployment, observe a normal scheduled run
and the next recurrence. Confirm success ordering and status, then identify the
last completed phase for a disconnected request. No manual seed is required.
If timing is dominated by body reading, investigate upload/body handling; if by
the mutation await, inspect its execution and queue data. If `response_ready`
precedes disconnect, inspect the response path. Do not widen the existing
10-second attempt timeout or 30-second overall budget to hide a failure.

This diagnostic does not fix the timeout or change authentication, validation,
retry policy, mutation arguments, response bodies, or freshness clocks. Remove
or reduce it in a separate change once a cause-specific repair has been accepted.
