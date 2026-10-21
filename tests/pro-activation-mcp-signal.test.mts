/**
 * #5612 — a connected MCP client counts toward the activation wizard's power
 * step, and the lookup is wired where the flow opens, not into the shared
 * strict reader that the confirm handlers also call.
 *
 * Every case drives the REAL `openProActivationFlow` with its default
 * `readContext`, so the wiring itself is under test: `listMcpClients`, the
 * channels read, the widget store and auth are stubbed at the module boundary
 * (esbuild aliases, mirroring pro-activation-alerts-blocked.test.mts). The
 * decision table for `resolveHasUsedPowerFeature` lives in
 * pro-activation-state.test.mts.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type InterstitialModule = typeof import('../src/components/ProActivationInterstitial.ts');
type ActivationModule = InterstitialModule & typeof import('../src/app/pro-activation-controller.ts');
type InterstitialOptions = Parameters<InterstitialModule['openProActivationInterstitial']>[0];

interface McpSignalState {
  __mcpUserId: string;
  __mcpAuthListeners: Array<() => void>;
  __mcpWidgets: unknown[];
  __mcpListCalls: number;
  __mcpList: () => Promise<unknown[]>;
  __mcpChannelsData: unknown;
  __mcpPushPermission: 'default' | 'granted' | 'denied';
  __mcpConfigWrites: unknown[];
}

const state = globalThis as unknown as McpSignalState;

async function loadInterstitial(): Promise<ActivationModule> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-pro-activation-mcp-'));
  const outfile = join(tempDir, 'interstitial.bundle.mjs');
  const stubs = new Map([
    ['i18n-stub', 'export function t(key) { return key; }'],
    ['auth-stub', `
      export function getAuthState() {
        return { user: { id: globalThis.__mcpUserId, email: 'pro@worldmonitor.test' }, isPending: false };
      }
      export function subscribeAuthState(listener) {
        globalThis.__mcpAuthListeners.push(listener);
        listener();
        return () => {
          globalThis.__mcpAuthListeners = globalThis.__mcpAuthListeners.filter((l) => l !== listener);
        };
      }
    `],
    ['billing-stub', `
      export function getSubscription() {
        return { activationKey: 'sub_key', activationOnboardingEligible: true,
          planKey: 'pro_monthly', currentPeriodEnd: Date.now() + 86400000 };
      }
      export function onSubscriptionChange() { return () => {}; }
      export async function claimProActivationPresentation() { return 'claimed'; }
      export async function confirmProActivationPresentation() { return true; }
      export async function openProActivationDay0Presentation() { return 'opened'; }
      export async function recordProActivationOutcome() { return true; }
    `],
    ['channels-stub', `
      export async function getChannelsData() { return globalThis.__mcpChannelsData; }
      export async function setEmailChannel() { return true; }
      export async function setNotificationConfig(config) {
        globalThis.__mcpConfigWrites.push(config);
        return true;
      }
    `],
    ['push-stub', `
      export function isWebPushSupported() { return true; }
      export function getPushPermission() { return globalThis.__mcpPushPermission; }
      export async function subscribeToPush() {
        return { endpoint: 'https://push.test/x', p256dh: 'k', auth: 'a', userAgent: 'test' };
      }
    `],
    ['insights-stub', `
      export function getServerInsights() { return null; }
      export async function fetchServerInsights() { return null; }
    `],
    ['widgets-stub', `
      export function loadWidgets() { return globalThis.__mcpWidgets; }
      export function loadWidgetsStrict() { return globalThis.__mcpWidgets; }
    `],
    ['mcp-clients-stub', `
      export function listMcpClients() {
        globalThis.__mcpListCalls += 1;
        return globalThis.__mcpList();
      }
    `],
    ['variant-stub', "export const SITE_VARIANT = 'full';"],
    ['chip-stub', 'export function showFinishSetupChipForResults() {} export function maybeShowFinishSetupChip() {}'],
    ['analytics-stub', 'export function trackProActivation() {}'],
    ['entitlements-stub', `
      export function getEntitlementState() {
        return { planKey: 'pro_monthly', validUntil: Date.now() + 86400000,
          features: { tier: 1, mcpAccess: true } };
      }
      export function hasFeature(flag) { return Boolean(getEntitlementState().features[flag]); }
      export function onEntitlementChange() { return () => {}; }
    `],
    ['sentry-stub', `
      export async function scheduleSentryInit() {}
      export function enqueueSentryCall() {}
    `],
  ]);
  const aliases = new Map([
    ['@/services/i18n', 'i18n-stub'],
    ['@/services/auth-state', 'auth-stub'],
    ['@/services/billing', 'billing-stub'],
    ['@/services/notification-channels', 'channels-stub'],
    ['@/services/push-notifications', 'push-stub'],
    ['@/services/insights-loader', 'insights-stub'],
    ['@/services/widget-store', 'widgets-stub'],
    ['@/services/mcp-clients', 'mcp-clients-stub'],
    ['@/config/variant', 'variant-stub'],
    ['@/components/ProActivationChip', 'chip-stub'],
    ['@/bootstrap/sentry-defer', 'sentry-stub'],
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/entitlements', 'entitlements-stub'],
  ]);

  const result = await build({
    stdin: {
      contents: `export * from './src/components/ProActivationInterstitial.ts';
        export { ProActivationController } from './src/app/pro-activation-controller.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'pro-activation-mcp-test-stubs',
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

  writeFileSync(outfile, result.outputFiles![0]!.text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as ActivationModule;
}

const UNUSED_CLIENT = { id: 'tok_1', name: 'Claude Desktop', createdAt: 1_700_000_000_000 };
const CONNECTED_CLIENT = { ...UNUSED_CLIENT, lastUsedAt: 1_700_000_050_000 };
const REVOKED_CLIENT = { ...CONNECTED_CLIENT, revokedAt: 1_700_000_100_000 };

function installState(input: {
  widgets?: unknown[];
  list?: () => Promise<unknown[]>;
} = {}): void {
  Object.assign(globalThis, {
    __mcpUserId: 'user_mcp',
    __mcpAuthListeners: [],
    __mcpWidgets: input.widgets ?? [],
    __mcpListCalls: 0,
    __mcpList: input.list ?? (async () => []),
    __mcpChannelsData: { channels: [], alertRules: [] },
    __mcpPushPermission: 'granted',
    __mcpConfigWrites: [],
  } satisfies McpSignalState);
}

/** Simulate a Clerk account switch: the flow owner is no longer current. */
function switchAccount(): void {
  state.__mcpUserId = 'user_other';
  for (const listener of [...state.__mcpAuthListeners]) listener();
}

const never = (): Promise<unknown[]> => new Promise(() => {});

let mod: InterstitialModule | null = null;

afterEach(() => {
  mod?.closeProActivationInterstitial();
  mod = null;
});

interface FlowRun {
  result: Awaited<ReturnType<InterstitialModule['openProActivationFlow']>>;
  captured: InterstitialOptions | null;
  claimCalls: number;
}

async function runFlow(
  cohort: 'day0' | 'retro',
  extra: { mcpClientsTimeoutMs?: number } = {},
): Promise<FlowRun> {
  mod = await loadInterstitial();
  let captured: InterstitialOptions | null = null;
  let claimCalls = 0;
  const result = await mod.openProActivationFlow(
    {
      accountUserId: 'user_mcp',
      accountEmail: 'pro@worldmonitor.test',
      isAccountCurrent: () => state.__mcpUserId === 'user_mcp',
      ...(cohort === 'retro'
        ? {
            onlyIfUnactivated: true,
            expectedActivationKey: 'sub_key',
            activationClaimNonce: 'nonce_1',
          }
        : {}),
    },
    {
      claimPresentation: async () => {
        claimCalls += 1;
        return 'claimed';
      },
      confirmPresentation: async () => true,
      openDay0Presentation: async () => 'opened',
      recordOutcome: async () => true,
      openInterstitial: (options) => {
        captured = options;
      },
      ...extra,
    },
  );
  return { result, captured, claimCalls };
}

function powerState(run: FlowRun): string | undefined {
  assert.ok(run.captured, 'the flow must open the interstitial');
  return run.captured!.steps.find((step) => step.id === 'power')?.state;
}

describe('day-0 checkout return: connected MCP client (#5612)', () => {
  it('keeps the power step confirmable for an unused token', async () => {
    installState({ list: async () => [UNUSED_CLIENT] });
    const run = await runFlow('day0');
    assert.equal(powerState(run), 'confirmable');
  });

  it('renders the power step already-done for a user with a connected client', async () => {
    // The exact #5612 scenario: free user connects Claude Desktop, then
    // upgrades. No widget exists, so only the MCP lookup can answer.
    installState({ list: async () => [CONNECTED_CLIENT] });
    const run = await runFlow('day0');

    assert.equal(run.result, 'opened');
    assert.equal(powerState(run), 'already-done');
    assert.equal(state.__mcpListCalls, 1);
  });

  it('keeps the power step confirmable when every client is revoked', async () => {
    installState({ list: async () => [REVOKED_CLIENT] });
    const run = await runFlow('day0');

    assert.equal(powerState(run), 'confirmable');
  });

  it('a stored widget answers without the network lookup', async () => {
    installState({ widgets: [{ id: 'w1' }], list: async () => [CONNECTED_CLIENT] });
    const run = await runFlow('day0');

    assert.equal(powerState(run), 'already-done');
    assert.equal(state.__mcpListCalls, 0, 'a widget hit must not pay for the MCP round trip');
  });

  it('fails open to the widget-only signal when the lookup rejects', async () => {
    installState({ list: async () => { throw new Error('convex unavailable'); } });
    const run = await runFlow('day0');

    assert.equal(run.result, 'opened', 'the post-checkout welcome must still open');
    assert.equal(powerState(run), 'confirmable');
  });

  it('fails open when the lookup times out', async () => {
    installState({ list: never });
    const run = await runFlow('day0', { mcpClientsTimeoutMs: 20 });

    assert.equal(run.result, 'opened');
    assert.equal(powerState(run), 'confirmable');
  });
});

describe('markerless retro path: connected MCP client (#5612)', () => {
  it('opens with the power step confirmable for an unused token', async () => {
    installState({ list: async () => [UNUSED_CLIENT] });
    const run = await runFlow('retro');
    assert.equal(run.result, 'opened');
    assert.equal(powerState(run), 'confirmable');
  });

  it('does not list MCP clients on a second controller boot after not-eligible', async () => {
    installState({ list: async () => [CONNECTED_CLIENT] });
    const { ProActivationController } = await loadInterstitial();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
        setTimeout,
        clearTimeout,
      },
    });
    try {
      for (let boot = 0; boot < 2; boot += 1) {
        const controller = new ProActivationController({
          isDestroyed: false, isDesktopApp: false,
        } as never, { reloadPending: false, openAiAnalyst() {} });
        try {
          controller.init();
          await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
          assert.equal(state.__mcpListCalls, 1, `boot ${boot + 1} must reuse the terminal eligibility result`);
        } finally {
          controller.destroy();
        }
      }
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('suppresses the wizard for a subscriber who already connected a client', async () => {
    // hasAnyActivatedProFunctionality counts the power signal, so the retro
    // cohort reads a connected client as "already activated".
    installState({ list: async () => [CONNECTED_CLIENT] });
    const run = await runFlow('retro');

    assert.equal(run.result, 'not-eligible');
    assert.equal(run.claimCalls, 0, 'an activated subscriber must not take the presentation lease');
    assert.equal(run.captured, null);
  });

  it('opens with the power step confirmable when there are no clients', async () => {
    installState({ list: async () => [] });
    const run = await runFlow('retro');

    assert.equal(run.result, 'opened');
    assert.equal(powerState(run), 'confirmable');
  });

  it('retries instead of fabricating "no clients" when the lookup rejects', async () => {
    installState({ list: async () => { throw new Error('convex unavailable'); } });
    const run = await runFlow('retro');

    assert.equal(run.result, 'retry');
    assert.equal(run.claimCalls, 0);
  });

  it('retries when the lookup times out', async () => {
    installState({ list: never });
    const run = await runFlow('retro', { mcpClientsTimeoutMs: 20 });

    assert.equal(run.result, 'retry');
    assert.equal(run.claimCalls, 0);
  });
});

describe('MCP lookup cancellation and scope (#5612)', () => {
  for (const cohort of ['day0', 'retro'] as const) {
    it(`${cohort}: an account switch mid-lookup stops waiting on it`, async () => {
      installState({ list: never });
      const started = Date.now();
      const pending = runFlow(cohort, { mcpClientsTimeoutMs: 30_000 });
      // Let the flow reach the pending lookup, then switch accounts.
      for (let i = 0; i < 400 && state.__mcpListCalls === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(state.__mcpListCalls, 1, 'the flow-open read must start the lookup');
      switchAccount();

      const deadline = new Promise<'deadline'>((r) => setTimeout(() => r('deadline'), 2_000));
      const outcome = await Promise.race([pending, deadline]);

      assert.notEqual(outcome, 'deadline', 'the flow must not wait out the lookup after an abort');
      assert.equal((outcome as FlowRun).result, 'retry');
      assert.ok(Date.now() - started < 2_000);
    });
  }

  it('the brief and alerts confirms never call the MCP lookup', async () => {
    installState({ list: async () => [] });
    const run = await runFlow('day0');
    const afterOpen = state.__mcpListCalls;

    // The brief confirm reads the hour <select> when the user never picked one.
    const domGlobals: Record<string, unknown> = {
      document: { getElementById: () => null },
      HTMLSelectElement: class {},
    };
    const saved = Object.keys(domGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    for (const [key, value] of Object.entries(domGlobals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    try {
      assert.equal(await run.captured!.onConfirmStep('brief'), 'verified');
      assert.equal(await run.captured!.onConfirmStep('alerts'), 'verified');
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }

    assert.equal(state.__mcpListCalls, afterOpen, 'confirm reads do not use the power signal');
    assert.ok(state.__mcpConfigWrites.length >= 1, 'the confirms must actually run their reads and writes');
    assert.equal(afterOpen, 1, 'flow open performs the one lookup');
  });
});
