---
title: A local build uploads source maps to Sentry under the semver release
date: 2026-09-28
category: workflow-issues
module: pro-test
problem_type: workflow_issue
component: tooling
severity: medium
symptoms:
  - "A local npm --prefix pro-test run build uploaded a source-map artifact bundle to Sentry release worldmonitor@2.10.0"
  - "The uploaded bundle's modified time kept moving after the build, which looked like a later production upload but was other local builds"
root_cause: config_error
resolution_type: workflow_improvement
tags: [sentry, source-maps, artifact-bundle, debug-id, pro-test, local-build]
---

# A local build uploads source maps to Sentry under the semver release

## Context

While replacing text-matching tests for #8686, an agent ran `npm --prefix pro-test run build` so that the built-output suites (`pro-welcome-prerender`) would run instead of skipping. `SENTRY_AUTH_TOKEN` is exported from the shell profile on the maintainer's machine. `pro-test/vite.config.ts:12` enables the Sentry Vite plugin whenever that variable is set, so the local build uploaded a source-map artifact bundle.

The release it uploaded to is not the one production uses. `shared/sentry-build-metadata.ts` names the release from the build hash:

- A production or preview deploy has a 40-character `VERCEL_GIT_COMMIT_SHA`. It uses that SHA as both the release and the dist (lines 29-30), and each deploy uploads its own bundles tagged with the SHA.
- A local build has no SHA, so its hash is `dev`. It falls back to `worldmonitor@<version>` with no dist (lines 24-26). In this incident that was `worldmonitor@2.10.0`.

## Guidance

1. **Build locally with the token removed:** `env -u SENTRY_AUTH_TOKEN npm --prefix pro-test run build`. That stops the upload for every Vite build in the repo.
   - For `pro-test` it also stops `.map` output, because `pro-test/vite.config.ts:75` emits source maps only when uploading.
   - The dashboard build still emits maps when `WM_EMIT_SOURCEMAPS=1` or `VERCEL_ENV=preview` (`vite.config.ts:894`).
   - For bundle-budget reseeds, the token must be unset for the **build** that produces `dist/`, not only for `npm run bundle:budgets`. `scripts/bundle-budgets.mjs` reads an existing `dist/` and never builds. The plugin's debug-ID snippet is already in that output.
2. **Before deleting an artifact bundle, check that every debug ID in it has another holder.** Debug IDs come from file content, so identical JavaScript built locally and in production carries the same ID, and production's own SHA-tagged bundle holds its copy. The test:
   - List the candidate bundle's debug IDs: `projects/<org>/<project>/artifact-bundles/<bundleId>/files/`.
   - Page through the project's bundles (`projects/<org>/<project>/files/artifact-bundles/`) and remove every ID found in another bundle.
   - Delete only if no ID is left.

   This covers every chunk and every surface, not just the pages loaded today, and it covers clients still running older assets. If an ID is left with no other holder, keep the bundle while any client might still run that asset.

## Why This Matters

The first diagnosis in this incident got this wrong. The stray bundle, created at 12:53 UTC, had a modified time of 13:08, just after #8685 merged and production deployed. The first reading was that production had uploaded identical content into the same bundle, so deleting it would remove live `/pro` source maps. That reading was wrong:

- Production and preview uploads land in their own SHA-tagged bundles. The bundle list showed a separate pair per deploy.
- The stray bundle's modified time kept moving, to 13:57 by the time of the second check, with no deploy involved. Any local build with identical output and the token set re-touches the same bundle.
- The per-ID check found all 32 of its debug IDs in other bundles; 200 bundles were scanned. Deleting it would lose nothing.

The deletion then returned HTTP 403 "You do not have permission to perform this action." The profile token can upload bundles but cannot delete them, so an accidental upload needs someone with project admin rights to remove it.

## When to Apply

- Any local Vite build (`pro-test`, the dashboard, the embed) on a machine where the shell exports `SENTRY_AUTH_TOKEN`.
- Any cleanup of Sentry artifact bundles after an accidental upload.
- Any comparison of local and production artifacts: production's release is the commit SHA, not `worldmonitor@<version>`.

## Examples

Local build, before and after:

```bash
# Before: uploads to the worldmonitor@<version> release when the profile exports the token.
npm --prefix pro-test run build

# After: no upload.
env -u SENTRY_AUTH_TOKEN npm --prefix pro-test run build
```

Deletion decision in this incident: all 32 debug IDs were held by other bundles, so deleting the stray bundle was lossless. It still exists only because the available token lacked delete permission.

## Related

- `docs/solutions/workflow-issues/sentry-resolve-by-shipping-permanently-mutes-issues.md`, another Sentry workflow trap. It is also the reason production releases are commit SHAs.
- `scripts/bundle-budgets.mjs`: build its `dist/` input with `SENTRY_AUTH_TOKEN` unset, because the plugin adds about 460 bytes per chunk.
- #8686: the pull request whose verification triggered the upload.
