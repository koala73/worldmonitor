---
title: "Vercel Node-runtime routes fail at module load on extensionless relative imports"
date: 2026-10-08
category: runtime-errors
module: api/mcp-proxy.ts
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "Every request to a route moved to runtime: 'nodejs' returns FUNCTION_INVOCATION_FAILED, OPTIONS preflights included"
  - "vercel build succeeds and every local test passes under tsx and vitest"
  - "A plain curl User-Agent sees the bot gate's 403, which masks the 500"
root_cause: wrong_api
resolution_type: code_fix
related_components: [testing_framework, development_workflow]
tags: [vercel-node-runtime, native-esm, err-module-not-found, import-specifiers, mcp-proxy, ghsa-887j, vercel-build-harness]
---

# Vercel Node-runtime routes fail at module load on extensionless relative imports

## Problem

Moving `api/mcp-proxy.ts` from the Edge runtime to the Node runtime (needed to pin upstream sockets for GHSA-887j) took the route down in production twice. PR #4749 was reverted by #4754, and PR #7578 was reverted by #7605. The second failure stayed undiagnosed for a month, because nothing outside the built artifact shows it.

## Symptoms

- After #7578 merged, production `/api/mcp-proxy` answered `FUNCTION_INVOCATION_FAILED` to every request, `OPTIONS` included.
- `vercel build` succeeded. The Node-shaped entry-point test passed. The suite runs under `tsx`.
- Probing with a default `curl` User-Agent returned the bot gate's `403`, which hid the `500`.

## What Didn't Work

- **Testing the handler under `tsx`.** `tsx` resolves extensionless relative imports, so every local test saw a module that loads.
- **Testing the `(req, res)` adapter contract.** #7578 added a guard test that drove the default export with an `IncomingMessage`-shaped object. The test was correct and irrelevant, because the module never loaded far enough to reach the handler.
- **Reading Vercel runtime logs afterwards.** They are a live tail, so the July and September incidents left nothing to query.

## Solution

Reproduce with Vercel's own builder, then make the import graph loadable as native ESM.

**Reproduction.** Extract the reverted commit into a scratch project and build it:

1. Run `git archive caf42e6287` for `api`, `server`, `shared`, `src/shared`, `src/generated`, `src/config`, `package.json` and `tsconfig.json`.
2. Keep only `api/mcp-proxy.ts`, the `_*` helpers and `api/mcp/`.
3. Strip `scripts` from `package.json`, because the repo `postinstall` needs files the scratch copy lacks.
4. Add a stub `.vercel/project.json` with `"buildCommand": "true"` and `"outputDirectory": "public"`.
5. Run `vercel build --yes` and import the emitted function:

```text
.vercel/output/functions/api/mcp-proxy.func/api/mcp-proxy.js
  import { isCallerPremium } from '../server/_shared/premium-check';

node -e "import('./api/mcp-proxy.js')"
  ERR_MODULE_NOT_FOUND Cannot find module '.../mcp-proxy.func/server/_shared/premium-check'
```

**Fix (PR #9038).**

1. Name the `.js` file of every relative import in the route's local graph: 42 specifiers in 11 files. `tsc` (`moduleResolution: "bundler"`), esbuild, `tsx` and vitest all resolve `./x.js` to `x.ts`, so only the specifier text changes.

   ```ts
   // before
   import { resolvePremiumCallerIdentity } from '../server/_shared/premium-check';
   // after
   import { resolvePremiumCallerIdentity } from '../server/_shared/premium-check.js';
   ```

2. Export per-method Web handlers and **no default export**:

   ```ts
   export const config = { runtime: 'nodejs' };
   export async function handler(req, ctx) { /* Web Request => Response */ }
   export { handler as GET, handler as POST, handler as OPTIONS };
   ```

3. Guard it in CI. `tests/edge-functions.test.mjs` ("Node-runtime routes load as native ESM") bundles each Node-runtime route with an esbuild metafile and fails on any local relative import that does not end in `.js`, `.mjs` or `.cjs`. It names the file and the specifier.

## Why This Works

`@vercel/node` does not bundle a Node function. It compiles each file separately, traces dependencies with nft, and keeps import specifiers as written. With `"type": "module"` in `package.json`, the output is native ESM, and Node's ESM resolver requires a full file path for relative imports. An extensionless specifier throws `ERR_MODULE_NOT_FOUND` while the module loads, so no request ever reaches the handler. Edge functions are bundled by esbuild, which resolves extensionless imports, so the same source works there.

The export shape is a second trap: it is what reverted #4749. The loader in `@vercel/node` (`dev-server.mjs`) runs `for (...) if (listener.default) listener = listener.default` **before** it checks for `GET`, `POST` and the other method exports. Any default export therefore wins, and Vercel calls it as `(IncomingMessage, ServerResponse)`; a Web-style default export then fails at `req.headers.get`. With method exports only, Vercel builds a genuine `Request` through `@edge-runtime/node-utils`' `buildToNodeHandler`. It skips `addHelpers`, so the body is not pre-drained. It passes a FetchEvent-like second argument with `waitUntil`, and it answers unexported methods with 405.

## Prevention

- Treat `vercel build` output as the only trustworthy artifact for a Node-runtime route. Before merging a runtime move, build the route in a scratch project and serve the `.func` through a harness that copies `dev-server.mjs`'s listener selection and `createWebExportsHandler`. The same harness that served the fixed route reproduced #7578's failure exactly.
- Smoke a real preview before merge. Use the Vercel connector's `get_access_to_vercel_url` to get past deployment protection, and send a browser User-Agent so the bot gate cannot mask a `500`. Then read `runtime=nodejs24.x` in the runtime logs: a healthy `401` looks the same on Edge and Node.
- Node's `fetch` is not Edge's. It forwards `TE`, `Trailer` and `Proxy-*` as given, and it throws on caller-set `Transfer-Encoding`, `Keep-Alive`, `Upgrade`, `Expect` and a mismatched `Content-Length`. A proxy that moves to Node needs an explicit hop-by-hop header filter.
- To pin a socket without leaving `fetch()`, pass a per-request undici `Agent` with `connect: { lookup }` as the `dispatcher`. Answer both lookup conventions (`{ all: true }` and the single-address callback). The URL hostname still drives TLS SNI and `Host`. A graceful `agent.close()` lets an in-flight streaming body finish.

## Related

- GHSA-887j-p88r-qmm9: the advisory, with the full remediation history.
- Issue #4674: the original request for DNS resolution and private-IP blocking.
- PR #9038: the fix and its gates.
