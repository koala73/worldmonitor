---
module: source-attribution
date: 2026-08-12
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "`npm run sources:check` exits 0 on a clean tree while `npm run sources:generate` immediately dirties ~5800 lines"
  - "A published attribution row cites `file:line` positions that moved commits ago"
  - "Any PR that legitimately edits the manifest carries thousands of lines of unrelated churn, or hand-splices its own rows"
root_cause: logic_error
resolution_type: code_fix
related_components: [documentation, development_workflow]
tags: [green-while-dead, generator-gate, fixpoint, idempotence, drift, attribution, compliance-artifact, mutation-testing]
---

# A --check gate that rebuilt its expectation from the artifact it was checking

## Problem

`scripts/source-attribution.mjs` generates the public upstream-provider ledger: `shared/source-attribution-manifest.json` (license posture and required credit per host) and the table published at `docs/source-attribution.mdx`. Its `--check` mode is a required CI gate.

On clean `main`, `--check` passed while `--write` rewrote ~5800 lines. The committed artifacts had drifted from the source tree and nothing detected it.

## Symptoms

- `npm run sources:check` exits 0; `npm run sources:generate` then leaves the manifest and docs dirty.
- Published rows cite stale positions (`api/skills/fetch-agentskills.ts:26` when the URL had moved to `:90`).
- PR #6486 had to hand-splice manifest rows to avoid carrying the ambient churn.

## What Didn't Work

Reading the failure as "someone forgot to regenerate" is wrong, and re-running the generator only launders it — the next merge re-drifts the artifact and the gate goes quiet again. The blindness is structural, not an operational lapse.

## Solution

The check derived its expectation from the artifact it was checking:

- `--write` → `buildManifest(inventory, previous)` → fresh scan → renders docs from **that new manifest**.
- `--check` → `validateManifest(inventory, previous)` → renders docs from **`previous`**, the committed manifest.

Docs positions come from the *manifest*, not the live scan. So `--check` compared committed-docs against a render of committed-manifest: self-consistent, and structurally incapable of seeing the manifest's own staleness. `validateManifest` only checked host-set membership, so the only two errors it could emit were "missing manifest entry" and "observed but scanner found no current reference".

Two changes, and **both are required**:

1. **Remove the churn.** `references[].line` is gone. A line number is not part of an attribution — the manifest records license posture and required credit — and it was the only field changing. References are now one deduplicated `{ path }` per file.
2. **Make the check honest.** Every observed row must equal `mergeEntry(observed, row)`, and `--check` byte-compares the committed manifest against a rebuild.

```js
// scripts/source-attribution.mjs — the honest comparison
const rebuilt = serializeManifest(buildManifest(inventory, previous));
if (readFileSync(manifestPath, 'utf8') !== rebuilt) {
  return { errors: [`${MANIFEST_PATH} is out of date; ${REGENERATE_HINT}`] };
}
```

## Why This Works

**The two halves are coupled.** 278 of 289 drifting rows were line-only. An honest gate on a churning field would have gone red on nearly every PR that shifted a line — an intolerable tax that would have been reverted. Removing the meaningless field is what makes the honest gate affordable. Fixing only honesty produces a gate nobody can live with; fixing only churn leaves the blindness in place.

**A rebuild-comparison gate needs `--write` to be a fixpoint.** It was not. `buildManifest` retired a vanished host in place (`observed: false`), but the retention loop skipped already-retired rows — so a *second* regeneration deleted the row the first one preserved. `tuoitrenews.vn`, retired by #6486, was one regeneration from silently losing its credit. Retaining already-retired rows is what makes `--write` idempotent and therefore comparable.

**Byte-compare, don't only walk semantically.** Deleting a `logicalEntries` row was invisible to every semantic check, because the docs render from the same committed manifest — so both sides agreed. Only the byte comparison notices a named provider leaving a legal ledger.

**A rule-derived field must be withdrawn when its rule stops applying.** `mergeEntry` did `{ ...previous, ...override }`. When the rule that minted `status: 'excluded'` stopped applying, `override` became `{}` and the stale exclusion carried forward as the base — so the rebuild reproduced it and the fixpoint check *certified* it. A playback-only host that gains a real fetch stayed out of the published count and out of license review, green all the way.

## Prevention

**The diagnostic, for any generator with a `--check`/`--write` pair:** run the writer on a clean tree and look at `git status`. Any diff is drift the checker cannot see. Then ask the structural question — *does `--check` derive its expectation from the artifact it is checking?* If yes, it can only ever prove the artifact agrees with itself.

**Prove both directions.** A gate that only ever reports green proves nothing:

```bash
# must go RED — a genuine new reference
printf "\nconst PROBE = 'https://agentskills.io/probe';\n" >> scripts/seed-economy.mjs
npm run sources:check   # exit 1, names agentskills.io

# must stay GREEN — a pure line shift
printf '\n\n\n' | cat - scripts/seed-economy.mjs > /tmp/s && cp /tmp/s scripts/seed-economy.mjs
npm run sources:check   # exit 0
```

**Test the gate's verdict, not only its parts.** `main()` was unexported, so deleting the manifest comparison left the entire suite green. `checkSourceAttribution(rootDir)` is now exported and driven against a throwaway checkout whose artifacts the generator itself wrote, so every red path is proven rather than assumed.

**Mutation-test each guard.** Six mutants each turn a named test red: deleting the manifest comparison, the per-row drift check, or the mirror comparison; disabling the reference extra-field guard; reverting the stale-exclusion clearing; keeping stale references on retirement. Two guards added mid-review were proven *vacuous* this way before they had tests.

**Never route a reviewer to the command that destroys their edit.** The first pass made `--check` reject a hand-curated license for a `PROVIDER_OVERRIDES` host with `run --write` — which silently reverted it. On an artifact whose exact wording is the deliverable, CI was instructing people to destroy their own work. Drift in a script-owned field now names the script instead:

```
manifest entry api.openaq.org disagrees with this script on license, attribution;
those fields are set in scripts/source-attribution.mjs (PROVIDER_OVERRIDES or an
exclusion rule) and --write will overwrite the manifest — edit the script instead
```

**Render before you write.** `--write` wrote the manifest and *then* rendered, and rendering validates. A retained row that no longer validated left the manifest rewritten, the docs stale, and every rerun repeating it, with no path back to green.

## References

- Issue #6487, PR #6499.
- Follow-up #6500: retirement is still a `--write` side effect. The scanner cannot distinguish "provider removed" from "URL moved out of the scanned tree", so regenerating can retire a provider the code still fetches. #6499 makes it loud (two-remedy error, per-host warning); a `--retire <host>` gate would make it deliberate.
- Sibling failure of the same shape: `docs/solutions/logic-errors/pre-push-green-tree-cache-attested-a-tree-the-gates-never-ran.md`.
