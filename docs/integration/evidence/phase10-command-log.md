# Phase 10 — command and exit-code log

**Recorded:** 2026-08-12 (Asia/Shanghai). Commands below use
`D:\global-intelligence-earth\worldmonitor-upstream-integration-lf` unless a
path is explicitly shown. Raw build streams stay local because they contain
host-specific ANSI output; this file is the versioned, non-secret command
summary.

| Order | Command / operation | Result |
|---|---|---|
| 1 | `winget` Rustup installation after owner confirmation | PASS; Rustup 1.29.0, `rustc 1.97.1`, Cargo available. |
| 2 | Visual Studio Build Tools 2022 C++ workload modification after owner confirmation | PASS; MSVC 14.44 `cl.exe`/`link.exe` discovered. |
| 3 | `node scripts/download-node-windows.mjs` | PASS; Node 22.14.0 official archive checksum matched and bundled runtime checksum recorded. |
| 4 | `node --test tests/phase10-desktop-launcher.test.mjs` | PASS, 6/6. |
| 5 | `node scripts/prepare-desktop-node-runtime.mjs` | PASS; verified already-bundled Windows Node 22.14.0. |
| 6 | `node scripts/check-desktop-build-env.mjs` | PASS, exit 0. |
| 7 | `node scripts/check-vite-env-secrets.mjs --strict-local` | PASS, exit 0. |
| 8 | `node scripts/sync-desktop-version.mjs --check` | PASS, exit 0. |
| 9 | `npm run desktop:tauri:build:nsis` under `vcvars64.bat` | Tauri completed the optimized release and `Finished 1 bundle` twice. The temporary Chinese-path status redirect did not record the successful outer exit code; installation/launch proof below is used instead. |
| 10 | Silent NSIS installer from final path | PASS, exit 0. |
| 11 | Final artifact SHA-256 | `9F0A44E20B847BEF42AE22A0F20E8C85F48616DA0E677A2B40C5F7518074D371`. |
| 12 | `Launch-Global-Intelligence-Earth-Mother.ps1` after final install | PASS, exit 0; branded native process and bundled sidecar started. |
| 13 | Loopback listener verification | PASS; installed sidecar owned `127.0.0.1:46123`. |
| 14 | Second launcher invocation | PASS, exit 0; detected existing branded process without duplicating it. |
| 15 | `Create-Global-Intelligence-Earth-DesktopShortcut.ps1` | PASS, exit 0; desktop shortcut recreated. |
| 16 | PowerShell parser for both launcher scripts | PASS, 0 parser errors. |
| 17 | Scoped `biome lint` for Phase 10 files | PASS, exit 0. |
| 18 | `npm run typecheck:all` | PASS, exit 0. |
| 19 | `npm run test:sidecar` | PASS, 371/371. Initial run was 370/371 only because the intentionally running review sidecar occupied the exact EADDRINUSE test port; after closing that owned process, retry passed without code change. |
| 20 | `npm run lint` | PASS, exit 0; existing 33 warnings/9 infos, Safe HTML guard passed. |
| 21 | `npm run lint:api-contract` | PASS, exit 0. |
| 22 | `npm run test:dom` | PASS, 293/293. |
| 23 | `npm run sources:check` | PASS, exit 0; 534 active upstream data hosts. |

## Rejected or corrected observations

1. An earlier raw `tauri build` omitted the desktop Vite variables. Its binary
   showed `asset not found: index.html` and was not accepted. The final command
   explicitly uses `VITE_VARIANT=full VITE_DESKTOP_RUNTIME=1` through the
   project script.
2. A later incremental Tauri build could retain a stale frontend resource map.
   `src-tauri/build.rs` now watches Vite desktop entrypoints/assets, and the
   final packaged application opened the full native overview instead of the
   missing-asset error.
3. Before bundling Node, the application honestly logged that the local API
   sidecar executable was unavailable. The final installation contains the
   checksum-verified runtime and started the installed sidecar successfully.
4. No Provider key, secret, account, entitlement, source payload or live
   market/K-line claim was created during this phase.
