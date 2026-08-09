/**
 * #5622 — the client side of the billing-verification contract.
 *
 * The gap this closes: #5600 taught six Pro-gated endpoints to answer an
 * unverifiable entitlement with `503 + Retry-After + X-Billing-Verification`
 * instead of a terminal "upgrade to Pro". No client honored it. Every function
 * in `src/services/notification-channels.ts` threw
 * ``Error(`... ${res.status}`)`` on any non-2xx, so on the surface the day-0 Pro
 * activation wizard writes through, the new contract was inert — the wizard
 * failed the step exactly as it did before the server fix.
 *
 * Both halves are exercised here: the pure wire decision, and the real
 * `authFetch` retry (through an actual exported service function), because a
 * predicate nobody calls is the same bug in a different place.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  billingVerificationRetryDelayMs,
  setNotificationConfig,
  setEmailChannel,
  startSlackOAuth,
  getChannelsData,
  __setNotificationChannelsClientDepsForTests,
} from '../src/services/notification-channels.ts';

const RETRYABLE_CODES = [
  'entitlement_verification_unavailable',
  'renewal_verification_pending',
  'renewal_verification_failed',
] as const;

function denial(
  code: string | null,
  retryAfter: string | null,
  status = 503,
  { omitHeader = false } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (code && !omitHeader) headers.set('X-Billing-Verification', code);
  if (retryAfter !== null) headers.set('Retry-After', retryAfter);
  return new Response(JSON.stringify(code ? { error: 'nope', code } : { error: 'nope' }), {
    status,
    headers,
  });
}

/** Install a fake transport; returns the recorded calls and the slept delays. */
function installTransport(responses: Response[]) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const slept: number[] = [];
  let i = 0;
  __setNotificationChannelsClientDepsForTests({
    getClerkToken: async () => 'token-abc',
    getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
    fetch: (async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const res = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return res;
    }) as never,
    sleep: async (ms: number) => { slept.push(ms); },
  });
  return { calls, slept };
}

function installAbortableRetryTransport(controller: AbortController) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const slept: number[] = [];
  let observeSleep!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    observeSleep = resolve;
  });
  __setNotificationChannelsClientDepsForTests({
    getClerkToken: async () => 'token-abc',
    getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
    fetch: (async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return denial('entitlement_verification_unavailable', '5');
    }) as never,
    sleep: async (ms: number, signal?: AbortSignal | null) => {
      slept.push(ms);
      observeSleep();
      assert.equal(signal, controller.signal, 'the public client must forward its abort signal');
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  return { calls, slept, sleepStarted };
}

afterEach(() => {
  __setNotificationChannelsClientDepsForTests(null);
});

describe('billingVerificationRetryDelayMs', () => {
  it('honors Retry-After exactly for every retryable code', () => {
    for (const code of RETRYABLE_CODES) {
      assert.equal(
        billingVerificationRetryDelayMs({ status: 503, code, retryAfterHeader: '5' }),
        5_000,
        `${code} must wait the advertised 5s`,
      );
      assert.equal(
        billingVerificationRetryDelayMs({ status: 503, code, retryAfterHeader: '2' }),
        2_000,
      );
    }
  });

  it('never retries a non-503 — a lapse is a 403 and terminal', () => {
    for (const status of [200, 400, 401, 403, 429, 500, 502]) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status,
          code: 'entitlement_verification_unavailable',
          retryAfterHeader: '5',
        }),
        null,
        `status ${status} must not be retried`,
      );
    }
  });

  it('never retries subscription_lapsed, whatever status carries it', () => {
    for (const status of [403, 503]) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status,
          code: 'subscription_lapsed',
          retryAfterHeader: '5',
        }),
        null,
      );
    }
  });

  it('does not retry a 503 the gate did not produce', () => {
    // This endpoint also 503s for a missing Convex/relay env, and for relay
    // failures that can happen AFTER a mutation partially landed. Retrying a
    // POST on those risks a duplicate write, so the decision is an allowlist of
    // the codes the gate emits BEFORE any write — not "any 503".
    assert.equal(
      billingVerificationRetryDelayMs({ status: 503, code: null, retryAfterHeader: '5' }),
      null,
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'Service unavailable',
        retryAfterHeader: null,
      }),
      null,
    );
  });

  it('falls back to the server default when Retry-After is missing or unusable', () => {
    for (const header of [null, '', 'soon', '0', '-3', 'NaN']) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status: 503,
          code: 'entitlement_verification_unavailable',
          retryAfterHeader: header,
        }),
        5_000,
        `Retry-After ${JSON.stringify(header)} must fall back to 5s`,
      );
    }
  });

  it('declines to retry when the server asks for longer than a user will wait', () => {
    // The server clamps Retry-After to 1-60s. Waiting out 60s inline in the
    // activation wizard is worse than surfacing the failure — and retrying
    // EARLY is not the alternative: the server negative-caches a transient
    // answer, so an early retry is served the same cached failure.
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '60',
      }),
      null,
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '10',
      }),
      10_000,
      '10s is the boundary and is still retried',
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '11',
      }),
      null,
    );
  });

  it('retries the two states whose real delays fit, and declines the one whose cooldown makes it pointless', () => {
    // The delays the server actually sends (convex/payments/billing.ts), not
    // hypotheticals — this is what makes the 10s threshold a calibrated choice
    // rather than a guess, and it is the assertion that fails if either side
    // moves:
    //   entitlement_verification_unavailable -> fixed 5s
    //   renewal_verification_pending         -> 1-3s (2s Dodo re-check window)
    //   renewal_verification_failed          -> up to 60s (failure cooldown)
    const delay = (code: string, header: string) =>
      billingVerificationRetryDelayMs({ status: 503, code, retryAfterHeader: header });

    assert.equal(delay('entitlement_verification_unavailable', '5'), 5_000);
    for (const header of ['1', '2', '3']) {
      assert.equal(
        delay('renewal_verification_pending', header),
        Number(header) * 1_000,
        `a pending re-check at ${header}s is short enough to wait out inline`,
      );
    }
    // Not a shortfall: that cooldown exists to stop re-querying the provider, so
    // any retry inside it is answered from the same cooled-down state. Blocking
    // the wizard for a minute would reach the identical denial.
    for (const header of ['30', '45', '60']) {
      assert.equal(
        delay('renewal_verification_failed', header),
        null,
        `a ${header}s failure cooldown must surface the failure, not stall the UI`,
      );
    }
  });

  it('rounds a fractional delay up rather than retrying early', () => {
    // '1.0001', not '1.2': 1.2 * 1000 is exactly 1200 in IEEE-754, so that value
    // cannot tell Math.ceil from Math.floor. 1.0001 can.
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'entitlement_verification_unavailable',
        retryAfterHeader: '1.0001',
      }),
      1_001,
      'a fractional delay must round UP — rounding down retries before the server allows',
    );
  });
});

describe('authFetch honors a retryable billing-verification 503', () => {
  it('retries once after the advertised delay and returns the recovered response', async () => {
    const { calls, slept } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      new Response(null, { status: 200 }),
    ]);

    // Resolving without throwing IS the assertion: before the retry existed this
    // rejected with `set notification config: 503`.
    await setNotificationConfig({ variant: 'global', enabled: true });

    assert.equal(calls.length, 2, 'exactly one retry');
    assert.deepEqual(slept, [5_000], 'waited the delay the server asked for');
  });

  it('re-sends the same method, path and body on the retry', async () => {
    const { calls } = installTransport([
      denial('renewal_verification_pending', '3'),
      new Response(null, { status: 200 }),
    ]);

    await setEmailChannel('buyer@example.com');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, '/api/notification-channels');
    assert.equal(calls[1].path, calls[0].path);
    assert.equal(calls[1].init?.method, 'POST');
    assert.equal(calls[1].init?.body, calls[0].init?.body);
    assert.match(String(calls[1].init?.body), /buyer@example\.com/);
  });

  it('surfaces the failure when the retry is denied too — exactly one extra attempt', async () => {
    const { calls, slept } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      denial('entitlement_verification_unavailable', '5'),
    ]);

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }),
      /set notification config: 503/,
    );
    assert.equal(calls.length, 2, 'the retry budget is one attempt, not a loop');
    assert.equal(slept.length, 1);
  });

  it('reads the code from the body when the header is unreadable, without consuming the caller stream', async () => {
    // Cross-origin consumers (Tauri shell, widget embeds) and intermediaries can
    // leave the header unreadable; the body's `code` mirrors it. The caller must
    // still be able to read the final response.
    const { calls } = installTransport([
      denial('entitlement_verification_unavailable', '5', 503, { omitHeader: true }),
      new Response(JSON.stringify({ channels: [], alertRules: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    const data = await getChannelsData();

    assert.equal(calls.length, 2);
    assert.deepEqual(data, { channels: [], alertRules: [] });
  });

  it('does not retry a terminal 403 upsell', async () => {
    const { calls, slept } = installTransport([
      denial('subscription_lapsed', null, 403),
    ]);

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }),
      /set notification config: 403/,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(slept, []);
  });

  it('does not retry the plain pro_required 403 the day-0 marker cohort receives', async () => {
    // That state is a 403 by design (api/notification-channels.ts): turning it
    // into a retry would hand every never-subscribed free user a spinner instead
    // of a clean upsell.
    const { calls } = installTransport([
      new Response(JSON.stringify({ error: 'pro_required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await assert.rejects(setNotificationConfig({ variant: 'global', enabled: true }));
    assert.equal(calls.length, 1);
  });

  it('does not retry an unrelated 503 that may have already written', async () => {
    const { calls, slept } = installTransport([
      new Response(JSON.stringify({ error: 'Service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await assert.rejects(setNotificationConfig({ variant: 'global', enabled: true }));
    assert.equal(calls.length, 1, 'a non-gate 503 must not be re-sent');
    assert.deepEqual(slept, []);
  });

  it('does not retry under a different account than the one the caller pinned', async () => {
    // The wait gives a second modal time to switch users. Re-asserting the
    // expected account on the retry keeps a write from landing on the wrong row.
    const { calls } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      new Response(null, { status: 200 }),
    ]);
    let current = 'user_1';
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => ({ id: current }) as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        // The account changes while we are waiting out the Retry-After.
        current = 'user_2';
        return denial('entitlement_verification_unavailable', '5');
      }) as never,
      sleep: async () => {},
    });

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }, 'user_1'),
      /Authenticated account changed/,
    );
  });

  it('retries the Slack/Discord OAuth-start writes too — they share authFetch', async () => {
    const { calls, slept } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      new Response(JSON.stringify({ oauthUrl: 'https://slack.com/oauth/v2/authorize?x=1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    const url = await startSlackOAuth();

    assert.equal(calls.length, 2, 'the retry is a property of authFetch, not of one caller');
    assert.deepEqual(slept, [5_000]);
    assert.match(url, /^https:\/\/slack\.com\//);
  });

  it('pins the identity for the retry even when the caller passed no expectedUserId', async () => {
    // Most callers in this file omit expectedUserId (everything reached from
    // src/services/notifications-settings.ts), which made assertExpectedAccount a
    // no-op for them. Tolerable at one round-trip; not once a multi-second wait
    // sits in the middle. authFetch pins the at-call-time session instead.
    const calls: Array<{ path: string }> = [];
    let current = 'user_1';
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => ({ id: current }) as never,
      fetch: (async (path: string) => {
        calls.push({ path });
        current = 'user_2'; // account switches while we wait out Retry-After
        return denial('entitlement_verification_unavailable', '5');
      }) as never,
      sleep: async () => {},
    });

    await assert.rejects(
      // No expectedUserId argument — the shape every notifications-settings call uses.
      setEmailChannel('buyer@example.com'),
      /Authenticated account changed/,
      'the retry must not write under a session the caller never asked for',
    );
    assert.equal(calls.length, 1, 'the retry is abandoned, not sent to the new account');
  });

  it('cancels a public read during Retry-After without sending a second request', async () => {
    const controller = new AbortController();
    const abortReason = new Error('notification settings closed');
    const { calls, slept, sleepStarted } = installAbortableRetryTransport(controller);

    const request = getChannelsData(undefined, controller.signal);
    await sleepStarted;
    controller.abort(abortReason);

    await assert.rejects(request, (err) => err === abortReason);
    assert.deepEqual(slept, [5_000]);
    assert.equal(calls.length, 1, 'abort during the delay must prevent the retry fetch');
  });

  it('cancels a public mutation during Retry-After without sending a second POST', async () => {
    const controller = new AbortController();
    const abortReason = new Error('notification settings closed');
    const { calls, slept, sleepStarted } = installAbortableRetryTransport(controller);

    const request = setEmailChannel('buyer@example.com', undefined, controller.signal);
    await sleepStarted;
    controller.abort(abortReason);

    await assert.rejects(request, (err) => err === abortReason);
    assert.deepEqual(slept, [5_000]);
    assert.equal(calls.length, 1, 'abort during the delay must prevent the retry POST');
    assert.equal(calls[0]?.init?.method, 'POST');
  });

  it('leaves a 2xx alone — no clone, no delay, no second call', async () => {
    const { calls, slept } = installTransport([
      new Response(JSON.stringify({ channels: [], alertRules: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await getChannelsData();

    assert.equal(calls.length, 1);
    assert.deepEqual(slept, []);
  });

  it('re-derives the Clerk token for the retry rather than reusing the first', async () => {
    // Every other stub in this file returns a constant token, so a regression
    // that cached the first attempt's Authorization header — or dropped it on
    // the second sendOnce — would leave the whole suite green. Hand out a
    // distinct token per call and assert the retry actually carries the second.
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    let tokenIssues = 0;
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => {
        tokenIssues += 1;
        return `token-${tokenIssues}`;
      },
      getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return calls.length === 1
          ? denial('entitlement_verification_unavailable', '5')
          : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as never,
      sleep: async () => {},
    });

    await setNotificationConfig({ variant: 'full', enabled: true });

    assert.equal(calls.length, 2, 'the retryable 503 must produce a second attempt');
    assert.equal(tokenIssues, 2, 'the retry must call getClerkToken again');
    const authOf = (i: number) =>
      (calls[i]?.init?.headers as Record<string, string> | undefined)?.Authorization;
    assert.equal(authOf(0), 'Bearer token-1');
    assert.equal(authOf(1), 'Bearer token-2', 'the retry must send the freshly derived token');
  });

  it('declines the retry when no Clerk identity can be pinned', async () => {
    // getCurrentClerkUser() is a synchronous `clerkInstance?.user` read that
    // never triggers a load, while getClerkToken() can itself initialise Clerk
    // and succeed — so a call in that window reaches the retry with
    // pinnedUserId === undefined, making assertExpectedAccount a no-op. Retrying
    // there would run the multi-second wait with the account check silently
    // disabled, which is the exact protection the retry claims to add.
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const slept: number[] = [];
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => null as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return denial('entitlement_verification_unavailable', '5');
      }) as never,
      sleep: async (ms: number) => { slept.push(ms); },
    });

    await assert.rejects(setNotificationConfig({ variant: 'full', enabled: true }));

    assert.equal(calls.length, 1, 'an unpinnable identity must not be retried');
    assert.deepEqual(slept, [], 'and must not wait');
  });

  it('a write setter aborts only the retry wait, never the dispatched request', async () => {
    // The panel's lifetime signal reaches authFetch's waitSignal, NOT init.signal
    // — otherwise closing notification settings cancels an in-flight POST and
    // silently discards a setting the user already changed.
    const controller = new AbortController();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as never,
      sleep: async () => {},
    });

    await setNotificationConfig({ variant: 'full', enabled: true }, undefined, controller.signal);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.init?.signal,
      undefined,
      'the write must not carry the panel signal into fetch()',
    );
  });

  it('a read still cancels through init.signal', async () => {
    // The inverse of the test above: cancelling a stale read IS the point, so
    // getChannelsData must keep passing its signal to fetch.
    const controller = new AbortController();
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return new Response(JSON.stringify({ channels: [], alertRules: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as never,
      sleep: async () => {},
    });

    await getChannelsData(undefined, controller.signal);

    assert.equal(calls[0]?.init?.signal, controller.signal);
  });
});
