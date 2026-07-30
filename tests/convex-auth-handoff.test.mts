/**
 * Direct-account handoff coverage for the shared Convex client.
 *
 * The entitlement and billing watches are user-scoped on the server even
 * though their query args are empty. They therefore must not attach until the
 * singleton WebSocket has confirmed the newly selected Clerk identity.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import {
  __setConvexClientFactoryForTests,
  __setConvexClientForTests,
  getConvexClient,
  invalidateConvexAuthForSignOut,
  rebindConvexAuthForWatchHandoff,
  waitForConvexAuth,
} from '../src/services/convex-client.ts';
import { createApiKey, listApiKeys } from '../src/services/api-keys.ts';
import {
  acknowledgePlanLimitNotice,
  listCurrentPlanLimitNotices,
} from '../src/services/api-plan-limit-notices.ts';
import { listMcpClients } from '../src/services/mcp-clients.ts';
import { settleAccountOperation } from '../src/services/account-operation.ts';
import {
  __setClerkInstanceForTests,
  getClerkToken,
} from '../src/services/clerk.ts';
import { startAccountAuthHandoff } from '../src/app/account-auth-handoff.ts';
import {
  destroyEntitlementSubscription,
  initEntitlementSubscription,
} from '../src/services/entitlements.ts';
import {
  destroySubscriptionWatch,
  getSubscription,
  initSubscriptionWatch,
  listBusinessSeats,
  openBillingPortal,
} from '../src/services/billing.ts';

type TokenFetcher = (args?: { forceRefreshToken?: boolean }) => Promise<string | null>;
type AuthCallback = (isAuthenticated: boolean) => void;

class FakeConvexClient {
  readonly authConfigs: Array<{
    fetchToken: TokenFetcher;
    onChange: AuthCallback;
  }> = [];
  readonly watchAttachments: unknown[] = [];
  readonly mutations: unknown[][] = [];
  readonly queries: unknown[][] = [];
  readonly actions: unknown[][] = [];
  mutationResult: Promise<unknown> | null = null;
  queryResult: Promise<unknown> | null = null;
  actionResult: Promise<unknown> | null = null;

  setAuth(fetchToken: TokenFetcher, onChange: AuthCallback): void {
    this.authConfigs.push({ fetchToken, onChange });
  }

  onUpdate(...args: unknown[]): (() => void) & { unsubscribe: () => void } {
    this.watchAttachments.push(args);
    const unsubscribe = () => {};
    return Object.assign(unsubscribe, { unsubscribe });
  }

  mutation(...args: unknown[]): Promise<unknown> {
    this.mutations.push(args);
    if (this.mutationResult) return this.mutationResult;
    const input = args[1] as { name?: string; keyPrefix?: string } | undefined;
    return Promise.resolve({
      id: 'key_1',
      name: input?.name ?? '',
      keyPrefix: input?.keyPrefix ?? '',
    });
  }

  query(...args: unknown[]): Promise<unknown> {
    this.queries.push(args);
    return this.queryResult ?? Promise.resolve([]);
  }

  action(...args: unknown[]): Promise<unknown> {
    this.actions.push(args);
    return this.actionResult ?? Promise.resolve({});
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

async function waitForCalls(calls: unknown[][], expected: number): Promise<void> {
  await waitForCondition(
    () => calls.length >= expected,
    `expected ${expected} call(s), received ${calls.length}`,
  );
  assert.equal(calls.length, expected);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function installFakeClient(): FakeConvexClient {
  const fake = new FakeConvexClient();
  __setConvexClientForTests(fake);
  assert.equal(fake.authConfigs.length, 1, 'test install should model the initial A auth binding');
  return fake;
}

afterEach(() => {
  destroyEntitlementSubscription();
  destroySubscriptionWatch();
  __setConvexClientFactoryForTests(null);
  __setConvexClientForTests(null);
  __setClerkInstanceForTests(null);
});

describe('generation-scoped Convex auth handoff', () => {
  it('does not let A readiness satisfy B and attaches B watches only after B server confirmation', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    assert.equal(await waitForConvexAuth(50), true, 'A starts from an already-confirmed socket');

    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    assert.equal(fake.authConfigs.length, 2, 'B must install a fresh Convex auth config');
    assert.deepEqual(attached, [], 'A readiness must not attach B watches');

    // Even a late callback from A cannot resolve B's generation.
    fake.authConfigs[0].onChange(true);
    await flushMicrotasks();
    assert.deepEqual(attached, [], 'an old auth callback must not resolve the B barrier');

    fake.authConfigs[1].onChange(true);
    assert.equal(await handoff, true);
    assert.deepEqual(attached, ['B'], 'B watches attach after B is confirmed by the server');
  });

  it('supersedes an overlapping B rebind so only current C can attach watches', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);

    let currentUserId = 'B';
    const attached: string[] = [];
    const handoffB = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'B',
      () => attached.push('B'),
      1_000,
    );
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2);

    currentUserId = 'C';
    const handoffC = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'C',
      () => attached.push('C'),
      1_000,
    );
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 3);

    // B's server response arrives after C became current. Its callback belongs
    // to a superseded auth generation and must be inert.
    fake.authConfigs[1].onChange(true);
    assert.equal(await handoffB, false);
    assert.deepEqual(attached, []);

    fake.authConfigs[2].onChange(true);
    assert.equal(await handoffC, true);
    assert.deepEqual(attached, ['C']);
  });

  it('treats a same-config true then false callback as unauthenticated', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    fake.authConfigs[1].onChange(true);
    fake.authConfigs[1].onChange(false);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
    assert.equal(await waitForConvexAuth(10), false);
  });

  it('fails closed on terminal auth failure while the identity remains current', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    fake.authConfigs[1].onChange(false);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
  });

  it('retries a transient terminal token failure for the current identity', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    let current = true;
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
      [1],
    );
    try {
      await flushMicrotasks();

      fake.authConfigs[1].onChange(false);
      await waitForCondition(
        () => fake.authConfigs.length === 3,
        'current B should install one bounded retry config',
      );

      fake.authConfigs[2].onChange(true);
      assert.equal(await handoff, true);
      assert.deepEqual(attached, ['B']);
    } finally {
      current = false;
      __setConvexClientForTests(null);
      await handoff;
    }
  });

  it('recovers current-user watches after a bounded wait times out', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      5,
      [],
    );
    await flushMicrotasks();

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);

    fake.authConfigs[1].onChange(true);
    await flushMicrotasks();
    assert.deepEqual(attached, ['B']);
  });

  it('does not attach after auth succeeds for an identity that signed out', async () => {
    const fake = installFakeClient();
    let current = true;
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
    );
    await flushMicrotasks();

    current = false;
    fake.authConfigs[1].onChange(true);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
  });

  it('invalidates the old token before, but not during, the new token fetch', async () => {
    const fake = installFakeClient();
    const token = deferred<string | null>();
    let tokenFetches = 0;
    __setClerkInstanceForTests({
      session: {
        getToken: async () => {
          tokenFetches += 1;
          return token.promise;
        },
      },
      user: {
        id: 'B',
      },
    } as never);

    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => {},
      1_000,
    );
    const cloudPrefsToken = getClerkToken();
    await flushMicrotasks();

    assert.equal(fake.authConfigs.length, 2);
    const convexToken = fake.authConfigs[1].fetchToken();
    token.resolve('token-b');

    assert.equal(await cloudPrefsToken, 'token-b');
    assert.equal(await convexToken, 'token-b');
    assert.equal(tokenFetches, 1, 'Convex and cloud prefs should share B token fetch');

    fake.authConfigs[1].onChange(true);
    assert.equal(await handoff, true);
  });

  it('cancels async watch initialization when the selected identity changes', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    let current = true;

    const entitlementInit = initEntitlementSubscription('B', () => current);
    const billingInit = initSubscriptionWatch('B', () => current);
    current = false;

    await Promise.all([entitlementInit, billingInit]);
    assert.equal(fake.watchAttachments.length, 0);
  });

  it('invalidates cached, in-flight, and Convex credentials on sign-out', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    const oldAuthCallback = fake.authConfigs[0].onChange;
    const token = deferred<string | null>();
    __setClerkInstanceForTests({
      session: {
        getToken: async () => token.promise,
      },
      user: {
        id: 'B',
      },
    } as never);

    const inFlightToken = getClerkToken();
    invalidateConvexAuthForSignOut();
    assert.equal(fake.authConfigs.length, 2);

    // Model Clerk completing the same observed sign-out transition.
    __setClerkInstanceForTests(null);
    token.resolve('token-b');
    assert.equal(await inFlightToken, null);
    assert.equal(await getClerkToken(), null);

    // The old server callback is inert, and the dedicated replacement config
    // can never fetch the departing session.
    oldAuthCallback(true);
    assert.equal(await fake.authConfigs[1].fetchToken(), null);
    fake.authConfigs[1].onChange(false);
    assert.equal(await waitForConvexAuth(10), false);
  });

  it('does not dispatch an API-key create if A changes while auth is pending', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();

    // Leave A's barrier unresolved so the sensitive operation is in flight
    // when Clerk selects B.
    const createRejected = assert.rejects(
      createApiKey('A key'),
      /Account changed while creating the API key/,
    );
    await flushMicrotasks();

    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    const handoffB = rebindConvexAuthForWatchHandoff(
      () => true,
      () => {},
      1_000,
      [],
    );
    await flushMicrotasks();

    await createRejected;
    assert.equal(fake.mutations.length, 0, 'no account-bound mutation may cross the switch');

    fake.authConfigs[1].onChange(true);
    assert.equal(await handoffB, true);
  });

  it('checks the initiating account immediately before dispatch', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    let dispatched = false;

    await assert.rejects(
      settleAccountOperation('A', 'running the operation', async () => {
        dispatched = true;
      }),
      /Account changed while running the operation/,
    );
    assert.equal(dispatched, false);
  });

  it('masks an A-specific rejection when the operation rejects after B is selected', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const operation = deferred<string>();
    const rejected = assert.rejects(
      settleAccountOperation('A', 'loading private account data', () => operation.promise),
      /Account changed while loading private account data/,
    );

    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    operation.reject(new Error('A-specific backend detail'));

    await rejected;
  });

  it('preserves the original rejection while the initiating account remains current', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const operation = deferred<string>();
    const original = new Error('same-account backend detail');
    const rejected = assert.rejects(
      settleAccountOperation('A', 'loading private account data', () => operation.promise),
      (err) => err === original,
    );

    operation.reject(original);
    await rejected;
  });

  it('surfaces current-account auth outages instead of rendering empty account lists', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(false);

    const cases: Array<[string, () => Promise<unknown>]> = [
      ['API keys', listApiKeys],
      ['MCP clients', listMcpClients],
      ['API plan-limit notices', listCurrentPlanLimitNotices],
      ['Business Pro seats', listBusinessSeats],
    ];
    for (const [label, operation] of cases) {
      await assert.rejects(
        operation(),
        new RegExp(`Authentication unavailable while loading ${label}`),
      );
    }
  });

  it('rejects an A API key that resolves after Clerk selects B', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    const mutation = deferred<{
      id: string;
      name: string;
      keyPrefix: string;
    }>();
    fake.mutationResult = mutation.promise;

    const rejected = assert.rejects(
      createApiKey('A key'),
      /Account changed while creating the API key/,
    );
    await waitForCalls(fake.mutations, 1);

    mutation.resolve({ id: 'key_a', name: 'A key', keyPrefix: 'wm_a' });
    queueMicrotask(() => {
      __setClerkInstanceForTests({
        session: { getToken: async () => 'token-b' },
        user: { id: 'B' },
      } as never);
    });

    await rejected;
    assert.equal(fake.mutations.length, 1, 'the A mutation completed, but its plaintext stayed discarded');
  });

  it('rejects a notice acknowledgement when the identity-bound auth gate fails', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(false);

    await assert.rejects(
      acknowledgePlanLimitNotice('notice-a'),
      /Account changed while acknowledging the API plan-limit notice/,
    );
    assert.equal(fake.mutations.length, 0);
  });

  it('discards account-scoped list results that settle after A changes to B', async () => {
    const cases = [
      ['API keys', listApiKeys],
      ['MCP clients', listMcpClients],
      ['plan-limit notices', listCurrentPlanLimitNotices],
      ['Business seats', listBusinessSeats],
    ] as const;

    for (const [label, load] of cases) {
      __setClerkInstanceForTests({
        session: { getToken: async () => 'token-a' },
        user: { id: 'A' },
      } as never);
      const fake = installFakeClient();
      fake.authConfigs[0].onChange(true);
      const query = deferred<unknown>();
      fake.queryResult = query.promise;

      const rejected = assert.rejects(
        load(),
        /Account changed while/,
        `${label} must not cross the account handoff`,
      );
      await waitForCalls(fake.queries, 1);

      __setClerkInstanceForTests({
        session: { getToken: async () => 'token-b' },
        user: { id: 'B' },
      } as never);
      query.resolve([]);

      await rejected;
      __setConvexClientForTests(null);
    }
  });

  it('closes the reserved tab instead of navigating B to A billing portal', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    const action = deferred<{ portal_url: string }>();
    fake.actionResult = action.promise;
    const reserved = {
      closed: false,
      location: { href: '' },
      close() {
        this.closed = true;
      },
    };

    const opening = openBillingPortal(reserved as never);
    await waitForCalls(fake.actions, 1);

    action.resolve({ portal_url: 'https://portal.example/account-a-secret' });
    queueMicrotask(() => {
      __setClerkInstanceForTests({
        session: { getToken: async () => 'token-b' },
        user: { id: 'B' },
      } as never);
    });

    assert.deepEqual(await opening, { outcome: 'account-changed' });
    assert.equal(reserved.closed, true);
    assert.equal(reserved.location.href, '', 'A portal URL must never be assigned');
  });

  it('drops a late billing-watch snapshot after its account handoff is stale', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const fake = installFakeClient();
    await initSubscriptionWatch('A');
    assert.equal(fake.watchAttachments.length, 1);

    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    const onResult = fake.watchAttachments[0]?.[2] as (
      result: { planKey: string } | null,
    ) => void;
    onResult({ planKey: 'pro' });

    assert.equal(getSubscription(), null);
  });
});

describe('cold Convex singleton initialization', () => {
  it('constructs one client and installs one auth config for concurrent callers', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    let factoryCalls = 0;
    __setConvexClientFactoryForTests(async () => {
      factoryCalls += 1;
      await releaseFactory.promise;
      return fake as never;
    });

    const first = getConvexClient();
    const second = getConvexClient();
    assert.equal(factoryCalls, 1);

    releaseFactory.resolve();
    const [firstClient, secondClient] = await Promise.all([first, second]);

    assert.equal(factoryCalls, 1);
    assert.strictEqual(firstClient, secondClient);
    assert.strictEqual(firstClient, fake);
    assert.equal(fake.authConfigs.length, 1);
  });

  it('keeps only the latest account rebind when cold initialization resolves out of order', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    __setConvexClientFactoryForTests(async () => {
      await releaseFactory.promise;
      return fake as never;
    });

    let currentUserId = 'B';
    const attached: string[] = [];
    const handoffB = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'B',
      () => attached.push('B'),
      1_000,
      [],
    );
    currentUserId = 'C';
    const handoffC = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'C',
      () => attached.push('C'),
      1_000,
      [],
    );

    releaseFactory.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(await handoffB, false);
    assert.equal(fake.authConfigs.length, 2, 'initial config plus latest C rebind only');
    fake.authConfigs[1].onChange(true);
    assert.equal(await handoffC, true);
    assert.deepEqual(attached, ['C']);
  });

  it('installs only a null-token auth config when sign-out wins cold creation', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    __setConvexClientFactoryForTests(async () => {
      await releaseFactory.promise;
      return fake as never;
    });

    let current = true;
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
      [],
    );

    current = false;
    invalidateConvexAuthForSignOut();
    __setClerkInstanceForTests(null);
    releaseFactory.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
    assert.equal(fake.authConfigs.length, 1, 'cold client must install only signed-out auth');
    assert.equal(await fake.authConfigs[0].fetchToken(), null);
  });
});

describe('App account-switch controller', () => {
  it('resets state, starts rebind before cloud prefs, and nests watch attachment', async () => {
    const events: string[] = [];
    const completion = deferred<boolean>();
    let attachWatches: (() => void) | null = null;

    const handoff = startAccountAuthHandoff({
      userId: 'B',
      isCurrent: () => true,
      effects: {
        destroyEntitlementSubscription: () => events.push('destroy-entitlement'),
        resetEntitlementState: () => events.push('reset-entitlement'),
        destroySubscriptionWatch: () => events.push('destroy-billing'),
        rebindConvexAuthForWatchHandoff: (isCurrent, attach) => {
          events.push('rebind');
          assert.equal(isCurrent(), true);
          attachWatches = attach;
          return completion.promise;
        },
        initEntitlementSubscription: (userId) => {
          events.push(`attach-entitlement:${userId}`);
        },
        initSubscriptionWatch: (userId) => {
          events.push(`attach-billing:${userId}`);
        },
        cloudPrefsSignIn: (userId) => {
          events.push(`cloud-prefs:${userId}`);
        },
      },
    });

    assert.deepEqual(events, [
      'destroy-entitlement',
      'reset-entitlement',
      'destroy-billing',
      'rebind',
      'cloud-prefs:B',
    ]);

    assert.ok(attachWatches);
    attachWatches();
    assert.deepEqual(events.slice(-2), [
      'attach-entitlement:B',
      'attach-billing:B',
    ]);

    completion.resolve(true);
    assert.equal(await handoff, true);
  });

  it('wires App through the tested account-handoff controller', async () => {
    const app = await readFile(new URL('../src/App.ts', import.meta.url), 'utf8');
    const branch = app.match(
      /if \(userId !== null && userId !== _prevUserId\) \{[\s\S]*?\/\/ Claim any anonymous purchase/,
    )?.[0];
    assert.ok(branch, 'expected the signed-in identity-change branch');
    assert.match(branch, /startAccountAuthHandoff\(\{/);
    assert.match(branch, /getAuthState\(\)\.user\?\.id === userId/);
    assert.match(branch, /resetEntitlementState,/);
    assert.match(branch, /rebindConvexAuthForWatchHandoff,/);
    assert.match(branch, /cloudPrefsSignIn: \(nextUserId\)/);
    assert.match(
      app,
      /else if \(userId === null && _prevUserId !== null\) \{[\s\S]*?invalidateConvexAuthForSignOut\(\);/,
    );
  });
});
