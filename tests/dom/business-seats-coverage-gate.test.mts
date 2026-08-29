/**
 * The Business seats UI must appear exactly when the SERVER would authorize a
 * seat operation.
 *
 * convex/payments/businessSeats.ts scans EVERY subscription row for a covering
 * `api_business` one. The client cannot reproduce that from `getSubscription()`,
 * which returns a single DISPLAY row chosen by a sort that ranks
 * active(0) < on_hold(1) < ended(2) and takes the first
 * (convex/payments/billing.ts:622-637). So an owner holding an active
 * `pro_monthly` alongside an `on_hold` or paid-through-cancelled `api_business`
 * gets the pro_monthly as their display row — and any client-side predicate
 * over that row answers "not an owner" while the server still authorizes.
 * A `cancelled` Business row can even be outranked by an `expired` row with a
 * later recorded period end, so no display-row predicate is sound.
 *
 * The gate is therefore the server's own verdict: `listSeats` returns
 * `businessSubscriptionId` non-null exactly when getCoveringBusinessSubscription
 * found a covering Business row. This locks that the client asks rather than
 * re-derives, which is what CONCEPTS.md § Covering Subscription requires.
 *
 * Matters because an invitee's grant keeps conferring Pro for exactly the
 * covering window (subscriptionHelpers.ts:419): hiding the surface strands a
 * team on Pro that the owner cannot see, remove, or add to.
 */
// No initTestI18n(): BusinessSeatsSection renders hardcoded copy, so loading
// the locale dictionaries here would only add startup cost to a suite whose
// slowest file already sits near the 15s budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionInfo } from '@/services/billing';

const DAY = 86_400_000;

/** Both read lazily by the billing mock; set per case. */
let mockSubscription: SubscriptionInfo | null = null;
let serverBusinessSubscriptionId: string | null = null;
let listSeatsError: Error | null = null;

vi.mock('@/services/billing', () => ({
  getSubscription: () => mockSubscription,
  listBusinessSeats: async () => {
    if (listSeatsError) throw listSeatsError;
    return {
      businessSubscriptionId: serverBusinessSubscriptionId,
      ownerDomain: 'example.com',
      ownerIsCorporateDomain: true,
      seats: [],
    };
  },
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

function rendersSeatsUi(): boolean {
  return section.renderContent() !== '';
}

beforeEach(() => {
  const overlay = document.createElement('div');
  overlay.innerHTML = '<div id="usBusinessSeats"></div>';
  document.body.appendChild(overlay);
  section = new BusinessSeatsSection(overlay);
});

afterEach(() => {
  mockSubscription = null;
  serverBusinessSubscriptionId = null;
  listSeatsError = null;
  document.body.replaceChildren();
});

describe('Business seats UI follows the server verdict', () => {
  it('renders once the server confirms a covering Business subscription', async () => {
    mockSubscription = subscription({ status: 'active' });
    serverBusinessSubscriptionId = 'sub_biz_1';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);
  });

  it('renders when the Business row is hidden behind another display subscription', async () => {
    // The owner's display row is an active pro_monthly; their on_hold Business
    // row sorts second and never reaches the client. The server still finds it.
    mockSubscription = subscription({ planKey: 'pro_monthly', status: 'active' });
    serverBusinessSubscriptionId = 'sub_biz_hidden';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);
  });

  it('renders for a paid-through-cancelled Business owner', async () => {
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() + 20 * DAY,
    });
    serverBusinessSubscriptionId = 'sub_biz_cancelled';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);
  });

  it('renders for an on_hold Business owner (retry window keeps coverage)', async () => {
    mockSubscription = subscription({ status: 'on_hold' });
    serverBusinessSubscriptionId = 'sub_biz_onhold';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);
  });

  it('stays hidden when the server reports no covering Business subscription', async () => {
    // Even though the display row still reads api_business, coverage has ended
    // and the server is the authority.
    mockSubscription = subscription({
      status: 'cancelled',
      currentPeriodEnd: Date.now() - DAY,
    });
    serverBusinessSubscriptionId = null;
    await section.load();
    expect(rendersSeatsUi()).toBe(false);
  });

  it('stays hidden before any load has settled', () => {
    // No verdict yet is not the same as a positive verdict.
    mockSubscription = subscription({ status: 'active' });
    expect(rendersSeatsUi()).toBe(false);
  });

  it('keeps a known owner visible when a later refresh fails', async () => {
    mockSubscription = subscription({ status: 'active' });
    serverBusinessSubscriptionId = 'sub_biz_1';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);

    // A transient failure must not silently strip an owner's seat surface;
    // the error belongs inside the section, not instead of it.
    listSeatsError = new Error('network');
    await section.load();
    expect(rendersSeatsUi()).toBe(true);
    expect(section.renderContent()).toContain('network');
  });

  it('stays hidden when the very first load fails', async () => {
    // Never confirmed an owner, so rendering a seats surface would be a guess.
    mockSubscription = subscription({ status: 'active' });
    listSeatsError = new Error('network');
    await section.load();
    expect(rendersSeatsUi()).toBe(false);
  });

  it('drops the surface on account change until the new account is confirmed', async () => {
    mockSubscription = subscription({ status: 'active' });
    serverBusinessSubscriptionId = 'sub_biz_1';
    await section.load();
    expect(rendersSeatsUi()).toBe(true);

    section.resetForAccountChange();
    expect(rendersSeatsUi()).toBe(false);
  });
});
