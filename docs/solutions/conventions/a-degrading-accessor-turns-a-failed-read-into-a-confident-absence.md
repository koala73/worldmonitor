---
title: "A degrading accessor turns a failed read into a confident absence"
date: 2026-09-07
category: conventions
module: src/utils/safe-storage.ts, src/utils/cloud-prefs-sync.ts, src/utils/settings-persistence.ts
problem_type: convention
component: service_object
severity: high
applies_when:
  - "Migrating raw localStorage/sessionStorage calls onto a shared safe accessor that swallows failures and returns null"
  - "A call site treats an absent value as user intent (cleared, opted out, empty set) rather than as an unknown"
  - "A local read feeds a payload that REPLACES remote state wholesale rather than merging into it"
  - "Cross-tab state (dirty-key sidecars, generation counters, version markers) is read-modify-written from storage"
  - "A cleanup or sign-out path early-returns on an unreadable value, skipping steps that must run unconditionally"
  - "A success or failure toast is derived from whether the wrapped call threw"
tags: [localstorage, safe-accessor, fail-closed, silent-data-loss, cloud-sync, cross-tab-state, accessor-migration, hit-miss-failure]
---
## Context

PR #7840 (`fix(storage): stop the null-localStorage crash class recurring`, follow-up to #7832) fixed issue #7833 by migrating `cloud-prefs-sync.ts` and `settings-persistence.ts` off raw `localStorage.getItem()`/`setItem()` calls onto the degrading accessors in `src/utils/safe-storage.ts` (`safeStorageGet`, `safeStorageSet`, …). Those accessors exist because Android WebView with DOM storage disabled makes `localStorage` itself `null` — a `TypeError` on every access — and sandboxed iframes / blocked cookies make the property throw (WORLDMONITOR-122 and related). The fix worked: the crash class went away. But code review on the same PR found that the mechanical swap had opened a second, quieter failure class in every call site that read a synced value and treated its absence as meaningful — and it kept finding new instances as the review went round after round. Six are enumerated below, all in `src/utils/cloud-prefs-sync.ts` unless noted, all traceable to the same one-line cause.

## Guidance

`safeStorageGet` degrades a throwing read to `null` on purpose — see the doc comment at `src/utils/safe-storage.ts:1-18`. That is correct for a flag with a sane default. It is wrong wherever the caller's next move depends on *why* the value is missing:

```ts
// src/utils/safe-storage.ts:20-26
export function safeStorageGet(key: string): string | null {
  try {
    return localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
```

The raw `localStorage.getItem()` this replaced threw on a broken store, and the throw propagated up and aborted whatever operation was mid-flight. `safeStorageGet` removes the crash — and, as a side effect nobody asked for, removes the abort. A read that fails now looks identical to a read that succeeded and found nothing. Any code that branches on "is this value present" rather than "did I get an answer" inherits the bug silently, with no type error and no test failure, because `null` was already a valid return value before the migration.

The fix is a **checked accessor** family that returns `{ ok: boolean, value }` instead of degrading (`safeStorageGetChecked`, `safeStorageSetChecked`, `safeStorageRemoveChecked`, `safeStorageSnapshot` — `src/utils/safe-storage.ts:100-171`), paired with a classification pass over every existing degrading call:

- **Absence is intent** (the caller will act on "not present" as a real signal — delete a cloud key, skip a migration, treat a version as unreconciled) → switch to the checked accessor and **fail closed**: on `ok: false`, abort the operation instead of proceeding on a guess.
- **Absence is a default** (a UI flag, a feature toggle with a safe fallback) → the degrading accessor is still correct. Leave a comment at the call site saying so, because the whole point of this bug class is that it is invisible to a reviewer who doesn't already know the difference.

Two contract details fell out of getting this right in #7840:

**1. The checked *write* variant needs an asymmetric contract.** `safeStorageSetChecked` returns `true` for two different situations that must not be conflated — a successful write, and "there is no store at all" (`src/utils/safe-storage.ts:100-109`):

```ts
export function safeStorageSetChecked(key: string, value: string): boolean {
  const store = storageHandle();
  if (store === null) return true;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
```

`false` is reserved for "a usable store existed and refused the write" (quota, private-mode restrictions). The first round of this fix returned `false` for *any* failure to write, including "no store at all" — which meant every cloud-pref write on a sandboxed iframe or with cookies blocked looked like a rejection, and sign-in terminated in an error state on every load (comment at `src/utils/safe-storage.ts:50-55`, "#7833 review, second round"). The asymmetry matters because a missing store is self-consistent (nothing was written, nothing durable disagrees, the next load re-reconciles from scratch) while a rejected write on an otherwise-working store leaves local and cloud state disagreeing about what happened.

**2. Retrieve the storage handle in its own guarded step, not inside the write's `try`.** `storageHandle()` (`src/utils/safe-storage.ts:57-63`) is called before the write's own try/catch specifically so a throwing `localStorage` *getter* (the sandboxed-iframe shape) doesn't fall into the write's catch block and get misreported as "the store rejected this write" — the exact bug in point 1.

**3. When several durable markers must land together, order them so a partial failure can't leave a durable claim that the whole operation succeeded.** `runSignInAttempt` writes `KEY_LOCAL_SCHEMA_VERSION` before `KEY_SYNC_VERSION`, deliberately (`src/utils/cloud-prefs-sync.ts:994-1012`):

```ts
// ORDER IS LOAD-BEARING: the schema marker persists BEFORE the sync
// version. Both writes are checked, but advancing the version first
// leaves a durable claim that this cloud generation was reconciled
// while the schema marker is still old — and the next sign-in sees
// equal versions, takes the local-upload branch, and reruns one-shot
// migrations over already-migrated data (#7833 review).
if (!setLocalSchemaVersion(migrated.schemaVersion)) { ... return; }
if (!setSyncVersion(cloud.syncVersion)) { ... return; }
```

If the sync-version marker landed first and the schema marker's write then failed, a future load would see "this generation is fully synced" (sync version matches) while the schema marker still claims the old, pre-migration schema — and would re-run a one-shot migration over data that had already been migrated. The same ordering rule appears again in `resolveConflictWithMerge` (`src/utils/cloud-prefs-sync.ts:877-886`).

## Why This Matters

The migration replaced a loud failure (crash, operation aborted) with a silent one (operation proceeds on wrong data) in every place a `null` return was overloaded to mean two different things: "the key isn't set" and "I couldn't find out." Six real instances of this shipped in a single PR before review caught them, and they cluster into two consequence classes:

- **Data gets deleted or overwritten that shouldn't be.** `buildCloudBlob()` (`src/utils/cloud-prefs-sync.ts:450-458`) builds the payload that *replaces* the server's row wholesale — it omits any key whose local read comes back `null`. Before the checked accessor, an unreadable key was indistinguishable from a cleared one, so the next upload permanently deleted a perfectly-set preference from the cloud because the browser happened to be unable to read it back for one request:

  ```ts
  // src/utils/cloud-prefs-sync.ts:450-458
  function buildCloudBlob(): Record<string, string> | null {
    const blob: Record<string, string> = {};
    for (const key of CLOUD_SYNC_KEYS) {
      const read = safeStorageGetChecked(key);
      if (!read.ok) return null;          // fail closed: abort, don't post a partial blob
      if (read.value !== null) blob[key] = read.value;
    }
    return blob;
  }
  ```

  The dirty-key sidecar (`persistDirtyKeyAddition` / `persistSettledDirtyKeyRemovals`, `src/utils/cloud-prefs-sync.ts:230-267`) has the same shape but a cross-tab blast radius: it's a read-modify-write over `KEY_DIRTY_KEYS`, a single localStorage entry shared by every open tab for that user. A failed read degrading to "empty" makes the union-with-empty-set write replace another tab's durable dirty markers with just this tab's key — silently making that other tab's unsynced edits look settled and overwritable. The fix is to abandon the write entirely on a failed read, keeping only the in-memory guard for the current page view.

- **A guard added to prevent bad behavior accidentally skips unrelated cleanup.** `onSignOut()` (`src/utils/cloud-prefs-sync.ts:1170-1224`) needed a guard so it wouldn't flush an unreadable preference up to the cloud (which would look like a deletion, same as `buildCloudBlob`). An early version of that guard used a function-scope `return`, which also skipped every line after it: bumping `_authGeneration`, clearing the retry timers, clearing dirty-key ownership, and nulling `_cachedToken`. That last one is the sharpest edge — a stale `_cachedToken` for the signed-out user stays live for a later `beforeunload` handler to post with, uploading data under the wrong identity. The fix scopes the early return to skip only the flush block, not the rest of the cleanup (comment at `src/utils/cloud-prefs-sync.ts:1185-1188`).

  Markers have the same shape at smaller scale: `getSyncVersionChecked()` (`src/utils/cloud-prefs-sync.ts:413-417`) degrading `KEY_SYNC_VERSION` to `0` on a failed read means "never synced" — which makes `cloud.syncVersion > localVersion` true, so the cloud blob is applied *over* local edits it should have been compared against, and also makes `isFirstEverSync` true, fabricating an undo-toast snapshot for a sync that already happened. `getLocalSchemaVersion()` (`src/utils/cloud-prefs-sync.ts:616-622`) has the mirror problem: a failed read looks like "no marker yet, assume oldest," which reruns one-shot migrations over already-migrated data — and schema 2 specifically re-enables an entire source category (Layoffs, Semiconductors, IPO, Funding, …) that the user may have deliberately disabled since the first migration ran.

A seventh variant shows the same bug one layer up, where the unsafe part isn't the read but the *success signal*. `exportSettings()` (`src/utils/settings-persistence.ts:45-63`) used to build its payload from the degrading accessors and always produce a file — empty if storage was unreadable. The caller in `src/services/preferences-content.ts:552-558` wraps the call in `try { exportSettings(); showToast(exportSuccess) } catch { showToast(exportFailed) }`, so a silently-empty export reported success:

```ts
// src/services/preferences-content.ts:552-558
try {
  exportSettings();
  showToast(container, t('components.settings.exportSuccess'), true);
} catch {
  showToast(container, t('components.settings.exportFailed'), false);
}
```

The first fix attempt checked `isStorageAvailable()` before exporting — and that wasn't enough either, because a storage *handle* can exist while an individual `getItem` or the enumeration itself throws. `safeStorageSnapshot()` (`src/utils/safe-storage.ts:156-171`) closes that gap by reporting whether the *reads* succeeded, not whether the handle exists, and `exportSettings` now throws instead of returning an empty payload (`src/utils/settings-persistence.ts:60-63`) — restoring the "throw = caller sees exportFailed" behavior the raw call used to give for free.

## When to Apply

This is not specific to `localStorage` — it applies to any wrapper that converts a checked/throwing resource access into a value with a default. Before wrapping (or before using an existing wrapper for) a new call site, ask what the caller does with the "empty" result:

- Building a payload that **replaces** something else wholesale (an upload blob, a full-row overwrite, a cache rebuild) → absence of one field silently deletes it. Use the checked form; fail the whole operation on any unreadable field rather than post a partial replacement.
- Comparing a **version or generation marker** to decide which side wins a merge → a degraded default (usually `0` or "never set") makes one side look definitively older/newer than it is, when the truth is "unknown." Use the checked form; treat "unknown" as its own outcome, not as the oldest possible value.
- A **guard that early-returns** to prevent one bad action → check whether the return also skips cleanup/bookkeeping that has nothing to do with the thing being guarded. Scope the early exit to only the risky step.
- A **success/failure toast or status** derived from "did the function throw" → confirm the wrapped function still throws (or otherwise reports) on the specific failure the UI promises to catch. A wrapper that silently degrades converts every downstream `catch` block into dead code for that failure mode.
- Multiple durable writes that describe one **logical operation** → order them so that if a later write fails, the already-landed markers don't overstate what succeeded (write the more conservative/gating marker first).

Absence-as-default is still the right choice for genuinely optional, low-stakes reads — a display flag, a UI preference with a safe fallback, anything where "assume the default" and "the key legitimately isn't set" lead to the same acceptable behavior. Document that choice at the call site; this bug class is invisible on the page and disappears from review the moment someone assumes the pattern was applied uniformly.

## Examples

Before (repo state prior to the checked-accessor pass, reconstructed from the review comments — do not treat as literal history, the point is the shape):

```ts
function buildCloudBlob(): Record<string, string> {
  const blob: Record<string, string> = {};
  for (const key of CLOUD_SYNC_KEYS) {
    const value = safeStorageGet(key);       // throws degrade to null here
    if (value !== null) blob[key] = value;   // an unreadable key is now "absent"
  }
  return blob;                                // always succeeds, even when reads failed
}
```

After, matching current `src/utils/cloud-prefs-sync.ts:450-458`:

```ts
function buildCloudBlob(): Record<string, string> | null {
  const blob: Record<string, string> = {};
  for (const key of CLOUD_SYNC_KEYS) {
    const read = safeStorageGetChecked(key);
    if (!read.ok) return null;               // fail closed instead of posting a partial blob
    if (read.value !== null) blob[key] = read.value;
  }
  return blob;
}
```

Every caller of `buildCloudBlob` (`migrateLocalBlobIfNeeded`, `resolveConflictWithMerge`, `runSignInAttempt`, `clearSettledDirtyKeys`) now branches on `=== null` and aborts the enclosing operation with `setState('error')` rather than proceeding with a blob that silently dropped a key — see `src/utils/cloud-prefs-sync.ts:659-660`, `862-868`, and `967-974` for three of those call sites.

## Related

- [Never render a confident empty state from a loader that cannot distinguish a miss from a failure](never-render-a-confident-empty-state-from-a-loader-that-cannot-distinguish-miss-from-failure.md) (`docs/solutions/conventions/`)
  — the same collapse one layer up and in the other direction: a *read* path renders a confident
  "No data" from a loader that cannot tell a miss from a failure. That doc closes by prescribing
  "preserve that distinction through the return type" when the loader can tell; this doc is the
  worked instance of that prescription on the *write* side, where the cost is deleted data rather
  than a dishonest empty state.
- [Stripped null keys in a fallback cache crash typed consumers](../logic-errors/stripped-null-keys-in-a-fallback-cache-crash-typed-consumers.md) (`docs/solutions/logic-errors/`)
  — a normalizing write that drops null-valued keys, erasing a signal a downstream decision relied on.
- [A degraded 200 digest poisoned the last-good cache](../logic-errors/degraded-200-digest-poisoned-the-last-good-cache.md) (`docs/solutions/logic-errors/`)
  — a degraded-but-technically-successful response trusted and written through as fact.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) (`docs/solutions/best-practices/`)
  — the same fail-closed rule for a guard that loses the thing it was guarding.
- `CONCEPTS.md` — the hit / miss / failure distinction this doc's checked accessors exist to preserve.

Issues: #7833 (the survey and the ask: guard the remaining raw call sites and add a lint rule),
#7840 (the PR), #7832 (the prior PR that fixed the first two sites and introduced the degrading
accessors this doc is about). The write-side instances here were all found by review *on* #7840 —
none were in the original diff, and each round of review found another until the reads were
classified systematically rather than one at a time.
