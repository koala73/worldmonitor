/**
 * Unit tests for the pure Pro-activation-onboarding decision core.
 *
 * Mirrors tests/billing-state.test.mts: the module under test is a zero-import
 * leaf, so it stays importable under `tsx --test` (no jsdom, no Vite globals).
 * Covers the mount flowchart (R1/R2/R3/R12), the read-time plan-identity rule
 * and the #5494 "one snapshot still settling" race, the marker/fire-once/chip
 * records (TTL + versioned keys), the step model (R15/AE6), the exit summary,
 * the finish-setup chip, and telemetry event selection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DODO_PRODUCTS } from '@/config/products.generated';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import {
  decideActivationMount,
  computePendingMarker,
  parsePendingMarker,
  parseFireOnceRecord,
  parseChipDismissal,
  isPendingMarkerExpired,
  isProProductId,
  isProPlanKey,
  deriveActivationAccountKey,
  deriveSubscriptionKey,
  isFireOnceActive,
  computeFireOnceRecord,
  fireOnceStorageKey,
  readScopedFireOnceRecord,
  writeScopedFireOnceRecord,
  buildActivationSteps,
  hasAnyActivatedProFunctionality,
  buildBriefDigestPayload,
  buildCriticalAlertsPayload,
  DEFAULT_DIGEST_HOUR,
  buildExitSummary,
  buildActivationOutcomeBuckets,
  ACTIVATION_FLOW_RETRY_DELAYS_MS,
  activationFlowRetryDelay,
  summarizeActivationExit,
  shouldShowFinishSetupChip,
  computeFinishSetupChipDismissal,
  isChipDismissed,
  computeMountClaim,
  parseMountClaim,
  isMountClaimBlocking,
  selectAdvanceOutcome,
  selectConfirmOutcome,
  selectStepEvent,
  shouldReportPushSubscribeFailure,
  ACTIVATION_EVENTS,
  PRO_PRODUCT_IDS,
  PRO_PLAN_KEYS,
  PENDING_MARKER_KEY,
  PENDING_MARKER_TTL_MS,
  FIRE_ONCE_KEY,
  FIRE_ONCE_TTL_MS,
  FINISH_SETUP_CHIP_DISMISS_KEY,
  FINISH_SETUP_CHIP_DISMISS_TTL_MS,
  MOUNT_CLAIM_KEY,
  MOUNT_CLAIM_TTL_MS,
  type PendingOnboardingMarker,
  type FireOnceRecord,
  type ActivationEntitlementSnapshot,
  type ActivationSubscriptionSnapshot,
  type ActivationMountInput,
  type ActivationExistingConfig,
  type ActivationPlatformCapabilities,
  type ActivationStepResult,
} from '@/services/pro-activation-state';

const NOW = 1_800_000_000_000; // fixed epoch ms
const DAY = 86_400_000;

const USER_A = 'user_2abcAAA';
const USER_B = 'user_2defBBB';
const ACCOUNT_A = deriveActivationAccountKey(USER_A)!;
const ACCOUNT_B = deriveActivationAccountKey(USER_B)!;

const PRO_ID = DODO_PRODUCTS.PRO_MONTHLY;
const PRO_ANNUAL_ID = DODO_PRODUCTS.PRO_ANNUAL;
const PRO_BUSINESS_ID = DODO_PRODUCTS.PRO_BUSINESS_MONTHLY;
const PRO_BUSINESS_ANNUAL_ID = DODO_PRODUCTS.PRO_BUSINESS_ANNUAL;
const API_STARTER_ID = DODO_PRODUCTS.API_STARTER_MONTHLY;
const API_STARTER_ANNUAL_ID = DODO_PRODUCTS.API_STARTER_ANNUAL;
const ENTERPRISE_ID = DODO_PRODUCTS.ENTERPRISE;

function marker(overrides: Partial<PendingOnboardingMarker> = {}): PendingOnboardingMarker {
  return { productId: PRO_ID, createdAt: NOW, ...overrides };
}

function ent(overrides: Partial<ActivationEntitlementSnapshot> = {}): ActivationEntitlementSnapshot {
  return { planKey: 'pro_monthly', validUntil: NOW + 30 * DAY, ...overrides };
}

function sub(
  overrides: Partial<ActivationSubscriptionSnapshot> = {},
): ActivationSubscriptionSnapshot {
  return {
    activationKey: 'sub_live_1',
    planKey: 'pro_monthly',
    currentPeriodEnd: NOW + 30 * DAY,
    activationOnboardingEligible: true,
    ...overrides,
  };
}

function fireOnce(overrides: Partial<FireOnceRecord> = {}): FireOnceRecord {
  return { subscriptionKey: 'sub_live_1', shownAt: NOW, ...overrides };
}

function createMemoryStorage(
  values: Map<string, string>,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function mountInput(overrides: Partial<ActivationMountInput> = {}): ActivationMountInput {
  return {
    marker: marker(),
    entitlement: ent(),
    subscription: sub(),
    fireOnce: null,
    isDesktop: false,
    authPending: false,
    currentAccountKey: ACCOUNT_A,
    now: NOW,
    ...overrides,
  };
}

describe('decideActivationMount — happy path & mount gate', () => {
  it('marker(Pro) + live Pro entitlement + subscription + no fire-once = mount', () => {
    const d = decideActivationMount(mountInput());
    assert.equal(d.action, 'mount');
    assert.equal(d.action === 'mount' ? d.subscriptionKey : null, 'sub_live_1');
  });

  it('no marker + first-cycle unactivated eligibility mounts the cohort fallback', () => {
    const d = decideActivationMount(mountInput({ marker: null }));
    assert.equal(d.action, 'mount');
    assert.equal(d.action === 'mount' ? d.onlyIfUnactivated : null, true);
  });

  it('no marker + eligible annual subscription mounts throughout its first billing cycle', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        entitlement: ent({
          planKey: 'pro_annual',
          validUntil: NOW + 365 * DAY,
        }),
        subscription: sub({
          planKey: 'pro_annual',
          currentPeriodEnd: NOW + 365 * DAY,
        }),
      }),
    );
    assert.equal(d.action, 'mount');
    assert.equal(d.action === 'mount' ? d.onlyIfUnactivated : null, true);
  });

  it('no marker + ineligible subscription = none', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        subscription: sub({ activationOnboardingEligible: false }),
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + mixed-deploy subscription without eligibility = none', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        subscription: sub({ activationOnboardingEligible: undefined }),
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + pending auth keeps the markerless decision retryable', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        authPending: true,
        currentAccountKey: null,
        entitlement: null,
        subscription: null,
      }),
    );
    assert.equal(d.action, 'keep');
  });

  it('no marker + settled signed-out visitor = none', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        currentAccountKey: null,
        entitlement: null,
        subscription: null,
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + settled free account without a subscription = none', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        entitlement: ent({ planKey: 'free', validUntil: 0 }),
        subscription: null,
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + first-cycle cohort waits for the live Pro entitlement', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        entitlement: ent({ planKey: 'free', validUntil: 0 }),
      }),
    );
    assert.equal(d.action, 'keep');
  });

  it('no marker + already-shown subscription = none', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        fireOnce: fireOnce(),
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + desktop platform = none (R12 applies to the markerless cohort too)', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        isDesktop: true,
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('no marker + entitlement not yet loaded keeps the markerless decision retryable', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        entitlement: null,
      }),
    );
    assert.equal(d.action, 'keep');
  });

  it('no marker + live entitlement whose subscription snapshot has not loaded yet = keep', () => {
    const d = decideActivationMount(
      mountInput({
        marker: null,
        subscription: null,
      }),
    );
    assert.equal(d.action, 'keep');
  });

  it('desktop platform flag never mounts, even with a fully valid marker (R12)', () => {
    assert.equal(decideActivationMount(mountInput({ isDesktop: true })).action, 'clear');
  });

  it('expired marker (past TTL) clears, never mounts', () => {
    const stale = marker({ createdAt: NOW - PENDING_MARKER_TTL_MS - 1 });
    assert.equal(decideActivationMount(mountInput({ marker: stale })).action, 'clear');
  });
});

describe('decideActivationMount — plan identity allowlist (R1)', () => {
  it('api_starter product id clears, never mounts', () => {
    const d = decideActivationMount(mountInput({ marker: marker({ productId: API_STARTER_ID }) }));
    assert.equal(d.action, 'clear');
  });

  it('api_starter_annual product id clears (allowlist regression — non-Pro)', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ productId: API_STARTER_ANNUAL_ID }) }),
    );
    assert.equal(d.action, 'clear');
  });

  it('enterprise product id clears (allowlist regression — non-Pro non-starter)', () => {
    const d = decideActivationMount(mountInput({ marker: marker({ productId: ENTERPRISE_ID }) }));
    assert.equal(d.action, 'clear');
  });

  it('unknown product id clears (allowlist: anything not the two Pro ids is non-Pro)', () => {
    const d = decideActivationMount(mountInput({ marker: marker({ productId: 'pdt_unknown' }) }));
    assert.equal(d.action, 'clear');
  });

  it('Pro annual product id mounts', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ productId: PRO_ANNUAL_ID }), entitlement: ent({ planKey: 'pro_annual' }) }),
    );
    assert.equal(d.action, 'mount');
  });
});

describe('decideActivationMount — read-time identity fallback (KTD2)', () => {
  it('marker without productId + live Pro entitlement mounts (classify from live snapshot)', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ productId: undefined }), entitlement: ent() }),
    );
    assert.equal(d.action, 'mount');
  });

  it('marker without productId + entitlement still settling (null) = keep (retry later, never clear)', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ productId: undefined }), entitlement: null }),
    );
    assert.equal(d.action, 'keep');
  });

  it('marker without productId + loaded free entitlement = keep, NOT clear (pre-transition settling race)', () => {
    // A pre-auth/pre-webhook `free` snapshot must not clear a real Pro
    // subscriber's marker. Only the authoritative productId path clears
    // non-Pro; the entitlement fallback only ever mounts or keeps.
    const d = decideActivationMount(
      mountInput({ marker: marker({ productId: undefined }), entitlement: ent({ planKey: 'free', validUntil: 0 }) }),
    );
    assert.equal(d.action, 'keep');
  });
});

describe('decideActivationMount — snapshot settling race (#5494)', () => {
  it('entitlement present but subscription snapshot absent = keep (still settling), never mount', () => {
    const d = decideActivationMount(mountInput({ subscription: null }));
    assert.equal(d.action, 'keep');
  });

  it('subscription present but entitlement snapshot absent = keep (still settling), never mount', () => {
    const d = decideActivationMount(mountInput({ entitlement: null }));
    assert.equal(d.action, 'keep');
  });

  it('Pro marker but entitlement loaded not-yet-live (still free) = keep (wait for unlock, R2)', () => {
    const d = decideActivationMount(
      mountInput({ entitlement: ent({ planKey: 'free', validUntil: 0 }) }),
    );
    assert.equal(d.action, 'keep');
  });

  it('subscription snapshot present but unkeyable (no id, no period-start) = keep', () => {
    const d = decideActivationMount(
      mountInput({ subscription: { activationKey: null } }),
    );
    assert.equal(d.action, 'keep');
  });

  it('Pro planKey but validUntil already in the past = keep (never mount, never clear)', () => {
    const d = decideActivationMount(
      mountInput({ entitlement: ent({ planKey: 'pro_monthly', validUntil: NOW - DAY }) }),
    );
    assert.equal(d.action, 'keep');
  });
});

describe('decideActivationMount — fire-once per subscription (R3)', () => {
  it('fire-once record for the same subscription id suppresses (clear, no re-mount)', () => {
    const d = decideActivationMount(mountInput({ fireOnce: fireOnce({ subscriptionKey: 'sub_live_1' }) }));
    assert.equal(d.action, 'clear');
  });

  it('fire-once for a DIFFERENT subscription id re-offers onboarding (win-back mounts)', () => {
    const d = decideActivationMount(
      mountInput({
        subscription: sub({ activationKey: 'sub_winback_2' }),
        fireOnce: fireOnce({ subscriptionKey: 'sub_live_1' }),
      }),
    );
    assert.equal(d.action, 'mount');
    assert.equal(d.action === 'mount' ? d.subscriptionKey : null, 'sub_winback_2');
  });

  it('expired fire-once record (past TTL) no longer suppresses — re-offers', () => {
    const stale = fireOnce({ subscriptionKey: 'sub_live_1', shownAt: NOW - FIRE_ONCE_TTL_MS - 1 });
    const d = decideActivationMount(mountInput({ fireOnce: stale }));
    assert.equal(d.action, 'mount');
  });

});

describe('decideActivationMount — cross-account marker identity (#6)', () => {
  it('marker without an account key waits for a resolved account instead of mounting anonymously', () => {
    assert.equal(
      decideActivationMount(mountInput({ marker: marker(), currentAccountKey: ACCOUNT_A })).action,
      'mount',
    );
    assert.equal(
      decideActivationMount(mountInput({ marker: marker(), currentAccountKey: null })).action,
      'keep',
    );
  });

  it('marker with the same opaque account key mounts', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ accountKey: ACCOUNT_A }), currentAccountKey: ACCOUNT_A }),
    );
    assert.equal(d.action, 'mount');
  });

  it('scoped marker + auth still settling = keep, never mount/clear', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ accountKey: ACCOUNT_A }), currentAccountKey: null }),
    );
    assert.equal(d.action, 'keep');
  });

  it('a different account keeps the foreign marker for the buyer to revisit', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ accountKey: ACCOUNT_A }), currentAccountKey: ACCOUNT_B }),
    );
    assert.equal(d.action, 'keep');
  });

  it('foreign-user identity gate precedes plan classification (a Pro marker for user A does not mount for user B)', () => {
    const d = decideActivationMount(
      mountInput({
        marker: marker({ productId: PRO_ID, accountKey: ACCOUNT_A }),
        entitlement: ent(),
        subscription: sub(),
        currentAccountKey: ACCOUNT_B,
      }),
    );
    assert.equal(d.action, 'keep');
  });

  it('desktop + scoped marker still clears (desktop precedes the identity gate, R12)', () => {
    const d = decideActivationMount(
      mountInput({
        marker: marker({ accountKey: ACCOUNT_A }),
        currentAccountKey: ACCOUNT_B,
        isDesktop: true,
      }),
    );
    assert.equal(d.action, 'clear');
  });

  it('expired + foreign account marker still clears (TTL precedes the identity gate)', () => {
    const stale = marker({
      accountKey: ACCOUNT_A,
      createdAt: NOW - PENDING_MARKER_TTL_MS - 1,
    });
    const d = decideActivationMount(mountInput({ marker: stale, currentAccountKey: ACCOUNT_B }));
    assert.equal(d.action, 'clear');
  });
});

describe('decideActivationMount — boundaries', () => {
  it('entitlement validUntil exactly now counts as live', () => {
    const d = decideActivationMount(mountInput({ entitlement: ent({ validUntil: NOW }) }));
    assert.equal(d.action, 'mount');
  });

  it('marker created exactly TTL ago is NOT expired (inclusive boundary) and proceeds', () => {
    const edge = marker({ createdAt: NOW - PENDING_MARKER_TTL_MS });
    assert.equal(decideActivationMount(mountInput({ marker: edge })).action, 'mount');
  });
});

describe('pending marker record + TTL (KTD1)', () => {
  it('computePendingMarker carries the productId and createdAt', () => {
    assert.deepEqual(computePendingMarker(PRO_ID, null, NOW), { productId: PRO_ID, createdAt: NOW });
  });

  it('computePendingMarker omits productId when the checkout attempt is unknown', () => {
    const m = computePendingMarker(null, null, NOW);
    assert.equal(m.createdAt, NOW);
    assert.equal(m.productId, undefined);
    assert.equal('productId' in m, false);
  });

  it('computePendingMarker embeds only the opaque account key when signed in', () => {
    assert.deepEqual(computePendingMarker(PRO_ID, ACCOUNT_A, NOW), {
      productId: PRO_ID,
      accountKey: ACCOUNT_A,
      createdAt: NOW,
    });
    const anon = computePendingMarker(PRO_ID, null, NOW);
    assert.equal('accountKey' in anon, false);
  });

  it('isPendingMarkerExpired: fresh false, past-TTL true, exactly-TTL false (inclusive)', () => {
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW }), NOW), false);
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW - PENDING_MARKER_TTL_MS }), NOW), false);
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW - PENDING_MARKER_TTL_MS - 1 }), NOW), true);
  });
});

describe('plan classification helpers (allowlist)', () => {
  it('isProProductId: only the Pro / Pro Business product ids are Pro', () => {
    assert.equal(isProProductId(PRO_ID), true);
    assert.equal(isProProductId(PRO_ANNUAL_ID), true);
    assert.equal(isProProductId(PRO_BUSINESS_ID), true);
    assert.equal(isProProductId(PRO_BUSINESS_ANNUAL_ID), true);
    assert.equal(isProProductId(API_STARTER_ID), false);
    assert.equal(isProProductId(ENTERPRISE_ID), false);
    assert.equal(isProProductId('pdt_unknown'), false);
  });

  it('isProPlanKey: only the pro / pro_business plan keys are Pro', () => {
    assert.equal(isProPlanKey('pro_monthly'), true);
    assert.equal(isProPlanKey('pro_annual'), true);
    assert.equal(isProPlanKey('pro_business_monthly'), true);
    assert.equal(isProPlanKey('pro_business_annual'), true);
    assert.equal(isProPlanKey('free'), false);
    assert.equal(isProPlanKey('api_starter'), false);
    assert.equal(isProPlanKey('enterprise'), false);
  });

  it('PRO_PRODUCT_IDS stays in sync with the generated catalog (drift guard)', () => {
    assert.deepEqual(
      [...PRO_PRODUCT_IDS].sort(),
      [
        DODO_PRODUCTS.PRO_MONTHLY,
        DODO_PRODUCTS.PRO_ANNUAL,
        DODO_PRODUCTS.PRO_BUSINESS_MONTHLY,
        DODO_PRODUCTS.PRO_BUSINESS_ANNUAL,
      ].sort(),
    );
  });

  it('PRO_PLAN_KEYS stays in sync with the catalog\'s pro-family tierGroups (drift guard)', () => {
    // Pro Business gets the Pro day-0 activation lifecycle (KTD9), so the
    // allowlist tracks BOTH pro-family tier groups — not tierGroup === 'pro'.
    const catalogProPlanKeys = Object.values(PRODUCT_CATALOG)
      .filter((e) => e.tierGroup === 'pro' || e.tierGroup === 'pro_business')
      .map((e) => e.planKey)
      .sort();
    assert.deepEqual([...PRO_PLAN_KEYS].sort(), catalogProPlanKeys);
  });
});

describe('deriveSubscriptionKey (fire-once identity)', () => {
  it('uses the opaque server-generated activation key', () => {
    assert.equal(deriveSubscriptionKey({ activationKey: 'sub_x' }), 'sub_x');
  });

  it('returns null when nothing identifies the subscription yet', () => {
    assert.equal(deriveSubscriptionKey({ activationKey: null }), null);
    assert.equal(deriveSubscriptionKey(null), null);
  });
});

describe('fire-once record + TTL (KTD4)', () => {
  it('computeFireOnceRecord captures the subscription key and shown time', () => {
    assert.deepEqual(computeFireOnceRecord('sub_x', NOW), {
      subscriptionKey: 'sub_x',
      shownAt: NOW,
    });
  });

  it('computeFireOnceRecord never persists a raw account id', () => {
    assert.equal('userId' in computeFireOnceRecord('sub_x', NOW), false);
  });

  it('isFireOnceActive: fresh true, expired false, null false', () => {
    assert.equal(isFireOnceActive(fireOnce({ shownAt: NOW }), NOW), true);
    assert.equal(isFireOnceActive(fireOnce({ shownAt: NOW - FIRE_ONCE_TTL_MS - 1 }), NOW), false);
    assert.equal(isFireOnceActive(null, NOW), false);
  });

  it('scopes storage independently for each opaque account key', () => {
    assert.notEqual(fireOnceStorageKey(ACCOUNT_A), fireOnceStorageKey(ACCOUNT_B));
    assert.equal(fireOnceStorageKey(ACCOUNT_A), `${FIRE_ONCE_KEY}:${ACCOUNT_A}`);
  });

  it('migrates legacy state once and preserves independent A-to-B-to-A records', () => {
    const values = new Map<string, string>([
      [FIRE_ONCE_KEY, JSON.stringify(fireOnce({ subscriptionKey: 'sub-a' }))],
    ]);
    const storage = createMemoryStorage(values);

    assert.equal(
      readScopedFireOnceRecord(storage, ACCOUNT_A, 'sub-a', NOW)?.subscriptionKey,
      'sub-a',
    );
    assert.equal(values.has(FIRE_ONCE_KEY), false);
    assert.equal(
      writeScopedFireOnceRecord(storage, ACCOUNT_B, fireOnce({ subscriptionKey: 'sub-b' })),
      true,
    );
    assert.equal(
      readScopedFireOnceRecord(storage, ACCOUNT_B, 'sub-b', NOW)?.subscriptionKey,
      'sub-b',
    );
    assert.equal(
      readScopedFireOnceRecord(storage, ACCOUNT_A, 'sub-a', NOW)?.subscriptionKey,
      'sub-a',
    );
  });

  it('leaves a legacy record for its owning account when another account evaluates first', () => {
    const values = new Map<string, string>([
      [FIRE_ONCE_KEY, JSON.stringify(fireOnce({ subscriptionKey: 'sub-a' }))],
    ]);
    const storage = createMemoryStorage(values);

    assert.equal(readScopedFireOnceRecord(storage, ACCOUNT_B, 'sub-b', NOW), null);
    assert.equal(values.has(FIRE_ONCE_KEY), true);
    assert.equal(values.has(fireOnceStorageKey(ACCOUNT_B)), false);

    assert.equal(
      readScopedFireOnceRecord(storage, ACCOUNT_A, 'sub-a', NOW)?.subscriptionKey,
      'sub-a',
    );
    assert.equal(values.has(FIRE_ONCE_KEY), false);
  });

  it('expires only the current account record and fails closed on storage errors', () => {
    const values = new Map<string, string>([
      [
        fireOnceStorageKey(ACCOUNT_A),
        JSON.stringify(fireOnce({ shownAt: NOW - FIRE_ONCE_TTL_MS - 1 })),
      ],
      [fireOnceStorageKey(ACCOUNT_B), JSON.stringify(fireOnce({ subscriptionKey: 'sub-b' }))],
    ]);
    const storage = createMemoryStorage(values);
    assert.equal(readScopedFireOnceRecord(storage, ACCOUNT_A, 'sub-a', NOW), null);
    assert.equal(values.has(fireOnceStorageKey(ACCOUNT_A)), false);
    assert.equal(values.has(fireOnceStorageKey(ACCOUNT_B)), true);

    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    assert.equal(readScopedFireOnceRecord(denied, ACCOUNT_A, 'sub-a', NOW), null);
    assert.equal(writeScopedFireOnceRecord(denied, ACCOUNT_A, fireOnce()), false);
  });
});

function caps(overrides: Partial<ActivationPlatformCapabilities> = {}): ActivationPlatformCapabilities {
  return { webPushSupported: true, pushPermission: 'default', ...overrides };
}

function config(overrides: Partial<ActivationExistingConfig> = {}): ActivationExistingConfig {
  return {
    hasVerifiedEmailChannel: false,
    hasEmailDelivery: false,
    hasEnabledDigestRule: false,
    hasTunedDigestHour: false,
    hasWebPushChannel: false,
    hasWebPushDelivery: false,
    hasUsedPowerFeature: false,
    ...overrides,
  };
}

describe('buildActivationSteps — step model (R15/AE6)', () => {
  it('orders steps [brief, alerts, power] when push is supported', () => {
    const steps = buildActivationSteps(caps(), config());
    assert.deepEqual(steps.map((s) => s.id), ['brief', 'alerts', 'power']);
  });

  it('omits the alerts step entirely when web push is unsupported', () => {
    const steps = buildActivationSteps(caps({ webPushSupported: false }), config());
    assert.deepEqual(steps.map((s) => s.id), ['brief', 'power']);
  });

  it('alerts is blocked when push permission is pre-denied', () => {
    const steps = buildActivationSteps(caps({ pushPermission: 'denied' }), config());
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'blocked');
  });

  it('alerts is already-done when the current-variant rule delivers to web push', () => {
    const steps = buildActivationSteps(caps(), config({ hasWebPushDelivery: true }));
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'already-done');
  });

  it('alerts stays confirmable when a web-push row exists but the rule does not use it', () => {
    const steps = buildActivationSteps(caps(), config({ hasWebPushChannel: true }));
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'confirmable');
  });

  it('alerts is confirmable with default permission and no existing channel', () => {
    const steps = buildActivationSteps(caps(), config());
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'confirmable');
  });

  it('brief already-done when an enabled digest rule + verified channel exist', () => {
    const steps = buildActivationSteps(
      caps(),
      config({
        hasEnabledDigestRule: true,
        hasVerifiedEmailChannel: true,
        hasEmailDelivery: true,
      }),
    );
    assert.equal(steps.find((s) => s.id === 'brief')?.state, 'already-done');
  });

  it('brief already-done with tuned digestHour preserves their schedule (AE6, never overwrite)', () => {
    const brief = buildActivationSteps(
      caps(),
      config({
        hasEnabledDigestRule: true,
        hasVerifiedEmailChannel: true,
        hasEmailDelivery: true,
        hasTunedDigestHour: true,
      }),
    ).find((s) => s.id === 'brief');
    assert.equal(brief?.state, 'already-done');
    assert.equal(brief?.preservesSchedule, true);
  });

  it('brief is confirmable when the digest rule has no verified delivery channel', () => {
    const steps = buildActivationSteps(
      caps(),
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: false }),
    );
    assert.equal(steps.find((s) => s.id === 'brief')?.state, 'confirmable');
  });

  it('brief stays confirmable when a verified email row exists but the rule does not use it', () => {
    const steps = buildActivationSteps(
      caps(),
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: true }),
    );
    assert.equal(steps.find((s) => s.id === 'brief')?.state, 'confirmable');
  });

  it('power already-done when a power feature has been used; confirmable otherwise', () => {
    const on = buildActivationSteps(caps(), config({ hasUsedPowerFeature: true }));
    assert.equal(on.find((s) => s.id === 'power')?.state, 'already-done');
    const off = buildActivationSteps(caps(), config());
    assert.equal(off.find((s) => s.id === 'power')?.state, 'confirmable');
  });

  it('fully-configured returning subscriber: every step already-done (still surfaced once)', () => {
    // Documented policy: the mount decision is independent of step state, so a
    // fully-configured returning subscriber still mounts once (fire-once
    // bounded) and sees an all-verified summary. The step model faithfully
    // reports every step as already-done here.
    const steps = buildActivationSteps(
      caps(),
      config({
        hasVerifiedEmailChannel: true,
        hasEmailDelivery: true,
        hasEnabledDigestRule: true,
        hasTunedDigestHour: true,
        hasWebPushChannel: true,
        hasWebPushDelivery: true,
        hasUsedPowerFeature: true,
      }),
    );
    assert.deepEqual(steps.map((s) => s.state), ['already-done', 'already-done', 'already-done']);
  });
});

describe('hasAnyActivatedProFunctionality — cohort suppression', () => {
  it('returns false when none of the onboarding targets is active', () => {
    assert.equal(hasAnyActivatedProFunctionality(config()), false);
  });

  it('returns true for an active email brief', () => {
    assert.equal(
      hasAnyActivatedProFunctionality(
        config({ hasEnabledDigestRule: true, hasEmailDelivery: true }),
      ),
      true,
    );
  });

  it('returns true for active browser alerts', () => {
    assert.equal(
      hasAnyActivatedProFunctionality(config({ hasWebPushDelivery: true })),
      true,
    );
  });

  it('returns true for a previously used power feature', () => {
    assert.equal(
      hasAnyActivatedProFunctionality(config({ hasUsedPowerFeature: true })),
      true,
    );
  });
});

describe('buildBriefDigestPayload — brief step write delta (U4)', () => {
  it('carries explicit daily mode, chosen hour, and IANA timezone', () => {
    assert.deepEqual(buildBriefDigestPayload(config(), 6, 'America/New_York'), {
      enabled: true,
      digestMode: 'daily',
      digestHour: 6,
      digestTimezone: 'America/New_York',
    });
  });

  it('returns null when a digest rule + verified channel already exist (already-done, never overwrite AE6)', () => {
    assert.equal(
      buildBriefDigestPayload(
        config({
          hasEnabledDigestRule: true,
          hasVerifiedEmailChannel: true,
          hasEmailDelivery: true,
        }),
        6,
        'UTC',
      ),
      null,
    );
  });

  it('enables an existing rule without a verified channel but PRESERVES its cadence (never forces daily)', () => {
    // A subscriber with an enabled weekly/twice_daily rule but no verified email
    // channel keeps the brief step confirmable; confirming must add email
    // without overwriting their chosen cadence — so the payload omits the
    // cadence fields (relay preserves them on omit) rather than forcing daily.
    const p = buildBriefDigestPayload(
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: false }),
      9,
      'UTC',
    );
    assert.deepEqual(p, { enabled: true });
    assert.equal(p?.digestMode, undefined);
    assert.equal(p?.digestHour, undefined);
    assert.equal(p?.digestTimezone, undefined);
  });

  it('clamps an out-of-range or non-integer hour to the default, keeps valid bounds', () => {
    assert.equal(buildBriefDigestPayload(config(), -1, 'UTC')?.digestHour, DEFAULT_DIGEST_HOUR);
    assert.equal(buildBriefDigestPayload(config(), 24, 'UTC')?.digestHour, DEFAULT_DIGEST_HOUR);
    assert.equal(buildBriefDigestPayload(config(), 9.5, 'UTC')?.digestHour, DEFAULT_DIGEST_HOUR);
    assert.equal(buildBriefDigestPayload(config(), Number.NaN, 'UTC')?.digestHour, DEFAULT_DIGEST_HOUR);
    assert.equal(buildBriefDigestPayload(config(), 0, 'UTC')?.digestHour, 0);
    assert.equal(buildBriefDigestPayload(config(), 23, 'UTC')?.digestHour, 23);
  });
});

describe('buildCriticalAlertsPayload — alerts step write delta (U5)', () => {
  it('seeds a critical-only rule carrying web_push when no enabled rule exists', () => {
    assert.deepEqual(buildCriticalAlertsPayload([], false), {
      enabled: true,
      channels: ['web_push'],
      sensitivity: 'critical',
    });
  });

  it('PATCHES channels only (omits sensitivity) when an enabled rule already exists — preserves cadence (R15)', () => {
    assert.deepEqual(buildCriticalAlertsPayload(['email'], true), {
      enabled: true,
      channels: ['email', 'web_push'],
    });
  });

  it('does not duplicate web_push when it is already a delivery channel', () => {
    assert.deepEqual(buildCriticalAlertsPayload(['email', 'web_push'], true), {
      enabled: true,
      channels: ['email', 'web_push'],
    });
  });

  it('web_push already present + no enabled rule: no duplicate channel, sensitivity still seeded', () => {
    assert.deepEqual(buildCriticalAlertsPayload(['web_push'], false), {
      enabled: true,
      channels: ['web_push'],
      sensitivity: 'critical',
    });
  });
});

describe('buildExitSummary — R15 pending/verified/failed', () => {
  it('maps each outcome to its distinct status, preserving order', () => {
    const results: ActivationStepResult[] = [
      { id: 'brief', outcome: 'confirmed' },
      { id: 'alerts', outcome: 'skipped' },
      { id: 'power', outcome: 'failed' },
    ];
    assert.deepEqual(buildExitSummary(results), [
      { id: 'brief', outcome: 'confirmed', status: 'verified' },
      { id: 'alerts', outcome: 'skipped', status: 'pending' },
      { id: 'power', outcome: 'failed', status: 'failed' },
    ]);
  });

  it('already-done (done) reads as verified', () => {
    assert.deepEqual(buildExitSummary([{ id: 'brief', outcome: 'done' }]), [
      { id: 'brief', outcome: 'done', status: 'verified' },
    ]);
  });

  // #5617: a browser refusal is durably distinct from a voluntary skip, but the
  // USER-facing line must stay identical — 'failed' renders "We couldn't set
  // this up", which is wrong for a permission we were never allowed to attempt.
  it('blocked reads as pending, never failed (#5617)', () => {
    assert.deepEqual(buildExitSummary([{ id: 'alerts', outcome: 'blocked' }]), [
      { id: 'alerts', outcome: 'blocked', status: 'pending' },
    ]);
  });
});

describe('summarizeActivationExit — funnel exit completion state', () => {
  it('all verified (confirmed/done) → complete, counts bucketed', () => {
    assert.deepEqual(
      summarizeActivationExit([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'done' },
        { id: 'power', outcome: 'confirmed' },
      ]),
      { completion: 'complete', verified: 3, pending: 0, failed: 0, total: 3 },
    );
  });

  it('mix of verified + skipped + failed → partial', () => {
    assert.deepEqual(
      summarizeActivationExit([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'skipped' },
        { id: 'power', outcome: 'failed' },
      ]),
      { completion: 'partial', verified: 1, pending: 1, failed: 1, total: 3 },
    );
  });

  it('nothing verified (all skipped) → none', () => {
    assert.deepEqual(
      summarizeActivationExit([
        { id: 'brief', outcome: 'skipped' },
        { id: 'alerts', outcome: 'skipped' },
      ]),
      { completion: 'none', verified: 0, pending: 2, failed: 0, total: 2 },
    );
  });

  it('a failed-only exit is none, not partial (no step verified)', () => {
    assert.deepEqual(summarizeActivationExit([{ id: 'brief', outcome: 'failed' }]), {
      completion: 'none',
      verified: 0,
      pending: 0,
      failed: 1,
      total: 1,
    });
  });

  it('empty flow → none with zero counts', () => {
    assert.deepEqual(summarizeActivationExit([]), {
      completion: 'none',
      verified: 0,
      pending: 0,
      failed: 0,
      total: 0,
    });
  });

  // The aggregate funnel event keeps its three buckets: adding the durable
  // `blocked` outcome (#5617) must not shift a denial out of `pending` into
  // `failed` and silently move the exit-event baseline.
  it('a blocked step counts as pending, leaving the funnel counts unchanged (#5617)', () => {
    assert.deepEqual(
      summarizeActivationExit([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'blocked' },
      ]),
      { completion: 'partial', verified: 1, pending: 1, failed: 0, total: 2 },
    );
  });
});

describe('buildActivationOutcomeBuckets — durable outcome record (#5582)', () => {
  it('confirmed and done both land in confirmedSteps (both count as verified)', () => {
    assert.deepEqual(
      buildActivationOutcomeBuckets([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'done' },
      ]),
      {
        confirmedSteps: ['brief', 'alerts'],
        skippedSteps: [],
        blockedSteps: [],
        failedSteps: [],
      },
    );
  });

  it('skipped and failed bucket separately from confirmed', () => {
    assert.deepEqual(
      buildActivationOutcomeBuckets([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'skipped' },
        { id: 'power', outcome: 'failed' },
      ]),
      {
        confirmedSteps: ['brief'],
        skippedSteps: ['alerts'],
        blockedSteps: [],
        failedSteps: ['power'],
      },
    );
  });

  it('preserves step order within each bucket', () => {
    assert.deepEqual(
      buildActivationOutcomeBuckets([
        { id: 'power', outcome: 'skipped' },
        { id: 'brief', outcome: 'skipped' },
        { id: 'alerts', outcome: 'skipped' },
      ]),
      {
        confirmedSteps: [],
        skippedSteps: ['power', 'brief', 'alerts'],
        blockedSteps: [],
        failedSteps: [],
      },
    );
  });

  it('empty flow → all buckets empty', () => {
    assert.deepEqual(buildActivationOutcomeBuckets([]), {
      confirmedSteps: [],
      skippedSteps: [],
      blockedSteps: [],
      failedSteps: [],
    });
  });

  // #5617: the whole point of the fourth bucket. A browser-denied step must be
  // queryable AFTER the fact — landing it in skippedSteps makes the denial
  // cohort unsizeable, and landing it in failedSteps would say we tried and
  // failed. It gets its own bucket, and the other three are untouched.
  it('a blocked step lands in blockedSteps, not skippedSteps or failedSteps (#5617)', () => {
    assert.deepEqual(
      buildActivationOutcomeBuckets([
        { id: 'brief', outcome: 'confirmed' },
        { id: 'alerts', outcome: 'blocked' },
        { id: 'power', outcome: 'skipped' },
      ]),
      {
        confirmedSteps: ['brief'],
        skippedSteps: ['power'],
        blockedSteps: ['alerts'],
        failedSteps: [],
      },
    );
  });

  // Guards the shape of the bucketing itself: an `else`-as-catch-all silently
  // swallows every future outcome into failedSteps, which is exactly how the
  // blocked cohort would have been mislabelled here.
  it('every outcome is routed explicitly — no bucket is a catch-all (#5617)', () => {
    const buckets = buildActivationOutcomeBuckets([
      { id: 'brief', outcome: 'blocked' },
      { id: 'alerts', outcome: 'blocked' },
      { id: 'power', outcome: 'blocked' },
    ]);
    assert.deepEqual(buckets.blockedSteps, ['brief', 'alerts', 'power']);
    assert.deepEqual(buckets.failedSteps, []);
    assert.deepEqual(buckets.skippedSteps, []);
    assert.deepEqual(buckets.confirmedSteps, []);
  });
});

// The two shell paths that advance past a step without a confirm (the Continue
// button and the implicit default for a step the user never acted on) share
// this seam so they cannot drift apart — a blocked step recorded through one
// path and skipped through the other would make the durable bucket a biased
// sample of the very cohort it exists to size (#5617).
describe('selectAdvanceOutcome — advancing past a step without confirming', () => {
  it('a browser-refused step resolves blocked, not skipped', () => {
    assert.equal(selectAdvanceOutcome('blocked'), 'blocked');
  });

  it('an already-configured step resolves done', () => {
    assert.equal(selectAdvanceOutcome('already-done'), 'done');
  });

  it('a confirmable step the user walked past is a real skip', () => {
    assert.equal(selectAdvanceOutcome('confirmable'), 'skipped');
  });

  it('a platform-unsupported step stays a skip (we never asked for anything)', () => {
    assert.equal(selectAdvanceOutcome('unavailable'), 'skipped');
  });
});

describe('shouldShowFinishSetupChip', () => {
  const done: ActivationStepResult[] = [
    { id: 'brief', outcome: 'confirmed' },
    { id: 'alerts', outcome: 'done' },
  ];
  const withSkip: ActivationStepResult[] = [
    { id: 'brief', outcome: 'confirmed' },
    { id: 'alerts', outcome: 'skipped' },
  ];
  const withFail: ActivationStepResult[] = [
    { id: 'brief', outcome: 'failed' },
  ];
  const withBlocked: ActivationStepResult[] = [
    { id: 'brief', outcome: 'confirmed' },
    { id: 'alerts', outcome: 'blocked' },
  ];

  it('shows the chip when any step was skipped', () => {
    assert.equal(shouldShowFinishSetupChip(withSkip, null, null, NOW), true);
  });

  // Splitting blocked out of skippedSteps (#5617) is a RECORD change, not a UX
  // change: a denied step is still unfinished setup, so the chip must keep
  // appearing exactly as it did when blocked resolved as 'skipped'.
  it('still shows the chip when the only unfinished step was blocked (#5617)', () => {
    assert.equal(shouldShowFinishSetupChip(withBlocked, null, null, NOW), true);
  });

  it('shows the chip when any step failed', () => {
    assert.equal(shouldShowFinishSetupChip(withFail, null, null, NOW), true);
  });

  it('no chip when everything was completed or already-done', () => {
    assert.equal(shouldShowFinishSetupChip(done, null, null, NOW), false);
  });

  it('no chip when there are no results', () => {
    assert.equal(shouldShowFinishSetupChip([], null, null, NOW), false);
  });

  it('a fresh dismissal record suppresses the chip even with skipped steps', () => {
    assert.equal(shouldShowFinishSetupChip(withSkip, { dismissedAt: NOW }, null, NOW), false);
  });

  it('an expired dismissal record no longer suppresses the chip', () => {
    const stale = { dismissedAt: NOW - FINISH_SETUP_CHIP_DISMISS_TTL_MS - 1 };
    assert.equal(shouldShowFinishSetupChip(withSkip, stale, null, NOW), true);
  });

  it("a DIFFERENT account's fresh dismissal does not suppress the chip (#13)", () => {
    const foreign = { dismissedAt: NOW, accountKey: ACCOUNT_A };
    assert.equal(shouldShowFinishSetupChip(withSkip, foreign, ACCOUNT_B, NOW), true);
  });

  it("the SAME account's fresh dismissal suppresses the chip (#13)", () => {
    const own = { dismissedAt: NOW, accountKey: ACCOUNT_A };
    assert.equal(shouldShowFinishSetupChip(withSkip, own, ACCOUNT_A, NOW), false);
  });
});

describe('finish-setup chip dismissal record', () => {
  it('computeFinishSetupChipDismissal captures the dismissal time and opaque account key', () => {
    assert.deepEqual(computeFinishSetupChipDismissal(null, NOW), { dismissedAt: NOW });
    assert.deepEqual(computeFinishSetupChipDismissal(ACCOUNT_A, NOW), {
      dismissedAt: NOW,
      accountKey: ACCOUNT_A,
    });
  });

  it('isChipDismissed: fresh true, expired false, null false (legacy unscoped record)', () => {
    assert.equal(isChipDismissed({ dismissedAt: NOW }, null, NOW), true);
    assert.equal(
      isChipDismissed({ dismissedAt: NOW - FINISH_SETUP_CHIP_DISMISS_TTL_MS - 1 }, null, NOW),
      false,
    );
    assert.equal(isChipDismissed(null, null, NOW), false);
  });

  it('isChipDismissed identity matrix (#13): legacy suppresses all; scoped suppresses same account + pre-auth only', () => {
    // Legacy record (no account key) suppresses for everyone, signed in or not.
    assert.equal(isChipDismissed({ dismissedAt: NOW }, ACCOUNT_A, NOW), true);
    // Scoped record suppresses for the SAME account.
    assert.equal(
      isChipDismissed({ dismissedAt: NOW, accountKey: ACCOUNT_A }, ACCOUNT_A, NOW),
      true,
    );
    // A DIFFERENT signed-in account is not bound by it — the chip may show.
    assert.equal(
      isChipDismissed({ dismissedAt: NOW, accountKey: ACCOUNT_A }, ACCOUNT_B, NOW),
      false,
    );
    // Pre-auth: suppress a fresh record to avoid flashing.
    assert.equal(isChipDismissed({ dismissedAt: NOW, accountKey: ACCOUNT_A }, null, NOW), true);
    // Expiry still wins over identity.
    assert.equal(
      isChipDismissed(
        {
          dismissedAt: NOW - FINISH_SETUP_CHIP_DISMISS_TTL_MS - 1,
          accountKey: ACCOUNT_A,
        },
        ACCOUNT_A,
        NOW,
      ),
      false,
    );
  });
});

describe('telemetry event selection', () => {
  it('exposes stable kebab-case event names', () => {
    assert.equal(ACTIVATION_EVENTS.entered, 'pro-activation-entered');
    assert.equal(ACTIVATION_EVENTS.stepConfirmed, 'pro-activation-step-confirmed');
    assert.equal(ACTIVATION_EVENTS.stepSkipped, 'pro-activation-step-skipped');
    assert.equal(ACTIVATION_EVENTS.stepBlocked, 'pro-activation-step-blocked');
    assert.equal(ACTIVATION_EVENTS.stepFailed, 'pro-activation-step-failed');
    assert.equal(ACTIVATION_EVENTS.exit, 'pro-activation-exit');
  });

  it('selectConfirmOutcome reports blocked through no step event', () => {
    // Silent-hazard pin between #5609 and #5600: the shell already reports a
    // blocked step via onBlockStep. If a confirm result of `blocked` also mapped
    // to the `failed` outcome, one denied-permission attempt would emit BOTH
    // step-blocked and step-failed — double-counting it and re-creating the
    // mislabeled funnel #5600 exists to fix, just with different labels.
    assert.equal(selectConfirmOutcome('verified'), 'confirmed');
    assert.equal(selectConfirmOutcome('failed'), 'failed');
    assert.equal(selectConfirmOutcome('blocked'), null);
    // #5600: a dismissed permission prompt is a USER outcome, not our write
    // erroring. Mapping it to 'failed' put the most common alerts-step result
    // into the step-failed metric that exists to catch systemic write failures —
    // the same mislabeling this PR fixes, with the labels swapped. Note
    // shouldReportPushSubscribeFailure below already excluded 'default' from
    // Sentry for exactly this reason; the funnel simply did not agree.
    assert.equal(selectConfirmOutcome('declined'), null);
    // And the composition the flow actually performs.
    assert.equal(selectStepEvent(selectConfirmOutcome('verified')!), ACTIVATION_EVENTS.stepConfirmed);
    assert.equal(selectStepEvent(selectConfirmOutcome('failed')!), ACTIVATION_EVENTS.stepFailed);
  });

  it('reports a push-subscribe failure to Sentry only when permission was granted', () => {
    // #5600: the capture exists to surface real write failures. A user who
    // denies OR dismisses the browser prompt is the documented AE3 outcome and
    // is the common case — reporting either would bury the signal in noise.
    assert.equal(shouldReportPushSubscribeFailure('granted'), true);
    assert.equal(shouldReportPushSubscribeFailure('denied'), false);
    assert.equal(shouldReportPushSubscribeFailure('default'), false);
    assert.equal(shouldReportPushSubscribeFailure('unsupported'), false);
  });

  it('selectStepEvent maps confirmed/skipped/failed to their events; done to null', () => {
    // #5600: `failed` used to map to null, so a genuinely errored step reached
    // Umami only as a `step-skipped` — the funnel read broken writes as user
    // disinterest for a full day before anyone noticed.
    assert.equal(selectStepEvent('confirmed'), ACTIVATION_EVENTS.stepConfirmed);
    assert.equal(selectStepEvent('skipped'), ACTIVATION_EVENTS.stepSkipped);
    assert.equal(selectStepEvent('failed'), ACTIVATION_EVENTS.stepFailed);
    assert.equal(selectStepEvent('done'), null);
  });

  // The durable `blocked` outcome (#5617) must keep its OWN event. Falling
  // through to stepSkipped here would re-collapse the denial cohort into
  // voluntary skips at the event level — the exact gap #5615 closed.
  it('selectStepEvent maps blocked to stepBlocked, never stepSkipped (#5617)', () => {
    assert.equal(selectStepEvent('blocked'), ACTIVATION_EVENTS.stepBlocked);
  });
});

describe('storage key constants (versioned, stable)', () => {
  it('keys are versioned and distinct', () => {
    const keys = [PENDING_MARKER_KEY, FIRE_ONCE_KEY, FINISH_SETUP_CHIP_DISMISS_KEY];
    for (const k of keys) assert.match(k, /-v\d+$/);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('stored-record parsers (raw string → validated record, storage stays with callers)', () => {
  it('parsePendingMarker: valid roundtrip, with and without productId', () => {
    assert.deepEqual(parsePendingMarker(JSON.stringify({ productId: 'pdt_x', createdAt: 5 })), {
      productId: 'pdt_x',
      createdAt: 5,
    });
    assert.deepEqual(parsePendingMarker(JSON.stringify({ createdAt: 5 })), { createdAt: 5 });
  });

  it('parsePendingMarker: strips junk keys and rejects malformed values', () => {
    assert.deepEqual(parsePendingMarker(JSON.stringify({ createdAt: 5, junk: true })), {
      createdAt: 5,
    });
    assert.equal(parsePendingMarker(null), null);
    assert.equal(parsePendingMarker('not json'), null);
    assert.equal(parsePendingMarker(JSON.stringify({ createdAt: 'nope' })), null);
    assert.equal(parsePendingMarker(JSON.stringify('a string')), null);
  });

  it('parseFireOnceRecord: valid roundtrip, junk stripped, malformed rejected', () => {
    assert.deepEqual(
      parseFireOnceRecord(JSON.stringify({ subscriptionKey: 'sub_1', shownAt: 7, junk: 1 })),
      { subscriptionKey: 'sub_1', shownAt: 7 },
    );
    assert.equal(parseFireOnceRecord(null), null);
    assert.equal(parseFireOnceRecord('{'), null);
    assert.equal(parseFireOnceRecord(JSON.stringify({ shownAt: 7 })), null);
  });

  it('parseChipDismissal: valid roundtrip, junk stripped, malformed rejected', () => {
    assert.deepEqual(parseChipDismissal(JSON.stringify({ dismissedAt: 9, junk: 'x' })), {
      dismissedAt: 9,
    });
    assert.equal(parseChipDismissal(null), null);
    assert.equal(parseChipDismissal('[]'), null);
    assert.equal(parseChipDismissal(JSON.stringify({ dismissedAt: null })), null);
  });

  it('parsers migrate legacy raw user ids to opaque account keys', () => {
    assert.deepEqual(parsePendingMarker(JSON.stringify({ createdAt: 5, userId: USER_A })), {
      createdAt: 5,
      accountKey: ACCOUNT_A,
    });
    assert.equal(
      'userId' in (parsePendingMarker(JSON.stringify({ createdAt: 5, userId: 42 })) ?? {}),
      false,
    );
    assert.deepEqual(
      parseFireOnceRecord(JSON.stringify({ subscriptionKey: 'sub_1', shownAt: 7, userId: USER_A })),
      { subscriptionKey: 'sub_1', shownAt: 7 },
    );
    assert.deepEqual(parseChipDismissal(JSON.stringify({ dismissedAt: 9, userId: USER_A })), {
      dismissedAt: 9,
      accountKey: ACCOUNT_A,
    });
  });
});

describe('cross-tab mount claim (#7)', () => {
  it('computeMountClaim captures the nonce and claim time', () => {
    assert.deepEqual(computeMountClaim('nonce-1', NOW), { nonce: 'nonce-1', claimedAt: NOW });
  });

  it('parseMountClaim: valid roundtrip, junk stripped, malformed rejected', () => {
    assert.deepEqual(parseMountClaim(JSON.stringify({ nonce: 'n1', claimedAt: 7, junk: 1 })), {
      nonce: 'n1',
      claimedAt: 7,
    });
    assert.equal(parseMountClaim(null), null);
    assert.equal(parseMountClaim('{'), null);
    assert.equal(parseMountClaim(JSON.stringify({ claimedAt: 7 })), null);
    assert.equal(parseMountClaim(JSON.stringify({ nonce: 5, claimedAt: 7 })), null);
    assert.equal(parseMountClaim(JSON.stringify({ nonce: 'n1', claimedAt: 'nope' })), null);
  });

  it('isMountClaimBlocking matrix: fresh-foreign blocks; own/stale-foreign/null do not', () => {
    const fresh = computeMountClaim('other-tab', NOW);
    // A fresh claim from a DIFFERENT tab blocks us.
    assert.equal(isMountClaimBlocking(fresh, 'my-tab', NOW), true);
    // Our OWN fresh claim never blocks us.
    assert.equal(isMountClaimBlocking(computeMountClaim('my-tab', NOW), 'my-tab', NOW), false);
    // A stale foreign claim (past TTL) has lapsed — non-blocking.
    const stale = computeMountClaim('other-tab', NOW - MOUNT_CLAIM_TTL_MS - 1);
    assert.equal(isMountClaimBlocking(stale, 'my-tab', NOW), false);
    // No claim at all — non-blocking.
    assert.equal(isMountClaimBlocking(null, 'my-tab', NOW), false);
    // Exactly-at-TTL foreign claim is still within its lease (inclusive) → blocks.
    const edge = computeMountClaim('other-tab', NOW - MOUNT_CLAIM_TTL_MS);
    assert.equal(isMountClaimBlocking(edge, 'my-tab', NOW), true);
  });

  it('MOUNT_CLAIM_KEY is versioned and distinct from the other activation keys', () => {
    assert.match(MOUNT_CLAIM_KEY, /-v\d+$/);
    const keys = [PENDING_MARKER_KEY, FIRE_ONCE_KEY, FINISH_SETUP_CHIP_DISMISS_KEY, MOUNT_CLAIM_KEY];
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('activation flow retry schedule', () => {
  it('backs off finitely through the abandoned server-claim lease window', () => {
    assert.deepEqual(ACTIVATION_FLOW_RETRY_DELAYS_MS, [2_000, 4_000, 8_000, 16_000, 30_000]);
    assert.equal(activationFlowRetryDelay(0), 2_000);
    assert.equal(activationFlowRetryDelay(4), 30_000);
    assert.equal(activationFlowRetryDelay(5), null);
  });
});
