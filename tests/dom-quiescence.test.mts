import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOM_QUIESCENCE_SAMPLE_MS,
  DOM_QUIESCENCE_STABLE_SAMPLES,
  waitForDomQuiescence,
  type DomQuiescenceProbe,
} from '../e2e/helpers/dom-quiescence';

/**
 * #7837 — the cold-load probe records a settled-page sample alongside the
 * asserted first-paint one. These pin the properties that make the recorded
 * number worth reading (it waits for the page to stop growing, for traffic to
 * drain, and for traffic that never straddles a poll boundary) and the one that
 * keeps it off the required gate (a slow runner yields `quiesced: false`, it
 * does not throw).
 *
 * Assertions are driven off POLL COUNT, never wall clock. `waitedMs >= n *
 * SAMPLE_MS` looks equivalent and is not: a 50 ms scheduler hiccup flips it,
 * which would make this suite the second flaky test in an issue about flaky
 * tests. Poll count is what the loop actually decides on.
 */

type ProbeState = {
  elements: number;
  inflight: number;
  requestsStarted: number;
};

/** Probe whose state can be advanced per poll, so tests never race the clock. */
function pollDrivenProbe(
  state: ProbeState,
  onPoll?: (poll: number, state: ProbeState) => void,
): DomQuiescenceProbe & { polls: () => number } {
  let polls = 0;
  return {
    waitForTimeout: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    elementCount: async () => {
      polls += 1;
      onPoll?.(polls, state);
      return state.elements;
    },
    inflight: () => state.inflight,
    requestsStarted: () => state.requestsStarted,
    polls: () => polls,
  };
}

test('quiescence absorbs a late DOM bump instead of freezing on the first quiet sample (#7837)', async () => {
  // Poll 1 is the pre-loop baseline; the page grows once, observed on poll 3.
  // A wait that returned on one unchanged reading would report 3,000 for a page
  // that ended at 3,400.
  const state: ProbeState = { elements: 3000, inflight: 0, requestsStarted: 7 };
  const probe = pollDrivenProbe(state, (poll, s) => {
    if (poll === 3) s.elements = 3400;
  });

  const result = await waitForDomQuiescence(probe);
  assert.equal(result.quiesced, true);
  assert.equal(result.elements, 3400);
  assert.equal(result.stableSamples, DOM_QUIESCENCE_STABLE_SAMPLES);
  // Baseline + the changed poll + the poll that reset the baseline + 3 quiet.
  assert.equal(result.polls, 6);
});

test('quiescence waits for in-flight requests to drain even when the DOM is already still (#7837)', async () => {
  // The element count never changes, so only the in-flight check can hold the
  // wait open — a page mid-fetch has not settled just because it looks quiet.
  const state: ProbeState = { elements: 3000, inflight: 2, requestsStarted: 7 };
  const probe = pollDrivenProbe(state, (poll, s) => {
    if (poll === 4) s.inflight = 0;
  });

  const result = await waitForDomQuiescence(probe);
  assert.equal(result.quiesced, true);
  assert.equal(result.inflight, 0);
  // Polls 2 and 3 saw traffic; the drain is first seen on poll 4, so the three
  // quiet samples are polls 4-6. This is the assertion a wall-clock bound was
  // approximating, without the timer coupling.
  assert.equal(result.polls, 3 + DOM_QUIESCENCE_STABLE_SAMPLES);
});

test('quiescence catches a request that starts and finishes between two polls (#7837)', async () => {
  // `inflight` reads 0 at every single poll — the request opened and closed
  // inside one 200 ms gap. Only the monotonic started-count reveals it, which
  // is why the quiet check compares it. Drop that comparison and this page is
  // declared settled while it is still fetching.
  const state: ProbeState = { elements: 3000, inflight: 0, requestsStarted: 7 };
  const probe = pollDrivenProbe(state, (poll, s) => {
    if (poll === 3) s.requestsStarted = 8;
  });

  const result = await waitForDomQuiescence(probe);
  assert.equal(result.quiesced, true);
  assert.equal(result.requestsStarted, 8);
  // Without the started-count check the wait would have ended at poll 4.
  assert.equal(result.polls, 6);
});

test('quiescence reports a timeout instead of throwing so the recorded sample never reds the gate (#7837)', async () => {
  // A page that keeps growing past the budget. The cold-load probe still takes
  // its sample and records `quiesced: false`; the asserted first-paint budget
  // is unaffected.
  const state: ProbeState = { elements: 3000, inflight: 0, requestsStarted: 7 };
  const probe = pollDrivenProbe(state, (_poll, s) => {
    s.elements += 10;
  });

  const result = await waitForDomQuiescence(probe, {
    timeout: DOM_QUIESCENCE_SAMPLE_MS * 6,
  });
  assert.equal(result.quiesced, false);
  assert.ok(result.stableSamples < DOM_QUIESCENCE_STABLE_SAMPLES);
  assert.ok(result.polls > 1, 'expected the wait to have sampled at least once');
});

test('quiescence times out when traffic never drains, not just when the DOM keeps growing (#7837)', async () => {
  // The other independent way the wait can expire, and the one a stuck
  // request counter would produce in CI: a still DOM with `inflight` pinned
  // above zero forever. It must report the same non-throwing shape, and expose
  // the non-zero counter so the artifact says WHY it never settled.
  const state: ProbeState = { elements: 3000, inflight: 1, requestsStarted: 7 };
  const probe = pollDrivenProbe(state);

  const result = await waitForDomQuiescence(probe, {
    timeout: DOM_QUIESCENCE_SAMPLE_MS * 6,
  });
  assert.equal(result.quiesced, false);
  assert.equal(result.stableSamples, 0);
  assert.equal(result.inflight, 1);
  assert.equal(result.elements, 3000);
});
