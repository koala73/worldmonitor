---
module: dependencies
component: npm dependency graphs and temporary security backports
problem_type: security_issue
tags: [stream-json, deepmerge, minimatch, glob, uuid, dependency-backports]
---

# Dependency advisory remediation on November 5, 2026

Package presence does not establish that an external WorldMonitor request reaches
the affected function. This repair covers the root, Pro, Railway scripts, and
Zapier npm lockfiles where the reported packages occur.

## Findings and resolution

| Advisory | Evidence and resolution |
| --- | --- |
| [stream-json filter depth DoS](https://github.com/advisories/GHSA-528h-pc64-c93x) | The 1.x backport still rebuilt the full path at each unmatched container. Bound path-filter traversal to 1024 containers before evaluating another container; callers may lower the limit. Preserve the CommonJS API used by jayson. |
| [stream-json Assembler prototype poisoning](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | Already repaired in both normal and reviver assignments. Installed-consumer regressions continue to prove own-key semantics. |
| [stream-json JSONC scanning DoS](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | Not applicable: the vendored 1.x package has no JSONC parser or verifier. |
| [stream-json FlexAssembler depth DoS](https://github.com/advisories/GHSA-jj87-hc4r-jwfw) | Not applicable: FlexAssembler is absent from 1.x; the current affected range begins at 2.0.0. |
| [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | The advisory updated November 4 excludes versions below 7. Preserve 3.x and 5.x. Replace affected 9.x/10.x instances with patched 11.x. |
| [glob cancellation bypass](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | Scope overrides to affected 10.x/11.x/13.x consumers and select 14.0.2. Preserve unaffected glob 7.x. Check synchronous/asynchronous globbing and abort behavior through Sentry and Workbox resolutions. |
| [deepmerge returned-object prototype poisoning](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | Reproduced with null-prototype targets, own prototype keys, and null nested targets. No patched release is listed. Backport own-data-property writes to all three merge destinations; preserve the 4.x API. This issue concerns returned objects, not global Object.prototype pollution. |
| [uuid output buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | Select 11.1.1 for the affected 8.x/11.x consumers. jayson and ExcelJS use the preserved v4 API without output buffers. Verify that v3/v5 reject undersized output buffers and that v4 generation still works. |

The existing dependency backport documentation records provenance, licenses, and
removal conditions. Docker install stages copy the deepmerge source before npm
installation. The shared backport lives under `scripts/vendor/deepmerge` so it is
also available to Railway services whose build root is `scripts/`. Railway scripts
use copied local packages, as the root and Pro projects already do.

## Verification

- The new stream-json, deepmerge, and uuid regressions fail against the previous
  installation and pass after remediation.
- Clean installs with lifecycle scripts disabled pass for all four affected graphs.
- An isolated `scripts/` build-root install and its html-to-text/deepmerge consumers
  pass without access to repository-root packages. The audit sparse checkout
  preserves the new scripts npm configuration; all 112 workflow coverage checks pass.
- The four changed Docker dependency-install stages build. The digest image's
  install now disables lifecycle scripts, matching the other Alpine images;
  otherwise its bufferutil install attempts compilation without Python.
- The dependency security and backport suites exercise installed code and exclude
  the affected glob, minimatch, and uuid ranges in all four lockfiles.
- Root/API type checks, import boundaries, and Pro TypeScript checks pass.
- Pro prerender and the full dashboard production build pass. The PWA checks pass
  with 29 precache entries within the existing file and size budgets.
- Zapier's tests and structural validation pass. Validation still reports its
  existing publication tasks and recommendations; this repair does not publish
  or promote the integration.

Private backport versions may still match scanners' broad upstream version
ranges. Recheck installed-source evidence before dismissing such alerts. These
checks do not establish production exploitability, deployment, or live acceptance.
