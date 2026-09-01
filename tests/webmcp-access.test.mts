import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCESS_CONTEXT_PRIVACY_KEYS,
  buildWebMcpAccessContext,
  resolveWebMcpOpenSignIn,
} from '../src/services/webmcp-access-snapshot.ts';
import { FREE_TAB_CAP } from '../src/services/gates/export-resolver.ts';
import { boundWebMcpAccessContext } from '../src/services/webmcp.ts';

const FREE_MAX_PANELS = 40;

const SIGNED_OUT_AUTH = { user: null, isPending: false } as const;
const LOADING_AUTH = { user: null, isPending: true } as const;
const FREE_AUTH = {
  user: {
    id: 'user_secret_id',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: 'https://example.com/ada.png',
    role: 'free' as const,
  },
  isPending: false,
};
const PRO_AUTH = {
  ...FREE_AUTH,
  user: { ...FREE_AUTH.user, role: 'pro' as const },
};

function signedOutInput(
  overrides: Partial<Parameters<typeof buildWebMcpAccessContext>[0]> = {},
) {
  return {
    auth: SIGNED_OUT_AUTH,
    clerkEnabled: true,
    clerkReady: true,
    premiumAccess: false,
    entitlement: null,
    tabCap: { allowed: true, cap: FREE_TAB_CAP, pendingActivation: false } as const,
    enabledPanelUsed: 12,
    dashboardTabCount: 1,
    freePanelCap: FREE_MAX_PANELS,
    freeTierFallbackActive: false,
    dataExport: false,
    ...overrides,
  };
}

function assertNoPersonalInformation(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of ACCESS_CONTEXT_PRIVACY_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value as object, key),
      false,
      `access context must not expose ${key}`,
    );
  }
  assert.doesNotMatch(serialized, /ada@example\.com/i);
  assert.doesNotMatch(serialized, /Ada Lovelace/);
  assert.doesNotMatch(serialized, /user_secret_id/);
  assert.doesNotMatch(serialized, /pk_test_|sk_live_|Bearer /);
}

describe('buildWebMcpAccessContext', () => {
  it('reports signed-out, ready Clerk, anonymous tier, and free limits', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput());
    assert.equal(snapshot.accountState, 'signed_out');
    assert.equal(snapshot.clerk, 'ready');
    assert.equal(snapshot.productTier, 'anonymous');
    assert.deepEqual(snapshot.capabilities, {
      premiumAccess: false,
      apiAccess: false,
      mcpAccess: false,
      dataExport: false,
    });
    assert.deepEqual(snapshot.limits, {
      enabledPanels: { used: 12, cap: FREE_MAX_PANELS },
      dashboardTabs: { used: 1, cap: FREE_TAB_CAP, canCreate: true },
    });
    assertNoPersonalInformation(snapshot);
  });

  it('keeps loading and Clerk-unavailable states explicit', () => {
    const loading = buildWebMcpAccessContext(signedOutInput({
      auth: LOADING_AUTH,
      clerkReady: false,
    }));
    assert.equal(loading.accountState, 'loading');
    assert.equal(loading.clerk, 'loading');
    assert.equal(loading.productTier, 'unknown');
    assert.equal(loading.limits.enabledPanels.cap, null);
    assert.equal(loading.limits.dashboardTabs.cap, null);
    assert.equal(loading.limits.dashboardTabs.canCreate, true);

    const unavailable = buildWebMcpAccessContext(signedOutInput({
      clerkEnabled: false,
      clerkReady: false,
    }));
    assert.equal(unavailable.accountState, 'signed_out');
    assert.equal(unavailable.clerk, 'unavailable');
    assert.equal(unavailable.productTier, 'anonymous');
  });

  it('treats a configured Clerk that failed to load as unavailable, not loading', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      clerkEnabled: true,
      clerkReady: false,
      auth: SIGNED_OUT_AUTH,
    }));
    assert.equal(snapshot.accountState, 'signed_out');
    assert.equal(snapshot.clerk, 'unavailable');
  });

  it('derives signed-in free and pro capability from the same entitlement source as the dashboard', () => {
    const free = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
      premiumAccess: false,
      entitlement: {
        planKey: 'free',
        features: {
          tier: 0,
          apiAccess: false,
          apiRateLimit: 0,
          maxDashboards: FREE_TAB_CAP,
          prioritySupport: false,
          exportFormats: [],
          mcpAccess: false,
          dataExport: false,
        },
        validUntil: Date.now() + 60_000,
      },
      tabCap: { allowed: false, cap: FREE_TAB_CAP, reason: 'free_tier' },
      enabledPanelUsed: 40,
      dashboardTabCount: 3,
    }));
    assert.equal(free.accountState, 'signed_in');
    assert.equal(free.productTier, 'free');
    assert.equal(free.capabilities.premiumAccess, false);
    assert.equal(free.limits.enabledPanels.cap, FREE_MAX_PANELS);
    assert.equal(free.limits.dashboardTabs.canCreate, false);

    const pro = buildWebMcpAccessContext(signedOutInput({
      auth: PRO_AUTH,
      premiumAccess: true,
      entitlement: {
        planKey: 'pro',
        features: {
          tier: 1,
          apiAccess: true,
          apiRateLimit: 60,
          maxDashboards: -1,
          prioritySupport: true,
          exportFormats: ['csv', 'json', 'pdf'],
          mcpAccess: true,
          dataExport: true,
        },
        validUntil: Date.now() + 60_000,
      },
      tabCap: { allowed: true, cap: null, pendingActivation: false },
      enabledPanelUsed: 80,
      dashboardTabCount: 6,
      dataExport: true,
    }));
    assert.equal(pro.accountState, 'signed_in');
    assert.equal(pro.productTier, 'pro');
    assert.deepEqual(pro.capabilities, {
      premiumAccess: true,
      apiAccess: true,
      mcpAccess: true,
      dataExport: true,
    });
    assert.equal(pro.limits.enabledPanels.cap, null);
    assert.equal(pro.limits.dashboardTabs.cap, null);
    assert.equal(pro.limits.dashboardTabs.canCreate, true);
    assertNoPersonalInformation(free);
    assertNoPersonalInformation(pro);
  });

  it('keeps a signed-in account visible while entitlement is still unknown', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
      premiumAccess: false,
      entitlement: null,
      tabCap: { allowed: false, cap: FREE_TAB_CAP, reason: 'free_tier' },
    }));
    assert.equal(snapshot.accountState, 'signed_in');
    assert.equal(snapshot.productTier, 'unknown');
    assert.equal(snapshot.limits.enabledPanels.cap, null);
    assert.equal(snapshot.limits.dashboardTabs.cap, null);
    assert.equal(snapshot.limits.dashboardTabs.canCreate, true);
  });

  it('reports the free panel cap after the settle backstop when entitlement stays null', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
      premiumAccess: false,
      entitlement: null,
      freeTierFallbackActive: true,
      tabCap: { allowed: false, cap: FREE_TAB_CAP, reason: 'free_tier' },
    }));
    assert.equal(snapshot.accountState, 'signed_in');
    assert.equal(snapshot.productTier, 'unknown');
    assert.equal(snapshot.limits.enabledPanels.cap, FREE_MAX_PANELS);
    assert.equal(snapshot.limits.dashboardTabs.cap, null);
    assert.equal(snapshot.limits.dashboardTabs.canCreate, true);
  });

  it('keeps productTier pro when premium access is already known and entitlement is still null', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      auth: PRO_AUTH,
      premiumAccess: true,
      entitlement: null,
    }));
    assert.equal(snapshot.accountState, 'signed_in');
    assert.equal(snapshot.productTier, 'pro');
    assert.equal(snapshot.limits.enabledPanels.cap, null);
    assert.equal(snapshot.limits.dashboardTabs.cap, null);
  });

  it('takes dataExport from the reader boolean, not the entitlement feature flag', () => {
    const freeFeatures = {
      tier: 0,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: FREE_TAB_CAP,
      prioritySupport: false,
      exportFormats: [] as string[],
      mcpAccess: false,
    };
    const unlockedDespiteMissingFlag = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
      entitlement: {
        planKey: 'free',
        features: { ...freeFeatures, dataExport: false },
        validUntil: Date.now() + 60_000,
      },
      dataExport: true,
    }));
    assert.equal(unlockedDespiteMissingFlag.capabilities.dataExport, true);
    assert.equal(unlockedDespiteMissingFlag.capabilities.apiAccess, false);
    assert.equal(unlockedDespiteMissingFlag.capabilities.mcpAccess, false);

    const unlockedWhenFeatureOmitted = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
      entitlement: {
        planKey: 'free',
        features: freeFeatures,
        validUntil: Date.now() + 60_000,
      },
      dataExport: true,
    }));
    assert.equal(unlockedWhenFeatureOmitted.capabilities.dataExport, true);

    const lockedDespiteFeature = buildWebMcpAccessContext(signedOutInput({
      auth: PRO_AUTH,
      premiumAccess: true,
      entitlement: {
        planKey: 'pro',
        features: {
          tier: 1,
          apiAccess: false,
          apiRateLimit: 60,
          maxDashboards: -1,
          prioritySupport: true,
          exportFormats: ['csv', 'json', 'pdf'],
          mcpAccess: true,
          dataExport: true,
        },
        validUntil: Date.now() + 60_000,
      },
      dataExport: false,
    }));
    assert.equal(lockedDespiteFeature.capabilities.dataExport, false);
    assert.equal(lockedDespiteFeature.capabilities.mcpAccess, true);
    assert.equal(lockedDespiteFeature.capabilities.apiAccess, false);
  });

  it('never copies personal fields even when a caller tries to inject them', () => {
    const snapshot = buildWebMcpAccessContext(signedOutInput({
      auth: FREE_AUTH,
    }));
    const bounded = boundWebMcpAccessContext({
      ...snapshot,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      userId: 'user_secret_id',
      token: 'sess_abc',
      sessionId: 'sess_abc',
    } as typeof snapshot & Record<string, string>, true);
    assert.equal(snapshot.accountState, 'signed_in');
    assertNoPersonalInformation(snapshot);
    assertNoPersonalInformation(bounded);
    assert.equal(bounded.targetCancellationSupported, true);
    assert.equal(
      Object.keys(bounded).sort().join(','),
      [
        'accountState',
        'capabilities',
        'clerk',
        'limits',
        'productTier',
        'targetCancellationSupported',
      ].sort().join(','),
    );
  });
});

describe('resolveWebMcpOpenSignIn', () => {
  it('returns clerk_unavailable when Clerk is not configured or failed to load', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: false, clerkReady: false, alreadyOpen: false }),
      { ok: false, status: 'denied', reason: 'clerk_unavailable' },
    );
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: false, alreadyOpen: false, loadFailed: true }),
      { ok: false, status: 'denied', reason: 'clerk_unavailable' },
    );
  });

  it('returns already_open when the Clerk modal is already visible', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: true, alreadyOpen: true }),
      { ok: true, status: 'already_open', reason: 'already_open' },
    );
  });

  it('asks the host to open the existing Clerk modal and never accepts credentials', () => {
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: true, alreadyOpen: false }),
      { action: 'open' },
    );
    assert.deepEqual(
      resolveWebMcpOpenSignIn({ clerkEnabled: true, clerkReady: false, alreadyOpen: false }),
      { action: 'load_and_open' },
    );
  });
});
