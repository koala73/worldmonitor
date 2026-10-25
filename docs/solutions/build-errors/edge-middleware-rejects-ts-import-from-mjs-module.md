---
title: "Vercel refuses the deploy when a .mjs module bundled into middleware.ts imports a .ts file"
date: 2026-10-24
category: build-errors
module: middleware.ts
problem_type: build_error
component: tooling
severity: high
symptoms:
  - "Vercel preview deploy fails with: The Edge Function \"middleware\" is referencing unsupported modules"
  - "The error names the offending pair, e.g. scripts/situation-page/sections.mjs: ../../src/config/chokepoint-registry.ts"
  - "typecheck, typecheck:api, esbuild bundling and every node --import tsx test pass locally"
root_cause: wrong_api
resolution_type: code_fix
related_components: [testing_framework, development_workflow]
tags: [vercel-edge, middleware, edge-bundler, unsupported-modules, mjs-imports-ts, import-graph-test, dependency-injection, crawlable-corpus]
---

# Vercel refuses the deploy when a .mjs module bundled into middleware.ts imports a .ts file

## Problem

PR #9623 added `/monitor-the-situation/`. Its live sections live in `scripts/situation-page/sections.mjs`, which is imported both by the static generator and by `middleware.ts`. The first version of that module imported `CHOKEPOINT_REGISTRY` straight from `../../src/config/chokepoint-registry.ts`. Vercel refused the preview deployment, so the PR could not ship.

## Symptoms

- The Vercel check on the PR failed with `The Edge Function "middleware" is referencing unsupported modules`, followed by `scripts/situation-page/sections.mjs: ../../src/config/chokepoint-registry.ts`.
- The same build log carries `TS7016` "Could not find a declaration file" lines. Those were present before the change and are not the cause.
- Every local check was green: `npm run typecheck`, `npm run typecheck:api`, esbuild-based bundling, and all tests run with `node --import tsx`.

## What Didn't Work

- **Trusting local bundling.** esbuild bundles a `.ts` import from a `.mjs` file without complaint, so a local esbuild check of the middleware graph does not reproduce the failure.
- **Trusting typecheck.** `tsc` with `allowImportingTsExtensions` resolves the specifier, so the types are fine.
- **Reading the `TS7016` lines first.** They appear in the same log and look like the failure, but they are long-standing noise in this repo.

## Solution

Keep the middleware-bundled `.mjs` module free of `.ts` imports and inject the TypeScript data from a TypeScript caller.

Before, in `scripts/situation-page/sections.mjs` (the pre-squash shape, simplified; #9623 merged squashed, so this version is not on main):

```js
import { CHOKEPOINT_REGISTRY } from '../../src/config/chokepoint-registry.ts';
export const SITUATION_SECTIONS = [headlinesSection, chokepointsSection(CHOKEPOINT_REGISTRY), outagesSection];
```

After, the module exports a factory (`scripts/situation-page/sections.mjs:278`):

```js
export function situationSections(chokepointRegistry) {
  return Object.freeze([headlinesSection, chokepointsSection(chokepointRegistry), outagesSection]);
}
```

`middleware.ts` imports the registry from TypeScript, extensionless, where the Edge bundler accepts it (`middleware.ts:28` and `middleware.ts:32`):

```ts
import { CHOKEPOINT_REGISTRY } from './src/config/chokepoint-registry';
const SITUATION_SECTIONS = situationSections(CHOKEPOINT_REGISTRY);
```

The static generator runs under `tsx`, so it can keep the `.ts` import (`scripts/build-situation-page.mjs:11` and `:14`). The rebuilt HTML was byte-identical to the pre-fix build. The preview deploy went green, and production served the page with all three middleware-swapped sections live.

## Why This Works

Vercel's Edge middleware bundler treats a `.ts` specifier reached from a JavaScript module as an unsupported module. A `.ts` file imported from a `.ts` file (`middleware.ts`) is compiled normally. Moving the only `.ts` import up to the TypeScript entry point leaves the `.mjs` graph pure JavaScript, and the data still arrives through the factory argument.

## Prevention

- `tests/middleware-edge-js-imports.test.mjs` bundles `middleware.ts` with esbuild (`metafile: true`, `packages: 'external'`, no output written) and fails when any `.mjs` or `.js` input resolves an import to a `.ts`, `.tsx`, `.mts` or `.cts` file. With the original bug in place it fails and names `scripts/situation-page/sections.mjs imports ../../src/config/chokepoint-registry.ts`. It also asserts that more than five modules resolved, so a broken walk cannot pass vacuously.
- Read the resolved graph instead of matching import text. The first version of this test used a regex. Three review rounds on PR #9625 found forms it missed (side-effect imports, `{x}from` with no space, compact `export{x}from'./x.ts'`) and a false positive (`// import './x.ts'` in a comment). It also could not see an extensionless `import './x'` that resolves to `x.ts`. A fixture test in the same file now pins all of these against the esbuild walk.
- When a module under `scripts/` is shared by a generator and `middleware.ts`, pass TypeScript-owned data in as an argument. Do not import it.
- The same PR hit a second CI-only gate. A new top-level crawlable-corpus prefix must be mapped in `SEGMENT_FAMILIES` in `scripts/lib/seo-url-taxonomy.mjs`, or `tests/seo-url-taxonomy.test.mjs` fails in the unit shard. #9623 hit this on its first CI run.

## Related Issues

- [Vercel Node-runtime routes fail at module load on extensionless relative imports](../runtime-errors/vercel-node-runtime-extensionless-imports-fail-at-module-load.md). Same family: local tooling resolves an import graph that Vercel's runtime or bundler rejects. That case is the Node runtime and the opposite specifier problem.
- PR #9623 (the page and the fix), PR #9625 (the esbuild-graph version of the guard test).
