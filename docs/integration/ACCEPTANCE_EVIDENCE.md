# Acceptance Evidence

## Phase 0 — Safety inventory, backup and workspace decision

**Closure time:** 2026-08-11T16:47:20+08:00
**Phase documentation commit:** `81369e41cfd0e3dd454dbd37ae3739b5aa53b056` (`chore(integration): record Phase 0 safety inventory`)
**Phase closure-evidence receipt:** `8cf5937b8c4bad406e7c64eba8e50a51ac473ce6` (`docs(integration): close Phase 0 evidence gate`)

| Check | Result | Evidence |
|---|---|---|
| Legacy project preserved | PASS | Original directory remains `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪`; no Git repository was initialized or source file removed |
| Recoverable legacy checkpoint | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\backups\old-simplified-pre-worldmonitor-mother-20260811-161129`; Robocopy completed with exit 1 (files copied), 5,900 files, 1.828 GB; closure audit rechecked 20 deterministic non-sensitive files and three restored representative files |
| New mother workspace | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated` created independently from the fork |
| Main protection | PASS | `main` remains at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; Phase 0 work is on `integration/phase0-safety-inventory`; backup branch `backup/pre-worldmonitor-mother-20260811-162026` exists |
| GitHub repository authority | PASS | Connected GitHub app reports `daking32168-byte/worldmonitor` with admin, maintain, pull and push permissions |
| Origin SHA lock | PASS | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` through local clone and GitHub app |
| Official upstream SHA lock | PASS (connector) | `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` through connected GitHub app; local fetch deferred to Phase 1 due checkout transport limit |
| PokieTicker SHA lock | PASS | `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` through connected GitHub app |
| PokieTicker database baseline | PASS | SHA-256 `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C`; 226,844,672 bytes; 53,025 OHLC rows; maximum date `2026-03-03` |
| Destructive action check | PASS | No `reset --hard`, force push, source deletion, old-project overwrite, main commit or new provider credential used |
| Working-tree and branch closure | PASS | Isolated-index `git status --short --branch` was clean; `integration/phase0-safety-inventory` is ahead 1 of `origin/main`; `main` and `backup/pre-worldmonitor-mother-20260811-162026` both remain at `0fca203...` |
| Backup 20-file integrity sample | PASS | Fixed seed `20260811`; 5,876 non-sensitive files no larger than 2 MiB were eligible; all 20 selected files existed and were SHA-256 hashed. See `evidence/phase0-closure.md`. |
| Read-only restoration probe | PASS | `README.md`, `frontend/package.json`, and `backend/package.json` copied from the backup to a Codex-created temporary directory and each source/destination SHA-256 pair matched. See `evidence/phase0-closure.md`. |
| Staged-artifact and secret gate | PASS | No staged files before the backfill; `git diff --cached --check` exited 0. Targeted scans for AWS, GitHub, OpenAI-style, Google, and Slack key patterns found no values. No SQLite is in the Phase 0 diff. |

## Observed environment constraints

- A full Git clone and a filtered fetch exceeded the 64-second tool command limit. The process tree was verified as agent-created and stopped only after it held the new workspace lock without progress; no user process was terminated.
- The host rejected a direct removal of the stale Git lock file. A separate Git index enabled a clean sparse checkout without bypassing that host protection.
- A first Python SQLite query passed the Chinese path directly and failed to open it; the read-only query was then repeated using a Unicode environment variable and succeeded. The database was never written.
- The normal Git index is absent and `.git/index.lock` remains host-protected. All Phase 0 Git verification used the Git-native isolated index `.git/index.phase0`; it reports a clean source worktree. No source files were deleted.
- The host rejected the explicitly scoped PowerShell cleanup of the Codex-created temporary restoration directory. The exact directory is recorded in `evidence/phase0-closure.md`; it contains only the three copied representative files and is not part of either project or Git worktree.

## Phase 0 gate

**PASS.** Legacy checkpoint is recoverable by sampled hash evidence, the formal workspace is explicit, source locks are recorded, the Phase 0 documentation commit is recorded above, and no destructive overwrite occurred.
