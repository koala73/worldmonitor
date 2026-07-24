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
  deriveSubscriptionKey,
  isFireOnceActive,
  computeFireOnceRecord,
  buildActivationSteps,
  buildBriefDigestPayload,
  buildCriticalAlertsPayload,
  DEFAULT_DIGEST_HOUR,
  buildExitSummary,
  summarizeActivationExit,
  shouldShowFinishSetupChip,
  computeFinishSetupChipDismissal,
  isChipDismissed,
  computeMountClaim,
  parseMountClaim,
  isMountClaimBlocking,
  selectStepEvent,
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

const PRO_ID = DODO_PRODUCTS.PRO_MONTHLY;
const PRO_ANNUAL_ID = DODO_PRODUCTS.PRO_ANNUAL;
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
  return { id: 'sub_live_1', currentPeriodStart: NOW - DAY, ...overrides };
}

function fireOnce(overrides: Partial<FireOnceRecord> = {}): FireOnceRecord {
  return { subscriptionKey: 'sub_live_1', shownAt: NOW, ...overrides };
}

function mountInput(overrides: Partial<ActivationMountInput> = {}): ActivationMountInput {
  return {
    marker: marker(),
    entitlement: ent(),
    subscription: sub(),
    fireOnce: null,
    isDesktop: false,
    currentUserId: null,
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

  it('no marker = none (nothing to decide)', () => {
    assert.equal(decideActivationMount(mountInput({ marker: null })).action, 'none');
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
      mountInput({ subscription: { id: null, currentPeriodStart: null } }),
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
        subscription: sub({ id: 'sub_winback_2' }),
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

  it('keys off currentPeriodStart when the subscription id is absent', () => {
    const d = decideActivationMount(
      mountInput({ subscription: { id: null, currentPeriodStart: 123 } }),
    );
    assert.equal(d.action, 'mount');
    assert.equal(d.action === 'mount' ? d.subscriptionKey : null, 'period:123');
  });
});

describe('decideActivationMount — cross-account marker identity (#6)', () => {
  it('marker without userId mounts regardless of signed-in user (legacy tolerance)', () => {
    // A marker written before identity scoping carries no userId; it flows
    // through the identity gate untouched and mounts on the live snapshot.
    assert.equal(
      decideActivationMount(mountInput({ marker: marker(), currentUserId: USER_A })).action,
      'mount',
    );
    assert.equal(
      decideActivationMount(mountInput({ marker: marker(), currentUserId: null })).action,
      'mount',
    );
  });

  it('marker with userId + same signed-in user mounts', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ userId: USER_A }), currentUserId: USER_A }),
    );
    assert.equal(d.action, 'mount');
  });

  it('marker with userId + auth still settling (currentUserId null) = keep, never mount/clear', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ userId: USER_A }), currentUserId: null }),
    );
    assert.equal(d.action, 'keep');
  });

  it('marker with userId + a DIFFERENT signed-in user = none (foreign marker: no mount, no clear)', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ userId: USER_A }), currentUserId: USER_B }),
    );
    assert.equal(d.action, 'none');
  });

  it('foreign-user identity gate precedes plan classification (a Pro marker for user A does not mount for user B)', () => {
    const d = decideActivationMount(
      mountInput({
        marker: marker({ productId: PRO_ID, userId: USER_A }),
        entitlement: ent(),
        subscription: sub(),
        currentUserId: USER_B,
      }),
    );
    assert.equal(d.action, 'none');
  });

  it('desktop + userId marker still clears (desktop precedes the identity gate, R12)', () => {
    const d = decideActivationMount(
      mountInput({ marker: marker({ userId: USER_A }), currentUserId: USER_B, isDesktop: true }),
    );
    assert.equal(d.action, 'clear');
  });

  it('expired + foreign userId marker still clears (TTL precedes the identity gate)', () => {
    const stale = marker({ userId: USER_A, createdAt: NOW - PENDING_MARKER_TTL_MS - 1 });
    const d = decideActivationMount(mountInput({ marker: stale, currentUserId: USER_B }));
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

  it('computePendingMarker embeds the userId when signed in, omits it when null (#6)', () => {
    assert.deepEqual(computePendingMarker(PRO_ID, USER_A, NOW), {
      productId: PRO_ID,
      userId: USER_A,
      createdAt: NOW,
    });
    const anon = computePendingMarker(PRO_ID, null, NOW);
    assert.equal('userId' in anon, false);
  });

  it('isPendingMarkerExpired: fresh false, past-TTL true, exactly-TTL false (inclusive)', () => {
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW }), NOW), false);
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW - PENDING_MARKER_TTL_MS }), NOW), false);
    assert.equal(isPendingMarkerExpired(marker({ createdAt: NOW - PENDING_MARKER_TTL_MS - 1 }), NOW), true);
  });
});

describe('plan classification helpers (allowlist)', () => {
  it('isProProductId: only the two Pro product ids are Pro', () => {
    assert.equal(isProProductId(PRO_ID), true);
    assert.equal(isProProductId(PRO_ANNUAL_ID), true);
    assert.equal(isProProductId(API_STARTER_ID), false);
    assert.equal(isProProductId(ENTERPRISE_ID), false);
    assert.equal(isProProductId('pdt_unknown'), false);
  });

  it('isProPlanKey: only pro_monthly / pro_annual are Pro', () => {
    assert.equal(isProPlanKey('pro_monthly'), true);
    assert.equal(isProPlanKey('pro_annual'), true);
    assert.equal(isProPlanKey('free'), false);
    assert.equal(isProPlanKey('api_starter'), false);
    assert.equal(isProPlanKey('enterprise'), false);
  });

  it('PRO_PRODUCT_IDS stays in sync with the generated catalog (drift guard)', () => {
    assert.deepEqual([...PRO_PRODUCT_IDS].sort(), [DODO_PRODUCTS.PRO_MONTHLY, DODO_PRODUCTS.PRO_ANNUAL].sort());
  });

  it('PRO_PLAN_KEYS stays in sync with the catalog\'s pro tierGroup (drift guard)', () => {
    const catalogProPlanKeys = Object.values(PRODUCT_CATALOG)
      .filter((e) => e.tierGroup === 'pro')
      .map((e) => e.planKey)
      .sort();
    assert.deepEqual([...PRO_PLAN_KEYS].sort(), catalogProPlanKeys);
  });
});

describe('deriveSubscriptionKey (fire-once identity)', () => {
  it('prefers the subscription id', () => {
    assert.equal(deriveSubscriptionKey({ id: 'sub_x', currentPeriodStart: 5 }), 'sub_x');
  });

  it('falls back to period-start when id is absent', () => {
    assert.equal(deriveSubscriptionKey({ id: null, currentPeriodStart: 999 }), 'period:999');
  });

  it('returns null when nothing identifies the subscription yet', () => {
    assert.equal(deriveSubscriptionKey({ id: null, currentPeriodStart: null }), null);
    assert.equal(deriveSubscriptionKey(null), null);
  });
});

describe('fire-once record + TTL (KTD4)', () => {
  it('computeFireOnceRecord captures the subscription key and shown time', () => {
    assert.deepEqual(computeFireOnceRecord('sub_x', null, NOW), {
      subscriptionKey: 'sub_x',
      shownAt: NOW,
    });
  });

  it('computeFireOnceRecord embeds the userId when signed in, omits it when null (#6 observability)', () => {
    assert.deepEqual(computeFireOnceRecord('sub_x', USER_A, NOW), {
      subscriptionKey: 'sub_x',
      userId: USER_A,
      shownAt: NOW,
    });
    assert.equal('userId' in computeFireOnceRecord('sub_x', null, NOW), false);
  });

  it('isFireOnceActive: fresh true, expired false, null false', () => {
    assert.equal(isFireOnceActive(fireOnce({ shownAt: NOW }), NOW), true);
    assert.equal(isFireOnceActive(fireOnce({ shownAt: NOW - FIRE_ONCE_TTL_MS - 1 }), NOW), false);
    assert.equal(isFireOnceActive(null, NOW), false);
  });
});

function caps(overrides: Partial<ActivationPlatformCapabilities> = {}): ActivationPlatformCapabilities {
  return { webPushSupported: true, pushPermission: 'default', ...overrides };
}

function config(overrides: Partial<ActivationExistingConfig> = {}): ActivationExistingConfig {
  return {
    hasVerifiedEmailChannel: false,
    hasEnabledDigestRule: false,
    hasTunedDigestHour: false,
    hasWebPushChannel: false,
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

  it('alerts is already-done when a web-push channel already exists', () => {
    const steps = buildActivationSteps(caps(), config({ hasWebPushChannel: true }));
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'already-done');
  });

  it('alerts is confirmable with default permission and no existing channel', () => {
    const steps = buildActivationSteps(caps(), config());
    assert.equal(steps.find((s) => s.id === 'alerts')?.state, 'confirmable');
  });

  it('brief already-done when an enabled digest rule + verified channel exist', () => {
    const steps = buildActivationSteps(
      caps(),
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: true }),
    );
    assert.equal(steps.find((s) => s.id === 'brief')?.state, 'already-done');
  });

  it('brief already-done with tuned digestHour preserves their schedule (AE6, never overwrite)', () => {
    const brief = buildActivationSteps(
      caps(),
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: true, hasTunedDigestHour: true }),
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
        hasEnabledDigestRule: true,
        hasTunedDigestHour: true,
        hasWebPushChannel: true,
        hasUsedPowerFeature: true,
      }),
    );
    assert.deepEqual(steps.map((s) => s.state), ['already-done', 'already-done', 'already-done']);
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
        config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: true }),
        6,
        'UTC',
      ),
      null,
    );
  });

  it('still writes when an enabled rule exists but has no verified delivery channel (undeliverable)', () => {
    const p = buildBriefDigestPayload(
      config({ hasEnabledDigestRule: true, hasVerifiedEmailChannel: false }),
      9,
      'UTC',
    );
    assert.equal(p?.digestHour, 9);
    assert.equal(p?.digestMode, 'daily');
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

  it('shows the chip when any step was skipped', () => {
    assert.equal(shouldShowFinishSetupChip(withSkip, null, null, NOW), true);
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

  it("a DIFFERENT user's fresh dismissal does not suppress the chip (#13)", () => {
    const foreign = { dismissedAt: NOW, userId: USER_A };
    assert.equal(shouldShowFinishSetupChip(withSkip, foreign, USER_B, NOW), true);
  });

  it("the SAME user's fresh dismissal suppresses the chip (#13)", () => {
    const own = { dismissedAt: NOW, userId: USER_A };
    assert.equal(shouldShowFinishSetupChip(withSkip, own, USER_A, NOW), false);
  });
});

describe('finish-setup chip dismissal record', () => {
  it('computeFinishSetupChipDismissal captures the dismissal time, embeds userId when signed in', () => {
    assert.deepEqual(computeFinishSetupChipDismissal(null, NOW), { dismissedAt: NOW });
    assert.deepEqual(computeFinishSetupChipDismissal(USER_A, NOW), {
      dismissedAt: NOW,
      userId: USER_A,
    });
  });

  it('isChipDismissed: fresh true, expired false, null false (legacy no-userId record)', () => {
    assert.equal(isChipDismissed({ dismissedAt: NOW }, null, NOW), true);
    assert.equal(
      isChipDismissed({ dismissedAt: NOW - FINISH_SETUP_CHIP_DISMISS_TTL_MS - 1 }, null, NOW),
      false,
    );
    assert.equal(isChipDismissed(null, null, NOW), false);
  });

  it('isChipDismissed identity matrix (#13): legacy suppresses all; scoped suppresses same user + pre-auth only', () => {
    // Legacy record (no userId) suppresses for everyone, signed in or not.
    assert.equal(isChipDismissed({ dismissedAt: NOW }, USER_A, NOW), true);
    // Scoped record suppresses for the SAME user.
    assert.equal(isChipDismissed({ dismissedAt: NOW, userId: USER_A }, USER_A, NOW), true);
    // A DIFFERENT signed-in user is not bound by it — the chip may show.
    assert.equal(isChipDismissed({ dismissedAt: NOW, userId: USER_A }, USER_B, NOW), false);
    // Pre-auth (currentUserId null): suppress a fresh record to avoid flashing.
    assert.equal(isChipDismissed({ dismissedAt: NOW, userId: USER_A }, null, NOW), true);
    // Expiry still wins over identity.
    assert.equal(
      isChipDismissed(
        { dismissedAt: NOW - FINISH_SETUP_CHIP_DISMISS_TTL_MS - 1, userId: USER_A },
        USER_A,
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
    assert.equal(ACTIVATION_EVENTS.exit, 'pro-activation-exit');
  });

  it('selectStepEvent maps confirmed/skipped to their events; done/failed to null', () => {
    assert.equal(selectStepEvent('confirmed'), ACTIVATION_EVENTS.stepConfirmed);
    assert.equal(selectStepEvent('skipped'), ACTIVATION_EVENTS.stepSkipped);
    assert.equal(selectStepEvent('done'), null);
    assert.equal(selectStepEvent('failed'), null);
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

  it('parsers preserve a string userId and strip a non-string one (#6/#13)', () => {
    assert.deepEqual(parsePendingMarker(JSON.stringify({ createdAt: 5, userId: USER_A })), {
      createdAt: 5,
      userId: USER_A,
    });
    assert.equal(
      'userId' in (parsePendingMarker(JSON.stringify({ createdAt: 5, userId: 42 })) ?? {}),
      false,
    );
    assert.deepEqual(
      parseFireOnceRecord(JSON.stringify({ subscriptionKey: 'sub_1', shownAt: 7, userId: USER_A })),
      { subscriptionKey: 'sub_1', shownAt: 7, userId: USER_A },
    );
    assert.deepEqual(parseChipDismissal(JSON.stringify({ dismissedAt: 9, userId: USER_A })), {
      dismissedAt: 9,
      userId: USER_A,
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
