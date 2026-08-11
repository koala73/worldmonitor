# Acceptance Evidence

## Phase 0 — Safety inventory, backup and workspace decision

| Check | Result | Evidence |
|---|---|---|
| Legacy project preserved | PASS | Original directory remains `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪`; no Git repository was initialized or source file removed |
| Recoverable legacy checkpoint | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\backups\old-simplified-pre-worldmonitor-mother-20260811-161129`; Robocopy completed with exit 1 (files copied), 5,900 files, 1.828 GB |
| New mother workspace | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated` created independently from the fork |
| Main protection | PASS | `main` remains at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; Phase 0 work is on `integration/phase0-safety-inventory`; backup branch `backup/pre-worldmonitor-mother-20260811-162026` exists |
| GitHub repository authority | PASS | Connected GitHub app reports `daking32168-byte/worldmonitor` with admin, maintain, pull and push permissions |
| Origin SHA lock | PASS | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` through local clone and GitHub app |
| Official upstream SHA lock | PASS (connector) | `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` through connected GitHub app; local fetch deferred to Phase 1 due checkout transport limit |
| PokieTicker SHA lock | PASS | `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` through connected GitHub app |
| PokieTicker database baseline | PASS | SHA-256 `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C`; 226,844,672 bytes; 53,025 OHLC rows; maximum date `2026-03-03` |
| Destructive action check | PASS | No `reset --hard`, force push, source deletion, old-project overwrite, main commit or new provider credential used |

## Observed environment constraints

- A full Git clone and a filtered fetch exceeded the 64-second tool command limit. The process tree was verified as agent-created and stopped only after it held the new workspace lock without progress; no user process was terminated.
- The host rejected a direct removal of the stale Git lock file. A separate Git index enabled a clean sparse checkout without bypassing that host protection.
- A first Python SQLite query passed the Chinese path directly and failed to open it; the read-only query was then repeated using a Unicode environment variable and succeeded. The database was never written.

## Phase 0 gate

**PASS pending documentation commit.** Legacy checkpoint exists, formal workspace is explicit, source locks are recorded, and no destructive overwrite occurred.
