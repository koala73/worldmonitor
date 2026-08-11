# Integration Decisions

## D-0001 — Adopt a separate WorldMonitor mother workspace

**Decision:** Use `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated` as the only formal integration workspace.
**Reason:** The previous project is a non-Git React/Express/SQLite implementation, while the requested mother is the AGPL WorldMonitor fork. Combining their root manifests would violate the execution-book architecture decision and make upstream maintenance unsafe.
**Consequence:** The old project, database and desktop shortcut remain preserved until the new mother passes final acceptance.

## D-0002 — Preserve a local legacy checkpoint before mother work

**Decision:** Create a local source/data snapshot before creating the mother workspace.
**Reason:** The legacy project has no Git history and therefore no branch-based recovery point.
**Consequence:** The 1.828 GB checkpoint is excluded from Git and remains recoverable locally.

## D-0003 — Use sparse checkout during Phase 0

**Decision:** Use a Git-native sparse checkout with an isolated index for Phase 0 metadata and documentation.
**Reason:** Full clone/fetch exceeded the desktop tool's 64-second single-command limit; no force, reset, deletion of legacy files, or modification of `main` was used.
**Consequence:** Phase 1 must expand/finalize the official mother checkout before any code integration or baseline test claim. The sparse index is an implementation recovery detail, not evidence that source integration has started.

## D-0004 — Provider truth labels are contractual

**Decision:** Use the exact status model in `PROVIDER_MATRIX.md`; values and charts may not be displayed above their proven freshness/authorization level.
**Reason:** The execution book forbids fake K lines, historical-as-live data, cargo inference-as-fact, and causal overstatement.

## D-0005 — Legal gate before Phase 1 integration

**Decision:** Do not merge/synchronize/ship a WorldMonitor-derived integration until the user explicitly accepts AGPL-3.0-only network-distribution obligations and independent branding.
**Reason:** The execution book lists this as P0 manual approval. Local audit and Phase 0 preservation are safe; public or substantive mother integration requires the legal premise.

## D-0006 — Close Phase 0 with an auditable recovery probe

**Decision:** Treat Phase 0 as complete only after verifying the isolated-index worktree, source locks, a deterministic 20-file backup sample, and a three-file read-only restoration probe.
**Reason:** A backup directory and a prose statement alone are not sufficient recovery evidence.
**Consequence:** The closure output, SHA-256 values, exit codes, and the host-protected temporary cleanup limitation are retained in `evidence/phase0-closure.md`. The normal index remains unavailable because `.git/index.lock` is host-protected; source state is verified with the clean Git-native isolated index instead of deleting the lock or resetting the worktree.

## D-0007 — Do not substitute a cached or dirty old copy for the required upstream baseline

**Decision:** Leave Phase 1 blocked until `upstream/main` is fetched into the new workspace and its local graph proves the remote relationship.
**Reason:** GitHub HTTPS is currently unavailable from the machine. The legacy backup contains a nested WorldMonitor repository only at `0fca203...` and it has pre-existing generated-file modifications; it does not contain `ae0a0fe...`.
**Consequence:** Do not copy that tree into the formal mother workspace, create a synthetic `upstream/main`, run a build against it, or claim the 43 upstream commits were integrated. The verified remote comparison and failed local commands are recorded in `evidence/phase1-preflight-network.md`.

## D-0008 — Establish Phase 1 from the real fetched upstream baseline

**Decision:** After GitHub HTTPS recovery, fetch both remotes locally and create the dedicated integration branch from the real `upstream/main` commit `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`.
**Reason:** The Phase 1 requirement is a verifiable local object graph, not a cached copy, a synthetic ref, or an inference from the GitHub connector. Local HTTP/1.1 fetches now prove fork merge-base `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` and upstream ahead/behind `0 43`.
**Consequence:** `integration/pokieticker-maritime-china-factory` is the only Phase 1 implementation branch. `main`, the preserved legacy project, and the backup branch remain untouched.

## D-0009 — Make provenance and independent identity executable contracts

**Decision:** Centralize the product identity in a source constant, render the exact AGPL attribution visibly in the application footer, retain PokieTicker's MIT license and source lock, and test these requirements in the repository.
**Reason:** A README-only promise can drift from the shipped UI. The user requires an independently branded product while the AGPL upstream attribution, PokieTicker provenance, and non-deceptive data boundaries must remain visible and auditable.
**Consequence:** Phase 1 does not copy PokieTicker source code or its historical SQLite data. It adds only the license/trace documents, branded UI metadata, and contract tests; live data, K-lines, AIS facts and Provider claims remain out of scope until their honest Phase 2+ adapters exist.

## D-0010 — Fail closed for market data until a licensed adapter exists

**Decision:** Establish the complete stock RPC/provenance contract before
connecting a Provider. The initial handler validates inputs but returns an
explicit `NOT_CONFIGURED` envelope and no value-bearing market payload.
**Reason:** A blank 200 response conceals configuration failure, while a shared
sample OHLC array would be a fake K line. The product must be able to distinguish
licensed real-time, delayed, historical, stale, degraded, unavailable and
unconfigured states in both code and UI before it can render a chart.
**Consequence:** Every future market adapter must use the Phase 2 symbol
validator, symbol-qualified cache key and bar invariant guard. A Provider key or
non-empty response cannot by itself upgrade the status to
`REALTIME_LICENSED`.
