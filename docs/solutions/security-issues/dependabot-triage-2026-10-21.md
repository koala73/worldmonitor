---
module: dependencies
component: npm and pnpm dependency graphs
problem_type: security_issue
tags: [dependabot, zapier, zapier-platform-cli, simple-git, adm-zip, tar, markdown-it, hono]
---

# Dependabot triage on October 21, 2026

The GitHub API returned 29 open alerts. This review uses main commit `809efd9339b8d749742d47e5a6d05ea6fa4d6d85` and Node 24.15.0.

25 alerts appeared at 17:14 UTC, one minute after #9523 merged. That PR committed `integrations/zapier/package-lock.json` for the first time. The file was previously gitignored, so Dependabot had never scanned the Zapier graph. Its directory was also absent from `.github/dependabot.yml`, so Dependabot could raise alerts there but never open a fix PR. No dependency changed. The vulnerable versions had been installed locally the whole time.

| Alerts | Dependency and graph | Evidence and action |
| --- | --- | --- |
| 407, 409–411, 413, 414, 418, 425 | tar 6.2.1 in Zapier | Pulled by cacache, node-gyp, and pacote under `@npmcli/arborist`, which yeoman-environment 4.4.3 uses to install generator packages. yeoman-environment 6.0.1 still reaches arborist through fly-import, now at arborist 9.9.3, pacote 21.5.1, and node-gyp 12.4.0. The upgraded chain selects tar 7.5.22. |
| 419, 420 | sigstore 2.3.1 and @sigstore/core 1.1.0 in Zapier | Same pacote chain. They now resolve 4.1.1 and 3.2.1. |
| 416 | yeoman-environment 4.4.3 in Zapier | zapier-platform-cli 19.2.1, the latest release, pins it exactly. Override it to 6.0.1 for that CLI. |
| 421, 428–430, 434 | adm-zip 0.5.16 in Zapier | The CLI pins it exactly. Override it to 0.6.1. Alert 428 lists no patched version, but its range ends at 0.6.0, so 0.6.1 is outside it. |
| 406, 417 | tmp 0.2.5 and 0.0.33 in Zapier | The CLI pins 0.2.5, and inquirer's external-editor 3.1.0 asks for `^0.0.33`. The override is scoped to the CLI, so it applies to the CLI's whole subtree and both resolve 0.2.7. external-editor still creates and cleans up its temp file with 0.2.7. |
| 437–440 | simple-git 3.36.0 and @simple-git/argv-parser 1.1.1 in Zapier | yeoman-generator 7.5.1 asks for `^3.20.0` to read git user config. Override it to `^4.0.2`, which brings argv-parser 2.0.1. |
| 412, 415 | serialize-javascript 6.0.2 in Zapier | Pulled by mocha 10. Raise mocha to `^12.0.3`, which resolves 7.1.2. |
| 436 | postcss-selector-parser 6.1.5 in Zapier | Pulled by `@npmcli/query` under arborist. arborist 9.9.3 uses query 5, which selects 7.1.7. |
| 397, 401, 402 | markdown-it 14.3.1 in root | markdownlint-cli2 pulls it in, and the root override pins it. Raise the override to 14.3.3. |
| 396 | hono 4.13.7 in Umami runtime | Prisma's dev server pulls it in, and the pnpm override pins it. Raise the override to 4.13.13 and regenerate with pnpm 10.15.1. |

Every Zapier alert is in development scope. The production graph, `zapier-platform-core` 19.2.1, was clean before this change and stays clean. The CLI runs only on maintainer machines and in CI, against repository code. No alert had a demonstrated exploit path. The overrides still remove the vulnerable code from installs.

After the change, `npm audit` in the Zapier directory still reports GHSA-vfj7-8cjw-p6xm against braces. That advisory covers every braces release and lists no patched version. Dependabot has not raised it for this repository.

No alert is dismissed. These changes do not authorize merge or deployment.

## Verification

- `tests/dependency-security-regression.test.mjs` asserts that every affected lockfile selects only patched versions. Against main's lockfiles the 12 new checks fail. With this change all 32 tests pass.
- Before the change, a clean Zapier `npm ci` reported 38 findings: 3 critical, 28 high, 4 moderate, and 3 low. After it, the only findings are the 9 high-severity braces paths. `npm audit --omit=dev` reports 0.
- With the overrides, the Zapier suite still passes all 91 tests. `zapier-platform validate` reports no structural errors. `zapier-platform build` produces `build.zip`. `zapier-platform init --template minimal` scaffolds an app through yeoman-environment 6 and simple-git 4.
- `build.zip` no longer contains `encoding`, `iconv-lite`, or `safer-buffer`. They had been installed only by the removed dev tree. node-fetch loads `encoding` lazily, and only for `textConverted()`, which neither zapier-platform-core nor the app calls.
- A frozen Umami install with pnpm 10.15.1 resolves hono 4.13.13.
- Root markdown-it 14.3.3 is a patch release. The CI markdown lint run is its only check.
- `zapier-platform push` and the Umami Docker image are unverified.
