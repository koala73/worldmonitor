---
module: search-links
date: 2026-11-10
problem_type: logic_error
component: tooling
severity: low
symptoms:
  - "`node scripts/search-links.mjs --write` would create empty ledgers for families with no links"
  - "An existing empty ledger survived `--write` because it compared equal to the empty proposal"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [generated-files, ledger, idempotence, lastmod, empty-state]
---

# A writer that skips empty files must compare presence, not content

## Problem

`scripts/search-links.mjs --write` rewrites each family's ledger under `scripts/data/search-links/` when its links change. Every ledger file, even an empty one, feeds a page's lastmod. So a family with nothing to hold must have no file at all. The comparison that decides whether a family changed got both empty cases wrong.

## Root cause

The comparison checked content only. A missing file (`undefined`) serialized differently from an empty proposal (`{ pages: {}, exclusions: [] }`), so `--write` created an empty file for every family with no links. My first fix treated "both empty" as equal. That made an existing empty file look unchanged, so it was never removed. CodeRabbit found the second case on #10380.

## Solution

When the proposal is empty, the family is unchanged only if no file exists. An empty proposal deletes any file that is there.

```js
const isEmptyLedger = (ledger) => !ledger
  || (Object.keys(ledger.pages ?? {}).length === 0 && (ledger.exclusions ?? []).length === 0);

const sameLinks = (left, right) => (isEmptyLedger(right)
  ? !left
  : JSON.stringify({ pages: left?.pages, exclusions: left?.exclusions })
    === JSON.stringify({ pages: right.pages, exclusions: right.exclusions }));
// in the write loop: if (isEmptyLedger(ledgers[family])) { rmSync(file, { force: true }); continue; }
```

The test "writes no ledger for a family with nothing to hold, and removes one the proposal empties or that is already empty" in `tests/search-links.test.mjs` covers three cases: a missing file, a populated file the proposal empties, and a file that is already empty.

## Prevention

When "absent" is the only valid empty state, model three file states: missing, empty and populated. Test the change matrix across all three. The old CLI fixture seeded an empty ledger for every family, a state the real repository no longer had, and that hid both bugs. Fixtures should start from the states the repository can actually be in.
