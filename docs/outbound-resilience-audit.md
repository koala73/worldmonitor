# Outbound resilience audit

Reviewed 2026-11-05 against base 870828e895bafe5f2b94a8b1b19c0e80e6ffe037.

## Scope and reproduction

Run with Node 24:

```sh
node scripts/audit-outbound-calls.mjs > /tmp/outbound-calls.json
```

The inventory covers tracked and unignored application, worker, CLI, and SDK source.
It excludes generated clients, vendor code, tests, and demos. Generated browser
RPC clients receive their deadline from the shared client constructor.

After repair, the inventory contains 722 fetch calls with a signal, 120 spread
forwarders, 15 options forwarders, 35 client configurations, 71 retry-loop
candidates, 31 native-language candidates, and 815 transport/SDK call candidates.
There are zero direct fetch candidates without a signal. These are static review
counts, not proof that every signal is a timer or that every SDK operation is
bounded. The transport candidate set also contains local database connections,
WebSocket sends, and other non-request methods.

## Changes and policy

- Previously unbounded browser requests use 15-second deadlines; public RPC and
  proxy requests use 30 seconds. The shared generated RPC and desktop bridge
  ceiling is 120 seconds to accommodate existing 90-second LLM operations.
  Key creation and contact submissions allow 60s for the server workflow.
  Caller cancellation and shorter deadlines survive composition, including
  cancellation carried by a Request.
- Missing server, CLI utility, Redis REST, email, and worker deadlines are
  bounded at their transport boundary. Rate-limit Redis operations have a
  three-second deadline and at most two configured retries. Existing
  single-attempt configurations remain single-attempt.
- Relay, economic fetch helper, CLI, and sidecar deadlines cover response body
  consumption. Native relay requests have an absolute deadline in addition to
  socket inactivity timeouts.
- The MCP consent context transport allows 35 seconds so its existing 30s
  recovery state wins first; mint requests retain the 120s RPC ceiling.
- Docs MCP SSE and transparent edge proxy traffic retain a five-minute budget
  rather than using the short JSON request budget. WebSocket connections use
  their existing connect, heartbeat, and reconnect lifecycle; they are not
  given a fixed request lifetime.
- Shared seeder and Yahoo retries use capped exponential delays with jitter.
  Seeder delays cap at 60 seconds and retry counts at ten. Provider Retry-After
  floors are preserved, including longer provider cooldowns. Callers with
  phase budgets reject hints that cannot fit before another attempt. Redis
  helpers stop without retry when an uncapped provider cooldown exceeds 60s. R2 uses one SDK attempt inside its three-attempt outer retry loop,
  avoiding compounded SDK retries.
- Immediate network retry loops for proxy rotation, Wikidata reads, shipping
  compare-and-set/lease contention, and deployment status reads now pause with
  capped exponential jitter. Fixed cadence polling, local locks, unique-code
  collision handling, and semantic LLM validation are separate from retries of
  a failed outbound request.
- Anthropic/Dodo tools have explicit deadlines and no hidden SDK retries.
  Resend sends have an explicit deadline. Ruby disables Net::HTTP's implicit
  immediate retry. Queue mutation, email, and database transaction writes do
  not gain automatic replay: a timeout can occur after a successful write.
  Quiet-hours email batches use a stable provider idempotency key across drains.
  Publish timeouts return an explicit unknown outcome and retain the processing
  marker. The existing RPOP consumer remains at-most-once: transport failure
  after a committed pop can lose that event. Durable queue acknowledgements
  require a separate delivery protocol and are not supplied by request retries.

## Pools and concurrency

| Consumer | Checked-in limit | Assessment |
| --- | --- | --- |
| Consumer prices PostgreSQL | Pool 10; retailer concurrency 5 | Covers the five awaiting retailer workers with headroom for API/aggregation reads in one process. Acquire 5s, server statement 30s, client query 35s, idle transaction 30s. Failed rollbacks discard the connection. |
| Relay OpenSky HTTPS | Agent maxSockets 6 | OpenSky requests use a serialized queue; no demonstrated socket shortage. |
| Desktop sidecar | Six concurrent upstream operations | Existing semaphore remains held through body completion and released on failure. |
| Shipping webhook delivery | Four concurrent deliveries | HTTP transport; no dedicated database pool to resize. |
| R2 S3 transport | Pinned Smithy default 50 sockets per origin | Current operations do not demonstrate saturation. |
| Upstash / Convex | Managed HTTP clients | No local PostgreSQL-style connection pool. |

No pool capacity was increased without evidence of saturation. These limits
describe source configuration per process. Live replica counts, database
max_connections, competing applications, and production saturation were not
queried. The source check cannot establish a deployment-wide connection budget.

## Verification

Focused checks passed for the following changed behavior:

- Real loopback fault injection: headers followed by a never-ending body abort
  in the relay, Anthropic SDK, and both CLI response paths; caller cancellation
  survives.
- Seeder retry cap/jitter boundaries, invalid retry counts, provider retry
  hints, Yahoo retries, R2 transport, and Resend send options.
- Redis rate-limit fail-open/fail-closed and OAuth/MCP contracts.
- Proxy rotation, shipping webhook leases/CAS, country-facts fallback,
  reconciliation reads, and merge-guard polling.
- MCP consent deadline/mint recovery in Chromium; widget preflight recovery.
- Gold panel refresh timeout retains the last successful data in Chromium, with desktop and mobile screenshots.
- Generated RPC, premium fetch, timeout compatibility, proxy response caching,
  and server sub-request dispatch.
- Worker CORS/cache behavior, queue requeue behavior, sidecar timeout and
  truncated-body handling, crawlable source pagination, and trust-page DOM.
- Consumer prices: 545 tests plus TypeScript build; Ruby SDK: 19 tests.
- Root and API typechecks, import boundaries, frontend production build, Rust
  offline compile check, derived-file generation, and whitespace validation.

Tests use fixtures and loopback faults. They do not establish live provider
latency, production pool saturation, or deployed acceptance. No production
configuration, merge, or deployment is part of this change.

The edge Worker opts into [incoming request cancellation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests) for its pinned compatibility date.
