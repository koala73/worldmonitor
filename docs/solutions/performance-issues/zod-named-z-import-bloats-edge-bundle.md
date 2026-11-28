---
title: "Named `import { z } from 'zod'` keeps all of zod in the MCP edge bundle"
date: 2026-11-12
category: performance-issues
module: api/mcp.ts
problem_type: performance_issue
component: tooling
severity: high
symptoms:
  - "tests/edge-function-size.test.mjs fails with \"api/mcp.ts: 1026401 bytes exceeds 1024000\" after adding one small MCP tool"
  - "main measured 1,023,401 bytes gzip-9, leaving 599 bytes for any new MCP tool"
root_cause: wrong_api
resolution_type: code_fix
tags: [zod, esbuild, tree-shaking, edge-bundle, mcp, bundle-size]
---

# Named `import { z } from 'zod'` keeps all of zod in the MCP edge bundle

## Problem

`tests/edge-function-size.test.mjs` caps the esbuild + gzip-9 size of `api/mcp.ts` at 1,024,000 bytes. That keeps it 24 KiB below the 1 MiB Edge ceiling. When the budget landed in #10491, main already measured 1,023,401 bytes. PR #10526 added `get_reservoir_levels`, about 3 KB, and the bundle failed at 1,026,401 bytes.

## Symptoms

- `unit-shard` failed on `api/mcp.ts stays within its compressed function budget`.
- Shrinking the new tool could not fix it. Its whole addition was about 3 KB gzip, and the overrun was 2.4 KB.

## What didn't work

- Trimming the new tool's output schema and description. That would have gutted a public contract to recover a few hundred bytes. The next tool would hit the same wall.
- Raising the budget. The 24 KiB reserve below the Edge ceiling is deliberate.

## Solution

Change every `import { z } from 'zod';` to `import * as z from 'zod';`. The PR changed 18 files across `shared/`, `api/mcp/` and `src/`.

```ts
// before
import { z } from 'zod';
// after
import * as z from 'zod';
```

Result on the #10526 branch: 1,026,401 → 963,087 bytes gzip-9, a 63 KB drop. `npm run typecheck`, `npm run typecheck:api`, `test:related` and `test:dom` stayed green.

## Why this works

zod 4 exports `z` as a namespace object (`export { z }`). A named import of `z` binds that object as a value. esbuild cannot prove which properties a value object needs, so it keeps every export, including about 70 locale modules. With `import * as z`, each `z.object(...)` is a static property access on an ES namespace, so esbuild drops everything unused. Before the fix, zod contributed about 454 KB of raw minified output to the bundle.

## How it was diagnosed

1. Build with `metafile: true` and sum `bytesInOutput` per input from `outputs[...].inputs`. The zod locale files (`zod/v4/locales/*.js`) each showed 2–10 KB, which was the tell.
2. List which first-party files import zod from `metafile.inputs[*].imports`.
3. Test the hypothesis without editing any files. Use an esbuild `onLoad` plugin that rewrites `import { z } from 'zod'` to `import * as z from 'zod'` for first-party `.ts` files, then compare gzip-9 sizes with and without it.

## Prevention

- Use `import * as z from 'zod'`. Repo-wide, `git grep "import { z } from 'zod'"` should return nothing.
- When an edge bundle approaches its budget, read the metafile per-input bytes before trimming feature code. A whole library kept through a value import is the usual cause of large, unexpected growth.
- The size budget alone missed a regression. #10505 merged with a new named `{ z }` import and raised the budget to 1,044,480 bytes to make room, so the 63 KB came back unnoticed. `tests/edge-function-size.test.mjs` now also fails on any tracked source file that imports the named `z` from zod, and the 24 KiB reserve is restored.
