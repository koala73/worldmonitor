# Global Intelligence Mother Reconstruction — Master Status

**Controlling specification:** `D:\google\Codex_5.6_Terra_极高_全球情报母体重构执行书_2026-08-11.md`
**Updated:** 2026-08-11T16:53:00+08:00
**Official product brand:** 全球实时热点追踪·探长版
**Current working branch:** `integration/phase0-safety-inventory`
**Formal mother repository:** `daking32168-byte/worldmonitor` (AGPL-3.0-only)

## Phase status

| Phase | Status | Scope | Commit | Evidence |
|---|---|---|---|---|
| 0 — Safety inventory, backup, workspace decision | completed | Old-project checkpoint, mother workspace, source locks, legacy-data baseline, recoverability audit | `81369e41cfd0e3dd454dbd37ae3739b5aa53b056`; `8cf5937b8c4bad406e7c64eba8e50a51ac473ce6` | `ACCEPTANCE_EVIDENCE.md`, `evidence/phase0-closure.md` |
| 1 — Sync and establish WorldMonitor mother baseline | blocked — local GitHub HTTPS unavailable | Safe `--ff-only` eligibility check, upstream baseline, legal/brand implementation | — | `ACCEPTANCE_EVIDENCE.md`, `evidence/phase1-preflight-network.md` |
| 2–12 | not started | Contracts, market, PokieTicker, maritime, China factory, controls, desktop, final acceptance, PR | — | — |

## Phase 0 result

- The legacy simplified project is preserved at `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪`; it is not a Git repository and therefore has no origin, upstream, branch or Git dirty state.
- A local recoverable snapshot was created at `D:\使用AI专属文件夹\global-intelligence-earth\backups\old-simplified-pre-worldmonitor-mother-20260811-161129` (5,900 files, 1.828 GB). It remains local-only and must never be added to Git.
- The new formal mother workspace is `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated`.
- Local branch `backup/pre-worldmonitor-mother-20260811-162026` points to the untouched fork baseline `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`.
- All Phase 0 work is isolated on `integration/phase0-safety-inventory`; `main` remains untouched.
- The initial full clone exceeded the desktop execution time limit. A Git-native sparse checkout using an isolated index completed against the fork baseline without deleting the incomplete clone objects or the legacy project. See `DECISIONS.md`.
- The Phase 0 closure audit used `GIT_INDEX_FILE=.git/index.phase0` because the normal index remains absent while `.git/index.lock` is host-protected. With the isolated index, the branch was clean and one commit ahead of `origin/main`; the default-index deletion listing is not treated as source deletion evidence.
- A deterministic, non-sensitive 20-file backup sample and a three-file restoration/readability probe passed on 2026-08-11. Raw commands, output, hashes, exit codes, and the temporary-directory cleanup limitation are in `evidence/phase0-closure.md`.

## Hard constraints in force

1. WorldMonitor is the only formal code mother. The legacy React/Express project is not to be merged into this root.
2. No data source is labelled real-time unless the Provider contract explicitly permits it and the live path has been verified.
3. PokieTicker SQLite remains `HISTORICAL_SNAPSHOT`; it is never a live-market fallback label.
4. AIS reports cannot prove cargo, origin, buyer, or final discharge. Modelled trade links stay visibly modelled.
5. News alignment, sentiment and realised returns remain separate; no correlation is written as a proven cause.
6. No API key, credential, browser session, CAPTCHA bypass, iframe of either upstream, or non-user-authorised data source may be introduced.

## Phase 1 preflight result

- The user explicitly confirmed AGPL-3.0-only network-distribution obligations and independent branding in chat on 2026-08-11. The confirmation panel's on-disk values still read `未确认`, so the user’s direct message — not an unobserved file edit — is the legal-confirmation evidence.
- The connected GitHub app compared the two locked commits. It reports `0fca203...` as the merge base and ancestor of `ae0a0fe...`; upstream is ahead by 43 and behind by 0. A future local sync can therefore be a safe fast-forward **only after the real local object graph has been fetched**.
- Local `git fetch` attempts did not obtain any upstream object. The checkout remains shallow, `upstream/main` does not exist locally, and the local GitHub 443 diagnostic failed. No branch, main ref, code file, dependency, Provider configuration, or data artifact was changed by the Phase 1 preflight.

## Next action

When GitHub HTTPS is reachable from this machine, rerun the local `origin` and `upstream` fetch gates, verify local merge-base/ahead/behind, create a new integration branch from the upstream baseline, and only then expand the checkout, install dependencies, and begin Phase 1 implementation.
