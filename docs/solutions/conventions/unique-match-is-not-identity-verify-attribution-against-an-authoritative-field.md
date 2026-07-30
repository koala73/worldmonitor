---
title: "A unique match is not an identity: verify attribution against an authoritative field"
date: 2026-07-28
category: conventions
module: intelligence company resolution (SEC EDGAR)
problem_type: convention
component: service_object
severity: high
applies_when:
  - "Re-enabling an endpoint that was disabled because it produced fabricated or misattributed data"
  - "Resolving a user-supplied identifier (domain, name, slug, email host) to a real-world entity"
  - "Reviewing code where a lookup falls back from an exact key to a fuzzy or prefix match"
  - "A resolver returns a single candidate and the caller treats singularity as proof of correctness"
  - "Deciding what an entity lookup should return when it cannot confirm a match"
related_components:
  - service_object
  - testing_framework
tags:
  - attribution
  - entity-resolution
  - fail-closed
  - fabricated-data
  - mutation-testing
  - sec-edgar
---

# A unique match is not an identity: verify attribution against an authoritative field

## Context

WorldMonitor's `get-company-enrichment` and `list-company-signals` RPCs were deliberately
disabled in PR #3777 (issues #3754/#3755) because they **fabricated** company intelligence:
they guessed a code-host org from a domain label and attributed whatever that guessed
identity returned. Any domain whose label collapsed to an unrelated org slug was assigned
someone else's footprint. The handler doc block set the bar for re-enabling:

> Re-enable only behind a verified attribution model (maintained company-to-code-host
> registry plus proper filer-CIK matching), never with another domain-slug heuristic.

Issue #5695 asked for the real data product. The obvious reading of that bar — "resolve
through an authoritative registry instead of guessing" — is necessary but **not sufficient**,
and the gap is subtle enough that it survived several rounds of self-review.

## Guidance

When resolving a user-supplied identifier to an entity, **uniqueness of the match is not
evidence that the match is correct.** Treat a non-exact match as *provisional* until it is
confirmed against a field the authoritative source itself publishes about that entity.

**Then check that the confirming field actually exists before building on it.** This
learning's own first implementation failed that check — see "What Didn't Work" below.

Concretely, the resolution ladder that shipped:

```ts
// ticker: exact key in the SEC registry — authoritative, done.
if (ticker) { ... return { status: 'ok', company: { ...entry, matchedBy: 'ticker' } }; }

// name: exact title, else a prefix match that is UNIQUE ACROSS FILERS.
// An ambiguous prefix resolves to NOTHING — picking the "most canonical"
// title is a coin flip between two real companies.
if (name) { const company = matchByName(map, name, { requireUnique: true, matchedBy: 'name' });
            return company ? { status: 'ok', company } : { status: 'not_found' }; }

// There is deliberately NO domain path — see below.
```

Three rules generalize out of this:

1. **Ambiguity resolves to nothing, never to a tie-break.** Sorting candidates by title
   length and taking the first is a guess wearing a heuristic's clothing.
2. **Confirm a low-precision match against a field the authority publishes about the
   entity** — not against a restatement of the input.
3. **If that field does not exist, do not offer the lookup key at all.** A guard that can
   never pass is not safety; it is a feature that silently never works.

Rule 3 is the one that cost the most to learn, and it has a cheap precondition: before
designing a confirmation step, *fetch the confirming field from the real upstream* and see
whether it is populated.

## What Didn't Work

**A confirmation step built on a field the authority does not populate.** The first
implementation kept a `domain` lookup, marked it provisional, and confirmed it against the
filer's SEC-registered `website` from the submissions record. The guard was correct, the
tests were green, and the feature was dead: SEC publishes that field but leaves it empty.
Sampling 15 filers found **0 populated**, Apple and NVIDIA included:

```
DELTA AIR LINES  website=''    Apple Inc.  website=''    NVIDIA CORP  website=''
FEAM ''   SBH ''   RDHL ''   TRU ''   MAAS ''   XE ''   VNRX ''   ... (0 of 15)
```

Because the helper fails closed, every domain request returned the empty envelope. The
`domain` parameter was documented in the OpenAPI surface and exposed to agents through MCP,
and it could not succeed for any input.

Two things hid it:

- **The test fixture supplied a website the real upstream never sends.** It was hand-written
  from the submissions *schema* rather than a captured payload, so it asserted against a
  shape that does not occur. Green tests were evidence about the fixture, not the feature.
- **Eleven reviewers, including two adversarial models, all read code.** None queried the
  live upstream. Reviewing the guard's logic can only tell you the guard is correct — not
  that its input is always empty.

The fix was to remove the domain path from active use (the v1 proto fields remain deprecated
at their original field numbers, handlers preserve the safe empty compatibility stub, and
the MCP param is dropped), which is what rule 3 above prescribes. A near-miss worth recording:
it is tempting to
re-source confirmation to a third-party profile's URL, which *is* populated — but that
confirms the *provider's* opinion of the pairing, not the authority's, and it quietly
reintroduces a dependency the attribution model was built to avoid.

## Why This Matters

`requireUnique: true` alone feels like it closes the hole, and it closes the *ambiguous*
case — but not the **wrong single match**, which is the one that actually ships bad data:

A domain label carries no relationship to a filer's legal title, so "exactly one filer's name
starts with this label" answers a question about the *registry's contents*, not about who
owns the domain. Whether any given label lands on the right company is luck: measured
against the live registry, `delta` happens to match one filer and it is the right one
(DELTA AIR LINES, INC.), while `apple` matches three distinct filers and `com` matches 36.
Uniqueness is a property of the label's collision rate, not evidence of ownership — so the
one-match case is exactly as unjustified as the three-match case, it just looks confident.

When it lands wrong, the caller receives a well-formed envelope with a real CIK, real
filings, and a real market cap — all belonging to a company they never asked about.

That is indistinguishable, from the outside, from the fabrication that got these endpoints
disabled in the first place. A resolver that returns *nothing* is a visible gap a caller can
handle; a resolver that returns *the wrong company* is a silent data-integrity failure that
looks like success.

This is the same failure shape already documented in this repo:
[a permissive default that leaked unattributed alerts](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md)
(fixed by inverting to default-DROP + explicit allowlist) and
[authority-gated seed sources](../integration-issues/authority-gated-cyclone-seed-sources.md)
(never infer identity/equivalence from a name match alone). The recurring lesson is that
**identity inference must be admitted explicitly, not fallen into by default.**

## When to Apply

Ask the confirmation question whenever **all** of these hold:

- The input is user-supplied and low-precision (a domain, a display name, a slug)
- The lookup can succeed with a single candidate without that candidate being right
- Being wrong produces confident, well-formed output rather than a visible error

Skip it when the identifier is an exact key in the authority's own namespace (a ticker, a
CIK, a UUID) — there is nothing to confirm.

Then check whether a confirming field is actually available, **by fetching it**, before
building on it:

- **Available and populated** → provisional match plus confirmation, failing closed.
- **Absent, or published-but-empty** → drop the lookup key, or return the candidate
  *clearly marked unconfirmed*. Do not ship an unmarked guess, and do not ship a guard that
  can never pass — it reads as safety while delivering nothing.

## Examples

**Verify the field before designing around it.** One command would have prevented the
dead-feature detour, and it is the same shape as the earlier registry probes:

```
$ curl -s -H "User-Agent: <declared>" https://data.sec.gov/submissions/CIK0000320193.json \
    | python3 -c "import json,sys; print(repr(json.load(sys.stdin).get('website')))"
''
```

**Prove any guard you do keep with mutation.** A test that passes both with and without the
guard is not coverage, and this class of guard is especially easy to write tests around that
never exercise it. Neutering the condition must turn exactly the intended tests red:

```
# guard neutered:  if (false && <guard condition>)
✖ refuses a unique-but-unconfirmed match
✖ refuses an unconfirmed match for signals too
ℹ pass 31   ℹ fail 2

# guard restored:
ℹ pass 33   ℹ fail 0
```

That mutation run is what proved the guard was wired correctly — and it is worth noting it
proved *only* that. A guard can be correctly wired, correctly mutation-tested, and still
never fire in production, which is why the field-availability probe above is a separate
check and not a substitute.

**Fixtures must mirror the payload, not the schema.** The fixture that hid this was written
from the submissions schema and supplied a `website` value the upstream never sends. Pin
fixtures to a captured real response, and when a field is documented but empty in practice,
encode the emptiness:

```ts
// SEC publishes this field but leaves it EMPTY in practice — 0 of 15 sampled
// filers populate it, Apple and NVIDIA included. The fixture mirrors that, so
// nothing here can depend on a value the real upstream never sends.
website: '',
```

Two independent adversarial reviewers on **different model families** (Codex and an Opus
in-process reviewer) converged on the uniqueness-is-not-identity finding — the strongest
signal in an 11-reviewer pass, and worth more than agreement among reviewers sharing a
model. But all eleven read *code*; none queried the upstream, which is why the dead-field
problem survived them and surfaced only when a later pass probed the live API. Model
diversity buys independence of reasoning, not independence of *evidence* — if every
reviewer reads the same artifact, they share its blind spots.

Shipped in PR #5738 (issue #5695). See also
[mutation-test every detection layer](verify-the-verifier-mutation-test-every-detection-layer.md)
for why the mutation step above is non-optional.
