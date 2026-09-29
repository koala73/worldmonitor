# Widget admission and paid-work budget

Widget POSTs require an available, provisioned Redis ledger. Missing credentials,
missing ledger configuration, malformed counters, failed Redis commands, and
unrecognized responses deny work. GET health and OPTIONS do not use the ledger.
No model or search call is made to check health.

## Identity and rate admission

The edge hashes the verified Clerk user ID or accepted tester credential. A
credential has one identity across header, cookie, edge, and direct-relay paths.
Keys shared by testers share a budget. IP addresses do not select a budget.

The edge signs the principal, normalized tier, request body digest, and timestamp
with `WIDGET_QUOTA_SIGNING_KEY`. Configure the same independent random secret of
at least 32 characters at the edge and relay. Never use a browser-held widget key
as this secret. The relay rejects partial, invalid, stale (over 120 seconds), or
body/tier-mismatched proofs. Without a proof, a direct relay request uses the hash
of its validated widget/pro key. Replaying a valid proof still charges admission
and every paid attempt; a signature is not a quota exemption.

Both surfaces atomically admit at most 10 basic or 20 Pro requests per principal
per UTC clock hour. Edge and relay admission have separate counters so a request
through both surfaces consumes one admission at each surface. Counters do not
split by tier, so switching tiers cannot create an extra allowance. The daily
spend counter is shared across tiers and both access routes.

## Units and bound

All budget values are integer **microdollars (USD / 1,000,000)**. The ledger
reserves the maximum accepted request cost before each paid attempt. It never
refunds, including provider failures, timeouts, cancellation, or unused output.
This is a conservative spend ceiling, not an invoice or actual-token meter.

| Attempt | Reserved microdollars | Bound at standard public list rates |
| --- | ---: | --- |
| Haiku 4.5, 4,096 output tokens | 220480 | 200,000 input tokens at $1/M plus 4,096 output tokens at $5/M |
| Sonnet 4.6, 8,192 output tokens | 3122880 | 1,000,000 input tokens at $3/M plus 8,192 output tokens at $15/M |
| Exa fast search, eight results with text | 100000 | $0.10, above fast search plus text extraction for eight pages |
| Brave web search | 100000 | $0.10, above $5 per 1,000 requests |

Model reservations use the full supported context window, including system,
tools, history, and accumulated tool results, rather than an estimated token
count. Output is capped. The relay pins the model, direct Anthropic base URL,
standard service tier, zero SDK retries, and no HTTP redirects. Each subsequent model turn reserves
again. The existing six/ten-turn limits remain. Each search provider attempt,
including Exa-to-Brave fallback, reserves separately. Exa uses `fast`, not the
provider-selected `auto` mode. Existing data-tool inference exclusions remain.

Tariff version `2026-09-10` uses the published
[Anthropic model limits](https://platform.claude.com/docs/en/models/sonnet-4-6/overview),
[Anthropic prices](https://platform.claude.com/docs/en/about-claude/pricing),
[Exa prices](https://exa.ai/pricing?tab=api), and
[Brave prices](https://api-dashboard.search.brave.com/app/plans).
Recheck the bound before changing models, output caps, service tiers, tools, or
provider pricing. These ceilings exclude tax, currency conversion, Redis/hosting
costs, and work outside the widget agent. A provider contract above these list
rates requires increased reservations before enabling this ledger.

## Provisioning and reset

All edge instances and relay replicas must use the same persistent Redis store
through `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The store must
support atomic EVAL, TIME, HMGET, HGET, and HSET. HTTPS is required unless the
existing explicit `UPSTASH_ALLOW_INSECURE_HTTP=true` trusted-network option is
used. The widget sends single-command POSTs to the Redis REST root; it does not use
`/multi-exec`. There is no in-memory fallback and no automatic request retry.

Provision hash `widget:quota:v1` once through an authorized operator procedure.
Use an atomic `EXISTS` guard to refuse overwriting an existing ledger. Required
fields are `tariff=2026-09-10`, `globalLimit`, `basicLimit`, `proLimit`, `day=0`,
and `spent=0`. Limits are integers from 0 to 1,000,000,000,000; zero disables paid
work. Example limits are 100000000 ($100 global), 10000000 ($10 per basic
principal), and 40000000 ($40 per Pro principal). Select actual limits before
provisioning. No default budget is enabled by code or deployment.

A new authenticated principal is initialized atomically inside that provisioned
ledger. Existing partial or corrupt principal records are denied. The global
ceiling remains authoritative across all principals. Protect the ledger against
eviction, deletion, and stale-backup restoration; do not expire it or delete
principal fields to recover capacity. Loss of the global ledger fails closed.

Redis TIME determines UTC day and hour boundaries, independently of replica
clocks. On the first operation of a new day, spent counters reset atomically;
principal resets are lazy. The budget covers work **admitted on that UTC day**:
a call reserved just before midnight can complete after midnight. In-flight
work keeps its reservation and is never refunded into the next day. Restarts
and deploys do not reset Redis state. A backwards clock or future-dated state
fails closed.

An admission denial returns JSON 429 (exhausted) or 503 (unavailable), with
Retry-After; the edge preserves CORS. A quota denial after SSE starts emits an
`error` event with `message`, `status`, and `retryAfter`, then ends the stream.
No subsequent paid call is made. Configure the ledger and signing secret before
an authorized rollout; deployment without them intentionally disables POSTs.

## Operator-enabled Docker installations

Stock Compose does not configure paid widget model credentials. To enable this
path, explicitly supply widget/model credentials and the independent signing
secret to the surfaces that use them. Both API and relay must share the same
ledger. With the bundled `http://redis-rest:80` service, set
`UPSTASH_ALLOW_INSECURE_HTTP=true` on the API container as well as the relay;
Compose currently supplies this opt-in only to the relay. Supply the matching
Redis REST token to both. These are operator configuration prerequisites, not
permission to enable paid calls or deploy during verification.

The bundled proxy pins this exact widget script and validates its single ledger
key, tariff, principal, tier, stage, and nonnegative integer cost. Arbitrary EVAL,
altered scripts, other keys, and standalone TIME remain blocked. A helper/script
change must update the pinned copy and pass the widget proxy parity tests. The
proxy image embeds the pin; it needs no extra runtime import or mount.

## Verification

`node --import tsx --test tests/widget-quota.test.mjs tests/widget-edge-quota.test.mjs tests/widget-relay-quota.test.mjs tests/widget-agent-auth.test.mts tests/widget-agent-relay-failure.test.mts tests/widget-builder.test.mjs tests/widget-proxy-quota.test.mjs`

Tests execute the production Lua in Fengari with a Redis command double and
exercise edge/relay handlers with synthetic authentication and mocked providers.
They cover concurrency, shared global and individual ceilings, rollover,
corruption and outages, auth variants, signed identities, direct relay access,
model-loop exhaustion, no retries/refunds, search fallback, and successful SSE.
No production calls or live paid-model acceptance are implied by these tests.
