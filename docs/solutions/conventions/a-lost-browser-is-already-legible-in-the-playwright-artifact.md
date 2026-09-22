---
title: A lost browser is already legible in the Playwright artifact you upload
date: 2026-09-08
category: conventions
module: e2e, .github/workflows/test.yml
problem_type: convention
component: testing_framework
severity: high
root_cause: async_timing
resolution_type: workflow_improvement
applies_when:
  - "A Playwright CI failure names no cause — an opaque guid message, or a bare 'Target page, context or browser has been closed'"
  - "Deciding whether to pay for DEBUG=pw:channel capture to diagnose an e2e flake"
  - "Judging whether a flake is a product race or an environment-level browser loss"
  - "Classifying two failure signatures as one event or two"
tags:
  - playwright
  - e2e
  - ci-artifacts
  - flaky-tests
  - browser-loss
  - trace-analysis
related_components:
  - development_workflow
---

# A lost browser is already legible in the Playwright artifact you upload

## Context

`variant-smoke` fails intermittently with `Object with guid response@<32-hex> was not bound in the connection` (#7880) and, in other specs, with `Target page,
context or browser has been closed` (#6501). Neither reproduces locally —
roughly 50 runs across two sessions produced zero.

Both issues concluded the same way: the open question is **did the browser die,
or did the protocol reorder**, and answering it needs `DEBUG=pw:channel` capture
in CI. #7882 was opened to ship that capture and measured its cost: **+75%
runtime and ~21 MB of stderr for one spec file of six** (~90–130 MB per shard).
The plan was to pay that, wait for a natural occurrence, and read the log.

That was unnecessary. The answer is already in `test-results/` — Playwright's
gitignored output directory, which the `variant-smoke` jobs already upload on
every failure. Establishing it took a session of trace reading and nine local
Playwright runs, and no new capture at all.

## Guidance

**Before adding protocol logging to diagnose a Playwright flake, read the trace
you already have for three signals of browser reachability.**

`ArtifactsRecorder` gives two independent probes, and `Worker Cleanup` gives a
third. Line numbers below are from the vendored `node_modules` copy of
playwright 1.58.2 (`node_modules/playwright/lib/index.js`) — re-check them after
any Playwright bump:

1. **Trace chunks vs contexts created.** `willCloseBrowserContext` (`:616-619`)
   calls `_stopTracing`, so every context the test closes itself writes one
   `N-trace.trace` chunk into `trace.zip`. `didFinishTest` (`:647-657`) then
   calls `_stopTracing` over `_allContexts()`, which writes one more for the
   **leftover live** context. A leftover context that contributed no chunk could
   not be reached.

2. **Screenshots vs contexts created.** Same shape, one line apart:
   `captureTemporary` on close (`:618`) writes one temporary PNG per closed
   context, and `maybeCapture()` over `_allPages()` in `didFinishTestFunction`
   (`:644-646`) writes one for the leftover live page. Both land in
   `SnapshotRecorder` (`:523-590`), whose `_snapshotPage` swallows failures with
   a bare `catch {}` (`:586`) — so a missing screenshot is silent.

3. **`Fixture "browser"` teardown duration inside `Worker Cleanup`.** A graceful
   `browser.close()` waits on the browser process. A close against a browser
   that is already gone returns immediately. This is the sharpest of the three
   and the easiest to read.

Extract them straight from `test.trace` (newline-delimited JSON):

```bash
unzip -q trace.zip -d t && ls t/*-trace.trace          # chunk count
ls test-results/<dir>/test-failed-*.png                 # screenshot count
python3 - <<'PY'
import json
ev=[json.loads(l) for l in open('t/test.trace') if l.strip()]
in_cleanup=False; b0=bid=None
for e in ev:
    if e['type']=='before' and e.get('title')=='Worker Cleanup': in_cleanup=True
    if e['type']=='before' and e.get('title')=='Fixture "browser"' and in_cleanup and bid is None:
        b0=e['startTime']; bid=e['callId']
    if e['type']=='after' and bid is not None and e.get('callId')==bid:
        print('browser close %.1f ms'%(e['endTime']-b0))
# the step that hung: a `before` with no matching `after`
after={e['callId'] for e in ev if e['type']=='after'}
print([(e['callId'],e['title']) for e in ev if e['type']=='before' and e['callId'] not in after])
PY
```

**Calibrate against a deliberately provoked baseline, not against intuition.**
SIGKILL the browser under an in-flight `goto` in a throwaway spec, and separately
fail a test with the browser alive. Both take minutes and turn a qualitative
argument into a measured one.

## Why This Matters

The measured separation is not subtle:

| Case | n | leftover-ctx chunk | leftover-ctx screenshot | `Fixture "browser"` teardown |
| --- | --- | --- | --- | --- |
| CI, guid signature | 2 | none | none | **3.9 ms / 9.6 ms** |
| CI, same test, healthy assertion failure | 1 | present | present | **126.5 ms** |
| local, assertion failure, browser alive | 3 | present | present | **30.4 / 43.2 / 47.1 ms** |
| local, browser SIGKILLed under an in-flight `goto` | 6 | none | none | **0.9–2.0 ms** |

CI is ~3x slower than the laptop on the alive case, so read the bands per
environment rather than across them. On CI the guid occurrences sit ~13x below
the alive measurement from the same runner and the same test (9.6 ms against
126.5 ms); locally the two bands are 0.9–2.0 ms against 30–47 ms. Verdict: the
browser was gone. Same event as #6501, established without `pw:channel`.

Three further things fall out that are worth carrying forward:

**The two candidate verdicts were never exclusive.** `Connection.close()` sets
`_closedError` and `dispatch()` returns early on it
(`playwright-core/lib/client/connection.js:134-135, 178-186`), so the guid
throw is only reachable while the client connection is **open** — and under the
in-process transport (`playwright-core/lib/inProcessFactory.js:46`) a dead
browser does not close it. The server disposes the Browser dispatcher subtree
and keeps sending. A `Frame.goto` that already resolved server-side then has
its result serialized after that cascade, referencing a `response@…` the client
just deleted (`playwright-core/lib/client/channelOwner.js:94-98`). Browser
death is the trigger; the ordering race is how it renders. When a decision
table offers "process died" *or* "clean dispose race", check whether the
transport makes them the same event.

**An ordered dispose cannot produce the signature.** `context.close()` racing an
in-flight `goto`, at five offsets (on the document `response` event, and 0/1/5/20
ms), four repeats each: **20/20** gave either a clean resolve or `Target page,
context or browser has been closed`. Never the guid message —
`potentiallyClosesScope` sequences the close against in-flight operations. Only
an *unsequenced* disposal strands a serialized result, which is what a browser
loss is. A negative control is what turns "probably" into "ruled out".

**`unhandledError` misattribution is a default, not a law.** The standard caveat
is that `workerMain.js` fails whatever test is current, so the red test may be
unrelated. True in general — but the trace settles it per-occurrence: a `before`
with no matching `after` pins the owning step and context. In both #7880
occurrences the throw is recorded inside the failing test's own `test.trace`, at
its own `Navigate`. Check before discarding the failing test's name as evidence.

## When to Apply

Apply this before shipping any new CI capture to diagnose a Playwright flake —
the trace may already answer the question, and protocol logging is expensive
enough that the check pays for itself immediately.

Apply it also when two failure signatures are suspected of being one event. The
three probes are signature-independent: they measure browser reachability, not
the error string, so they classify `Target page, context or browser has been
closed` and the opaque guid message on the same axis.

Do **not** apply it to conclude anything about *why* the browser was lost. These
probes separate "gone" from "alive" and nothing else. OOM kill vs Chromium crash
still needs `DEBUG=pw:browser` — which is cheap (~1 MB/shard, no measurable
runtime cost) and remains worth shipping.

## Examples

Two preserved CI occurrences, both `map-overlay-marker-budget.spec.ts:276`
(`keeps the full dashboard DOM and listener counts bounded across cold loads`):

```
run 34079140563 attempt 1   trace.zip: 0-trace.trace, 1-trace.trace   (3 contexts created)
                            screenshots: test-failed-1.png, -2.png    (both captureTemporary)
                            unclosed step: pw:api@58 Navigate to "/dashboard" @ 69017.728
                            Fixture "browser" (Worker Cleanup): 3.9 ms
                            error: Object with guid response@45d72eb1121c4abe7c1aad3b76260d8d …

run 34079140563 retry 1     trace.zip: 0-, 1-, 2-trace.trace          (3 contexts created)
                            screenshots: test-failed-1.png … -3.png
                            Fixture "browser": 126.5 ms
                            error: expect(15506).toBeLessThanOrEqual(15000)   ← ordinary #7837 failure
```

The retry is the control: same test, same runner, same three contexts, and the
leftover context contributed both artifacts because the browser was alive.
(`45d72eb1…` above is a Playwright dispatcher guid quoted verbatim from the
error, not a commit SHA — it resolves to nothing in this repository by design.)

A related gc-collection hypothesis was ruled out by measurement rather than
assertion, which is worth copying as a habit. `ResponseDispatcher` takes the
default `gcBucket` of its own type, so `maybeDisposeStaleDispatchers` fires only
above **10,000** live dispatchers per connection
(`playwright-core/lib/server/dispatchers/dispatcher.js:43-47`). The preserved
per-context network traces record 537 / 538 / 568 / 571 resources per cold
`/dashboard` load. Contexts close between loads and `_disposeRecursively`
removes their children from the bucket, so the peak is ~540 — about 5% of the
ceiling, an ~18x margin. Even assuming the worst case the evidence cannot rule
out, all three loads' dispatchers alive at once (~1,600), the margin is still
~6x. A number rather than an opinion, and either reading clears it.

## Related

- #7880 — the guid signature; verdict and full evidence table
- #6501 — the same event rendered as `Target page, context or browser has been closed`
- #7882 — the capture issue; tier 2 (`pw:channel`) dropped as a result of this, tier 1 (`pw:browser`) still needed
- #7718 — open PR carrying a `pw:browser` capture plus memory sampling
- #5685 — origin of the `retries: 1` mitigation, which stays
- [Evidence a gate emits is not evidence until you find it in the artifact](evidence-is-not-evidence-until-you-find-it-in-the-artifact.md) — the companion failure mode: an artifact that was never written at all

Preserved artifacts (expire from GitHub 2026-09-21, copied out 2026-09-08):
`~/wm-evidence/issue-7880/`.
