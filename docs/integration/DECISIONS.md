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
