---
title: Evidence a gate emits is not evidence until you find it in the artifact
date: 2026-09-07
category: conventions
module: e2e, .github/workflows/test.yml
problem_type: convention
component: testing_framework
severity: high
root_cause: wrong_api
resolution_type: test_fix
applies_when:
  - "Attaching JSON, screenshots, or metrics from a Playwright spec for later reading"
  - "Adding a measurement to a CI gate that a human or agent is expected to read back"
  - "Relying on a test artifact to satisfy an issue's acceptance criteria"
tags:
  - playwright
  - ci-artifacts
  - e2e
  - silent-failure
  - source-text-guard
  - evidence
---

# Evidence a gate emits is not evidence until you find it in the artifact

## Context

`e2e/map-overlay-marker-budget.spec.ts` collected cold-load renderer metrics and
attached them with `testInfo.attach(name, { body })`. The call succeeded, the
test passed, and the metrics reached nobody. When #7837 asked for "sample size,
first-attempt failures, retries, and metric ranges", the evidence to answer it
had never existed outside the worker process — for a full release cycle.

The mechanism is in Playwright's own source, not this repo — read it at
`node_modules/playwright/lib/util.js` (line numbers below are 1.58.2 and will
drift with the dependency). `normalizeAndSaveAttachment` (`:261-280`) copies an
attachment to
`<outputDir>/attachments/` **only** in the `{ path }` branch; the `{ body }`
branch returns an in-memory buffer for a reporter to persist. This project runs
`reporter: 'list'` (`playwright.config.ts`), which persists nothing. Downloading
the shard-1 artifact for run 34144452921 confirmed it: zero files for that spec,
while sibling specs using `{ path }` had theirs.

## Guidance

Write the file, then attach it by path:

```ts
const path = testInfo.outputPath('cold-dashboard-metrics.json');
await writeFile(path, payload, 'utf8');
await testInfo.attach('cold-dashboard-metrics.json', { path, contentType: 'application/json' });
```

Three links must all hold, and only the first is in the spec:

1. `{ path }`, not `{ body }` — otherwise nothing reaches disk.
2. `preserveOutput: 'always'` in `playwright.config.ts` — otherwise the output
   directory is discarded for a **passing** test, which is exactly the case a
   guardrail runs in.
3. The workflow uploads that directory (`path: test-results/` in
   `.github/workflows/test.yml`).

Then prove the chain end-to-end once: download the artifact from a real CI run
and open the file. A green job is not proof the evidence shipped.

Because the regression is silent, pin it in source text rather than trusting a
future run to notice, following the existing block in
`tests/deploy-config.test.mjs`:

```js
assert.match(src, /testInfo\.attach\('cold-dashboard-metrics\.json', \{ path/);
assert.doesNotMatch(src, /attach\('cold-dashboard-metrics\.json', \{[\s\S]{0,80}?body:/);
```

## Why This Matters

Ordinary test regressions announce themselves — something goes red. This class
does not. The assertion still runs, the gate still guards, and only the
*explanation* disappears. The cost is paid later, by whoever has to answer "was
this always like that?" and finds nothing to read, which is precisely how #7837
became unanswerable and needed a second investigation to reopen.

It also generalizes past Playwright. Any diagnostic whose consumer is a future
reader — an artifact, a log line, a metrics row — has a delivery path that is
not exercised by the code that produces it. Emitting is not delivering.

This sits next to
[a check that can no longer see its target must fail loudly](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md):
that one is about a check silently losing its subject, this one about a check
silently losing its evidence. Same failure shape, opposite end of the pipe.

## When to Apply

Whenever a test emits something meant to be read later rather than asserted on.
The tell is a value that no assertion consumes — metrics, timings, provenance
dumps. Nothing in the test's own pass/fail can protect it, so its delivery needs
separate proof and a separate guard.

Also apply the fail-visibly corollary: if writing the evidence throws, print the
payload rather than only reporting the loss, and never let that failure replace
the assertion that was already in flight. A `finally` block that throws will
discard the real failure that put it there.

## Examples

Before — passes, delivers nothing:

```ts
await testInfo.attach('cold-dashboard-metrics.json', {
  contentType: 'application/json',
  body: JSON.stringify({ samples }, null, 2),
});
```

After — same call site, evidence lands in `playwright-ci-smoke-<shard>-<run>-<attempt>`:

```ts
const path = testInfo.outputPath('cold-dashboard-metrics.json');
await writeFile(path, payload, 'utf8');
await testInfo.attach('cold-dashboard-metrics.json', { path, contentType: 'application/json' });
```

Verified in CI run 34148378315: the artifact now contains
`cold-dashboard-metrics.json`, and the numbers it carried immediately corrected
a conclusion drawn from local measurements — the settled dashboard uses ~72% of
its renderer budget on CI, not the ~94% a laptop run had suggested. Evidence
that reaches nobody cannot correct anything.
