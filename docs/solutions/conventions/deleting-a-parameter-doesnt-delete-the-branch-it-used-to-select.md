---
title: "Deleting a parameter doesn't delete the branch — audit what its absence now selects"
date: 2026-08-03
category: conventions
module: api/download.js desktop release asset selection
problem_type: convention
component: service_object
severity: high
applies_when:
  - "Removing a parameter, flag, or field from a caller because its value is no longer needed for computing the result"
  - "The parameter doubles as an implicit switch enabling a filter, guard, or validation branch, not just a data input"
  - "The caller-side deletion and the callee-side branch it feeds live in different files and get reviewed as separate diffs"
  - "Auditing an object-keyed lookup or dispatch table for attacker- or user-controlled keys"
  - "A deletion looks purely subtractive and 'obviously safe' because nothing downstream changed syntactically"
symptoms:
  - "A caller stops sending a parameter and its requests silently fall onto an unfiltered or unguarded branch, with no test failure"
  - "Existing tests stay green because their fixtures still supply the old parameter — the newly-exposed branch has zero coverage"
  - "A bare object lookup (OBJ[userInput]) treats inherited Object.prototype properties like constructor as present, passing an existence guard"
  - "A guard's remaining callers can be counted on one hand, and a cleanup removes the last one — the branch was already mostly inert before the change that finished it"
  - "Reviewers agree on a line, but their briefs named it — directed confirmation reads like independent convergence unless the briefs are re-read"
related_components:
  - service_object
  - testing_framework
  - development_workflow
tags:
  - parameter-deletion
  - implicit-branching
  - guard-coverage
  - code-review
  - mutation-testing
  - refactor-safety
  - release-asset-selection
  - prototype-pollution
---

# Deleting a parameter moves callers onto the branch its absence selects

## Context

Deletion diffs read as risk-free. When a value stops being meaningful — a query
parameter, a feature flag, a header, an optional field — the natural cleanup is to
stop sending it, and the change looks purely subtractive: fewer bytes on the wire, no
new behavior. The hazard is on the other side of the boundary. If the receiver branches
on that value's *presence*, dropping it does not remove a branch; it silently reselects
one. Whatever the receiver does when the value is absent is now what your most important
caller gets, and nothing in the caller's diff says so.

Before assuming the deletion is the whole story, count who else already reaches the
absence branch. A guard conditioned on an optional value tends to lose callers gradually,
so the deletion that removes the last one is usually finishing a decay rather than
starting it — and the other callers are where the bug has been living unnoticed.

The shape is worst when the parameter was never load-bearing for the thing it appeared
to control. Then it reads as decoration on the caller side and as a switch on the
receiver side, and only the receiver's code knows which.

This was found in a desktop-release change (issue #5908, PR #6124 — open and unmerged as
of this writing). The release model collapsed from "one binary per variant" to "one
published binary, variants switch in-app", so `src/app/desktop-updater.ts` stopped
appending `&variant=` to its download URL — correct, since no per-variant asset exists
any more. On the server, `api/download.js` had a ternary that used `variant` as the
switch enabling the World Monitor identity filter on the release asset. Dropping the
parameter moved the app's own update download — the single highest-volume caller — onto
the unfiltered branch, where any asset merely ending in the platform suffix could win.

## Guidance

**When you delete a value from a caller, read the receiver's branches on that value and
name what the absence branch now does for you.** Grep the receiver for the parameter,
find every `if (x)`, `x ? a : b`, and `x ?? default`, and answer one question per site:
"which arm do I land in now, and is it as strict as the one I left?"

Two follow-on rules make the class harder to reintroduce:

1. **Never gate a correctness or safety filter on an optional input.** If a filter states
   an invariant that holds for every caller, apply it unconditionally. A guard that
   applies only when an optional parameter happens to be present is a guard that any
   caller can disable by omission — usually without knowing the guard exists.
2. **Review both sides of a boundary in one pass.** A caller diff and a receiver diff in
   the same change are not independent concerns when one of them changes the input space
   of the other. If they are reviewed separately, no reviewer sees the pairing.

The related habit for the receiver: when the branch key is untrusted input, test
*presence on the object you own*, not truthiness of a property lookup. `obj[key]` walks
the prototype chain; `Object.hasOwn(obj, key)` does not.

## Why This Matters

The test suite stayed green through the whole regression, and that is the point. The
handler's stray-asset defense was asserted only for `variant=tech` — the strict branch —
so it guarded a call shape no shipped client used, while the variantless branch the
updater moved onto was covered by a single-asset fixture any implementation passes. Green
CI here was evidence that a call shape nobody sent still worked.

The filter was in fact already inert for most traffic. Only the updater ever sent a
variant; the in-app download banner, the README badges, and the machine-readable download
list all called the endpoint without one and had therefore always taken the unfiltered
branch. The deletion did not expose a safe endpoint — it removed the guard's last user,
finishing a decay that had been underway for as long as those other callers existed. That
is the more common shape: a conditional guard usually dies by attrition, one caller at a
time, and the deletion that removes the final one only looks like the cause.

**On what "caught it" is worth claiming.** Four passes flagged this line, but only one was
independent. The other three had been pointed at the variant/no-variant consistency
question in their briefs, so their agreement confirms a hypothesis rather than
corroborating a discovery — the reviewer who surfaced it unprompted was reviewing the
change's *verification fidelity* and noticed the tests defended the wrong branch. Treat
convergence as a strong signal only across reviewers whose briefs did not name the thing;
otherwise it measures how well the brief was written. Counting directed confirmations as
independent votes inflates confidence in exactly the situation where it should not, and
the roster is easy to check after the fact: read the briefs, not just the findings.

The blast radius is also asymmetric. Losing the filter did not break anything visible: a
download still resolved, still 302'd, still installed. It only mattered when a stray
asset ordered ahead of the real one — a leftover artifact on a release, an
attacker-influenced upload, a naming change upstream — at which point the app ships users
the wrong binary and the failure is silent on both ends.

## When to Apply

- Removing a query parameter, header, cookie, flag, or optional field from any caller.
- Retiring a feature flag whose false/absent path was never the tested path.
- Any receiver code of the form `param ? strictPath() : loosePath()` — treat the loose
  arm as the real default and take a census of who already reaches it before assuming
  your deletion is what put anyone there.
- Weighing whether reviewer agreement is corroboration: check whether the briefs named
  the finding before counting the votes.
- Migrations where one side of a client/server or producer/consumer pair changes shape
  and the two diffs land in the same PR under different review lenses.
- Any lookup keyed on user-controlled strings against a plain object literal.

## Examples

**Before** — the receiver on the base branch (`origin/main:api/download.js`), where the
strict path was reached only when `variant` was present:

```js
const asset = variant
  ? findAssetForVariant(assets, variant, matcher)  // identity-filtered
  : assets.find((a) => matcher(String(a?.name || ''))); // platform suffix only
```

The one-binary change rewrote the strict arm to a variant-agnostic
`findDesktopAsset(assets, matcher)` but kept the ternary — so the structure survived
while the caller stopped supplying the switch that reached it.

**After** — `api/download.js:80`, filter unconditional:

```js
const asset = findDesktopAsset(assets, matcher);
```

**The caller that triggered it** — `src/app/desktop-updater.ts:148` now builds
`.../api/download?platform=${platform}` with no `variant`. That single-line deletion is
the whole trigger; nothing else in the updater diff touched the endpoint.

**The census that reframes it.** Grepping the base branch for callers of the endpoint
shows the updater was the *only* one that ever sent a variant. The in-app download banner
(`src/components/DownloadBanner.ts:33-37`), the README download badges, and the
machine-readable download list (`public/llms.txt:106-109`) all called it without one, and
had therefore always been served by the unfiltered branch. Doing this census first would
have shown that the strict arm was already unreachable for most traffic — which reads as
a much louder signal than "this deletion introduces a risk", and points at deleting the
conditional rather than at preserving the parameter.

**Locking it down.** Two different kinds of test, because either alone is weak:

- A behavioral regression test that sends *no* variant with a decoy asset ordered first
  (`tests/download-handler.test.mjs:46-59`) — the case that had no coverage before.
- A source-level gate (`tests/desktop-one-binary-model.test.mjs:237-247`) asserting both
  `assert.match(handler, /const asset = findDesktopAsset\(assets, matcher\);/)` and
  `assert.doesNotMatch(handler, /variant\s*\?\s*findDesktopAsset/)`, so the conditional
  cannot be reintroduced by someone restoring "symmetry". A companion test
  (`tests/desktop-one-binary-model.test.mjs:220-235`) pins the caller side, including a
  `URLSearchParams` escape hatch that a literal `variant=` regex would miss.

**Same class, second instance in the same file.** The platform guard read
`if (!platform || !PLATFORM_PATTERNS[platform])`. `?platform=constructor` inherits a
truthy, callable value from `Object.prototype`, passes the guard, and then matches every
asset name — verified directly before fixing: for a plain object literal `P`,
`typeof P['constructor'] === 'function'`, and invoking that inherited constructor with
any asset name returns a truthy `String` object. Fixed at `api/download.js:58` with
`!Object.hasOwn(PLATFORM_PATTERNS, platform)`, pinned by
`tests/download-handler.test.mjs:61-73` looping `constructor`, `toString`, `__proto__`,
and `hasOwnProperty`. Both defects are the same failure to ask "what does this branch do
for an input I did not intend" — one for an absent value, one for an inherited one, and
both surfaced by review rather than by tests.

## Related Issues

- Issue #5908; PR #6124 (open, unmerged as of this writing).
- `api/download.js`, `src/app/desktop-updater.ts`,
  `tests/download-handler.test.mjs`, `tests/desktop-one-binary-model.test.mjs`.
