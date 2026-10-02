---
title: "A composing handler cannot see the failures its dependencies swallow"
date: 2026-09-07
category: conventions
module: server/worldmonitor/intelligence/v1
problem_type: convention
component: api_endpoint
severity: high
applies_when:
  - "Building a surface that composes several existing RPC handlers you did not write"
  - "An endpoint promises that missing or failed source data is reported explicitly"
  - "Adding a health boolean such as degraded, healthy, or stale to a response"
  - "A new server surface must return the same result as an existing browser view"
tags:
  - error-handling
  - fail-closed
  - read-outcome
  - observability
  - api-design
  - rpc-composition
  - parity
---

# A composing handler cannot see the failures its dependencies swallow

## Context

Issue #7526 (PR #7872) added `GetCountryCoverage`, a read-only RPC serving the
country panel's coverage timeline to agents. Its headline guarantee was that an
empty result is never mistaken for a healthy one: every producer reports its own
state, so `events: []` plus a green status can be trusted as "nothing happened".

That guarantee was false on arrival, and the code looked correct. Each producer
call sat inside a `try`/`catch` that returned a `failed` state — the obvious
shape, and the shape a reader would sign off on. A cross-model review pass found
it by *running* the code rather than reading it: with `UPSTASH_REDIS_REST_URL`
blanked and `fetch` forced to 503, every producer reported `empty`, and the
detail string cheerfully said "the producer responded; nothing matched".

The reason is one layer down. The composed handlers each swallow their own
failures:

```ts
// server/worldmonitor/unrest/v1/list-unrest-events.ts:47
  } catch {
    return { events: [], clusters: [], pagination: undefined };
  }
```

`listEarthquakes` (`list-earthquakes.ts:28`), `listAcledEvents` and
`listMilitaryFlights` all do the same. A dead Redis therefore reaches the caller
as a **successful call returning nothing**. The composing handler's own
`try`/`catch` is unreachable for that class of fault — it can only catch what its
dependencies decline to catch.

This is [Read Outcome](../../../CONCEPTS.md) collapse, but relocated. The
concept describes a *read helper* that answers the same empty value for "the key
holds nothing" and "the read did not complete". Here the collapse happens a full
layer higher, inside a handler that reads correctly and then flattens the outcome
on its way out. The distinction is destroyed at a boundary the composing surface
does not own and cannot inspect from the outside.

## Guidance

**Get reachability from a signal beneath the swallowing layer.** Do not infer
health from whether the dependency threw, and do not infer it from the row count
it returned. Read something the dependency cannot flatten:

```ts
// Its status, not just its value: 'hit' | 'miss' | 'error'.
const read = await readCachedEnvelopeJson('unrest:events:v1', true);
```

Then let reachability decide the state *before* content does
(`_country-coverage-structured.ts:160`):

```ts
if (seed.status === 'error') {
  return { source, state: 'failed',
    detail: 'The backing cache could not be read... This is not evidence of a quiet period.',
    fetchedAtMs: 0, incidents: [] };
}
```

**Reserve the healthy-empty state for a proved read.** "Empty" is a *claim* that
the producer was reachable and genuinely had nothing. Make it only when
something proved reachability. When nothing did, say so with a distinct state —
this codebase uses `unknown` — rather than dressing uncertainty as health.

**Find whatever proof is available; it differs per dependency.** There is rarely
one mechanism:

| Dependency | Proof of reachability |
|---|---|
| Seeded snapshot | the key's own `hit`/`miss`/`error` status |
| Globally-scoped query | rows returned at all — even for another country — prove the upstream answered |
| Handler with a disabled sentinel | the sentinel itself (`scrapedAt: '0'` means retired, not quiet) |
| Live bbox-scoped query | nothing; an empty box is genuinely ambiguous, so report `unknown` |

**A health flag must be able to be false.** The first fix made `degraded` cover
every non-ok state — and because two producers are permanently unavailable by
design, it became `true` on every response and carried zero information. The
final rule (`get-country-coverage.ts:357`) counts only what can change:

```ts
degraded: sources.some(s => s.state === 'stale' || s.state === 'failed'),
```

Structural states are excluded and documented, and the per-producer block keeps
the full truth. Before shipping a health boolean, ask what input makes it false.
If no realistic input does, it is decoration.

**Do not let a budget imply an observation you never make.** A 48-hour staleness
budget was declared for a producer whose freshness came from
`conflict:acled-events:v1` — a key that exists nowhere in the repo, because
`list-acled-events` writes per-query composite keys instead. The read always
missed, the age always read 0, and the budget was dead code shaped like a
guarantee. A budget is only meaningful for a producer whose age you can actually
observe.

## Why This Matters

An endpoint that reports a dead upstream as a quiet week is worse than one with
no health reporting at all: it converts an outage into a confident negative
finding that an agent will act on. The failure is silent in exactly the
conditions it exists to detect, and every layer downstream inherits the
fabricated fact.

The defect also survives ordinary review. The `try`/`catch` reads as careful
error handling; only knowing that the dependency swallows first reveals it as
unreachable. That is why the detection method matters as much as the rule — see
Prevention.

## When to Apply

Whenever a new surface composes handlers whose error contract you do not own,
and whenever a response carries a health signal. It applies with extra force
when the surface's *purpose* is trustworthy status reporting, because then the
false guarantee is the product.

## Examples

**The trap — reads as careful, catches nothing:**

```ts
try {
  const response = await deps.listUnrestEvents(ctx, req);   // resolves [] on outage
  return settle(source, toIncidents(response), now);        // -> 'empty'
} catch (error) {
  return failed(source, errorDetail(error));                // unreachable for this fault
}
```

**The fix — reachability first, from a signal the dependency cannot flatten:**

```ts
const [response, seed] = await Promise.all([
  deps.listUnrestEvents(ctx, req),
  deps.readSeed('unrest:events:v1'),   // 'hit' | 'miss' | 'error'
]);
// settle() branches on seed.status BEFORE it looks at incidents.length,
// and only claims 'empty' when the read was proved to succeed.
return settle(source, incidents, seed, now, /* healthConfirmed */ true);
```

## Prevention

**Test the outage, not the exception.** Every state in the original suite was one
the test had built by hand: both halves were injected, so no test drove a
producer through the path production actually takes — dependency resolves empty
while the backing store is dead. Compose the *real* collector with the *real*
handler and assert on that:

```ts
it('a Redis outage degrades the response instead of reading as a quiet week', async () => {
  const response = await run({ readSeed: async () => ({ status: 'error', fetchedAtMs: 0 }) });
  assert.equal(response.degraded, true);
  assert.ok(response.sources
    .filter(s => s.source.startsWith('structured:'))
    .every(s => s.state !== 'empty'));
});
```

**Probe by execution when a guarantee is the product.** Blanking the store's env
vars and forcing `fetch` to 503 took seconds and falsified a claim that five
reading passes had accepted. For any "we always report X" promise, run the
failure rather than reading for it.

**Prove the guard can fail.** After fixing a defect, revert the fix and confirm
the new test goes red. A regression guard that has never been observed failing is
an assumption.

**Grep the key before declaring a budget over it.** A cache-key constant that
matches nothing in the repo is a silent no-op; the read simply misses forever.

## Related

This is the third member of a family. The other two cover the collapse where the
code is yours to fix; this one covers the case where it is not:

- [A degrading accessor turns a failed read into a confident absence](a-degrading-accessor-turns-a-failed-read-into-a-confident-absence.md)
  — the collapse inside an accessor you own
- [Never render a confident empty state from a loader that cannot distinguish a miss from a failure](never-render-a-confident-empty-state-from-a-loader-that-cannot-distinguish-miss-from-failure.md)
  — the collapse at the render boundary
- **This doc** — the collapse inside a dependency you do **not** own

The distinction is not academic: the sibling docs' remedy is to change the
accessor so it stops degrading — return `{ ok, value }` instead of a bare null.
That fix is *unavailable* here. You cannot change the dependency's signature, and
it will keep answering a fault and an empty result identically no matter how
carefully you call it. So the remedy inverts: instead of widening what the layer
returns, you go underneath it for a signal it never had the chance to flatten.

Also:

- `CONCEPTS.md` — **Failure-Opaque Dependency** and **Constant Health Flag**
  (added by this learning), extending **Read Outcome**
- [A health metric must report zero when it has no basis](../best-practices/a-health-metric-must-report-zero-when-it-has-no-basis.md)
  — the sibling rule for numbers; this doc is its counterpart for states and flags
- [A check that can no longer see its target must fail loudly](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md)
  — the same failure shape in guards rather than in responses
