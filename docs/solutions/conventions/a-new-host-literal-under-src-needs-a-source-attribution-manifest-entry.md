---
title: A new https:// host literal under src/ fails CI docs-stats until the source-attribution manifest knows the host
module: source-attribution
date: 2026-10-14
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Adding any string containing https://<host> under src/, including a sentinel used only to resolve a URL"
  - "The local pre-push gate was green but the CI docs-stats job is red with 'missing manifest entry for <host>'"
  - "A URL-resolution helper needs a base origin that is never fetched"
tags: [source-attribution, docs-stats, manifest, sentinel-origin, worldmonitor-invalid, ci-only-check, safehtml]
---

# A new https:// host literal under src/ fails CI docs-stats until the source-attribution manifest knows the host

## Context

`safeHtml` in `src/utils/dom-utils.ts` needed to decide whether a leading-slash `href` is a genuine same-origin path or something the URL parser reads as scheme-relative (`//host`, `/\host`, `/<tab>/host`). The natural check resolves the href against a sentinel origin and compares `.origin`. The first cut used `https://safe-html.invalid`. Every local check passed (`typecheck`, `lint:boundaries`, the DOM suite, the pre-push gate), and CI `docs-stats` went red:

```
Error: source-attribution: invalid manifest (missing manifest entry for safe-html.invalid)
    at sourceAttributionStats (scripts/source-attribution.mjs)
    at computeStats (scripts/docs-stats.mjs)
```

`scripts/source-attribution.mjs` scans `src/` for every host literal and requires each one to have an entry in `shared/source-attribution-manifest.json`, so the published attribution page (`docs/source-attribution.mdx`) can account for every upstream the client might talk to. A sentinel that is never fetched still counts as a host. The pre-push gate does not run `docs-stats`, so this is CI-only.

## Guidance

1. For a URL-resolution sentinel, reuse the origin the manifest already excludes as test-only: `https://worldmonitor.invalid`. `src/shared/public-rpc-cache.ts` uses it for the same purpose, and the manifest entry carries `status: excluded`, so it never counts as a data provider.
2. After adding the literal, regenerate instead of hand-editing the manifest:

   ```bash
   node scripts/source-attribution.mjs --write   # records the new reference path under the host
   npm run docs:stats                            # regenerates docs/generated/stats.json
   node scripts/docs-stats.mjs --check           # what CI runs
   ```

3. Commit the three outputs together with the source change: `shared/source-attribution-manifest.json`, `docs/source-attribution.mdx`, and `docs/generated/stats.json` when it changed.
4. When the literal is a real upstream rather than a sentinel, `--write` still records the reference, but a human must fill in the provider, license and status fields the validator demands; see the existing entries for the shape.

```ts
// src/utils/dom-utils.ts
// Same test-only origin as src/shared/public-rpc-cache.ts (source-attribution manifest).
const SAME_ORIGIN_SENTINEL = 'https://worldmonitor.invalid';
function isSameOriginPath(href: string): boolean {
  if (!href.startsWith('/')) return false;
  try {
    return new URL(href, `${SAME_ORIGIN_SENTINEL}/`).origin === SAME_ORIGIN_SENTINEL;
  } catch {
    return false;
  }
}
```

## Why This Matters

The attribution page is a published claim about which upstreams the product uses. An unaccounted host literal, even a fake one, would make that claim incomplete, which is why the check throws instead of warning. Reusing the one excluded sentinel keeps the manifest honest without a second "test-only" entry that a reader would have to interpret.

The cost of not knowing this is one full CI round: the pre-push gate is scoped to the diff's test paths and never computes docs stats, so the first signal is the red `docs-stats` job after the push (PR #9131, 2026-10-14).

## When to Apply

- Any new `http://` or `https://` string under `src/`, `api/`, `server/` or `scripts/` (the inventory the generated attribution page says it is derived from), including constants, fixtures and resolution sentinels.
- Before pushing such a change, run `node scripts/docs-stats.mjs --check` locally; it is the only local way to see this failure.
- Strings under `tests/` are outside the inventory.

## Examples

Before (red in CI):

```ts
const SAME_ORIGIN_SENTINEL = 'https://safe-html.invalid';
```

After (manifest already has the host; `--write` only adds the reference path):

```ts
const SAME_ORIGIN_SENTINEL = 'https://worldmonitor.invalid';
```

```diff
       "host": "worldmonitor.invalid",
       ...
       "references": [
         { "path": "src/shared/public-rpc-cache.ts" },
+        { "path": "src/utils/dom-utils.ts" }
       ]
```

## Related Issues

- PR #9131 (the `safeHtml` origin check and the manifest reference).
- `scripts/source-attribution.mjs` (`--write` is the regenerate hint the validator prints).
