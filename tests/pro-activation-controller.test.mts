import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Zero-import decision leaf — safe to import directly under `tsx --test`, and
// the only honest source for the account-key hash the marker must carry.
import {
  computeFireOnceRecord,
  deriveActivationAccountKey,
  fireOnceStorageKey,
  PENDING_MARKER_KEY,
} from '@/services/pro-activation-state';

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

const windowSnapshot = snapshotGlobal('window');
const stateKeys = [
  '__activationAuth',
  '__activationAuthListeners',
  '__activationSubscription',
  '__activationEntitlement',
  '__activationEntitlementListeners',
  '__activationSubscriptionListeners',
  '__activationOpenedFor',
  '__activationOpenResult',
  '__activationOpenGate',
  '__activationCloseCalls',
  '__activationFlowOptions',
  '__activationChipOptions',
  '__activationChipClick',
  '__activationChipReopenOptions',
] as const;
const stateSnapshots = new Map(stateKeys.map((key) => [key, snapshotGlobal(key)]));

afterEach(() => {
  restoreGlobal('window', windowSnapshot);
  for (const key of stateKeys) restoreGlobal(key, stateSnapshots.get(key)!);
});

async function loadController(): Promise<typeof import('../src/app/pro-activation-controller.ts')> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-pro-activation-controller-'));
  const outfile = join(tempDir, 'controller.bundle.mjs');
  const stubs = new Map([
    ['analytics-stub', 'export function trackProActivation() {}'],
    ['auth-stub', `
      export function getAuthState() { return globalThis.__activationAuth; }
      export function subscribeAuthState(callback) {
        globalThis.__activationAuthListeners.add(callback);
        callback(globalThis.__activationAuth);
        return () => globalThis.__activationAuthListeners.delete(callback);
      }
    `],
    ['billing-stub', `
      export function getSubscription() { return globalThis.__activationSubscription; }
      export function onSubscriptionChange(callback) {
        globalThis.__activationSubscriptionListeners.add(callback);
        // Mirror production (src/services/billing.ts): a late subscriber gets
        // the current snapshot SYNCHRONOUSLY when it is already loaded.
        if (globalThis.__activationSubscription !== null) {
          callback(globalThis.__activationSubscription);
        }
        return () => globalThis.__activationSubscriptionListeners.delete(callback);
      }
    `],
    ['entitlements-stub', `
      export function getEntitlementState() { return globalThis.__activationEntitlement; }
      // Mirrors production hasFeature() EXACTLY (src/services/entitlements.ts):
      // null state → false, and an absent flag coerces to false. Deliberately no
      // optional chaining on \`.features\` — production indexes it directly, so a
      // fixture that omits the (required) field must throw here too rather than
      // silently reporting false and hiding a real crash.
      export function hasFeature(flag) {
        const state = globalThis.__activationEntitlement;
        if (state === null || state === undefined) return false;
        return Boolean(state.features[flag]);
      }
      export function onEntitlementChange(callback) {
        globalThis.__activationEntitlementListeners.add(callback);
        // Mirror production (src/services/entitlements.ts): a late subscriber
        // gets the current snapshot SYNCHRONOUSLY when it is already loaded.
        if (globalThis.__activationEntitlement !== null) {
          callback(globalThis.__activationEntitlement);
        }
        return () => globalThis.__activationEntitlementListeners.delete(callback);
      }
    `],
    ['interstitial-stub', `
      export async function openProActivationFlow(options) {
        globalThis.__activationOpenedFor.push(options.accountUserId);
        globalThis.__activationFlowOptions.push(options);
        if (globalThis.__activationOpenGate) await globalThis.__activationOpenGate;
        return globalThis.__activationOpenResult ?? 'opened';
      }
      export function closeProActivationInterstitial() {
        globalThis.__activationCloseCalls = (globalThis.__activationCloseCalls ?? 0) + 1;
      }
    `],
    ['chip-stub', `
      export function maybeShowFinishSetupChip(options) {
        globalThis.__activationChipOptions.push(options);
        globalThis.__activationChipClick = () => {
          const identity = options.createDay0SessionIdentity();
          const reopenedOptions = { ...options, ...identity };
          globalThis.__activationChipReopenOptions.push(reopenedOptions);
          return reopenedOptions;
        };
      }
    `],
  ]);
  const aliases = new Map([
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/auth-state', 'auth-stub'],
    ['@/services/billing', 'billing-stub'],
    ['@/services/entitlements', 'entitlements-stub'],
    ['@/components/ProActivationInterstitial', 'interstitial-stub'],
    ['@/components/ProActivationChip', 'chip-stub'],
  ]);

  const result = await build({
    entryPoints: [resolve(process.cwd(), 'src/app/pro-activation-controller.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'pro-activation-controller-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'js',
        }));
      },
    }],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as typeof import('../src/app/pro-activation-controller.ts');
}

function installBrowserState(options: { fastTimers?: boolean } = {}): void {
  const values = new Map<string, string>();
  // The real backoff schedule (2s..30s) would make retry-exhaustion tests slow
  // and flaky; fastTimers collapses every window.setTimeout delay to the next
  // tick while preserving real clearTimeout semantics.
  const timeoutFn = options.fastTimers
    ? ((handler: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
        setTimeout(handler, 0, ...args)) as typeof setTimeout
    : setTimeout;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
      },
      setTimeout: timeoutFn,
      clearTimeout,
    },
  });
  Object.assign(globalThis, {
    __activationAuth: { user: null, isPending: false },
    __activationAuthListeners: new Set<(state: unknown) => void>(),
    __activationSubscription: null,
    // Production never yields an EntitlementState without `features` — the Convex
    // query returns FREE_TIER_DEFAULTS or a catalog-merged row — so every fixture
    // carries it, matching what hasFeature()/hasTier() index directly.
    __activationEntitlement: {
      planKey: 'free',
      validUntil: Date.now() + 60_000,
      features: { tier: 0, apiAccess: false, mcpAccess: false },
    },
    __activationEntitlementListeners: new Set<() => void>(),
    __activationSubscriptionListeners: new Set<() => void>(),
    __activationOpenedFor: [] as string[],
    __activationOpenResult: 'opened' as string,
    __activationOpenGate: null as Promise<void> | null,
    __activationCloseCalls: 0,
    __activationFlowOptions: [] as unknown[],
    __activationChipOptions: [] as unknown[],
    __activationChipClick: null as (() => Record<string, unknown>) | null,
    __activationChipReopenOptions: [] as unknown[],
  });
}

/**
 * A first-cycle Pro account eligible for the markerless cohort mount.
 *
 * `features` mirrors the live Pro entitlement (`apiAccess: false`,
 * `mcpAccess: true`) so power-step deep links resolve against the same
 * capability set production sees; pass an override to model a legacy snapshot
 * that pre-dates the `mcpAccess` catalog field.
 */
function installEligibleMarkerlessAccount(
  userId: string,
  features: Record<string, unknown> = { apiAccess: false, mcpAccess: true },
): void {
  Object.assign(globalThis, {
    __activationAuth: {
      user: { id: userId, name: 'Markerless User', email: `${userId}@example.com`, role: 'pro' },
      isPending: false,
    },
    __activationSubscription: {
      activationKey: `opaque-${userId}-subscription`,
      activationOnboardingEligible: true,
      planKey: 'pro_monthly',
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
    __activationEntitlement: {
      planKey: 'pro_monthly',
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
      features,
    },
  });
}

describe('ProActivationController auth lifecycle', () => {
  it('re-evaluates a Pro account that signs in after signed-out resolution', async () => {
    installBrowserState();
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();

      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      assert.deepEqual(
        (globalThis as unknown as { __activationOpenedFor: string[] }).__activationOpenedFor,
        [],
      );

      Object.assign(globalThis, {
        __activationAuth: {
          user: {
            id: 'user-second-session',
            name: 'Second Session',
            email: 'second@example.com',
            role: 'pro',
          },
          isPending: false,
        },
        __activationSubscription: {
          activationKey: 'opaque-first-cycle-subscription',
          activationOnboardingEligible: true,
          planKey: 'pro_monthly',
          currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
        __activationEntitlement: {
          planKey: 'pro_monthly',
          validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
          features: { tier: 1, apiAccess: false, mcpAccess: true },
        },
      });
      const authState = (globalThis as unknown as { __activationAuth: unknown }).__activationAuth;
      for (const listener of (
        globalThis as unknown as { __activationAuthListeners: Set<(state: unknown) => void> }
      ).__activationAuthListeners) {
        listener(authState);
      }

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      for (let attempt = 0; attempt < 40 && openedFor.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(openedFor, ['user-second-session']);
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  });
});

describe('ProActivationController markerless mount() branching', () => {
  it("openFlow returning 'not-eligible' resolves the tab and stops re-attempting", async () => {
    installBrowserState();
    installEligibleMarkerlessAccount('user-not-eligible');
    (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'not-eligible';
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      for (let attempt = 0; attempt < 40 && openedFor.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(openedFor, ['user-not-eligible']);
      assert.equal((controller as unknown as { resolved: boolean }).resolved, true);
      assert.equal((controller as unknown as { mounting: boolean }).mounting, false);

      // Resolved tabs must not re-attempt on a later evaluate() call.
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      assert.deepEqual(openedFor, ['user-not-eligible']);
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  });

  it("openFlow returning 'retry' backs off through the bounded schedule, then falls back to passive listeners instead of giving up", async () => {
    installBrowserState({ fastTimers: true });
    installEligibleMarkerlessAccount('user-retry-forever');
    (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'retry';
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      // With fast timers, the whole 5-attempt backoff schedule collapses to a
      // handful of ticks instead of the real ~60s cumulative delay. Exhaustion
      // is observed here as "no new attempt for a while", since the tab no
      // longer resolves -- it falls back to listening instead of giving up.
      for (
        let attempt = 0;
        attempt < 200 && openedFor.length < 6;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(openedFor.length, 6, 'one initial attempt plus every entry in the backoff schedule');
      assert.ok(openedFor.every((id) => id === 'user-retry-forever'));

      // The tab must stay unresolved and retryable, not permanently give up.
      assert.equal((controller as unknown as { resolved: boolean }).resolved, false);
      // No 7th attempt fires on its own -- the timer-based schedule is done.
      // The exhaustion fallback re-arms the passive listeners, whose stubs
      // replay the current snapshot SYNCHRONOUSLY on subscribe (mirroring
      // production); that replay must be swallowed, not retrigger evaluate().
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(openedFor.length, 6);

      // An external entitlement/subscription change (e.g. the underlying
      // outage clearing) must still retrigger a fresh attempt instead of the
      // tab being stuck until reload. Let this retriggered attempt succeed so
      // the assertion doesn't depend on how many further backoff attempts a
      // still-failing mock would cascade through.
      (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'opened';
      for (const listener of (
        globalThis as unknown as { __activationSubscriptionListeners: Set<() => void> }
      ).__activationSubscriptionListeners) {
        listener();
      }
      for (
        let attempt = 0;
        attempt < 40 && (controller as unknown as { resolved: boolean }).resolved === false;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(openedFor.length, 7, 'a listener-driven re-evaluate must attempt to mount again');
      assert.equal(
        (controller as unknown as { resolved: boolean }).resolved,
        true,
        'the retriggered attempt succeeds and resolves the tab',
      );
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  });

  it("swallows the synchronous subscribe replay at exhaustion, but a genuine emission starts a full fresh schedule", async () => {
    installBrowserState({ fastTimers: true });
    installEligibleMarkerlessAccount('user-replay-not-an-emission');
    (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'retry';
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      for (
        let attempt = 0;
        attempt < 200 && openedFor.length < 6;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(openedFor.length, 6, 'initial attempt plus the bounded backoff schedule');

      // Exhaustion re-arms the passive listeners; the stubs replay the loaded
      // snapshot synchronously on subscribe (mirroring production). Without the
      // replay swallow that replay would immediately retrigger evaluate() and
      // recreate the very retry loop the fallback was meant to stop.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(openedFor.length, 6, 'the subscribe replay must not self-trigger a re-arm loop');

      // A genuine listener emission (the outage clearing) re-triggers a fresh
      // attempt -- and, with the flow still failing, a full fresh backoff
      // schedule (another 6 attempts) rather than an immediate re-give-up.
      for (const listener of (
        globalThis as unknown as { __activationEntitlementListeners: Set<() => void> }
      ).__activationEntitlementListeners) {
        listener();
      }
      for (
        let attempt = 0;
        attempt < 200 && openedFor.length < 12;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(openedFor.length, 12, 'the fresh trigger gets its own full backoff schedule');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(openedFor.length, 12, 'the second exhaustion must not self-trigger either');
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  });

  it("destroy() during an in-flight openFlow closes any interstitial that was opened, instead of leaving it orphaned", async () => {
    installBrowserState();
    installEligibleMarkerlessAccount('user-destroyed-mid-flight');
    let releaseGate!: () => void;
    Object.assign(globalThis, {
      __activationOpenResult: 'opened',
      __activationOpenGate: new Promise<void>((resolve) => {
        releaseGate = resolve;
      }),
    });
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    controller.init();
    const evaluatePromise = (controller as unknown as { evaluate(): Promise<void> }).evaluate();

    const openedFor = (
      globalThis as unknown as { __activationOpenedFor: string[] }
    ).__activationOpenedFor;
    for (let attempt = 0; attempt < 40 && openedFor.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(openedFor.length, 1, 'the flow must have started (and, in real code, rendered) before destroy()');

    // Simulate a same-document app re-init: the owning AppContext flips
    // isDestroyed and calls destroy() while openFlow() is still awaiting the
    // (gated) module call -- mirroring how a real teardown works, so this
    // controller instance never attempts to re-mount afterward.
    ctx.isDestroyed = true;
    controller.destroy();
    releaseGate();
    await evaluatePromise;

    assert.equal(
      (globalThis as unknown as { __activationCloseCalls: number }).__activationCloseCalls,
      1,
      'a destroy-triggered generation bump must close any interstitial the stale attempt opened',
    );
    assert.equal(openedFor.length, 1, 'a destroyed controller must not attempt to re-mount');
  });
});

describe('ProActivationController power-step surface wiring', () => {
  /** Drive one mount and return the flow options the interstitial received. */
  async function captureFlowOptions(
    userId: string,
    features: Record<string, unknown>,
  ): Promise<{
    options: Record<string, unknown>;
    settingsOpens: string[];
  }> {
    installBrowserState();
    installEligibleMarkerlessAccount(userId, features);
    const { ProActivationController } = await loadController();
    const settingsOpens: string[] = [];
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: { open: (tab: string) => settingsOpens.push(tab) },
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      const captured = (globalThis as unknown as { __activationFlowOptions: unknown[] })
        .__activationFlowOptions;
      for (let attempt = 0; attempt < 40 && captured.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(captured.length, 1, 'the eligible Pro account must mount the flow exactly once');
      return { options: captured[0] as Record<string, unknown>, settingsOpens };
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  }

  it('deep-links the power step to MCP Clients — the capability Pro actually has (#5607)', async () => {
    const { options, settingsOpens } = await captureFlowOptions('user-mcp-pointer', {
      apiAccess: false,
      mcpAccess: true,
    });

    assert.equal(
      typeof options.openMcpClients,
      'function',
      'a Pro account with mcpAccess must get an MCP Clients pointer',
    );
    assert.equal(
      options.openApiKeys,
      undefined,
      'Pro has apiAccess:false — the flow must not offer an API-keys deep link',
    );

    (options.openMcpClients as () => void)();
    assert.deepEqual(
      settingsOpens,
      ['mcp-clients'],
      'the pointer must open the MCP Clients tab, not the API Keys upsell',
    );
  });

  it('falls back to plain settings when mcpAccess lapses between build and click', async () => {
    // The finish-setup chip replays a captured options object, so the gap
    // between building the opener and invoking it can span an entitlement
    // change. A build-time-only check would deep-link to a tab UnifiedSettings
    // has since stopped rendering, leaving the modal with no active panel.
    const { options, settingsOpens } = await captureFlowOptions('user-lapsed-midflight', {
      apiAccess: false,
      mcpAccess: true,
    });
    assert.equal(typeof options.openMcpClients, 'function');

    Object.assign(globalThis, {
      __activationEntitlement: {
        planKey: 'pro_monthly',
        validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
        features: { tier: 1, apiAccess: false, mcpAccess: false },
      },
    });

    (options.openMcpClients as () => void)();
    assert.deepEqual(
      settingsOpens,
      ['settings'],
      'a lapsed mcpAccess must land on a rendered tab, not the vanished MCP panel',
    );
  });

  it('omits the pointer when mcpAccess is absent, rather than deep-linking to an unrendered tab', async () => {
    // Legacy Pro entitlement snapshots pre-date the mcpAccess catalog field.
    // UnifiedSettings renders neither the MCP tab button nor its panel in that
    // state, so open('mcp-clients') would leave the modal with no active panel.
    const { options } = await captureFlowOptions('user-legacy-snapshot', { apiAccess: false });

    assert.equal(
      options.openMcpClients,
      undefined,
      'without mcpAccess the power step must drop the pointer entirely',
    );
    assert.equal(options.openApiKeys, undefined, 'and must not fall back to the API-keys surface');
  });
});

describe('ProActivationController activation-record identity (#5621)', () => {
  /** Drive one mount for the requested cohort and return the flow options. */
  async function captureCohortOptions(
    cohort: 'day0' | 'markerless',
    userId: string,
  ): Promise<Record<string, unknown>> {
    installBrowserState();
    installEligibleMarkerlessAccount(userId);
    if (cohort === 'day0') {
      // A live checkout-return marker for THIS account takes the marker branch
      // of decideActivationMount, which mounts with onlyIfUnactivated: false.
      (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
        PENDING_MARKER_KEY,
        JSON.stringify({
          createdAt: Date.now(),
          productId: 'pdt_0Nbtt71uObulf7fGXhQup',
          accountKey: deriveActivationAccountKey(userId),
        }),
      );
    }
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: { open() {} },
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      const captured = (globalThis as unknown as { __activationFlowOptions: unknown[] })
        .__activationFlowOptions;
      for (let attempt = 0; attempt < 40 && captured.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(captured.length, 1, `the ${cohort} cohort must mount the flow exactly once`);
      return captured[0] as Record<string, unknown>;
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  }

  it('hands the day-0 cohort the same subscription identity the retro cohort gets', async () => {
    // Day-0 used to mount with expectedActivationKey/activationClaimNonce
    // undefined, which made persistActivationOutcomeWithRetry return early and
    // left the entire post-checkout cohort absent from Convex (#5621) — the
    // exact blind spot the #5600 investigation had to work around.
    const day0 = await captureCohortOptions('day0', 'user-day0-identity');

    assert.equal(day0.onlyIfUnactivated, false, 'a live checkout marker is the day-0 cohort');
    assert.equal(
      day0.expectedActivationKey,
      'opaque-user-day0-identity-subscription',
      'day-0 must carry the subscription identity its outcome row is keyed by',
    );
    assert.equal(
      typeof day0.activationClaimNonce,
      'string',
      'day-0 must carry a session nonce so its outcome writes are attributable',
    );
    assert.notEqual(day0.activationClaimNonce, '');
    assert.equal(
      typeof day0.activationSessionStartedAt,
      'number',
      'day-0 must carry a comparable session-start order',
    );
  });

  it('still hands the markerless cohort its lease identity', async () => {
    const retro = await captureCohortOptions('markerless', 'user-retro-identity');

    assert.equal(retro.onlyIfUnactivated, true);
    assert.equal(retro.expectedActivationKey, 'opaque-user-retro-identity-subscription');
    assert.equal(typeof retro.activationClaimNonce, 'string');
  });

  it('gives every click from one retained Finish Setup chip fresh ordered day-0 identity', async () => {
    installBrowserState();
    const userId = 'user-chip-identity';
    const subscriptionKey = `opaque-${userId}-subscription`;
    installEligibleMarkerlessAccount(userId);
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
      fireOnceStorageKey(deriveActivationAccountKey(userId)!),
      JSON.stringify(computeFireOnceRecord(subscriptionKey, Date.now())),
    );
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: { open() {} },
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });

    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      const captured = (globalThis as unknown as { __activationChipOptions: unknown[] })
        .__activationChipOptions;
      for (let attempt = 0; attempt < 40 && captured.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(captured.length, 1, 'the later session must retain one Finish Setup chip');

      const chipOptions = captured[0] as Record<string, unknown>;
      assert.equal(chipOptions.onlyIfUnactivated, false);
      assert.equal(chipOptions.expectedActivationKey, subscriptionKey);
      assert.equal(
        chipOptions.activationClaimNonce,
        undefined,
        'the chip must not capture an identity before the user clicks',
      );

      const click = (
        globalThis as unknown as {
          __activationChipClick: (() => Record<string, unknown>) | null;
        }
      ).__activationChipClick;
      assert.equal(typeof click, 'function');
      click!();
      click!();

      const [first, second] = (
        globalThis as unknown as { __activationChipReopenOptions: Array<Record<string, unknown>> }
      ).__activationChipReopenOptions;
      assert.ok(first);
      assert.ok(second);
      for (const options of [first, second]) {
        assert.equal(options.onlyIfUnactivated, false);
        assert.equal(options.expectedActivationKey, subscriptionKey);
        assert.equal(typeof options.activationClaimNonce, 'string');
        assert.notEqual(options.activationClaimNonce, '');
        assert.equal(typeof options.activationSessionStartedAt, 'number');
      }
      assert.notEqual(
        first.activationClaimNonce,
        (controller as unknown as { mountNonce: string }).mountNonce,
        'chip-triggered flows must not reuse the controller mount nonce',
      );
      assert.notEqual(
        second.activationClaimNonce,
        first.activationClaimNonce,
        'the retained chip must mint a fresh nonce on every click',
      );
      assert.ok(
        (second.activationSessionStartedAt as number) >
          (first.activationSessionStartedAt as number),
        'the retained chip must mint a strictly newer order on every click',
      );
    } finally {
      ctx.isDestroyed = true;
      controller.destroy();
    }
  });
});
