---
title: Umami answers HTTP 200 when it drops a bot write, and the alarm built on it paged on its own crawler
date: 2026-08-01
category: integration-issues
module: analytics
problem_type: integration_issue
component: service_object
symptoms:
  - "Sentry issue `Umami collector write failed` at 45 events / 24 users in its first 32 minutes"
  - "61% of the events carry `status: 200` and `failureKind: missing-receipt`"
  - "Zero `P2002` / `session_data_pkey` events anywhere in Sentry over 14 days — the race the alarm was built for"
  - "The CI collector monitor stays green while the browser alarm floods"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [tooling]
tags: [umami, analytics, sentry, alerting, alert-fatigue, bot-filter, observability]
---

# Umami answers HTTP 200 when it drops a bot write, and the alarm built on it paged on its own crawler

## Problem

PR #5964 added a browser-side Sentry warning for every Umami collector write failure. It fired 45 events across 24 users in its first 32 minutes and caught **zero** instances of the umami#4183 `session_data` race it was built to detect. Most of the "failures" were HTTP 200 successes, and most of those came from WorldMonitor's own crawler.

## Symptoms

- Sentry `Umami collector write failed`, level `warning`, first seen 6 minutes after the PR merged (12:31:13Z merge → 12:37:02Z first event).
- Event breakdown of 44 sampled: `missing-receipt` 27 (all `status: 200`, all `requestType: event`), `network` 14, `timeout` 1, `queue-overflow` 1, `http` 1.
- `P2002` and `session_data_pkey` return 0 results across the whole Sentry org over 14 days.

## What Didn't Work

- **Blaming the PR the user pointed at.** The report arrived as "after PR #5965". #5965 (`fix(insights): preserve freshness on synthesis rejection`) touches only `api/health.js`, `scripts/seed-insights.mjs`, and tests — it cannot emit a browser event. `git log -S "Umami collector write failed"` returned only #5964's commits, which is what actually settled attribution. **Merge-order adjacency is not causation; grep the message string for the introducing commit.**
- **Assuming the receipt check was simply wrong for `event` writes.** All 27 misclassified events were `type: 'event'` and zero were `identify`, which looks conclusive. Probing production disproved it: Umami returns a full `{cache, sessionId, visitId}` receipt for *every* shape — `event` and `identify`, with and without a client `id`, with and without `x-umami-cache`.
- **The `x-umami-cache` hypothesis.** Plausible that Umami returns a thinner body once the tracker holds a session token, and it would have explained why the CI monitor (which never sets that header) stayed green. Probed it directly: all four variants returned the same 419-byte receipt.
- **CORS / opaque-response hypothesis.** An unreadable cross-origin body would explain an empty parse, but `OPTIONS` against the collector returns `access-control-allow-origin: *`, and an opaque response would surface as `status: 0`, not `200`.

## Solution

The discriminator was the User-Agent, found by replaying the exact UA strings from the Sentry events against production:

```
real Chrome      status=200 bodyLen=419 body={"cache":"eyJhbGciOi...
HeadlessChrome   status=200 bodyLen=15  body={"beep":"boop"}
Googlebot        status=403 (Cloudflare WAF, never reaches Umami)
```

**Umami's bot check answers `HTTP 200` with `{"beep":"boop"}` and stores nothing.** 20 of the 27 came from `Mozilla/5.0 (VISION-3.0-WorldMonitor; +https://github.com/local/vision)` — our own agent — plus 3 HeadlessChrome. The remaining `network` failures are ad-blocked clients.

The fix separates *delivery classification* from *alerting*:

```ts
// shared/collector-failure-metadata.js — one definition, read by both the CI
// monitor and the browser transport.
export function isBotFilteredBody(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && parsed.beep === 'boop';
  } catch {
    return false;
  }
}
```

```ts
// src/services/analytics-collector-transport.ts
export function isAlertWorthyCollectorFailure(
  failure: CollectorFailure,
  window: CollectorHealthSnapshot,
): boolean {
  if (isKnownSessionDataConflict(failure)) return false;  // known umami#4183
  if (failure.botFiltered) return false;                  // dropped on purpose
  if (ENVIRONMENT_NOISE_KINDS.has(failure.kind)) {        // network | timeout
    if (window.noiseReported) return false;               // 1 per page per window
    if (window.writes < ENVIRONMENT_NOISE_MIN_WRITES) return false;
    return window.failures / window.writes >= ENVIRONMENT_NOISE_MIN_FAILURE_RATE;
  }
  return true;  // non-2xx, unexplained receiptless 200, queue-overflow
}
```

`botFiltered` is a **marker on `CollectorFailure`, deliberately not a new `kind`**. The write really was dropped, so `isRetryableCollectorFailure` and `isDurableMarkerResolved` must keep treating it exactly like any other receiptless 200. Promoting it to a `kind` would have turned an alert-noise fix into a conversion-accounting change.

## Why This Works

Three distinct facts were collapsed into one `missing-receipt` classification:

1. **Umami deliberately discarded this write** (bot filter) — expected, unactionable.
2. **The client's environment blocked the write** (ad blocker) — expected, unactionable *individually*.
3. **The collector returned something unexplained** — actionable.

Only (3) deserves an event. The alarm reported all three and suppressed the one genuinely known-bad case, so its signal-to-noise was inverted: it was quiet about umami#4183 and loud about everything expected.

The rate gate matters for a reason worth stating plainly: **an ad-blocked client and a dead collector are indistinguishable from inside one browser** — both fail 100% of writes. Nothing computed on the page separates them, so the outage signal is aggregate event volume across users, not any single event. That is why the per-window cap exists; without it, crossing the rate floor makes every remaining failure in the window report, and one ad-blocked power user out-produces the incident the floor was added to expose. The common outage shape (origin dead → Cloudflare 502) is `kind: 'http'` and alerts immediately regardless.

## Prevention

- **An alarm must be attacked from both directions.** Reviewing "does it fire?" is half the job; the other half is "can it fire on something expected?" and "can it stay silent while the watched thing is dead?" This alarm passed the first and failed the second and third. Tests now lock all three, including that the bot-filter suppression is reachable only through a 2xx:

  ```ts
  it('cannot be muted by a non-2xx body that mimics the bot sentinel', async () => {
    const failure = await inspectCollectorResponse(collectorResponse(false, 502, '{"beep":"boop"}'));
    assert.equal(failure?.kind, 'http');
    assert.ok(!failure?.botFiltered);
  });
  ```

- **A 2xx is not a delivery receipt for any third-party collector.** Check the response body contract, and check what the vendor returns for *rejected* traffic — that path is usually undocumented and usually still a 200.

- **Filter your own synthetic traffic before it reaches an alarm.** 20 of 27 events came from a first-party crawler hitting production pages. Any browser-side alarm will see monitoring traffic unless it explicitly excludes it.

- **When a monitor and a client disagree about "success," the definition is duplicated.** The CI monitor and the browser transport both required `{cache, sessionId, visitId}` but only the monitor sent a browser UA, so only the browser ever saw the bot path. The sentinel now lives in `shared/collector-failure-metadata.js`, whose own header says divergence between the two surfaces is what it exists to prevent.

- **Mutation-test each guard rather than trusting a green suite.** Six mutants were applied and all turned the suite red on the specific test that owns them: substring-scan detector, always-false detector, latch never set, sample floor lowered to 1, predicate not consulted, and the sentinel check leaking past the `!response.ok` branch.

## Related Issues

- #5973 — tracking issue for this regression
- #5964 — the PR that introduced the alarm (and fixed the real #5715 write-path gap)
- #5715 — collector 500s dropping checkout conversions
- #5565 — collector dead 4 days, unnoticed; the alert-fatigue endpoint this fix exists to avoid
- umami-software/umami#4183 — the unfixed upstream `session_data` race
