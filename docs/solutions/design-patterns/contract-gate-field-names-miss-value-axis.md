---
title: "A contract gate that compares field names certifies a payload that violates the contract"
date: 2026-08-02
category: design-patterns
module: proto/sebuf contract gates, supply-chain shipping seeder
problem_type: design_pattern
component: testing_framework
severity: high
applies_when:
  - "Building or reviewing a gate that diffs a produced payload against a declared schema (proto, OpenAPI, JSON Schema, Avro, GraphQL SDL)"
  - "A schema declares fields optional/nullable and a producer and a serving handler could disagree about what missing means"
  - "A handler casts a cached blob or upstream response to its declared response type without field stripping"
  - "A gate's coverage roster is hand-written to mirror a composition site that lives elsewhere in the source"
  - "The schema has nested messages, arrays, or an envelope that a top-level name comparison would not descend into"
  - "Writing a parser self-check — any count pin used to validate another parser"
root_cause: missing_validation
resolution_type: tooling_addition
tags:
  - contract-tests
  - schema-drift
  - proto-optional-fields
  - null-vs-absent
  - mutation-testing
  - vacuous-guard
  - hand-mirrored-coverage
  - anti-drift
---

# A schema gate that compares field names certifies a payload that violates the contract

## Context

Two things are true of most schema-contract gates, and both are load-bearing failures.

**The first is the value axis.** A gate that computes `Object.keys(payload) \ declaredFields` answers exactly one question: is every emitted key declared? It says nothing about whether the emitted *values* satisfy the declaration. `optional double period_change_pct = 9;` in `proto/worldmonitor/supply_chain/v1/supply_chain_data.proto:33` means the field is **absent** when missing — that is what the generated TypeScript says (`periodChangePct?: number;`, `src/generated/server/worldmonitor/supply_chain/v1/service_server.ts:22`) and what the published OpenAPI says (`type: number` / `format: double`, no `nullable`, `docs/api/SupplyChainService.openapi.yaml:3679-3681`). A producer writing an explicit JSON `null` emits a *declared name* carrying an *undeclared value*. A name-only gate certifies it, green, forever.

**The second is coverage provenance.** A gate whose input roster is hand-copied from a composition site starts correct and stops covering the thing the moment someone edits the composition site. That is the exact hand-mirrored-copy drift the gate exists to prevent — reproduced one level up, inside the gate.

Both landed together. Issue #6078 (branch opened in #6078, unmerged as of this writing) started from PR #6074 growing every `supply_chain:shipping:v2` entry by four fields while `message ShippingIndex` still declared eight. `server/worldmonitor/supply-chain/v1/get-shipping-rates.ts:50` casts the Redis blob straight to `GetShippingRatesResponse` with no field stripping, so the public endpoint served four undeclared properties. Nothing failed: the OpenAPI schema sets no `additionalProperties: false` on `ShippingIndex`.

Closing it properly surfaced seven distinct ways a schema gate goes green while blind. The recipe below is those seven, generalized.

## Guidance

A non-vacuous schema-contract gate needs all eight of these. Each one below is a false-pass mode that was found live, not a hypothetical.

### 1. Gate the value axis at the serving boundary, not just the name axis

Decide what your schema's `optional` / `nullable` *means* on the wire, write it down, and enforce it where the response is built.

```ts
// server/worldmonitor/supply-chain/v1/get-shipping-rates.ts:20-22
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}
```

Two rules that make this fix correct rather than merely present:

- **Key on absence, never on falsiness.** `value == null` (not `!value`) — a published `0` move and a published `0` prior level are real readings. A `||`-based normalizer erases them and recreates the exact "unchanged period vs. no prior at all" conflation the fields were introduced to eliminate (#6066).
- **Assert on the serialized wire, not the in-process object.** `undefined` disappears from JSON; `null` does not. `tests/shipping-rates-handler.test.mts:92` round-trips through `JSON.parse(JSON.stringify(response))` before checking `!(field in entry)` — without that, the assertion tests your object graph, not what a client receives.

**Fix at the handler, not the producer, when a cache sits between them.** A producer-side fix only fixes forward: values already written to the cache keep being served. It also collides with any in-flight change to the producer's tests. Handler-side normalization is idempotent and covers the existing cache contents on the next read.

### 2. Derive the gate's coverage from the composition site — and pin the composition site itself

If your gate feeds itself from a hand-written roster, that roster is a second source of truth and it will drift. You cannot always avoid the hand-mirror; you *can* make the mirror break loudly.

```js
// tests/freight-indices.test.mjs:501-506 — the exact element lines of `allIndices`
const FETCH_ALL_INDEX_ELEMENTS = [
  '...(sh?.indices || []),',
  '...scfiResult,',
  '...ccfiResult,',
  '...bdiResult,',
];
```

Compared against the array literal parsed out of the real source (`tests/freight-indices.test.mjs:590-596`), which fails closed if the block cannot be located at all. Add a 5th producer to `scripts/seed-supply-chain-trade.mjs:836-841` and the gate reds with an instruction, instead of silently ignoring the new producer's entries.

Pin **every element line**, not the spread expressions you happen to use today. Matching only `...x` was blind to a bare `{ indexId: 'X', ... }` object literal, which reaches the payload identically.

### 3. Composing the collection is not the only way to add an entry

An element pin sees the literal. It cannot see appends or reassignment after composition. Pin those as source-level evasions:

```js
// tests/freight-indices.test.mjs:601-604 (assertion message elided)
for (const mutation of [/allIndices\s*\.\s*push\s*\(/, /mergedIndices\s*\.\s*push\s*\(/, /mergedIndices\s*\[[^\]]*\]\s*=/]) {
  assert.ok(!mutation.test(seedSrc),
    `The seeder mutates the composed index list (${mutation}) after fetchAll() builds it. ...`);
}
```

### 4. Descend into nested messages — and find the paths that reach the payload without passing a producer

Top-level keys are the easy half. Ask: *what else ends up in this payload, and did it pass through anything the gate inspects?*

`ShippingRatePoint` history points did not. `accumulateHistory` (`scripts/seed-supply-chain-trade.mjs:326-350`) both builds new points and copies old ones forward from the previous payload, so points reach the wire without touching any producer — no drift guard at all until the gate descended one array deep (`tests/freight-indices.test.mjs:579-582`).

### 5. Guard the envelope, not only its elements

The same cast-the-blob mechanism operates one level up. `GetShippingRatesResponse` (`proto/worldmonitor/supply_chain/v1/get_shipping_rates.proto`) was unguarded: a diagnostic added to the producer's return (`degraded`, `sourcesOk`, …) would have shipped undeclared exactly like the four field additions did. `tests/freight-indices.test.mjs:607-622` diffs the producer's return literals against the envelope message's declared fields, in both directions (`deepEqual` of sorted key sets — so an omitted declared field trips too).

### 6. Fixtures must cover every branch that can emit a field

A gate can only see fields a fixture materializes. Every original fixture took `periodChangeBasis === 'publisher_reported'`, so anything emitted only on the derived / no-prior / unchanged branch was invisible. The fix is one fixture per branch plus an explicit assertion that the branches are actually reached:

```js
// tests/freight-indices.test.mjs:627-629
const bases = new Set(producedIndices().map(e => e.periodChangeBasis));
assert.ok(bases.has('publisher_reported'), `missing publisher_reported branch; saw ${[...bases]}`);
assert.ok(bases.has('derived_from_prior_period_level'), `missing derived branch; saw ${[...bases]}`);
```

Pair it with **per-producer counts, not "non-empty"** (`tests/freight-indices.test.mjs:535-539`): a fixture that quietly stops yielding 4 of its 5 entries still clears a `> 0` check while shrinking what the gate inspects. And pin any allowlist non-empty at module load (`tests/freight-indices.test.mjs:407-409`) — an emptied allowlist makes every loop over it pass with zero assertions executed.

### 7. A self-check must be strictly LOOSER than the thing it checks

If your parser has a sanity pin ("I understood N of N fields"), the pin must match every form the parser matches **and the forms it misses**. Share the shape and both go blind together, agreeing at the wrong number.

```js
// tests/freight-indices.test.mjs:414-420
const PROTO_FIELD_RE = /^\s*(?:optional\s+|repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+\s*(?:\[[^\]]*\])?\s*;/gm;
// Deliberately LOOSER: must match every form the field regex matches AND the ones it misses.
const PROTO_FIELD_NUMBER_RE = /=\s*\d+\s*(?:\[[^\]]*\])?\s*[;[]/g;
```

The original count pin used the same `=\s*\d+\s*;` shape the field regex required. An options-carrying field — and `repeated DirectionalDwt directional_dwt = 13 [deprecated = true];` is already live in this very file at `supply_chain_data.proto:102` — dropped out of *both* counts, and they matched.

### 8. Normalize the source before you locate anything in it

Order of operations in a text parser is a correctness property. Strip comments from the **whole source before** extracting the block, and strip **both** comment forms:

```js
// tests/freight-indices.test.mjs:430-431
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const block = src.match(new RegExp(`message ${messageName} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
```

Stripping after extraction let a block-commented stale `message ShippingIndex { ... }` preceding the live one get selected — the gate would then certify against fields the proto does not declare. Stripping only `//` let a block-commented field keep counting as declared.

### 9. Extract the predicate, then mutate every guard — the survivors are the point

A check that only ever runs against conforming input proves nothing about what it does with a violation. Extract the pure predicate so it can be attacked directly (`tests/freight-indices.test.mjs:449-451`), then assert its *negative* behavior (`tests/freight-indices.test.mjs:697-701` feeds it a fabricated `freightRateOutlook` and asserts it is reported).

Then mutate. Twelve mutants were run against this gate; **two initially survived**, and each survivor was a real coverage hole:

- Removing the `_observationDate` strip on `accumulateHistory`'s already-has-history branch (`scripts/seed-supply-chain-trade.mjs:339`) survived, because no producer today emits `history` *and* an internal key at once — no fixture ever reached that branch. Closed with a synthetic probe that drives it directly (`tests/freight-indices.test.mjs:674-695`).
- A field emitted only on the `derived_from_prior_period_level` branch survived until a derived-basis fixture existed.

A mutation score of 100% on the first pass usually means you mutated the guards you already believed in. Mutate the obvious ones too.

## Why This Matters

The failure mode is not "we missed a bug." It is **false assurance**: a green gate suppresses exactly the doubt that would have found the problem. Four undeclared properties reached a public endpoint through a gate-shaped hole while the suite was green, and the schema's lack of `additionalProperties: false` meant no downstream validator caught it either.

The value axis matters most where a schema is generated into several consumer surfaces at once. Here the same `optional` produced `periodChangePct?: number` in TypeScript and a non-nullable `number` in OpenAPI — a strict client validating against the published schema would reject a `null` the server was happily emitting. Name-axis gates cannot see that class of violation at all.

And a hand-mirrored coverage roster is worse than no roster, because it *looks* like coverage in review. The gate reads as exhaustive; it is exhaustive over a set that stopped matching production at some commit nobody remembers.

## When to Apply

- Any gate diffing a produced payload against a schema — proto, OpenAPI, JSON Schema, Avro, GraphQL SDL.
- Any handler that casts a cached blob or third-party response to a declared response type without field stripping. That cast is the whole attack surface.
- Whenever a schema field is `optional` / `nullable` and a producer and a serving boundary could disagree about which one "missing" means.
- Whenever a test file hand-lists producers, routes, tools, or fixtures that mirror a list living elsewhere in the source.
- Before trusting any parser-with-a-sanity-count: check whether the count shares the parser's blind spot.

## Examples

**Before — a name-only gate over a hand-mirrored roster.** Every entry's keys are declared, so it passes; the seeder writes `periodChangePct: null` and `get-shipping-rates` returns it verbatim. Meanwhile the roster covers four producers because someone typed four, and the response envelope and the nested `ShippingRatePoint` are never examined at all.

**After — the gate reads both ends from the real thing.** The declared set is parsed from the proto (contract source of truth, comments stripped first, parse self-checked by a looser pin), and the emitted set is produced by the *real exported seeder functions* run through the *real* publish-time merge:

```js
// tests/freight-indices.test.mjs:569-584 (abridged)
const published = accumulateHistory(producedIndices(), previousPayload);
for (const entry of published) {
  assert.deepEqual(undeclaredKeys(entry, declared), []);
  for (const point of entry.history ?? []) {
    assert.deepEqual(undeclaredKeys(point, declaredPoint), []);
  }
}
```

Run over both `previousPayload` states (first run and steady-state merge), because the two take different code paths through `accumulateHistory`.

**A companion bug the new fixtures exposed.** `parseBdiIndices` built its observation date as `new Date("March 13, 2026")` — **local** midnight — then called `.toISOString()`, while the fallback in the same function used `new Date().toISOString()` (UTC). The two branches disagreed by a day everywhere east of UTC. `_observationDate` is `accumulateHistory`'s dedup key and feeds content-age reporting, so the skew silently re-dated history points depending on where the seeder ran.

```js
// scripts/seed-supply-chain-trade.mjs:258-262
const parsed = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]}`);
if (!Number.isNaN(parsed.getTime())) {
  articleDate = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
    .toISOString().slice(0, 10);
}
```

Verified by running the parse under four zones — the old form yields `2026-03-12` under `Europe/Paris` and `Pacific/Auckland` and `2026-03-13` under `UTC` and `America/Los_Angeles`; the `Date.UTC` re-read yields `2026-03-13` in all four. The generalizable rule: **when a function has two date sources, pin them to the same clock.** A parsed calendar date and a `new Date()` fallback are not interchangeable unless both are UTC.

`node --test tests/freight-indices.test.mjs` passes 49/49 at the current tree. The branch's full-suite verification is reported as 20,413 tests green.

## Related

- [Verify the verifier: mutation-test every detection layer](../conventions/verify-the-verifier-mutation-test-every-detection-layer.md) — the parent convention. Its Layer 3 (a comment-stripper swallowing real source) is mechanically the same failure as the block-commented-proto-field evasion here, pointed at a schema gate instead of a security scanner.
- [Closed-world classification gate for config completeness](./closed-world-classification-gate-for-config-completeness.md) — the same construction pattern: enumerate the universe from the source of truth, then guard the enumerator itself against parser-evasion mutants. This doc is a second concrete instance.
- [Key-existence checks cannot detect stale translations](../logic-errors/key-existence-checks-cannot-detect-stale-translations.md) — the closest cross-domain restatement of the core insight: shape checks compare key *sets*, so a wrong *value* is invisible to them by construction.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — a sibling schema contract test with a false-pass mode, found via handler stubbing rather than name-vs-value comparison.
- [TTL staleness audit must ignore comments](../logic-errors/ttl-staleness-audit-must-ignore-comments.md) — the inverse comment/code boundary bug: prose mistaken for config there, commented-out field still counted as declared here.
- [Country scope filter permissive default](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md) — precedent for the mirror-test anti-pattern: a check that re-implements the real logic verifies its own reimplementation, not reality.

Issues: [#6078](https://github.com/koala73/worldmonitor/issues/6078) (this work, unmerged as of this writing), [#6074](https://github.com/koala73/worldmonitor/issues/6074) (added the undeclared fields), [#6066](https://github.com/koala73/worldmonitor/issues/6066), [#6077](https://github.com/koala73/worldmonitor/issues/6077), [#6082](https://github.com/koala73/worldmonitor/issues/6082) (the value-axis follow-up: a closed two-value taxonomy declared as a bare string, so the name check passes while the closed set stays undiscoverable from the schema).
