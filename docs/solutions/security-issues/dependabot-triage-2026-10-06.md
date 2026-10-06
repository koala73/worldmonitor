---
module: dependencies
component: npm and pnpm dependency graphs
problem_type: security_issue
tags: [dependabot, stream-json, katex, hono, sprintf-js]
---

# Dependabot triage on October 6, 2026

The GitHub API returned eight open alerts. This review uses main commit `468ec47bbc20e71029ca835b8f2f697a05422109` and Node 24.20.0. Package presence does not prove that a production request reaches the affected function.

| Alerts | Dependency and graph | Evidence and action |
| --- | --- | --- |
| 355, 360 | stream-json 1.9.1 in root and Pro | The installed `jayson.Utils.parseStream` replaces the parsed object's prototype for a JSON `__proto__` key. Backport the upstream Assembler fix to both normal and reviver assignment paths. Preserve the CommonJS API with private version 1.9.2-worldmonitor.1. |
| 356, 361 | stream-json JSONC comment scanning in root and Pro | Version 1.9.1 has no JSONC entry points. The advisory's affected code is absent. Retain the alerts with this evidence; do not upgrade across incompatible APIs just to change their status. |
| 358 | KaTeX 0.16.43 in root | The inherited `trust=true` reproduction emits a JavaScript link. Override to patched 0.18.2. Its consumer is markdownlint's micromark math extension, a development tool. This reproduction does not establish a production XSS path. |
| 346 | Hono 4.13.5 in Umami runtime | The runtime graph pins a vulnerable version through Prisma. Update the existing override to patched 4.13.7 and regenerate with pnpm 10.15.1. Production reachability of the affected JSX positions is unverified. |
| 351, 359 | sprintf-js in root and blog | Excess precision reproduces RangeError. No upstream patched version is published or listed. Root consumers are argparse CLI help and Fengari test execution. Blog consumer is gray-matter's js-yaml 3 dependency through argparse. The reviewed callers use repository-controlled formats and inputs. Retain the alerts pending a compatible upstream fix or evidence of an untrusted format path. |

The stream-json dependency comes from Clerk's Solana wallet adapters through `@solana/web3.js` and `jayson`. The browser Solana bundle imports `jayson/lib/client/browser`, not the vulnerable TCP stream parser. The local consumer test proves the installed package defect and the repair, not a remotely exploitable WorldMonitor route.

The backport uses the [upstream prototype fix](https://github.com/uhop/stream-json/commit/2f2d35bbb547306991ded6487a279154d865a358). The [KaTeX advisory](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7) names 0.18.2 as patched. The [Hono advisory](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv) names 4.13.7 as patched. The [sprintf-js upstream issue](https://github.com/alexei/sprintf.js/issues/237) remains open.

No alert is dismissed. A private backport may continue to match GitHub's broad vulnerable version range. Alert closure after merge must be checked separately from the installed regression results. These changes do not authorize merge or production deployment. Residual npm audit findings outside these eight alerts require their own review.

## Verification

- Clean root and Pro npm installs pass with lifecycle scripts disabled. The Umami frozen install passes with pnpm 10.15.1.
- The focused dependency, security policy, and Umami contract suites pass all 94 tests. The CI workflow suite passes all 68 tests. TypeScript, import boundaries, and Markdown checks pass.
- The original published KaTeX artifact emits an active JavaScript link for inherited trust. The installed patched artifact rejects inherited trust and preserves explicit trusted options.
- The original published Hono artifact emits an unescaped Suspense string child. The installed patched artifact emits escaped text. This check exercises the dependency, not the deployed collector.
- The vendored stream-json files match the published 1.9.1 artifact except for Assembler.js and package.json. The installed root and Pro consumers preserve JSON.parse semantics for hostile prototype keys.
- Root Vite bundling and the Pro build with prerender pass. Root Sentry source-map upload fails under restricted network access. The Docker image build and production behavior remain unverified.
