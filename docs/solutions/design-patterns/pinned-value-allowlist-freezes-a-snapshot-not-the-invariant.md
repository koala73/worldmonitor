---
title: "A guard that pins the values which were wrong freezes a snapshot, not the invariant"
date: 2026-09-03
category: design-patterns
module: JSON-LD entity graph, schema-graph contract gates
problem_type: design_pattern
component: testing_framework
severity: high
applies_when:
  - "Writing a gate that stops several producers from contradicting each other under one shared identity (JSON-LD @id, a shared cache key, a denormalized row, a config fragment merged from several files)"
  - "A fix enumerates the specific fields that were found wrong and pins those"
  - "The gate's producer population is a hand-written path list rather than a discovered one"
  - "A shared identity can be both DECLARED (identity plus a body) and merely REFERENCED (identity alone) in the same document"
  - "Some properties of the shared entity legitimately differ per producer while others must not"
root_cause: missing_validation
resolution_type: tooling_addition
tags:
  - contract-tests
  - vacuous-guard
  - mutation-testing
  - json-ld
  - shared-identity
  - allowlist-vs-invariant
  - anti-drift
  - population-discovery
---

# A guard that pins the values which were wrong freezes a snapshot, not the invariant

## Context

Issue #7611: three surfaces each emitted their own node body under the shared JSON-LD identity `https://www.worldmonitor.app/#software`. A consumer merging by `@id` received two `applicationCategory` values for one entity — `FinanceApplication` from `/` and `/pro`, `SecurityApplication` from `/dashboard` — plus conflicting `@type`, `url`, `description`, `operatingSystem` and `sameAs`.

The obvious fix is the one that was written first: hoist the correct values into a shared module, normalize every surface to them, and add a contract case asserting each surface matches. It went red before the fix and green after. It looked finished.

It was not a guard. Review mutated `index.html`'s `#software.screenshot` so one surface disagreed with the other two and ran the case: **green**. `screenshot`, `author`, `isPartOf`, `datePublished` and `dateModified` are all single-valued and all agreed across surfaces — purely by luck. None was in the pinned set, because none of them happened to be wrong in September 2026.

That is the shape of the mistake. The bug report enumerates the fields that diverged; pinning exactly those enumerated fields produces a gate that certifies the snapshot the bug report described, and stays green for the next property that drifts. The invariant was never "these eight values are correct." It was **one `@id`, one body**.

Two smaller false-pass modes rode along, both found by attacking the guard rather than reading it:

- The producing documents were a hand-written five-path list, so a *new* surface claiming the identity was exempt by construction — while the case's own name claimed "every surface."
- The lookup used `.find()`, so a second, contradictory declaration *on the same page* passed.

## Guidance

### 1. Pin the decision, assert the invariant — they are different jobs

Keep a pinned set for the values that encode a product decision, because a test cannot re-derive "should this be `BusinessApplication`?" from the tree. But do not let the pinned set be the whole gate. Add a rule that holds over properties nobody enumerated:

```ts
// tests/schema-graph-contract.test.mts:324-343 (abridged)
for (const [path, node] of emitters) {
  for (const [property, value] of Object.entries(node)) {
    if (MAY_DIVERGE_ACROSS_SURFACES.has(property)) continue;
    (carriers.get(property) ?? []).push([path, value]);
  }
}
// then: every property two emitters both carry must deepEqual
```

Invert the allowlist into a denylist. `MAY_DIVERGE_ACROSS_SURFACES` (`tests/schema-graph-contract.test.mts:148`) names the four properties a consumer merges by union — `alternateName`, `keywords`, `offers`, `featureList`. Everything else must agree, whether or not anyone thought to pin it. The exemption list is short, closed, and each entry has a stated reason; the pinned list is free to stay small.

### 2. Absence is not divergence — do not conflate them

A single-valued property may legitimately be *missing* on one producer while being wrong to hold *two different values* across producers. In this graph `isPartOf` is absent on the welcome page, `datePublished` and `dateModified` are absent on the dashboard. None of those is a contradiction: a merge yields one value.

So the rule compares only producers that both state the property, and those three stay **out** of the exemption set. A cross-model reviewer read "absent on one surface" as "may hold two values" and proposed exempting them — that would have reopened the exact hole. The distinction is worth a comment in the code, because it is the first thing a reader gets wrong.

### 3. Discover the producer population; keep the hand-list as a floor

A hand-written roster of producers cannot notice a producer it does not list. This is the same failure as the hand-mirrored coverage roster in [contract-gate-field-names-miss-value-axis](./contract-gate-field-names-miss-value-axis.md) §2, reached from a different direction — there the roster mirrored a composition site, here it mirrored a set of served documents.

```ts
// tests/schema-graph-contract.test.mts:116 — walks committed HTML entry points
// plus anything generated under public/, rather than naming five paths
function jsonLdDocumentPaths(): string[]
```

Keep the hand-written list too, as a **floor** asserted with `assert.ok(emitters.has(path), …)`. Discovery catches a surface that *starts* claiming the identity; the floor catches a surface that *stops* declaring it. Neither direction is covered by the other.

### 4. Distinguish a declaration from a reference

In a graph where nodes link by identity, most occurrences of an `@id` are references — `{"@id": X}` and nothing else — not declarations. A naive "find nodes with this `@id`" treats every `isPartOf` back-reference as a producer, and the population explodes into noise.

```ts
// tests/schema-graph-contract.test.mts:89-105 (abridged)
if (node['@id'] === id && Object.keys(node).some((k) => k !== '@id' && k !== '@context')) {
  found.push(node);   // a body, not a bare reference
}
```

Keying on "carries more than the identity" rather than on the presence of `@type` avoids depending on a field a producer might omit. Walk nested values too — a declaration wrapped in `@graph` is invisible to a top-level scan.

### 5. Assert exactly-once per document, not first-match

`.find()` answers "is there a conforming declaration?" The question a merge consumer asks is "is there exactly one?" Two contradictory declarations on one page is the same bug at smaller scale, and `.find()` cannot see it:

```ts
// tests/schema-graph-contract.test.mts:306
assert.equal(declarations.length, 1, `${path} must declare ${id} exactly once`);
```

### 6. Double-enter the decision values when the test reads them from the module

Asserting *surfaces against a module* proves agreement, not correctness: a wrong edit to the module, faithfully copied into every surface, passes. The surrounding file already restated every canonical `@id` as a local literal for exactly this reason. Restating the whole property objects would be maintenance for no gain, so restate only the values that carry the decision:

```ts
// tests/schema-graph-contract.test.mts:266-272
assert.equal(SOFTWARE_SHARED_PROPERTIES['@type'], 'SoftwareApplication');
assert.equal(SOFTWARE_SHARED_PROPERTIES.applicationCategory, 'BusinessApplication');
```

Prose and link lists do not need a second entry — a silently mirrored typo in a description is not a realistic failure. The category that was actively wrong does.

### 7. Prove the guard by attacking it, and keep the harness

Every claim above was established by mutation, not by reading. The harness restores the tree between attacks and re-asserts a green baseline at the end, so a mutation that fails to revert cannot be mistaken for a passing guard:

| Attack | Before | After |
|---|---|---|
| `screenshot` diverges on one surface | GREEN | RED |
| unpinned `datePublished` diverges | GREEN | RED |
| brand-new surface declares a conflicting node | GREEN | RED |
| `@graph`-wrapped conflicting declaration | GREEN | RED |
| required surface stops declaring the node | GREEN | RED |
| two contradictory declarations on one page | GREEN | RED |
| conflicting block as `<SCRIPT TYPE = 'application/ld+json'>` | GREEN | RED |

The last row came from a peer model and is its own lesson: the reader regex accepted only a double-quoted lowercase `type="application/ld+json"`, so a conflicting block written with single quotes or different case hid from the discovery entirely. **A discovery-based gate is only as wide as its parser** — widening the population is pointless if the reader silently skips valid inputs.

## Why This Matters

The failure is false assurance, and it is worse here than an ordinary missed bug: the fix *looked* thorough. It had a red-then-green proof, a shared source of truth, and a test named after the invariant. A reviewer reading the diff would have approved it. Only executing an attack against the guard showed that the name on the test and the property it enforced were different things.

The generalizable trigger is a bug report that enumerates. When an issue says "these five fields disagree," the enumeration is evidence, not specification. Pinning the enumeration produces a gate whose coverage is exactly the set of failures that already happened — which is the one set guaranteed not to happen again.

## When to Apply

- Any gate whose expected values were derived from the list of things a bug report found wrong.
- Any shared identity that several producers write under: a JSON-LD `@id`, a denormalized row, a shared cache key, a config object merged from several files, a manifest assembled from multiple packages.
- Whenever a test's population of producers is a literal array of paths, module names, or route names.
- Whenever a lookup over a collection of candidates uses `.find()` and the real requirement is uniqueness.
- Whenever a test asserts a producer against a constants module that no production code imports — check whether anything independently states the intended value.

## Examples

**Before.** The pinned set was the eight properties #7611 named. `SOFTWARE_SHARED_PROPERTIES` held them, the case looped five hard-coded paths, and `.find()` took the first match. Mutating `screenshot` on one surface left it green.

**After.** `src/config/schema-graph-ids.ts:53` still holds the decision values, and its docstring says explicitly that it is *not* the whole guard. The case discovers producers, requires exactly one declaration each, asserts the pinned values, and then requires every non-exempt property two producers both state to agree.

A second-order payoff: the same review pass found the variant-dashboard rewriter anchored on the first *textual* `"url"` after its type anchor rather than the node's own property, so a valid reordering that moves `offers` ahead of it rewrites `offers[0].url` — one match, so the count bound accepts it and the wrong field changes silently. Anchoring on the node's own indentation makes a reorder match zero times and throw. The pattern is the same one as §1: a bound that counts matches cannot tell you *which* thing matched, exactly as an allowlist of values cannot tell you about the values it does not list.

Verified at PR [#7622](https://github.com/koala73/worldmonitor/pull/7622): 1873 tests across the suites touching these surfaces, `WM_EXPECT_BUILT_OUTPUT=1`, zero skips, plus the seven-attack mutation harness above.

## Related

- [A contract gate that compares field names certifies a payload that violates the contract](./contract-gate-field-names-miss-value-axis.md) — the closest sibling. Its §2 (hand-mirrored coverage rosters drift) and §9 (mutate every guard; the survivors are the point) are the same two lessons reached from a schema-payload gate instead of a shared-identity graph. This doc adds the third axis those two do not cover: even with a correct population and a correct name check, a pinned *value* set is an allowlist that freezes a snapshot.
- [Closed-world classification gate for config completeness](./closed-world-classification-gate-for-config-completeness.md) — enumerate the universe from the source of truth, then guard the enumerator. §3 here is a third instance.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — the floor assertion in §3 exists for this reason: discovery that finds nothing must not read as agreement.
- [Key-existence checks cannot detect stale translations](../logic-errors/key-existence-checks-cannot-detect-stale-translations.md) — shape checks compare key sets, so a wrong value is invisible by construction; §1 is the value-set analogue.

Issues: [#7611](https://github.com/koala73/worldmonitor/issues/7611) (the contradiction), PR [#7622](https://github.com/koala73/worldmonitor/pull/7622) (this work).
