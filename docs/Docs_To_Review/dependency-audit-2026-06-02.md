# Dependency audit follow-up - 2026-06-02

Scope: Country Resilience Index round-4 P3-2 dependency hygiene follow-up, with round-5 R5-3 stale-count correction. This note records package-audit reachability only; no resilience scorer/runtime code was changed.

## Commands

- Baseline before lockfile refresh:
  - `npm audit --omit=dev --json`: 0 critical, 0 high, 36 moderate.
  - `npm audit --json`: 0 critical, 9 high, 44 moderate.
- After lockfile refresh, rerun on 2026-06-02 with `node v26.0.0` and `npm 11.12.1` in this worktree:
  - Root `npm audit --omit=dev --json`: 0 critical, 0 high, 36 moderate.
  - Root `npm audit --json`: 0 critical, 0 high, 43 moderate.
  - `blog-site/` `npm audit --omit=dev --json`: 0 vulnerabilities.

Counting caveat: npm audit totals are metadata counts for vulnerable package nodes in the resolved dependency graph, not unique CVE/GHSA advisory counts. npm 11's current graph counting reports 36 production moderate nodes and 43 all-dependency moderate nodes here; earlier 18/20 post-refresh totals in this note were stale.

## Updated dev/build chain

The high advisories were dev/build-only and were removed with a package-lock-only refresh inside existing semver ranges:

- `vite-plugin-pwa`: 1.2.0 -> 1.3.0.
- `workbox-build` and Workbox packages: 7.4.0 -> 7.4.1.
- Babel Workbox build chain, including `@babel/plugin-transform-modules-systemjs`: 7.29.7.
- `ajv`: 8.20.0.
- `fast-uri`: 3.1.2.
- Workbox `brace-expansion`: 5.0.6.
- `tmp`: 0.2.7.
- npm 10 lockfile peer entries for `utf-8-validate`: 5.0.10.

This clears the prior all-dependency high advisories in the PWA/Workbox/AJV/Babel chain and the `exceljs -> tmp` high advisory. `exceljs` remains at 4.4.0, which is the latest published version at the time of this audit.

## Remaining production-runtime advisories

Production audit remains high/critical clean. Remaining production advisories are moderate and are in these reachable dependency families:

- `@anthropic-ai/sdk`: direct dependency; npm reports no compatible fix available.
- Clerk wallet stack: `@clerk/clerk-js` through Solana wallet adapters, `@solana/web3.js`, `viem`, `ws`, `jayson`, and `uuid`.
- Mapping/vector stack: `deck.gl`, `@deck.gl/geo-layers`, `maplibre-gl`, `pbf`, `resolve-protobuf-schema`, and `protocol-buffers-schema`.
- Convex stack: `@dodopayments/convex`, `convex`, and `ws`.
- Telegram proxy/address parser stack: `telegram`, `socks`, and `ip-address`.
- Shared websocket/identifier transitives: `ws`, `uuid`, `isows`, and `isomorphic-ws`.

These were not force-upgraded because npm does not offer high/critical production fixes in the current compatible graph, and forcing broad wallet/map/runtime upgrades would be outside this P3 dependency-hygiene scope.

## Remaining dev/build-only advisories

The all-dependency audit now has only moderate dev/build advisories on top of the production-runtime moderate set:

- `vite`, `vite-plugin-pwa`, `vitest`, and `@vitest/mocker` through `postcss <8.5.10`. The root `vite@6.4.2` range currently resolves `postcss@8.5.8`; npm reports no compatible fix without broader Vite/PostCSS movement.
- `convex-test` through the same Convex/ws chain reported in production.
- `exceljs -> uuid@8.3.2`. `exceljs@4.4.0` depends on `uuid@^8.3.0`; no newer ExcelJS release is available, and replacing the spreadsheet library is outside this narrow follow-up.

No force upgrade was applied because the remaining issues are moderate and would require broader package replacement or runtime/toolchain changes.

## Round 6 R6-3 wallet-chain check - 2026-06-03

Scope: Country Resilience Index round-6 R6-3 moderate dependency advisory debt in the Clerk/Solana wallet chain.

Current audit results in the `origin/main` worktree at `e1739afc4758e664d13aae54e1b457c12e5eb075`:

- `npm audit --omit=dev --json`: 0 critical, 0 high, 12 moderate.
- `npm audit --json`: 0 critical, 0 high, 13 moderate.

These counts are lower than the earlier round-4 refresh because this section is a fresh point-in-time audit of the current `origin/main` tree, not a reduction produced by this R6-3 pass. npm's current report no longer includes the earlier Anthropic SDK, mapping/vector, Convex, Telegram, or shared websocket advisory families in this lockfile; the remaining production findings are the Clerk wallet chain.

The production findings are the Clerk wallet chain:

- `@clerk/clerk-js@6.13.0` directly pins `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- The Solana wallet packages peer on `@solana/web3.js@^1.98.0`; the resolved and latest stable release is `@solana/web3.js@1.98.4`.
- `@solana/web3.js@1.98.4` depends on `jayson@^4.1.1`; the resolved and latest release is `jayson@4.3.0`.
- `jayson@4.3.0` depends on `uuid@^8.3.2`, which remains inside the `uuid <11.1.1` advisory range.

The all-dependency-only extra finding is `exceljs@4.4.0 -> uuid@^8.3.0`. `exceljs@4.4.0` is still the latest published release.

A targeted package-lock-only update attempt was run for the implicated packages:

`npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts`

npm reported the graph was up to date and still had 13 moderate findings. It only removed optional peer lockfile entries for `utf-8-validate`, which did not reduce R6-3, so that incidental lockfile churn was not kept.

No override was added. Forcing `uuid@>=11.1.1` under `jayson` or `exceljs` would violate their declared `uuid@^8` ranges, and forcing `@solana/web3.js@2.x` or `3.x` would violate the current wallet adapter peer range and would be a broader wallet integration migration. Clerk snapshot/canary builds newer than `6.13.0` still pin the same Solana wallet packages.

Recommended tracking action: keep R6-3 open as upstream dependency debt and retest when one of these stable releases exists: Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched `@solana/web3.js` line, `@solana/web3.js` 1.x stops depending on `jayson -> uuid@8`, or `jayson`/`exceljs` publish compatible `uuid@>=11.1.1` support.

## Round 7 R7-2 dependency-envelope check - 2026-06-03

Scope: Country Resilience audit round-7 R7-2 moderate advisory debt in the broader repo dependency envelope. This pass stayed limited to root dependency audit evidence and did not change frontend import or bundle architecture.

Current audit results in the `origin/main` worktree at `14fd4a5f6d26b36c5ac8289af5073c092d5a2b4d`:

- `npm audit --omit=dev --json`: 0 critical, 0 high, 12 moderate.
- `npm audit --json`: 0 critical, 0 high, 13 moderate.

The before and after counts are unchanged for this R7-2 pass because the compatible graph is already at the latest stable releases for the implicated packages:

- `@clerk/clerk-js@6.13.0` is the latest stable release and still directly depends on `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- `@solana/web3.js@1.98.4` is the latest stable 1.x release and still depends on `jayson@^4.1.1`.
- `jayson@4.3.0` is the latest release and still depends on `uuid@^8.3.2`.
- `exceljs@4.4.0` is the latest release and still depends on `uuid@^8.3.0`.

Commands run for this check:

- `npm audit --omit=dev --json`
- `npm audit --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit fix --package-lock-only --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts`

The targeted update reported the graph was up to date and still had 13 moderate findings. It produced only incidental optional-peer lockfile churn for `utf-8-validate`; that churn did not affect the audit result and was not kept.

`npm audit fix --package-lock-only --dry-run --json` reported no safe package-lock-only reduction. Its force-style fix suggestions were semver-major downgrades, not compatible upgrades:

- `@clerk/clerk-js` 6.13.0 -> 5.114.1, which would change the direct auth package major line.
- `exceljs` 4.4.0 -> 3.4.0, which would downgrade the spreadsheet export dependency.

No override was added. Forcing `uuid@>=11.1.1` under `jayson` or `exceljs` would violate their declared `uuid@^8` ranges, and forcing a newer Solana API line would exceed the current wallet-adapter peer envelope. Those changes need auth, wallet, and export compatibility validation beyond this narrow dependency-envelope audit.

Owner/date: dependency hygiene owner, 2026-06-03. Close R7-2 when one of these lands and validates cleanly: Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched Solana web3 line, Solana web3 1.x removes the `jayson -> uuid@8` edge, `jayson` publishes compatible `uuid@>=11.1.1` support, or `exceljs` publishes compatible `uuid@>=11.1.1` support.

## Round 8 / R4-10 dependency-envelope check - 2026-06-04

Scope: Country Resilience P3/R4-10 dependency follow-up against current `origin/main`. This pass checked whether the remaining production `uuid <11.1.1` advisory has a minimal safe remediation and whether it belongs in the CRI defect queue. No package or runtime code was changed.

Current audit results in the `origin/main` worktree at `8fff4671cf1172f6869cafedfb2eb2acc98de7d2` with Node `v24.15.0` and npm `11.12.1`:

- `npm audit --omit=dev --json`: 0 critical, 0 high, 12 moderate.
- `npm audit --json`: 0 critical, 0 high, 13 moderate.

The production chain remains `@clerk/clerk-js -> @solana/wallet-adapter-* -> @solana/web3.js -> jayson -> uuid@8.3.2`. The all-dependency-only extra finding remains `exceljs -> uuid@8.3.2`.

R4-10 classification: non-CRI residual dependency hygiene. The advisory is rooted in the repository auth/wallet and spreadsheet dependency graph, not in Country Resilience scoring, seed freshness, API contract, methodology, or UI presentation logic. Do not count this item as an open CRI defect after this tracking note; keep it in the dependency-audit backlog until the recovery trigger below is met.

Current registry checks:

- `@clerk/clerk-js@6.14.0` is now published, but it still depends on `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- `@solana/wallet-adapter-base@0.9.27` still peers on `@solana/web3.js@^1.98.0`.
- `@solana/web3.js@1.98.4` remains the latest stable 1.x release and still depends on `jayson@^4.1.1`.
- `jayson@4.3.0` remains the latest release and still depends on `uuid@^8.3.2`.
- `exceljs@4.4.0` remains the latest release and still depends on `uuid@^8.3.0`.

Commands run for this check:

- `git fetch origin`
- `git rev-parse HEAD origin/main`
- `node --version`
- `npm --version`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --omit=dev --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit fix --package-lock-only --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @clerk/clerk-js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/web3.js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/wallet-adapter-base version peerDependencies dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view jayson version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view exceljs version dependencies --json`

`npm audit fix --package-lock-only --dry-run --json` reported no lockfile changes: 0 added, 0 removed, 0 changed. Its force suggestions remain semver-major downgrades rather than compatible upgrades:

- `@clerk/clerk-js` 6.x -> 5.114.1, which would change the direct auth package major line.
- `exceljs` 4.4.0 -> 3.4.0, which would downgrade the spreadsheet export dependency.

Conclusion: no minimal safe lockfile-only fix exists for this production advisory on 2026-06-04. Updating Clerk from 6.13.0 to 6.14.0 would not remove the Solana wallet chain or reduce the audit count, and forcing `uuid@>=11.1.1` under `jayson` or `exceljs` would violate their declared `uuid@^8` ranges. Treat R4-10 as closed for CRI by documentation/tracking, with the residual risk tracked as broader repository dependency debt.

Recovery trigger: re-open dependency remediation when one of these lands and validates cleanly without broad auth/wallet/export churn: Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched Solana web3 line, Solana web3 1.x removes `jayson -> uuid@8`, or `jayson`/`exceljs` publish compatible `uuid@>=11.1.1` support.

## Round 9 / CII dependency-envelope closeout - 2026-06-05

Scope: CII review dependency-audit closeout against worktree HEAD `eaaa0c5fedeebd30f321b2e6e96e1d05f39cb3c8`. This pass checked whether the remaining moderate advisory count can be reduced by a minimal package-lock-only or compatible package refresh. No package or runtime code was changed.

Current audit results with Node `v24.15.0` and npm `11.12.1` after `npm_config_cache=/tmp/worldmonitor-npm-cache npm ci --ignore-scripts`:

- `npm audit --omit=dev --audit-level=moderate --json`: 0 critical, 0 high, 12 moderate.
- `npm audit --audit-level=moderate --json`: 0 critical, 0 high, 13 moderate.

The production chain remains `@clerk/clerk-js -> @solana/wallet-adapter-* -> @solana/web3.js -> jayson -> uuid@8.3.2`. The all-dependency-only extra finding remains `exceljs -> uuid@8.3.2`.

Current registry checks:

- `@clerk/clerk-js@6.14.0` is published, but it still depends on `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- `@solana/wallet-adapter-base@0.9.27` still peers on `@solana/web3.js@^1.98.0`.
- `@solana/web3.js@1.98.4` remains the latest stable 1.x release and still depends on `jayson@^4.1.1`.
- `jayson@4.3.0` remains the latest release and still depends on `uuid@^8.3.2`.
- `exceljs@4.4.0` remains the latest release and still depends on `uuid@^8.3.0`.

Commands run for this check:

- `npm_config_cache=/tmp/worldmonitor-npm-cache npm ci --ignore-scripts`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --audit-level=moderate --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --omit=dev --audit-level=moderate --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit fix --package-lock-only --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @clerk/clerk-js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/web3.js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/wallet-adapter-base version peerDependencies dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view jayson version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view exceljs version dependencies --json`

`npm audit fix --package-lock-only --dry-run --json` reported no lockfile changes: 0 added, 0 removed, 0 changed. The targeted package-lock-only update dry run also reported 0 added, 0 removed, and 0 changed. The only npm-proposed fix paths remain semver-major downgrades rather than compatible upgrades:

- `@clerk/clerk-js` 6.x -> 5.114.1, which would change the direct auth package major line.
- `exceljs` 4.4.0 -> 3.4.0, which would downgrade the spreadsheet export dependency.

Conclusion: no minimal safe lockfile or package change exists for this CII closeout on 2026-06-05. Do not add a forced `uuid` override under `jayson` or `exceljs`; it would violate their declared `uuid@^8` ranges. Do not force a newer Solana API line in this narrow closeout; that would exceed the current wallet-adapter peer envelope and require broader auth/wallet compatibility validation. Treat the remaining 13 moderate findings as accepted residual dependency hygiene debt for CII, with production impact represented by the 12-moderate Clerk/Solana/Jayson/UUID chain and the all-dependency-only 13th finding represented by ExcelJS/UUID.

Recovery trigger: re-open dependency remediation when one of these lands and validates cleanly without broad auth/wallet/export churn: Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched Solana web3 line, Solana web3 1.x removes `jayson -> uuid@8`, or `jayson`/`exceljs` publish compatible `uuid@>=11.1.1` support.

## Round 10 / CII dependency-audit bounded follow-up - 2026-06-06

Scope: CII dependency-audit gap check against worktree HEAD `3a8b10ad99f34d5ef67291e28b9448d18d64507a` on branch `codex/cii-dependency-audit`. This pass stayed limited to dependency-audit evidence and did not change package manifests, lockfiles, or CII runtime code.

Current audit results with Node `v26.0.0` and npm `11.12.1`:

Runtime note: Round 9 was captured on Node `v24.15.0`; this follow-up used the active Codex workspace toolchain on 2026-06-06 (`v26.0.0`). The counts below are therefore recorded with the exact Node/npm runtime and should be compared as a point-in-time audit result, not as a runtime-invariant package metric.

- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --omit=dev --audit-level=moderate --json`: 0 critical, 0 high, 12 moderate.
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --audit-level=moderate --json`: 0 critical, 0 high, 13 moderate.

Production classification: all 12 production moderate findings are in the direct `@clerk/clerk-js@6.13.0` dependency path through Solana wallet packages, `@solana/web3.js@1.98.4`, `jayson@4.3.0`, and `uuid@8.3.2`.

All-dependency-only classification: the 13th moderate finding is the direct devDependency `exceljs@4.4.0` through `uuid@8.3.2`.

Current registry checks:

- Latest `@clerk/clerk-js` is `6.14.0`, but it still depends on `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- Latest `@solana/wallet-adapter-base` is `0.9.27` and still peers on `@solana/web3.js@^1.98.0`.
- Latest `@solana/web3.js` is `1.98.4` and still depends on `jayson@^4.1.1`.
- Latest `jayson` is `4.3.0` and still depends on `uuid@^8.3.2`.
- Latest `exceljs` is `4.4.0` and still depends on `uuid@^8.3.0`.

Commands run for this check:

- `node --version`
- `npm --version`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm ci --ignore-scripts`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --omit=dev --audit-level=moderate --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --audit-level=moderate --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit fix --package-lock-only --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts --dry-run --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @clerk/clerk-js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/wallet-adapter-base version peerDependencies dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/wallet-adapter-react version dependencies peerDependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/wallet-standard version dependencies peerDependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view @solana/web3.js version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view jayson version dependencies --json`
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm view exceljs version dependencies --json`

`npm audit fix --package-lock-only --dry-run --json` reported 0 added, 0 removed, and 0 changed, with the same 13 moderate all-dependency audit result. The only npm-proposed remediation paths remain semver-major or downgrade-shaped changes:

- `@clerk/clerk-js` 6.x -> 5.114.1, which would change the direct auth package major line.
- `exceljs` 4.4.0 -> 3.4.0, which would downgrade the spreadsheet export devDependency.

The targeted package-lock-only update dry run for the implicated packages also reported 0 added, 0 removed, and 0 changed. No manifest, lockfile, or override change was applied because there is no current compatible package or lockfile movement that reduces the audit count without exceeding the current auth/wallet/export dependency envelope.

Conclusion: the dependency-audit gap is intentionally bounded, not green. Close the CII audit item only as documented residual dependency debt; re-open remediation when Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched Solana web3 line, Solana web3 1.x removes `jayson -> uuid@8`, or `jayson`/`exceljs` publish compatible `uuid@>=11.1.1` support.

## Round 11 / delegated CII dependency-audit follow-up - 2026-06-06

Scope: delegated dependency-audit follow-up against fetched `origin/main` / detached HEAD `a560cb8c8f64cfd23058a42a41d4017ffadbe5f2` in an isolated Codex worktree. This pass checked whether a minimal safe manifest or lockfile movement now exists for the residual `uuid <11.1.1` moderate advisory chain. No package manifest, lockfile, runtime code, or override was changed.

Current runtime for this check:

- `node -v`: `v24.15.0`
- `npm -v`: `11.12.1`

Current audit results:

- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --omit=dev --json`: 0 critical, 0 high, 12 moderate.
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit --json`: 0 critical, 0 high, 13 moderate.

Lockfile dependency graph evidence:

- `npm ls @clerk/clerk-js @solana/web3.js exceljs uuid jayson` returned an empty tree in this isolated worktree because `node_modules` was not installed.
- `npm ls --package-lock-only @clerk/clerk-js @solana/web3.js exceljs uuid jayson` confirmed the production path: `@clerk/clerk-js@6.13.0 -> @solana/wallet-adapter-base@0.9.27` / `@solana/wallet-adapter-react@0.15.39 -> @solana/web3.js@1.98.4 -> jayson@4.3.0 -> uuid@8.3.2`.
- The all-dependency-only extra path remains `exceljs@4.4.0 -> uuid@8.3.2`.

Current registry and dry-run checks:

- Latest `@clerk/clerk-js` is `6.14.0`, but it still depends on `@solana/wallet-adapter-base@0.9.27`, `@solana/wallet-adapter-react@0.15.39`, and `@solana/wallet-standard@1.1.4`.
- Latest `@solana/wallet-adapter-base` is `0.9.27` and latest `@solana/wallet-adapter-react` is `0.15.39`; both still peer on `@solana/web3.js@^1.98.0`.
- Latest stable `@solana/web3.js` is `1.98.4` and still depends on `jayson@^4.1.1`. `@solana/web3.js@2.0.0` is published, but forcing that line would exceed the wallet adapter peer envelope.
- Latest `jayson` is `4.3.0` and still depends on `uuid@^8.3.2`.
- Latest `exceljs` is `4.4.0` and still depends on `uuid@^8.3.0`.
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm audit fix --package-lock-only --dry-run --json` reported 0 added, 0 removed, and 0 changed, with the same 13 moderate all-dependency audit result.
- `npm_config_cache=/tmp/worldmonitor-npm-cache npm update @clerk/clerk-js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-standard @solana/wallet-standard-wallet-adapter @solana/wallet-standard-wallet-adapter-base @solana/wallet-standard-wallet-adapter-react @solana/web3.js jayson uuid exceljs --package-lock-only --ignore-scripts --dry-run --json` reported 0 added, 0 removed, and 0 changed.

The only npm-reported fix paths remain semver-major or downgrade-shaped changes:

- `@clerk/clerk-js` 6.x -> 5.114.1, which would change the direct auth package major line.
- `exceljs` 4.4.0 -> 3.4.0, which would downgrade the spreadsheet export dependency.

Conclusion: no minimal safe package or lockfile change exists for this dependency-audit follow-up on 2026-06-06. Do not force a `uuid@>=11.1.1` override under `jayson` or `exceljs`; it would violate their declared `uuid@^8` dependency ranges. Do not force `@solana/web3.js@2.x` in this narrow audit closeout; that is a broader auth/wallet compatibility migration.

Reopen dependency remediation when one of these lands and validates cleanly without broad auth/wallet/export churn: Clerk removes or updates the Solana wallet pins, Solana wallet adapters accept a patched Solana web3 line, Solana web3 1.x removes `jayson -> uuid@8`, `jayson` publishes compatible `uuid@>=11.1.1` support, or `exceljs` publishes compatible `uuid@>=11.1.1` support.
