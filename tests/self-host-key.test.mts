/**
 * Self-host desktop-key verdict service (plan 2026-11-04-001, U5).
 *
 * The service reads the sidecar's /api/selfhost-key route and holds the
 * unknown -> unlocked -> locked state machine. These tests drive it with a
 * scripted fetch, a manual clock and a captured interval so no real timer or
 * network is involved.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  SELF_HOST_KEY_GRACE_MS,
  SELF_HOST_KEY_REFRESH_MS,
  _resetSelfHostKeyForTests,
  getSelfHostKeySnapshot,
  isSelfHostKeyUnlocked,
  noteSelfHostPremiumDenial,
  refreshSelfHostKey,
  removeSelfHostKey,
  saveSelfHostKey,
  startSelfHostKeyService,
  subscribeSelfHostKey,
} from '@/services/self-host-key';

type Reply = Response | Error | (() => Response | Error | Promise<Response | Error>);

interface Harness {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  replies: Reply[];
  clock: { now: number };
  intervals: Array<{ fn: () => void; ms: number }>;
  cleared: number;
}

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function verdict(status: string, extra: Record<string, unknown> = {}, httpStatus = 200): Response {
  return new Response(JSON.stringify({ enabled: status !== 'disabled', status, stale: false, verifiedAt: NOW, ...extra }), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
}

let h: Harness;
let unsubscribers: Array<() => void> = [];

function install(): Harness {
  const harness: Harness = { calls: [], replies: [], clock: { now: NOW }, intervals: [], cleared: 0 };
  _resetSelfHostKeyForTests({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      harness.calls.push({ url: String(input), init });
      const next = harness.replies.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      const value = typeof next === 'function' ? await next() : next;
      if (value instanceof Error) throw value;
      return value;
    }) as typeof fetch,
    now: () => harness.clock.now,
    setInterval: (fn, ms) => { harness.intervals.push({ fn, ms }); return harness.intervals.length; },
    clearInterval: () => { harness.cleared += 1; },
    canRun: () => true,
  });
  return harness;
}

function countChanges(): { count: number } {
  const counter = { count: 0 };
  unsubscribers.push(subscribeSelfHostKey(() => { counter.count += 1; }));
  return counter;
}

/** Let the lazily started boot read and its follow-up settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function bootWith(reply: Reply): Promise<void> {
  h.replies.push(reply);
  startSelfHostKeyService();
  await settle();
}

beforeEach(() => {
  h = install();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  _resetSelfHostKeyForTests({ canRun: () => false });
});

describe('self-host key boot read', () => {
  it('unlocks on an active verdict and notifies once (AE1)', async () => {
    const changes = countChanges();
    h.replies.push(verdict('active'));
    startSelfHostKeyService();
    assert.equal(isSelfHostKeyUnlocked(), false, 'unknown before any answer');
    await settle();

    assert.equal(isSelfHostKeyUnlocked(), true);
    assert.equal(getSelfHostKeySnapshot().unlock, 'unlocked');
    assert.equal(getSelfHostKeySnapshot().selfHosted, true);
    assert.equal(changes.count, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.url, '/api/selfhost-key');
    assert.equal(h.calls[0]!.init?.method, 'GET');
    assert.equal(h.intervals.length, 1, 'polls while self-hosted');
    assert.equal(h.intervals[0]!.ms, SELF_HOST_KEY_REFRESH_MS);
  });

  it('never unlocks on an invalid verdict (AE4)', async () => {
    await bootWith(verdict('invalid'));
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().unlock, 'locked');
    assert.equal(getSelfHostKeySnapshot().verdict?.status, 'invalid');
  });

  for (const status of ['none', 'not_desktop_key', 'over_cap', 'lapsed', 'disabled']) {
    it(`locks on the explicit inactive status ${status}`, async () => {
      await bootWith(verdict(status));
      assert.equal(isSelfHostKeyUnlocked(), false);
      assert.equal(getSelfHostKeySnapshot().unlock, 'locked');
    });
  }

  it('reads a 404 as "not self-hosted": no polling, no errors, no later calls', async () => {
    const errors = mock.method(console, 'error', () => {});
    const warns = mock.method(console, 'warn', () => {});
    try {
      const changes = countChanges();
      await bootWith(notFound());

      assert.equal(isSelfHostKeyUnlocked(), false);
      assert.equal(getSelfHostKeySnapshot().selfHosted, false);
      assert.equal(h.intervals.length, 0, 'no polling timer');
      assert.equal(changes.count, 1);

      // A premium denial and an explicit refresh on worldmonitor.app make no call.
      noteSelfHostPremiumDenial();
      await refreshSelfHostKey();
      await settle();
      assert.equal(h.calls.length, 1, 'only the first 404');
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(warns.mock.callCount(), 0);
    } finally {
      errors.mock.restore();
      warns.mock.restore();
    }
  });

  it('reading the state never starts the service; only boot does', async () => {
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().selfHosted, null);
    await settle();
    assert.equal(h.calls.length, 0, 'gating and Settings reads send no request');
  });

  it('does not start when the page cannot run it (desktop app, no window)', async () => {
    _resetSelfHostKeyForTests({
      fetch: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
      canRun: () => false,
    });
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().selfHosted, null);
    await settle();
  });

  it('a reload starts in unknown and unlocks from the stored key without re-entry (AE2)', async () => {
    await bootWith(verdict('active'));
    assert.equal(isSelfHostKeyUnlocked(), true);

    // A reload drops the module state; the HttpOnly cookie stays with the browser.
    h = install();
    h.replies.push(verdict('active'));
    startSelfHostKeyService();
    assert.equal(getSelfHostKeySnapshot().unlock, 'unknown');
    await settle();
    assert.equal(isSelfHostKeyUnlocked(), true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.init?.method, 'GET', 'no key is posted again');
  });
});

describe('self-host key refresh', () => {
  it('a premium denial re-checks and relocks on revoke (AE3)', async () => {
    await bootWith(verdict('active'));
    const changes = countChanges();

    h.replies.push(verdict('invalid'));
    noteSelfHostPremiumDenial();
    await settle();

    assert.equal(h.calls.length, 2);
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().unlock, 'locked');
    assert.equal(changes.count, 1);
  });

  it('several denials at once trigger one verdict check', async () => {
    await bootWith(verdict('active'));
    let release!: (value: Response) => void;
    h.replies.push(() => new Promise<Response>((resolve) => { release = resolve; }));

    for (let i = 0; i < 5; i += 1) noteSelfHostPremiumDenial();
    await settle();
    assert.equal(h.calls.length, 2, 'one check in flight');

    release(verdict('active'));
    await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(isSelfHostKeyUnlocked(), true);
  });

  it('a denial on a locked or unknown browser does not call the route', async () => {
    await bootWith(verdict('invalid'));
    noteSelfHostPremiumDenial();
    await settle();
    assert.equal(h.calls.length, 1);
  });

  it('keeps an unlocked browser unlocked on network errors, then drops to unknown past 24 hours (AE5)', async () => {
    await bootWith(verdict('active'));
    const changes = countChanges();
    const tick = h.intervals[0]!.fn;

    h.clock.now = NOW + SELF_HOST_KEY_REFRESH_MS;
    h.replies.push(new TypeError('Failed to fetch'));
    tick();
    await settle();
    assert.equal(isSelfHostKeyUnlocked(), true, 'transport failure alone does not lock');
    assert.equal(getSelfHostKeySnapshot().checkFailed, true);

    h.clock.now = NOW + SELF_HOST_KEY_GRACE_MS + 1;
    h.replies.push(new TypeError('Failed to fetch'));
    tick();
    await settle();
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().unlock, 'unknown');
    assert.equal(changes.count, 2, 'one change for the failed check, one for the expiry');
  });

  it('a 429, a 5xx and an unavailable verdict keep the last state', async () => {
    await bootWith(verdict('active'));
    h.replies.push(new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));
    await refreshSelfHostKey();
    assert.equal(isSelfHostKeyUnlocked(), true);
    h.replies.push(new Response('bad gateway', { status: 502 }));
    await refreshSelfHostKey();
    assert.equal(isSelfHostKeyUnlocked(), true);
    h.replies.push(verdict('unavailable', { verifiedAt: null }));
    await refreshSelfHostKey();
    assert.equal(isSelfHostKeyUnlocked(), true);

    // The same answers leave a locked browser locked.
    h = install();
    await bootWith(verdict('lapsed'));
    h.replies.push(new TypeError('offline'), verdict('unavailable', { verifiedAt: null }));
    await refreshSelfHostKey();
    await refreshSelfHostKey();
    assert.equal(getSelfHostKeySnapshot().unlock, 'locked');
  });

  it('an unavailable first answer stays unknown', async () => {
    await bootWith(verdict('unavailable', { verifiedAt: null }));
    assert.equal(getSelfHostKeySnapshot().unlock, 'unknown');
    assert.equal(isSelfHostKeyUnlocked(), false);
  });

  it('a stale active verdict verified within 24 hours unlocks', async () => {
    await bootWith(verdict('active', { stale: true, verifiedAt: NOW - 60 * 60 * 1000 }));
    assert.equal(isSelfHostKeyUnlocked(), true);
  });

  it('a stale active verdict verified over 24 hours ago does not unlock', async () => {
    await bootWith(verdict('active'));
    assert.equal(isSelfHostKeyUnlocked(), true);
    const changes = countChanges();

    // The cloud stays unreachable and the sidecar keeps serving its cached verdict.
    h.clock.now = NOW + SELF_HOST_KEY_GRACE_MS + 1;
    h.replies.push(verdict('active', { stale: true, verifiedAt: NOW }));
    await refreshSelfHostKey();
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().unlock, 'unknown');
    assert.equal(changes.count, 1);
  });

  it('the getter enforces the 24-hour bound between checks', async () => {
    await bootWith(verdict('active'));
    h.clock.now = NOW + SELF_HOST_KEY_GRACE_MS;
    assert.equal(isSelfHostKeyUnlocked(), false);
  });
});

describe('self-host key save and remove', () => {
  it('posts the key as JSON and unlocks on an active answer', async () => {
    await bootWith(verdict('none'));
    h.replies.push(verdict('active'));
    const result = await saveSelfHostKey(`  wm_${'a'.repeat(40)}  `);

    assert.deepEqual(result.kind, 'verdict');
    const call = h.calls[1]!;
    assert.equal(call.init?.method, 'POST');
    assert.equal(new Headers(call.init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(call.init?.body)), { key: `wm_${'a'.repeat(40)}` });
    assert.equal(isSelfHostKeyUnlocked(), true);
  });

  it('a status read that started during a save cannot overwrite the save\'s verdict', async () => {
    await bootWith(verdict('active'));
    let answerPost!: (r: Response) => void;
    let answerGet!: (r: Response) => void;
    h.replies.push(() => new Promise<Response>((resolve) => { answerPost = resolve; }));
    h.replies.push(() => new Promise<Response>((resolve) => { answerGet = resolve; }));
    const saving = saveSelfHostKey(`wm_${'c'.repeat(40)}`);
    await settle();
    const reading = refreshSelfHostKey();
    await settle();
    assert.equal(h.calls.length, 3, 'boot GET, the POST, then the overlapping GET');

    answerPost(verdict('invalid'));
    await saving;
    assert.equal(getSelfHostKeySnapshot().unlock, 'locked');
    answerGet(verdict('active'));
    await reading;
    assert.equal(getSelfHostKeySnapshot().unlock, 'locked', 'the read saw the old cookie; its answer is dropped');
    assert.equal(getSelfHostKeySnapshot().verdict?.status, 'invalid');
  });

  it('the status read carries a timeout so a hung sidecar cannot pin every later check', async () => {
    await bootWith(verdict('active'));
    assert.ok(h.calls[0]!.init?.signal instanceof AbortSignal);
  });

  it('a save or remove the server never answers times out as failed, so Settings can retry', async () => {
    for (const write of [() => saveSelfHostKey(`wm_${'d'.repeat(40)}`), () => removeSelfHostKey()]) {
      const deadline = new AbortController();
      _resetSelfHostKeyForTests({
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
        })) as typeof fetch,
        now: () => NOW,
        setInterval: () => 1,
        clearInterval: () => {},
        canRun: () => true,
        timeoutSignal: () => deadline.signal,
      });
      const pending = write();
      deadline.abort();
      assert.deepEqual(await pending, { kind: 'failed' });
    }
  });

  it('a 400 malformed-key answer is an invalid verdict and stays locked', async () => {
    await bootWith(verdict('none'));
    h.replies.push(verdict('invalid', { verifiedAt: null, error: 'malformed_key' }, 400));
    const result = await saveSelfHostKey('wm_nope');
    assert.equal(result.kind, 'verdict');
    assert.equal(result.kind === 'verdict' && result.verdict.status, 'invalid');
    assert.equal(isSelfHostKeyUnlocked(), false);
  });

  it('a rate-limited save reports Retry-After and changes nothing', async () => {
    await bootWith(verdict('active'));
    h.replies.push(new Response('{}', { status: 429, headers: { 'Retry-After': '42' } }));
    const result = await saveSelfHostKey(`wm_${'b'.repeat(40)}`);
    assert.deepEqual(result, { kind: 'rate_limited', retryAfterSeconds: 42 });
    assert.equal(isSelfHostKeyUnlocked(), true);
  });

  it('remove sends DELETE with a JSON content type and locks', async () => {
    await bootWith(verdict('active'));
    h.replies.push(verdict('none', { verifiedAt: null }));
    const result = await removeSelfHostKey();
    assert.equal(result.kind, 'verdict');
    const call = h.calls[1]!;
    assert.equal(call.init?.method, 'DELETE');
    assert.equal(new Headers(call.init?.headers).get('Content-Type'), 'application/json');
    assert.equal(call.init?.body, undefined);
    assert.equal(isSelfHostKeyUnlocked(), false);
    assert.equal(getSelfHostKeySnapshot().verdict?.status, 'none');
  });

  it('a status read sent before a save cannot overwrite the save answer', async () => {
    await bootWith(verdict('none'));
    let release!: (value: Response) => void;
    h.replies.push(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = refreshSelfHostKey();
    await settle();

    h.replies.push(verdict('active'));
    await saveSelfHostKey(`wm_${'c'.repeat(40)}`);
    release(verdict('none', { verifiedAt: null }));
    await pending;
    assert.equal(isSelfHostKeyUnlocked(), true);
  });
});

it('the hosted site never probes the self-host route', async () => {
  const { isHostedWorldMonitorHost } = await import('../src/services/self-host-key.ts');
  for (const host of ['worldmonitor.app', 'www.worldmonitor.app', 'tech.worldmonitor.app', 'WWW.WORLDMONITOR.APP']) {
    assert.equal(isHostedWorldMonitorHost(host), true, host);
  }
  for (const host of ['localhost', '192.168.1.20', 'worldmonitor.example.org', 'notworldmonitor.app', 'worldmonitor.app.evil.test', undefined]) {
    assert.equal(isHostedWorldMonitorHost(host), false, String(host));
  }
});
