---
module: i18n
date: 2026-07-26
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "/pro pricing page advertised 'No commercial use' in 23 languages beside a tier sold as commercially licensed"
  - "Translated feature bullets described the wrong feature after an English array had an element inserted"
  - "Every locale test passed: key counts, schema shape, and completeness checks were all green"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - documentation
  - development_workflow
tags:
  - i18n
  - localization
  - translation-staleness
  - ci-guards
  - unicode
---

# Key-existence checks cannot detect stale translations

## Problem

`scripts/translate-locales.mjs` backfilled only locale keys that were **absent**. When English copy was *edited*, every translation of it was skipped as "already present" and silently kept its old meaning. Worse, inserting one element into an English array shifted every later index onto a different English string, so existing translations became actively wrong rather than merely stale.

## Symptoms

The Pro Business pricing restructure (#5635) rewrote 14 English strings that all 24 non-English locales already had translations for. The result on `/pro`:

| key | English said | 23 locales said |
|---|---|---|
| `pricing.tiers.api.highlightFeatures[0]` | Commercial license — for your organization | **No commercial use** |
| `pricing.tiers.pro.features[6]` | MCP + SDK access… (50 calls/day) | Priority data refresh |
| `pricing.tiers.apiBusiness.features[4]` | 5 Pro licenses included | Same company email required *(deleted from the tier)* |

The page shipped the exact contradiction the restructure existed to remove — in translation — while `tests/pro-locale-registry.test.mjs` and `tests/locale-completeness.test.mjs` stayed green.

A locale can also be *fully English* and pass everything: `fa.json` had 571 of 582 values identical to the English source, so it matched the schema perfectly (#5644).

## What Didn't Work

- **Key-existence and schema-shape checks.** Both existing locale tests compare key *sets*. A stale value is a present value, so neither can see it. This is the whole defect class.
- **Assuming the file diff would show it.** The locale diff looked like a normal translation update; nothing in it says "this Portuguese string now describes a different English sentence."
- **Re-running the translator.** It only resends absent keys, so it re-confirmed the rot as complete.

## Solution

Record **provenance**: which English string each committed translation was produced from.

```js
// scripts/locale-baselines/pro-test.json — a flattened snapshot of en.json
// as of the last completed pass. A key whose baseline text no longer matches
// en.json is stale and gets retranslated alongside the missing ones.
export function classifyKeys(localeFlat, expected, baselineExpected, baselineExists = false) {
  const missing = [], stale = [], untracked = [], fresh = [];
  for (const [key, en] of Object.entries(expected)) {
    if (!(key in localeFlat)) missing.push(key);
    else if (!(key in baselineExpected)) (baselineExists ? stale : untracked).push(key);
    else if (baselineExpected[key] !== en) stale.push(key);
    else fresh.push(key);
  }
  // A locale value the English no longer has — removing the LAST element of an
  // English array leaves every earlier index matching, so nothing is stale.
  const orphan = Object.keys(localeFlat).filter(k => !(k in expected) && !isPrivateKey(k));
  return { missing, stale, untracked, orphan, fresh };
}
```

**Seed the baseline from the English the translations were actually made from**, not the current file. Seeding from current English would declare all 24 rotted locales fresh and freeze the bug permanently. Here that meant `git show origin/main:pro-test/src/locales/en.json`.

The CI gate is one assertion: **the baseline must equal `en.json`**. English copy changing without a translation pass is exactly the drift, and it reds the build.

## Why This Works

Staleness is a property of `(what it was translated from, what it says now)`. Shape-only checks read just the second half, which is why they are structurally blind to it — no amount of tightening key comparison finds a stale string. Recording the first half makes the comparison possible at all.

Note the asymmetry the `orphan` class covers: `classifyKeys` iterates English-derived keys, so it verifies English ⊆ locale but never locale ⊆ English. Removing the *last* element of an English array leaves every remaining index matching, so nothing is stale and 24 languages keep advertising a removed bullet.

## Prevention

**A provenance baseline is only safe if advancing it is paranoid.** Advancing is irreversible — it declares every translation correct against current English, and nothing re-examines a blessed key. Two holes found by adversarial review, both proven by execution:

1. **"Unprovenanced" is only benign during first adoption.** Locale files are written per batch while the baseline advances only on a clean pass, so "locales moved, baseline did not" is the normal outcome of any partial run. Once a baseline exists, a key missing from it means the baseline *lost entries* — treating that as fresh certifies rot permanently.
2. **A deleted baseline is indistinguishable from a first run.** `rm` the file, re-run, and every key is "untracked": the run exits 0 with zero API calls and re-adopts whatever the locales currently say. Adoption must be an explicit flag (`--adopt-baseline`), never inferred from absence.

```js
export function mayAdvanceBaseline({ unresolved, rejected, untracked, baselineExisted, adoptBaseline, dryRun }) {
  if (dryRun) return { advance: false, reason: 'dry run' };
  if (unresolved > 0) return { advance: false, reason: `${unresolved} key(s) still missing, stale or orphaned` };
  if (rejected > 0) return { advance: false, reason: `${rejected} translation(s) rejected` };
  if (untracked > 0 && !adoptBaseline) return { advance: false, reason: 'baseline lost entries or was deleted' };
  return { advance: true, reason: 'every locale complete and fresh' };
}
```

**A deterministic validator rejection makes a retry loop non-convergent.** `validateTranslation` treated any slash-plus-letter as a path that must survive translation, so `calls/day` and `requests/minute` read as `/day` and `/minute`. Any natural rendering ("250 Aufrufe pro Tag") was rejected for "dropping a URL" — *every time*. `setNested` had already created the array slot, so those keys serialised as literal `null` in nine files and no number of re-runs could fill them. When a retry loop stops converging, suspect a deterministic rejection rather than flaky output.

The mirror case matters too: German and French render a monthly price as `69,99 $/Monat`, so the *translation* gained a "path" the English lacked and was rejected for inventing one. And over-narrowing has its own cost — requiring a non-alphanumeric before the slash silently stopped matching `worldmonitor.app/docs/api-keys` (a real URL in `src/locales/en.json`), so a translation could delete it unnoticed.

**Scope a security-scanner carve-out to code points, not paths.** Persian ZWNJ (U+200C) and Devanagari ZWJ (U+200D) are *required* typesetting, and `scripts/check-unicode-safety.mjs` was rejecting every commit that added correctly-typeset Persian — very likely why `fa` was left in English. The tempting fix is to exclude the locale directory, but that disables Trojan Source detection on strings that render as prices and licence terms; a bidi override in an RTL locale can reverse a rendered digit run so the page shows something other than the JSON a reviewer reads. Allow the two code points the rationale names and keep scanning for everything else:

```js
const LOCALE_ALLOWED_CODEPOINTS = new Set([0x200c, 0x200d]);
const kind = localeData && LOCALE_ALLOWED_CODEPOINTS.has(cp) ? null : classify(cp);
```

**Pin a scope guard in both directions.** A test asserting only what a scanner *skips* stays green when the scanner is gutted — replacing `SCAN_ROOTS` with a single entry left the suite 7/7. Deep-equal the roots and the exclusion list, and assert a representative in-scope file under every root.

**Thresholds that cannot fire are worse than none.** A "fail if >50% of values are identical to English" rule sounds strict; at 582 shared keys it only trips above 291, so a locale could gain 251 raw-English values and pass. Per-locale ceilings taken from real counts fire on actual regression.

**Two adjacent defects this work surfaced, both worth checking in any similar scanner:**

- `getExtension` used `path.lastIndexOf('.')` over the whole path, so `.husky/pre-commit` reported an extension of `.husky/pre-commit` and never matched the `''` entry that existed to cover it. The git hooks — listed in `SCAN_ROOTS`, executed on every commit — had never been scanned. Take the basename first.
- A branch-contamination pre-push guard counting `origin/main..HEAD` blocks every stacked PR, charging it for its parent's commits. Count against the tracked upstream when there is one.

## Related

- Issue #5633 — the locale rot; PR #5655 — this fix
- Issue #5644 — `fa.json` ships as an English placeholder (565/582 values are the English source); provenance cannot detect this, so a ceiling pins it instead
- Issue #5645 — `src/locales/` (~2,400 keys × 24 locales) still has only key-existence checking; the script is root-agnostic, only seeding and adoption are missing
- [i18n shell namespaces are byte-budgeted first-paint surface](../conventions/i18n-shell-namespaces-are-byte-budgeted-first-paint-surface.md)
