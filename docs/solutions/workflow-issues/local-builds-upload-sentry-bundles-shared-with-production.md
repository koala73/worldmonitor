---
title: A local build uploads source maps to Sentry, and the bundle may be production's
date: 2026-09-28
category: workflow-issues
module: pro-test
problem_type: workflow_issue
component: tooling
severity: medium
symptoms:
  - "A local npm --prefix pro-test run build uploaded a source-map artifact bundle to the production Sentry release"
  - "The uploaded bundle's modified time changed again when production deployed a few minutes later"
root_cause: config_error
resolution_type: workflow_improvement
tags: [sentry, source-maps, artifact-bundle, debug-id, pro-test, local-build]
---

# A local build uploads source maps to Sentry, and the bundle may be production's

## Context

While replacing text-matching tests for #8686, an agent ran `npm --prefix pro-test run build` so that the built-output suites (`pro-welcome-prerender`) would run instead of skipping. `SENTRY_AUTH_TOKEN` is exported from the shell profile on the maintainer's machine. `pro-test/vite.config.ts` enables the Sentry Vite plugin whenever that variable is set (`uploadSourceMapsToSentry = Boolean(process.env.SENTRY_AUTH_TOKEN)`). So the local build uploaded a source-map artifact bundle to the release `worldmonitor@2.10.0`, the release production reports.

The obvious fix looked like deleting the stray bundle. That would have removed the source maps production was using.

## Guidance

1. **Build locally with the token removed:** `env -u SENTRY_AUTH_TOKEN npm --prefix pro-test run build`. That build writes no `.map` files and uploads nothing. The same applies to the dashboard build; see the bundle-budget note linked below.
2. **Never delete an artifact bundle without comparing its debug IDs to the live site.** Artifact bundle IDs are derived from the bundle's content. A local build of the same commit as production produces the same bundle, so production's later upload lands in the same bundle ID. Compare before deleting:
   - List the release's bundles through `projects/<org>/<project>/files/artifact-bundles/?query=<release>`.
   - List one bundle's files and debug IDs through `projects/<org>/<project>/artifact-bundles/<bundleId>/files/`.
   - Extract the debug IDs (the `debugId=` comments or `_sentryDebugIds` assignments) from the JS files under `/pro/assets/` that the live pages load.
   - Delete the bundle only if none of the live debug IDs are in it.

## Why This Matters

In this case the stray bundle was created at 12:53 UTC with 32 debug IDs, all of them from the local build. #8685 merged at 13:06 UTC, and the production deploy uploaded the identical `/pro` output at 13:08, which updated the same bundle. 2 of the 3 debug IDs in the live `/pro` JavaScript were in that bundle. Deleting it as a cleanup would have left production `/pro` errors without symbolication until the next deploy that changed `/pro` content.

## When to Apply

- Any local `vite build`, including `pro-test`, the dashboard and embed builds, on a machine where the shell exports `SENTRY_AUTH_TOKEN`.
- Any cleanup of Sentry artifact bundles, releases or debug files after an accidental upload.

## Examples

Local build, before and after:

```bash
# Before: uploads to the production release when the profile exports the token.
npm --prefix pro-test run build

# After: no upload and no source maps.
env -u SENTRY_AUTH_TOKEN npm --prefix pro-test run build
```

Cleanup decision: in this incident the answer was to keep the bundle. The local upload changed nothing lasting, because production uploaded identical content to the same bundle.

## Related

- `docs/solutions/workflow-issues/sentry-resolve-by-shipping-permanently-mutes-issues.md`, another Sentry workflow trap.
- The bundle-budget reseed procedure (`scripts/bundle-budgets.mjs`), which must also run with `SENTRY_AUTH_TOKEN` unset because the plugin adds about 460 bytes per chunk.
- #8686: the pull request whose verification triggered the upload.
