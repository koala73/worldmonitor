---
title: A Railway seeder crashes at import when scripts/ locks an older dependency than the root, while CI stays green
date: 2026-10-24
category: runtime-errors
module: railway-seeders
problem_type: runtime_error
component: background_job
symptoms:
  - "Every seed-natural-events cron tick crashed at startup with \"SyntaxError: Named export 'Dispatcher1Wrapper' not found. The requested module 'undici' is a CommonJS module\""
  - "seed-bundle-climate reported section=Natural-Events status=FAILED reason=exit 1 on the same import"
  - "The PR that introduced the import (#9608, a dependabot npm-security group bump) merged with every CI check green"
root_cause: config_error
resolution_type: dependency_update
severity: high
related_components: [testing_framework, tooling]
tags: [railway, seeders, undici, dependabot, lockfile, scripts-package-json, esm-named-exports, ci-guard]
---

# A Railway seeder crashes at import when scripts/ locks an older dependency than the root, while CI stays green

## Problem

Dependabot's #9608 bumped the root `undici` from 7.30.1 to 8.12.3 and changed `scripts/seed-natural-events.mjs` to wrap its `Agent` in `Dispatcher1Wrapper`, an export that exists only in undici 8. `scripts/package.json` still declared `^7.30.1`. Railway builds the nixpacks seeders with `rootDirectory: scripts`, so the container installed undici 7. Every tick of `seed-natural-events` and the Natural-Events section of `seed-bundle-climate` died at module link time, starting with the 07:50Z deploy on 2026-10-24.

## Symptoms

- The crash trace was `file:///app/seed-natural-events.mjs:6` ... `SyntaxError: Named export 'Dispatcher1Wrapper' not found`. The path `/app/<file>` shows the container root is `scripts/`.
- The `diagnose-railway-seeders` tool classified it `UNKNOWN`, because a module-link `SyntaxError` matches none of its crash markers. The evidence block still carried the trace.
- CI was green. Every test resolves bare packages from the root `node_modules`, which had undici 8.

## What Didn't Work

- **The existing #5266 container guard** (`tests/nixpacks-seeder-import-graph.test.mjs`, the `nixpacks-root-scripts seeder import graphs` suite) checks that each bare import is *declared* in `scripts/package.json`. undici was declared, just at the wrong major, so the guard passed.
- **A lockfile major-parity check alone** (added first, in #9611) catches only this exact shape. A same-major minor bump that adds an export, for example root 8.14 vs `scripts/` 8.12, would still pass CI and crash in production.
- **Probing exports with cwd `scripts/`.** The first version of the link check ran `node --input-type=module -e "import(...)"` from `scripts/`. Node's resolution walks up past `scripts/node_modules` into the root `node_modules`, which the container does not have. With `papaparse` deleted from `scripts/node_modules`, the check still passed.

## Solution

1. **Fix (#9611):** `scripts/package.json` declares `"undici": "^8.12.3"` (`scripts/package.json:27`). The `scripts/` engines floor moved to `>=22.19.0` (`scripts/package.json:41`), which undici 8 requires. The lockfile was refreshed. No other `scripts/` package depends on undici.
2. **Major-parity guard (#9611):** for every package declared in both manifests, the two lockfiles must lock the same major version, or the same minor while on 0.x (`tests/nixpacks-seeder-import-graph.test.mjs:217-258`).
3. **Link check against the real container tree (#9612):**
   - `namedPackageImports()` (`tests/nixpacks-seeder-import-graph.test.mjs:260`) uses the TypeScript parser on every file the nixpacks seeder graphs visit. It collects named imports, default imports, named re-exports, destructured `await import('pkg')` names, and a load-only entry for every bare static or dynamic package import.
   - `exportsFromScriptsDir()` (`:300`) loads each package from a temp dir whose only `node_modules` is a symlink to `scripts/node_modules` (a junction on Windows), run with `--preserve-symlinks`. Nothing above the sandbox can satisfy an import, and packages' own dependency lookups stay inside it too:

   ```js
   const sandbox = mkdtempSync(join(tmpdir(), 'wm-scripts-link-'));
   symlinkSync(join(scriptsDir, 'node_modules'), join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
   spawnSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e', probe], { cwd: sandbox, encoding: 'utf-8' });
   ```

4. **CI wiring (#9612):** each unit shard runs `npm ci --prefix scripts` and sets `WM_EXPECT_SCRIPTS_DEPS: '1'` (`.github/workflows/test.yml:416`, `:423`). With the marker set, a missing install fails the suite instead of skipping it, mirroring `WM_EXPECT_BUILT_OUTPUT`. Locally, without a `scripts/` install, the check skips and says why.

Each check was proven red before it was trusted:

- `npm i undici@7.30.1 --no-save` in `scripts/` fails with `Dispatcher1Wrapper (imported by scripts/seed-natural-events.mjs)`.
- `papaparse` removed fails with `Cannot find package 'papaparse'`.
- A stand-in `papaparse` without a default export names all 7 importers.
- `getDocument` stripped from the installed pdfjs-dist legacy build names its two dynamic importers.

Verified in production: the `seed-bundle-climate` 12:00Z run on 2026-10-24 logged `section=Natural-Events status=OK` and `ran:4 skipped:2 deferred:0 failed:0`.

## Why This Works

The two dependency trees are separate contracts. Tests exercise root `node_modules`, while the Railway nixpacks seeders run `npm ci` against `scripts/package-lock.json` and see nothing else. An ESM named import of a CommonJS package is checked when the module is linked, before any code runs, so a missing export kills the process at startup no matter which code path the tick would take. The link check asks Node the question it asks at container startup: "does this name exist in the namespace of the package as installed in `scripts/`?" It asks from a directory that can see only that tree.

## Prevention

- When a seeder crashes right after a dependency-bump merge, compare the package's version in `scripts/package-lock.json` with the root lockfile before reading seeder code. #9608's `npm-security` group bump covered four directories (root, `blog-site/`, `consumer-prices-core/`, `integrations/zapier/`), not `scripts/`, yet it edited a seeder to match the root's new version.
- Bump a shared package in both manifests in one PR. The parity guard fails if only the root moves a major.
- A test that probes "what the container would load" must run with a resolution root the container would have. Running from `scripts/` inside the repo is not equivalent, because Node keeps walking up to the root `node_modules`.
- When a new guard goes green on the first try, break the thing it guards before trusting it. Here the `papaparse` removal exposed the root-tree fallback, which the undici case could not: `scripts/` had its own undici 7, so resolution never reached the root.
- A crash during describe-time collection (here, `createSourceFile` without `setParentNodes`, so `node.parent` was undefined) shows up as `cancelled 1` with `fail 0` and exit 1. Read the `cancelled` line and the test count, not only `fail`.

## Related Issues

- #9608: the dependabot bump that introduced the import.
- #9611: the fix and the lockfile major-parity guard.
- #9612: the CI link check against `scripts/node_modules`.
- #5266: the original declared-dependency budget for nixpacks seeders (`papaparse` missing from `scripts/package.json`).
- [railway-cron-crash-behind-failed-build-never-self-heals](../integration-issues/railway-cron-crash-behind-failed-build-never-self-heals.md): a related Railway cron failure mode where the badge looks green.
