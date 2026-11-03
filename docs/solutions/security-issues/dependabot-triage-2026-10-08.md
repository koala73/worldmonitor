---
module: dependencies
component: npm and pnpm dependency graphs
problem_type: security_issue
tags: [dependabot, sharp, shell-quote, librsvg, stream-json, sprintf-js]
---

# Dependabot triage on October 8, 2026

The GitHub API returned ten open alerts. This review uses main commit `cc0d597e471a0d144f0e6882f98bdaf0f5b22dd8` and Node 24.20.0. Six alerts carry over from the [October 6 triage](dependabot-triage-2026-10-06.md). Four alerts are new.

| Alerts | Dependency and graph | Evidence and action |
| --- | --- | --- |
| 365 | sharp 0.35.4 in root | GHSA-wq5f-xc86-pv6w: the bundled librsvg can allow code execution on glibc Linux when sharp decodes an attacker-supplied SVG. The root override pinned 0.35.4. Raise the override to patched 0.35.5, which loads librsvg 2.63.2. |
| 367 | sharp 0.35.4 in the reconcile worker | Wrangler's miniflare pins sharp 0.35.4 exactly. This is a development dependency. Add an npm override to 0.35.5. The worker suite passes with the override. |
| 366 | shell-quote 1.10.0 in Pro | GHSA-pqg4-j6r4-53mv: `quote()` lets a line terminator after a comment token reach the shell. The Pro override pinned 1.10.0 for react-native's react-devtools-core. Raise it to 1.12.0, the version root already resolves. |
| 363 | shell-quote 1.10.0 in Umami runtime | npm-run-all 4.1.5 pulls it in to quote its own task arguments. Add a pnpm override to 1.12.0 and regenerate with pnpm 10.15.1. |
| 355, 360 | stream-json in root and Pro | Repaired on October 6 by the private 1.9.2-worldmonitor.1 backport. The private version still matches GitHub's range, so the alerts stay open. |
| 356, 361 | stream-json JSONC scanning in root and Pro | The affected JSONC code is absent from the installed 1.x package. No change. |
| 351, 359 | sprintf-js in root and blog | Upstream still publishes no patched release. Reviewed consumers use repository-controlled formats. No change. |

No demonstrated production path reaches the sharp defect. No repository code imports sharp outside `blog-site/scripts`, which already resolves 0.35.5. `@vercel/og` 0.11.1 renders the brief carousel on Edge through resvg-wasm and does not load sharp. `@xenova/transformers` runs in the browser ML worker, where sharp is not available. The upgrade removes the vulnerable binary from installs and images.

No repository code imports shell-quote. The Pro and Umami consumers are build tooling inside dependency trees.

No alert is dismissed. These changes do not authorize merge or deployment.

## Verification

- `tests/dependency-security-regression.test.mjs` asserts that the root, blog, worker, Pro, and Umami lockfiles select only patched sharp and shell-quote versions. Against main's lockfiles the four new checks fail, one per alert. With this change all 60 tests in the dependency, backport, and Umami suites pass.
- The installed root shell-quote rejects the advisory's line-terminator input with `TypeError`.
- The installed root sharp reports sharp 0.35.5 and librsvg 2.63.2.
- Clean root, Pro, and worker `npm ci` installs pass with lifecycle scripts disabled. The worker suite passes all 51 tests. A frozen Umami install with pnpm 10.15.1 resolves shell-quote 1.12.0.
- The Docker image build and production behavior are unverified.
