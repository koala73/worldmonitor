/**
 * Premium access gating with the self-host desktop-key verdict
 * (plan 2026-11-04-001, U5 / KTD9).
 *
 * The real panel-gating, widget-store, self-host-key, premium-fetch and
 * config/panels modules are bundled together; only the account, billing,
 * storage and desktop-runtime leaves are stubbed. The free panel cap reads
 * isProUser() directly, so an unlocked self-host verdict has to reach it
 * through widget-store, not only through readPremiumAccessGrant.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Gating = typeof import('../src/services/panel-gating.ts')
  & typeof import('../src/services/widget-store.ts')
  & typeof import('../src/services/self-host-key.ts')
  & Pick<typeof import('../src/services/premium-fetch.ts'), 'premiumFetch' | '_setTestProviders'>
  & Pick<typeof import('../src/config/panels.ts'),
    'enforceFreePanelLimit' | 'countFreePanelCapUsage' | 'FREE_MAX_PANELS' | 'VARIANT_DEFAULTS' | 'getEffectivePanelConfig'>;

interface Hooks {
  authUser: { id: string; role?: string } | null;
  entitled: boolean;
  apiKey: boolean;
}

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const PREMIUM_PATH = '/api/market/v1/analyze-stock';
const REPO = resolve(import.meta.dirname, '..');

const STUBS = new Map<string, string>([
  ['@/utils', `
    export function loadFromStorage(_key, fallback) { return fallback; }
    export function saveToStorage() {}
  `],
  ['@/utils/safe-storage', `export function safeStorageGet() { return null; }`],
  ['@/utils/panel-storage', `export function clearPanelSpanEntry() {} export function clearPanelColSpanEntry() {}`],
  ['@/utils/widget-sanitizer', `export function sanitizeWidgetHtml(html) { return html; }`],
  ['@/services/auth-state', `
    export function getAuthState() { return { user: globalThis.__gating.authUser, isPending: false }; }
  `],
  ['@/services/entitlements', `
    export function isEntitled() { return globalThis.__gating.entitled; }
    export function getEntitlementState() { return null; }
  `],
  ['@/services/browser-key-session', `
    export function clearBrowserKeySession() { return Promise.resolve(true); }
    export function migrateLegacyKeysToHttpOnlySession() { return Promise.resolve({ ok: true }); }
    export function readLegacySessionKey() { return ''; }
    export function readBrowserKeySessionStatus() { return Promise.resolve(null); }
  `],
  ['@/services/runtime-config', `
    export function getSecretState(key) {
      const present = key === 'WORLDMONITOR_API_KEY' && globalThis.__gating.apiKey;
      return { present, valid: present, source: present ? 'vault' : 'missing' };
    }
    export function getRuntimeConfigSnapshot() { return { secrets: {}, featureToggles: {} }; }
  `],
  ['@/services/runtime', `export function isDesktopRuntime() { return false; }`],
  ['./runtime', `export function isDesktopRuntime() { return false; }`],
  ['@/config/desktop-runtime', `export function isDesktopRuntime() { return false; } export function hasExplicitDesktopSignals() { return false; }`],
  ['./variant', `export const SITE_VARIANT = 'full';`],
  ['@/services/clerk', `export async function getClerkToken() { return null; } export function getCurrentClerkUser() { return null; }`],
  ['@/bootstrap/sentry-defer', `export function enqueueSentryCall() {}`],
  ['./billing', `
    export function getSubscription() { return null; }
    export function openBillingPortal() {}
    export function prereserveBillingPortalTab() { return null; }
  `],
  ['./billing-state', `
    export function deriveBillingUxState() { return null; }
    export function getBillingGateOverride() { return null; }
    export function getReactivationHref() { return '/pro'; }
  `],
  ['./entitlements', `export function getEntitlementState() { return null; }`],
  ['./external-navigation', `export function openExternalUrl() { return Promise.resolve(true); }`],
  ['./runtime-config', `
    export function getSecretState(key) {
      const present = key === 'WORLDMONITOR_API_KEY' && globalThis.__gating.apiKey;
      return { present, valid: present, source: present ? 'vault' : 'missing' };
    }
  `],
]);

async function loadGating(): Promise<Gating> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-panel-gating-'));
  const outfile = join(tempDir, 'gating.bundle.mjs');
  const entry = `
    export * from '@/services/panel-gating';
    export * from '@/services/widget-store';
    export * from '@/services/self-host-key';
    export { premiumFetch, _setTestProviders } from '@/services/premium-fetch';
    export {
      enforceFreePanelLimit, countFreePanelCapUsage, FREE_MAX_PANELS, VARIANT_DEFAULTS, getEffectivePanelConfig,
    } from '@/config/panels';
  `;
  const result = await build({
    stdin: { contents: entry, resolveDir: REPO, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    tsconfig: join(REPO, 'tsconfig.json'),
    define: { 'import.meta.env': '{}' },
    plugins: [{
      name: 'gating-stubs',
      setup(api) {
        api.onResolve({ filter: /.*/ }, (args) => {
          // panel-gating imports its sibling widget-store by relative path;
          // keep that one real.
          if (args.path === './widget-store') return null;
          if (!STUBS.has(args.path)) return null;
          // './runtime-config' etc. are only stubbed when panel-gating or
          // premium-fetch imports them; the real self-host-key is never stubbed.
          return { path: args.path, namespace: 'stub' };
        });
        api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: STUBS.get(args.path) ?? '',
          loader: 'js',
        }));
      },
    }],
  });
  writeFileSync(outfile, result.outputFiles[0]!.text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as Gating;
}

function verdict(status: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ enabled: true, status, stale: false, verifiedAt: NOW, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let g: Gating;
let hooks: Hooks;
let routeReplies: Array<Response | Error>;
let routeCalls: number;
let premiumReplies: Response[];
let accessChanges: number;
let unsubscribeAccess: () => void;

function fullDefaults(): ReturnType<Gating['enforceFreePanelLimit']> {
  return Object.fromEntries(
    g.VARIANT_DEFAULTS.full!.map((key) => [key, { ...g.getEffectivePanelConfig(key, 'full') }]),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Boot the service the way the dashboard does: App.init starts it. */
async function boot(reply: Response | Error): Promise<void> {
  routeReplies.push(reply);
  g.startSelfHostKeyService();
  await settle();
}

beforeEach(async () => {
  hooks = { authUser: null, entitled: false, apiKey: false };
  (globalThis as Record<string, unknown>).__gating = hooks;
  routeReplies = [];
  routeCalls = 0;
  premiumReplies = [];
  g ??= await loadGating();
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/selfhost-key')) {
      routeCalls += 1;
      const next = routeReplies.shift();
      if (!next) throw new Error('unexpected /api/selfhost-key call');
      if (next instanceof Error) throw next;
      return next;
    }
    const next = premiumReplies.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next;
  }) as typeof fetch;
  globalThis.fetch = fakeFetch;
  g._resetSelfHostKeyForTests({
    fetch: fakeFetch,
    now: () => NOW,
    setInterval: () => 1,
    clearInterval: () => {},
    canRun: () => true,
  });
  g._setTestProviders({ getTesterKeys: () => [], getClerkToken: async () => null });
  accessChanges = 0;
  unsubscribeAccess = g.subscribeWidgetAccess(() => { accessChanges += 1; });
});

afterEach(() => {
  unsubscribeAccess();
  g._setTestProviders(null);
  g._resetSelfHostKeyForTests({ canRun: () => false });
});

describe('self-host desktop key grants Pro', () => {
  it('an active verdict grants self_host_key, makes isProUser true, lifts the 40-panel cap, and notifies once (AE1)', async () => {
    routeReplies.push(verdict('active'));
    // App.init starts the read; the verdict has not arrived yet.
    g.startSelfHostKeyService();
    const before = g.enforceFreePanelLimit(fullDefaults(), g.isProUser());
    assert.equal(g.countFreePanelCapUsage(before), g.FREE_MAX_PANELS, 'boots on the free cap');
    await settle();

    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
    assert.equal(g.hasPremiumAccess(), true);
    assert.equal(g.isProUser(), true);
    assert.equal(g.getPanelGateReason({ user: null, isPending: false }, true), g.PanelGateReason.NONE);
    assert.equal(accessChanges, 1);

    const after = g.enforceFreePanelLimit(before, g.isProUser());
    assert.ok(
      g.countFreePanelCapUsage(after) > g.FREE_MAX_PANELS,
      `cap lifted: ${g.countFreePanelCapUsage(after)} panels`,
    );
  });

  it('an invalid verdict keeps the grant at none (AE4)', async () => {
    await boot(verdict('invalid'));
    assert.equal(g.readPremiumAccessGrant(), 'none');
    assert.equal(g.isProUser(), false);
    assert.equal(accessChanges, 0);
    assert.equal(
      g.countFreePanelCapUsage(g.enforceFreePanelLimit(fullDefaults(), g.isProUser())),
      g.FREE_MAX_PANELS,
    );
  });

  it('a 404 means not self-hosted: grant none and no further calls', async () => {
    await boot(new Response('{}', { status: 404 }));
    assert.equal(g.readPremiumAccessGrant(), 'none');
    premiumReplies.push(new Response('{}', { status: 401 }));
    await g.premiumFetch(PREMIUM_PATH);
    await settle();
    assert.equal(routeCalls, 1);
  });

  it('a premium 403 re-checks the verdict and relocks on revoke (AE3)', async () => {
    await boot(verdict('active'));
    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
    accessChanges = 0;

    premiumReplies.push(new Response(JSON.stringify({ error: 'Key revoked' }), { status: 403 }));
    routeReplies.push(verdict('invalid'));
    const res = await g.premiumFetch(PREMIUM_PATH);
    assert.equal(res.status, 403, 'the denial reaches the caller unchanged');
    await settle();

    assert.equal(routeCalls, 2);
    assert.equal(g.readPremiumAccessGrant(), 'none');
    assert.equal(g.isProUser(), false);
    assert.equal(accessChanges, 1);
  });

  it('several premium 403s at once trigger one verdict check', async () => {
    await boot(verdict('active'));
    for (let i = 0; i < 4; i += 1) premiumReplies.push(new Response('{}', { status: 403 }));
    routeReplies.push(verdict('active'));
    await Promise.all([1, 2, 3, 4].map(() => g.premiumFetch(PREMIUM_PATH)));
    await settle();
    assert.equal(routeCalls, 2);
    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
  });

  it('only a premium-path 401/403 re-checks; other paths and other statuses do not', async () => {
    await boot(verdict('active'));
    premiumReplies.push(new Response('{}', { status: 401 }));
    await g.premiumFetch('https://example.test/api/economic/v1/get-fred-series-batch');
    for (const status of [200, 429, 500, 502]) {
      premiumReplies.push(new Response('{}', { status }));
      await g.premiumFetch(PREMIUM_PATH);
    }
    await settle();
    assert.equal(routeCalls, 1);
    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
  });

  it('a relay timeout is not a denial and does not re-check', async () => {
    await boot(verdict('active'));
    premiumReplies.push(new Response('{}', { status: 504, headers: { 'X-Wm-Relay-Error': 'timeout' } }));
    await g.premiumFetch(PREMIUM_PATH);
    await settle();
    assert.equal(routeCalls, 1);
    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
  });

  it('a network failure keeps the grant (AE5)', async () => {
    await boot(verdict('active'));
    routeReplies.push(new TypeError('Failed to fetch'));
    await g.refreshSelfHostKey();
    assert.equal(g.readPremiumAccessGrant(), 'self_host_key');
  });

  it('a stale active verdict over 24 hours old drops the grant', async () => {
    await boot(verdict('active', { stale: true, verifiedAt: NOW - 25 * 60 * 60 * 1000 }));
    assert.equal(g.readPremiumAccessGrant(), 'none');
    assert.equal(g.isProUser(), false);
  });

  it('keeps the existing arms ahead: the desktop API key still reports api_key', async () => {
    hooks.apiKey = true;
    await boot(verdict('active'));
    assert.equal(g.readPremiumAccessGrant(), 'api_key');
  });

  it('on worldmonitor.app the existing pro_user arm wins and only the first 404 is sent', async () => {
    hooks.entitled = true;
    await boot(new Response('{}', { status: 404 }));
    assert.equal(g.readPremiumAccessGrant(), 'pro_user');
    g.isProUser();
    g.readPremiumAccessGrant();
    await settle();
    assert.equal(routeCalls, 1);
  });
});
