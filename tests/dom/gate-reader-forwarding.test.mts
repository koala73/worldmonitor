/**
 * #5813 — the gate READERS, driven for real.
 *
 * `readExportGateInputs` moved out of `panel-gating.ts` into
 * `src/services/gates/export.ts` and became module-private, because
 * `evaluateExportGate` / `evaluateTabCap` were always its only callers. That
 * removed the last thing the old guard could reach: `tests/tab-cap.test.mts`
 * used to assert the forwarding with two `assert.match` greps over
 * panel-gating's SOURCE TEXT —
 *
 *     assert.match(panelGating, /maxDashboards: entitlement\.features\.maxDashboards/);
 *     assert.match(panelGating, /export function evaluateTabCap\(/);
 *
 * — which is the source-regex wiring-guard shape this repo has been burned by
 * before (docs/solutions/logic-errors/playback-control-gated-on-a-clerk-role-
 * field-with-no-writer.md): a grep goes green on a name existing in a file and
 * never drives the decision. Re-pointing it at the new path would have carried
 * the same non-guarantee to a new address, so it is replaced here by tests that
 * call the real `evaluateTabCap` / `evaluateExportGate` against stubbed
 * reactive sources and assert the verdict.
 *
 * Teeth: drop `maxDashboards` from the reader and the resolver receives
 * `undefined`, fails `Number.isFinite`, and returns UNCAPPED — so the two cap
 * cases below go red. Same for `dataExport`, `gateActive` and
 * `desktopKeyPresent`: each has a case whose verdict flips if the field stops
 * being forwarded.
 *
 * Lives under `tests/dom/` rather than beside the pure-resolver suites because
 * the reader pulls the reactive import graph (entitlements → convex-client →
 * clerk), which `tsx --test` cannot transform.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@/services/auth-state';
import type { SubscriptionInfo } from '@/services/billing';
import type { EntitlementState } from '@/services/entitlements';

/** Mutable stand-ins for the reactive sources the reader snapshots. */
let entitlement: EntitlementState | null = null;
let subscription: SubscriptionInfo | null = null;
let desktopKeyPresent = false;
let gateActive = true;

vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  getEntitlementState: () => entitlement,
}));

// Mutable so the suite can prove the reader forwards billing evidence rather
// than only exercising the generic free-tier path.
vi.mock('@/services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing')>()),
  getSubscription: () => subscription,
}));

vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/runtime-config')>()),
  getSecretState: () => ({
    present: desktopKeyPresent,
    valid: desktopKeyPresent,
    source: desktopKeyPresent ? ('env' as const) : ('missing' as const),
  }),
}));

// Partial on purpose: `resolveExportGate` / `resolveTabCap` must stay REAL —
// they are the half of the chain these tests are proving the reader feeds.
vi.mock('@/services/gates/export-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/gates/export-resolver')>()),
  isExportGateActive: () => gateActive,
}));

const { evaluateAvailableExportFormats, evaluateExportGate, evaluateTabCap } = await import(
  '@/services/gates/export'
);

const SIGNED_IN: AuthSession = {
  isPending: false,
  user: { id: 'user_1' },
} as unknown as AuthSession;

const SIGNED_OUT: AuthSession = { isPending: false, user: null } as unknown as AuthSession;
const AUTH_PENDING: AuthSession = { isPending: true, user: null } as unknown as AuthSession;

/** A loaded snapshot whose catalog fields the reader must forward verbatim. */
function snapshot(features: Partial<EntitlementState['features']> = {}): EntitlementState {
  return {
    planKey: 'pro',
    validUntil: Date.now() + 86_400_000,
    features: {
      tier: 0,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: [],
      dataExport: false,
      ...features,
    },
  } as unknown as EntitlementState;
}

beforeEach(() => {
  entitlement = null;
  subscription = null;
  desktopKeyPresent = false;
  gateActive = true;
});

describe('evaluateTabCap — the reader forwards the dashboard allowance', () => {
  it('caps at the snapshot allowance, not at the free default', () => {
    // The allowance is deliberately NOT 3 (FREE_TAB_CAP): a reader that
    // dropped the field would fall through to UNCAPPED, and one that hardcoded
    // the free cap would deny here instead of allowing.
    entitlement = snapshot({ tier: 1, maxDashboards: 7 });

    expect(evaluateTabCap(SIGNED_IN, 6)).toEqual({
      allowed: true,
      cap: 7,
      pendingActivation: false,
    });
  });

  it('denies at the snapshot allowance with the upgrade reason', () => {
    entitlement = snapshot({ tier: 1, maxDashboards: 7 });

    expect(evaluateTabCap(SIGNED_IN, 7)).toEqual({
      allowed: false,
      cap: 7,
      reason: 'free_tier',
    });
  });

  it("honours the catalog's -1 unlimited sentinel", () => {
    entitlement = snapshot({ tier: 2, maxDashboards: -1 });

    expect(evaluateTabCap(SIGNED_IN, 50)).toEqual({
      allowed: true,
      cap: null,
      pendingActivation: false,
    });
  });

  it('forwards the desktop API key, which outranks any allowance', () => {
    entitlement = snapshot({ tier: 0, maxDashboards: 1 });
    desktopKeyPresent = true;

    expect(evaluateTabCap(SIGNED_IN, 99)).toEqual({
      allowed: true,
      cap: null,
      pendingActivation: false,
    });
  });

  it('forwards authPending — a still-resolving session is an unknown, never capped', () => {
    // A reader that hardcoded authPending:false would fall through to the
    // signed-out branch and cap a subscriber mid-hydration at the free 3.
    expect(evaluateTabCap(AUTH_PENDING, 99)).toEqual({
      allowed: true,
      cap: null,
      pendingActivation: false,
    });
  });

  it('leaves a settled signed-in session uncapped while its snapshot is missing', () => {
    expect(evaluateTabCap(SIGNED_IN, 99)).toEqual({
      allowed: true,
      cap: null,
      pendingActivation: false,
    });
  });

  it('forwards signedIn — an anonymous session gets the free cap, not the snapshot one', () => {
    // Deliberately paired with a loaded 25-dashboard snapshot: a reader that
    // hardcoded signedIn:true would read that allowance for a signed-out
    // visitor instead of denying at FREE_TAB_CAP.
    entitlement = snapshot({ tier: 2, maxDashboards: 25 });

    expect(evaluateTabCap(SIGNED_OUT, 3)).toEqual({
      allowed: false,
      cap: 3,
      reason: 'anonymous',
    });
  });
});

describe('evaluateExportGate — the reader forwards the entitlement + activation fields', () => {
  it('leaves a settled signed-in session unlocked while its snapshot is missing', () => {
    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: false,
      pendingActivation: false,
    });
  });

  it('unlocks on an explicit dataExport grant', () => {
    entitlement = snapshot({ tier: 2, dataExport: true });

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: false,
      pendingActivation: false,
    });
  });

  it('forwards tier for the legacy missing-dataExport fail-open', () => {
    entitlement = snapshot({ tier: 2, dataExport: undefined });

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: false,
      pendingActivation: false,
    });
  });

  it('keeps the legacy missing-dataExport fail-open bounded to tier 2+', () => {
    entitlement = snapshot({ tier: 1, dataExport: undefined });

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: true,
      reason: 'free_tier',
    });
  });

  it('forwards billing evidence into the denial reason', () => {
    entitlement = snapshot({ tier: 0, dataExport: false });
    subscription = {
      planKey: 'pro',
      displayName: 'Pro',
      status: 'on_hold',
      currentPeriodEnd: Date.now() + 86_400_000,
      renewalVerificationState: null,
    };

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: true,
      reason: 'payment_on_hold',
    });
  });

  it('locks on an explicit dataExport denial', () => {
    entitlement = snapshot({ tier: 0, dataExport: false });

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: true,
      reason: 'free_tier',
    });
  });

  it('forwards the catalog activation flag — an inactive gate never bites', () => {
    // Same denial as above; only `isExportGateActive()` differs. A reader that
    // stopped forwarding `gateActive` would lock a user the catalog cannot yet
    // sell an upgrade to.
    entitlement = snapshot({ tier: 0, dataExport: false });
    gateActive = false;

    expect(evaluateExportGate(SIGNED_IN)).toEqual({
      locked: false,
      pendingActivation: true,
    });
  });
});

describe('evaluateAvailableExportFormats — the reader forwards format capability', () => {
  it('exposes only declared supported formats from the loaded snapshot', () => {
    entitlement = snapshot({
      tier: 2,
      dataExport: true,
      exportFormats: ['pdf', 'csv', 'xlsx'],
    });

    expect(evaluateAvailableExportFormats(SIGNED_IN)).toEqual(['csv', 'pdf']);
  });
});
