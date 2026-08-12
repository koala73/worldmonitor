# Phase 10 — Windows desktop delivery evidence

**Recorded:** 2026-08-12 (Asia/Shanghai)

**Workspace:** `D:\global-intelligence-earth\worldmonitor-upstream-integration-lf`

**Branch:** `integration/pokieticker-maritime-china-factory`
**Scope:** Native Tauri 2 desktop delivery only. No legacy Express process,
legacy project file, `main` branch, Provider credential, hosted deployment or
third-party account was modified.

## Delivered artifact

| Item | Verified value |
|---|---|
| Product name | `全球实时热点追踪·探长版` |
| Native binary | `global-intelligence-earth.exe` |
| Installed application | `C:\Users\Administrator\AppData\Local\全球实时热点追踪·探长版\global-intelligence-earth.exe` |
| NSIS installer | `src-tauri\target\release\bundle\nsis\全球实时热点追踪·探长版_2.10.0_x64-setup.exe` |
| Installer size | `53,356,779` bytes |
| Installer SHA-256 | `9F0A44E20B847BEF42AE22A0F20E8C85F48616DA0E677A2B40C5F7518074D371` |
| Desktop shortcut | `C:\Users\Administrator\Desktop\全球实时热点追踪·探长版.lnk` |
| Shortcut target | PowerShell 5 launcher `scripts\Launch-Global-Intelligence-Earth-Mother.ps1` |
| Code signature | `NotSigned` / status code `2`; release signing remains an explicit manual action because no signing certificate was supplied. |

The shortcut calls the new native launcher only. The launcher resolves the
per-user NSIS installation, installs the exact local installer only if the
application is absent, preserves an already-running matching process, and
never probes or starts the legacy Express ports `4000` or `5173`.

## Runtime and supply-chain verification

The owner confirmed both local toolchain licences before installation. The
validated local tools were Rustup 1.29.0 / `rustc 1.97.1`, Visual Studio Build
Tools 2022 C++ workload (MSVC 14.44), and the official Node.js Windows x64
runtime below.

| Runtime item | Verified value |
|---|---|
| Bundled Node runtime | `v22.14.0` |
| Official archive | `node-v22.14.0-win-x64.zip` from `nodejs.org/dist` |
| Official archive SHA-256 | `55b639295920b219bb2acbcfa00f90393a2789095b7323f79475c9f34795f217` |
| Extracted `node.exe` SHA-256 | `33b1bc1a8aca11fd5a4f2699e51019c63c0af30cf437701d07af69be7706771b` |
| License delivery | The upstream Node `LICENSE` is packaged next to `sidecar\node\node.exe`; it begins with the Node.js MIT licence grant. |

`scripts/download-node-windows.mjs` obtains the signed-by-checksum official
archive, compares its SHA-256 to `SHASUMS256.txt`, extracts only the fixed
runtime members, and writes local verification metadata. The generated binary
and license stay ignored rather than being committed as a large Git blob.
`desktop:prepare-node-runtime` validates the local binary hash before every
Windows desktop package build and downloads it again only when absent or
invalid. It does not place a secret in `VITE_*`, source control or frontend
assets.

## Final install and launch proof

The final artifact was silently installed over the Phase 10 test installation,
then launched through the public shortcut launcher. All values below are from
the same final installer hash recorded above.

| Check | Result | Evidence |
|---|---|---|
| Final NSIS install | PASS | Installer exit `0`; the installed application, `sidecar\node\node.exe` (83,344,536 bytes), Node `LICENSE`, and `sidecar\local-api-server.mjs` all existed. |
| Native launcher | PASS | `Launch-Global-Intelligence-Earth-Mother.ps1` exit `0`; process ID `24308` had window title `全球实时热点追踪·探长版`. |
| Local sidecar | PASS | Installed Node process ID `15964` executed `sidecar\local-api-server.mjs`; desktop log recorded its resolved installed Node path and no injected keychain secret. |
| Loopback-only port | PASS | `sidecar.port` was `46123`; `Get-NetTCPConnection` observed listener `127.0.0.1:46123` owned by PID `15964`. No externally exposed legacy port was started. |
| Duplicate launch | PASS | A second launcher call exited `0` and reported that the matching native application was already running. |
| Shortcut recreation | PASS | `Create-Global-Intelligence-Earth-DesktopShortcut.ps1` exited `0` and regenerated the desktop shortcut with the repository launcher as its sole target. |
| Visible desktop review | PASS for shell | Windows UI Automation inspected the native window. It showed the independent product title, version, visible `Based on World Monitor … AGPL-3.0-only` attribution, the Markets panel, and links to the owned stock, maritime, China-factory and Provider workspaces. The window was left open for user review. |
| No fabricated market display | PASS | With no authorized market Provider configured, the visible Markets panel said `加载市场数据失败`; advanced analysis said `登录以解锁高级功能`. It did not draw a generic/shared K-line or label historical/delayed data as real-time. |

## Build and packaging result

The normal Windows command was:

```text
npm run desktop:tauri:build:nsis
```

It runs the Vite-secret gate, desktop environment gate, desktop version sync,
verified Windows Node preparation and the existing Tauri 2 full-desktop build
with `--bundles nsis` under the MSVC environment. The Tauri output recorded
`Finished \`release\` profile`, `Finished 1 bundle`, and the NSIS path above on
two independent final builds. The outer temporary `cmd` evidence wrapper exits
`0`, but its status-file redirect continued to show `RUNNING` under a Chinese
output path; therefore this phase does **not** claim a status-file `EXIT=0`.
The actual installation exit `0`, exact artifact SHA-256, native process,
sidecar process, loopback listener and tests above are the independent,
reproducible completion evidence.

The build also addresses the observed incremental-resource defect: Tauri's Rust
build script now watches all desktop `dist` entrypoints and assets. This forces
the native resource embedding to refresh after Vite emits the desktop
`index.html`, preventing the prior `asset not found: index.html` failure.

## Gates executed

| Command / check | Result |
|---|---|
| `node --test tests/phase10-desktop-launcher.test.mjs` | PASS, 6/6 |
| `node scripts/check-desktop-build-env.mjs` | PASS, exit 0; all 8 required desktop-build variables classified |
| `node scripts/check-vite-env-secrets.mjs --strict-local` | PASS, exit 0 |
| `node scripts/sync-desktop-version.mjs --check` | PASS, exit 0; package/Tauri/Cargo all `2.10.0` |
| PowerShell 5 parser for both launcher scripts | PASS, 0 parser errors |
| Scoped Biome for Phase 10 JS/test files | PASS, exit 0 |
| `npm run typecheck:all` | PASS, exit 0 |
| `npm run test:sidecar` | PASS, 371/371 after stopping the owned desktop sidecar; the first 370/371 run correctly exposed port `46123` as already occupied by the live review app, not a code assertion failure. |
| `npm run lint` | PASS, exit 0; repository baseline remains 33 warnings/9 infos and Safe HTML guard passed. |
| `npm run lint:api-contract` | PASS, exit 0; 183 API files / 114 manifest entries / 96 query parameters. |
| `npm run test:dom` | PASS, 293/293 |
| `npm run sources:check` | PASS, exit 0; the desktop runtime downloader is intentionally classified as executable dependency acquisition, not a user-facing upstream data Provider. |

## Boundaries and deferred manual actions

- This is a functioning native desktop shell with a bundled local API runtime;
  it is **not** an assertion that any market, AIS, news, customs, B/L or model
  Provider is currently configured or authorized.
- The final visible no-key market error is the required fail-closed outcome. A
  real/near-real K-line still requires the owner to obtain a permitted
  `MASSIVE_API_KEY` or equivalent licensed Provider, configure it only in the
  protected desktop/server store, and capture Provider/source/as-of/delay and
  display/rebroadcast entitlement evidence.
- The installer is unsigned. Code signing requires the owner-provided
  certificate and timestamp/signing authority; it must not be supplied in chat
  or committed to Git.
- NSIS is the delivered Windows installer. MSI was not delivered because the
  locally attempted WiX acquisition stalled; this is not a runtime defect and
  can be retried only if MSI distribution is required.
- The untouched legacy launcher remains at
  `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\scripts\Launch-Global-Intelligence-Earth.ps1`.
  It was neither overwritten nor used as a fallback.
