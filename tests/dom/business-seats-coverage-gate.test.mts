/**
 * The Business seats UI must appear exactly when the SERVER would authorize a
 * seat operation, not when the status string happens to read 'active'.
 *
 * convex/payments/businessSeats.ts:88 authorizes on
 * `planKey === "api_business" && isCoveringAt(s, at)`, which includes an
 * on_hold row (payment retry window) and a cancelled-but-paid-through row.
 * The client gated on `status === 'active'`, so an owner in either window lost
 * the entire seats surface — while their invitees' grants stayed alive
 * (subscriptionHelpers.ts:419 keeps a grant conferring Pro for exactly the
 * covering window), leaving a team on Pro that the owner could not see or
 * manage. CONCEPTS.md § Covering Subscription requires the client to mirror
 * the server rather than re-derive from status-string intuition.
 *
 * Harness mirrors unified-settings-billing-status-colour.test.mts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { SubscriptionInfo } from '@/services/billing';

const DAY = 86_400_000;

/** Read lazily by the billing mock; set per case. */
let mockSubscription: SubscriptionInfo | null = null;

vi.mock('@/services/billing', () => ({
  getSubscription: () => mockSubscription,
  listBusinessSeats: async () => ({
    businessSubscriptionId: null,
    ownerDomain: null,
    ownerIsCorporateDomain: false,
    seats: [],
  }),
  inviteBusinessSeats: async () => ({ invited: [] }),
  removeBusinessSeat: async () => ({ status: 'removed' as const }),
}));

const { BusinessSeatsSection } = await import('@/components/BusinessSeatsSection');

function subscription(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    planKey: 'api_business',
    displayName: 'API Business',
    status: 'active',
    currentPeriodEnd: Date.now() + 30 * DAY,
    renewalVerificationState: null,
    ...overrides,
  };
}

let section: InstanceType<typeof BusinessSeatsSection>;

/** The seats surface renders as a non-empty string, or '' when gated off. */
function rendersSeatsUi(): boolean {
  return section.renderContent() !== '';
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  const overlay = document.createElement('div');
  overlay.innerHTML = '<div id="usBusinessSeats"></div>';
  document.body.appendChild(overlay);
  section = new BusinessSeatsSection(overlay);
});

afterEach(() => {
  mockSubscription = null;
  document.body.replaceChildren();
});

describe('Business seats UI coverage gate', () => {
  it('renders for a renewing Business plan', () => {
    mockSubscription = subscription({ status: 'active' });
    expect(rendersSeatsUi()).toBe(true);
  });

  it('renders for a cancelled-but-paid-through Business plan', () => {
    // The owner still has coverage and their invitees still hold Pro through
    // the grant; hiding the surface strands a live team.
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() + 20 * DAY,
    });
    expect(rendersSeatsUi()).toBe(true);
  });

  it('renders for an on_hold Business plan (payment retry window keeps coverage)', () => {
    mockSubscription = subscription({
      status: 'on_hold',
      currentPeriodEnd: Date.now() + 5 * DAY,
    });
    expect(rendersSeatsUi()).toBe(true);
  });

  it('hides once a cancelled Business plan is past its paid period', () => {
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() - DAY,
    });
    expect(rendersSeatsUi()).toBe(false);
  });

  it('hides for an expired Business plan, even with a future period end', () => {
    // `expired` never covers, whatever its recorded period end.
    mockSubscription = subscription({
      status: 'expired',
      currentPeriodEnd: Date.now() + 30 * DAY,
    });
    expect(rendersSeatsUi()).toBe(false);
  });

  it('hides for a non-Business plan and for no subscription at all', () => {
    mockSubscription = subscription({ planKey: 'pro_monthly' });
    expect(rendersSeatsUi()).toBe(false);

    mockSubscription = null;
    expect(rendersSeatsUi()).toBe(false);
  });
});
