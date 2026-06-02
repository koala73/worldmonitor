# Dependency audit follow-up - 2026-06-02

Scope: Country Resilience Index round-4 P3-2 dependency hygiene follow-up. This note records package-audit reachability only; no resilience scorer/runtime code was changed.

## Commands

- Baseline before lockfile refresh:
  - `npm audit --omit=dev --json`: 0 critical, 0 high, 36 moderate.
  - `npm audit --json`: 0 critical, 9 high, 44 moderate.
- After lockfile refresh:
  - `npm audit --omit=dev --json`: 0 critical, 0 high, 18 moderate.
  - `npm audit --json`: 0 critical, 0 high, 20 moderate.

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
- Mapping/vector schema parser: `protocol-buffers-schema`.
- Convex stack: `convex` and `ws`.
- Proxy/address parser: `ip-address`.

These were not force-upgraded because npm does not offer high/critical production fixes in the current compatible graph, and forcing broad wallet/map/runtime upgrades would be outside this P3 dependency-hygiene scope.

## Remaining dev/build-only advisories

The all-dependency audit now has only moderate dev/build advisories:

- `vite`, `vite-plugin-pwa`, `vitest`, and `@vitest/mocker` through `postcss <8.5.10`. The root `vite@6.4.2` range currently resolves `postcss@8.5.8`; npm reports no compatible fix without broader Vite/PostCSS movement.
- `exceljs -> uuid@8.3.2`. `exceljs@4.4.0` depends on `uuid@^8.3.0`; no newer ExcelJS release is available, and replacing the spreadsheet library is outside this narrow follow-up.

No force upgrade was applied because the remaining issues are moderate and would require broader package replacement or runtime/toolchain changes.
