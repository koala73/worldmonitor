---
title: "Country-view e2e call count raced the late reservoirs read"
date: 2026-11-23
category: test-failures
module: plugin-country-view-e2e
problem_type: test_failure
component: testing_framework
severity: low
symptoms:
  - "plugin-country-view Signals reuse test fails with Expected length 60, Received length 61 after an Economy/Security tab round trip"
  - "The failure prints only the first 10 host calls, so the extra call cannot be identified from the CI log or trace"
  - "Passes every time locally, including under 8x CPU throttle"
root_cause: async_timing
resolution_type: test_fix
tags: [playwright, e2e, country-brief, host-calls, optional-reads, reservoirs, flaky, call-count]
---

# Country-view e2e call count raced the late reservoirs read

## Problem

`e2e/plugin-country-view.spec.ts` counts the host tool calls after the opening load, switches topics, and asserts that no new calls arrived. On a loaded CI runner the count went 60 → 61 during the switch (#11186). The fix is in PR #11188.

## Symptoms

- `expect(host.calls).toHaveLength(initialReads)` failed with `Expected length: 60 / Received length: 61`.
- Playwright truncates a printed received array to 10 elements, and the trace has no record of `exposeFunction` binding calls, so CI evidence could not name the 61st call.

## What Didn't Work

- **Reading the CI log or trace for the call list.** Both stop at the first 10 entries.
- **Reproducing with load.** 70 local runs, including `Emulation.setCPUThrottlingRate` at 8x and 6 workers, never failed.
- **Delaying the signal-family responses** (700 ms, 4 s). The test's `Low2` breakdown assertion waits for the qualified families, so the capture always came after them.
- **Holding the `reservoirs` record for a fixed time.** That also delays it past the final length check, so both counts were 60 and the test passed.

## Solution

The hosted brief reads `reservoirs` last. `src/plugin-country-main.ts` calls `controller.readReservoirContext(code)` in the `.finally` after `loadQualifiedCountrySignals`. `src/services/country-brief-host-transport.ts` treats `reservoirs` and the newer `countrySignals` families as optional reads, outside any section's loading state. So "the model context shows no loading section" does not mean that read was sent.

The spec gates each call-count capture on that read. It also compares the calls made after the capture with `[]`, so a recurrence names the extra call:

```ts
const openingReadsSent = (host: { calls: HostCall[] }) =>
  expect.poll(() => host.calls.some(call => call.arguments.section === 'reservoirs')).toBe(true);

await openingReadsSent(host);
const initialReads = host.calls.length;
// ...tab round trip...
expect(host.calls.slice(initialReads)).toEqual([]); // was: toHaveLength(initialReads)
```

Applied at the static-tiers, Signals-reuse, admission-failure and raw-slot captures.

**Red/green.** A temporary hold delivered only the `reservoirs` host record when the test called a release right after its capture, with a 1 s fallback so the gated version could not deadlock.

- Unfixed: 5/5 failed with CI's exact 60/61.
- Fixed: 5/5 passed.
- After removing the hold, the full spec passed 45/45 and the touched tests passed 90/90 under `--repeat-each 15`.

## Why This Works

The likely cause is a late opening read, not a re-read. The CI evidence never identified call 61, so a Signals re-read is not ruled out; the reproduction only shows that a late opening read produces the same 60/61. The evidence pointing to a late read:

- The CI commit changed only CI files, and its first 10 calls match the local order.
- Locally the opening load makes 61 calls, so a CI total of 61 fits one late opening read.
- Topic switches only toggle `hidden` and schedule a context update.
- `reservoirs` is the one opening read nothing gated.

If it was a re-read, the gate does not mask it: the `slice(n)` check still fails and now prints the call.

## Prevention

- Before counting host calls after a load, wait for the last read in the dispatch chain, not for a quiet model context or the sections' loading states.
- For "no new calls" checks, assert `calls.slice(n)` equals `[]`, not a length. A failure then prints the offending call.
- To reproduce an ordering race, hold the suspect event until just after the test's sync point. A fixed delay usually shifts both sides of the comparison.
- #10805 hit the same optional-read race in the quota test and solved it with a repeat-based check instead.
