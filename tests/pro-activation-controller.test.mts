import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
        if (globalThis.__activationOpenGate) await globalThis.__activationOpenGate;
        return globalThis.__activationOpenResult ?? 'opened';
      }
      export function closeProActivationInterstitial() {
        globalThis.__activationCloseCalls = (globalThis.__activationCloseCalls ?? 0) + 1;
      }
    `],
    ['chip-stub', 'export function maybeShowFinishSetupChip() {}'],
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
    __activationEntitlement: { planKey: 'free', validUntil: Date.now() + 60_000 },
    __activationEntitlementListeners: new Set<() => void>(),
    __activationSubscriptionListeners: new Set<() => void>(),
    __activationOpenedFor: [] as string[],
    __activationOpenResult: 'opened' as string,
    __activationOpenGate: null as Promise<void> | null,
    __activationCloseCalls: 0,
  });
}

/** A first-cycle Pro account eligible for the markerless cohort mount. */
function installEligibleMarkerlessAccount(userId: string): void {
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
