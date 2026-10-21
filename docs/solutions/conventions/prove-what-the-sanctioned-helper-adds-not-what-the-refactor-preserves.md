---
title: "Migrating onto a sanctioned helper: prove what the helper ADDS, not the behaviour the refactor preserves"
date: 2026-08-14
category: conventions
module: Panel content-write helpers and their migration coverage
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Migrating call sites from a raw primitive onto a sanctioned wrapper/helper that a guard or lint ratchet is pushing you toward"
  - "A refactor is described as behaviour-preserving and the existing suite stays green through it"
  - "Deciding what red-then-green evidence a migration PR actually owes, when the obvious behaviour was already correct"
  - "A ratchet or allowlist entry shrinks but does not vanish, and the remaining count looks like unfinished work"
  - "Only some writes in a method pair move onto the safe path, leaving siblings on the raw one"
symptoms:
  - "The migration diff is large but every existing test stays green, so no new test is written and the PR ships as an unproven refactor"
  - "A test added for the migration passes both before and after the production change, because it asserts the half that did not change"
  - "A ratchet entry left at x1 gets driven to zero by a later contributor who reads it as an unfinished migration"
  - "The guard's own remediation text advises the exact edit that introduces the regression"
  - "A sibling write in the same method is left on the raw path and becomes the only one missing the wrapper's protection"
related_components:
  - testing_framework
  - development_workflow
  - frontend_stimulus
tags:
  - migration-coverage
  - test-teeth
  - mutation-testing
  - ratchet-guards
  - refactor-proof
  - behaviour-preserving
---

# Migrating onto a sanctioned helper: prove what the helper ADDS, not the behaviour the refactor preserves

## Context

`Panel` (`src/components/Panel.ts`) exposes sanctioned content-write helpers — `setContentNodes` and `setTrustedContent` — added by #6557 along with a lint ratchet, `scripts/enforce-panel-content-writes.mjs`, that inventories every remaining raw `this.content` write and fails when one is added.

#6678 migrated five panels' success writes onto those helpers. The natural framing was "route the writes through the helper, the behaviour is the same" — and that framing is a trap, because it makes the migration look like it owes no new test.

It looked that way for a concrete reason. A predecessor PR (#6587) had already fixed the *observable* bug by adding an explicit `clearErrorState()` next to each raw write. So by the time the migration ran, the error-chip / countdown / backoff behaviour was already correct, and the whole existing suite — including the file specifically written to pin that behaviour — stayed green through the migration from the first commit.

A migration whose suite is green before you start is exactly the shape that ships unproven.

## Guidance

> **When a call site moves onto a sanctioned helper, the proof obligation is the delta between the helper and the code it replaced — not the behaviour both share.** List what the helper does that the old line did not; whatever survives that list is the thing the new test must assert, and the thing that must go red before the production change.

Work it mechanically. Read the helper, enumerate its steps, and strike every step the replaced code already performed:

```ts
protected setContentNodes(...children: DomChild[]): void {
  if (this._locked) return;            // (1) NEW — raw replaceChildren had no lock bail
  this.clearErrorState();              //     already done explicitly by the old code
  this.cancelPendingContentWrite();    // (2) NEW
  this.replaceContent(...children);    //     same write the old code performed
}
```

Three candidates survived. Two of them — `cancelPendingContentWrite()` and the `invalidateCommittedHtml()` inside `replaceContent` — turned out to be **unobservable for these five panels**, because none of them calls `setSafeContent`, so no debounced write can ever be pending and the committed-HTML cache is never consulted. Verifying that is part of the exercise, not a step to skip: it is what narrows the obligation honestly instead of padding the PR with tests that cannot fail.

That left exactly one: **the `_locked` bail**. It is also the one with a user-visible failure mode — a success render landing on a paywalled panel paints content straight over the upgrade CTA. So that is what the migration owed, and the test asserts it at every migrated call site:

```ts
// Non-vacuity first: unlocked, this write really does paint the panel's content.
await driveSuccess();
expect(content.querySelector(successSelector)).not.toBeNull();

panel.showLocked(['Premium feature']);
expect(content.querySelector('.panel-locked-state')).not.toBeNull();

await driveSuccess();

// The bail is the whole point: the CTA must survive a success render.
expect(content.querySelector('.panel-locked-state')).not.toBeNull();
expect(content.querySelector(successSelector)).toBeNull();
```

All six migrated writes failed this before the production change and passed after — the red-then-green the migration actually owed. Note the non-vacuity step: without it, a panel whose success render silently no-ops would satisfy the locked assertion for entirely the wrong reason.

### A shrinking ratchet entry can be a terminal state, not unfinished work

The same migration deliberately left each panel's **loading** branch on the raw write, because the helper clears through `clearErrorState()`, which resets `retryAttempt` — and resetting the backoff on a loading paint flattens the retry ladder to its 15s floor forever.

That leaves three ratchet entries at `x1` instead of gone. An `x1` reads like an unfinished migration, and the guard's own failure text made it worse by advising exactly the wrong edit:

```
These recorded writes no longer match the tree. Update LEGACY_DIRECT_CONTENT_WRITES
(lower the count, or delete the line) so the inventory keeps matching reality
```

A contributor who migrates the last loading branch drives the entry to zero, hits `stale`, is told to delete the line, does so, and ships a flattened retry ladder with a green guard.

Two fixes, both cheap: say so in the inventory (`an x1 here is the ratchet's terminal state, not an unfinished migration`), and make the guard's own remediation text name the hazard at the moment the maintainer reads it. A rule that lives only in a header comment is advice; a rule the failing tool states is enforcement-adjacent.

### Migrating one write can strand its sibling

`GdeltIntelPanel.renderTopicSummary` inserts a *sibling* before `this.content` rather than writing into it, so it correctly stayed off the wiping helpers. But `loadActiveTopic` calls it immediately before `renderArticles`, and once `renderArticles` gained the lock bail, the sibling insert became **the only lock-blind content write left in that pair** — able to paint a sparkline above the upgrade CTA the neighbouring write now refuses.

The general shape: **when only some writes in a method pair move onto the protected path, the protection is only as good as the least-protected sibling.** After migrating a call site, look at what runs next to it.

## Why This Matters

A behaviour-preserving refactor that ships with no new test is indistinguishable, in the repository's history, from one that quietly changed something. Worse, the green suite is actively misleading: it certifies the half that did not change.

The delta framing also prevents the opposite failure — writing tests for everything the helper does, including the parts that provably cannot fire for these call sites. Enumerate, strike what is shared, verify what is unobservable, and test what remains. Usually that is one property, and it is the one worth having.

## When to Apply

- Any migration onto a wrapper, helper, or sanctioned API that a lint gate or ratchet is steering call sites toward
- Any PR whose description contains "behaviour-preserving", "no functional change", or "pure refactor" while touching more than a couple of call sites
- When a guard's inventory entry shrinks rather than disappearing — decide explicitly whether the remainder is terminal, and record which
- When adopting a protection at one call site, before assuming the enclosing flow is protected

## Examples

**Deciding the obligation** — enumerate, then strike:

| Helper step | Old code did it? | Observable here? | Owed a test |
|---|---|---|---|
| `if (_locked) return` | no | yes — paints over the paywall CTA | **yes** |
| `clearErrorState()` | yes (explicit call, #6587) | n/a — unchanged | no |
| `cancelPendingContentWrite()` | no | no — panel never calls `setSafeContent` | no |
| `invalidateCommittedHtml()` | no | no — cache never consulted | no |

**Proving the loading-branch rule has teeth** — the assertion must fail when the branch is migrated. Mutating both loading branches onto `setContentNodes` produced exactly the intended symptom:

```
AssertionError: expected 'Retrying... (15s)' to match /\(30s\)/
```

The ladder had been reset by a loading render. Without that mutation check the two cases would have been assumed-good; with it they are known-good.

**Guarding the guard's advice** — the `stale` branch now names the hazard before repeating the remediation:

```
FIRST, though: if the write that vanished was a LOADING branch, check it did not
move to setContentNodes — that clears through clearErrorState() and flattens the
retry ladder to its 15s floor. [tests] red if it did. Routing a loading branch
through the inherited showLoading() is fine and legitimately zeroes the entry.
```

Note the last sentence: the warning names the *legitimate* way to reach zero too, so it steers rather than simply forbidding.

## Related

- [Mutate each call site: a global mutant proves the helper is reachable, not that each site is covered](mutate-each-call-site-a-global-mutant-hides-per-site-holes.md) — the companion rule for *where* to mutate once you know *what* to prove
- [Verify the verifier: mutation-test every detection layer](verify-the-verifier-mutation-test-every-detection-layer.md)
