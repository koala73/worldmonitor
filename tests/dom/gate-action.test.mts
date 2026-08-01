/**
 * T3 (#5634) — behavioral coverage for `resolveGateAction`.
 *
 * `tests/billing-state-wiring.test.mts` asserts this switch by reading the
 * SOURCE TEXT of panel-gating.ts (`assert.match(src, /case
 * PanelGateReason.PAYMENT_ON_HOLD:/)`). That locks the shape of the code, not
 * what a click does — the regex stays green if the branch stops opening
 * anything, opens the wrong URL, or loses the popup-blocker pre-reserve.
 *
 * Here the returned callback is INVOKED against a real (happy-dom) window with
 * an injected `openAuthModal`, and the observable effect is asserted:
 * which URL opened, in what order, and what got handed to the billing portal.
 *
 * `prereserveBillingPortalTab` is deliberately NOT mocked — its real body is
 * `window.open('', '_blank', 'noopener,noreferrer')`, and that call is the
 * behaviour under test. Only `openBillingPortal` is stubbed, because its real
 * body fetches a portal session.
 */

import { beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const openBillingPortal = vi.fn(async () => ({ outcome: 'opened' as const, url: 'https://portal' }));
const getSubscription = vi.fn<() => { planKey: string } | null>(() => null);

vi.mock('@/services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/billing')>()),
  openBillingPortal: (...args: unknown[]) => openBillingPortal(...(args as [])),
  getSubscription: () => getSubscription(),
}));

const { PanelGateReason, resolveGateAction } = await import('@/services/panel-gating');

const PRO_ORIGIN = 'https://worldmonitor.app';

let openSpy: MockInstance<typeof window.open>;
let reloadSpy: MockInstance<() => void>;
let openAuthModal: Mock<() => void>;
/** Stand-in for the tab the browser hands back from a synchronous window.open. */
const reservedTab = { closed: false, location: { href: '' } } as unknown as Window;

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  openAuthModal = vi.fn<() => void>();
  openSpy = vi.spyOn(window, 'open').mockReturnValue(reservedTab);
  reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  openBillingPortal.mockClear();
  getSubscription.mockReset().mockReturnValue(null);
});

// Spies are restored by `restoreMocks: true` in vitest.dom.config.mts — a
// second mechanism here would only invite the two to drift. The vi.fn()s above
// are not spies, so they are reset explicitly in beforeEach.

const act = (reason: (typeof PanelGateReason)[keyof typeof PanelGateReason], planKey?: string | null) =>
  resolveGateAction(reason, { openAuthModal, ...(planKey === undefined ? {} : { planKey }) });

describe('resolveGateAction — resolution is inert', () => {
  it('resolving a reason performs no side effect until the callback runs', () => {
    for (const reason of Object.values(PanelGateReason)) act(reason);

    expect(openSpy).not.toHaveBeenCalled();
    expect(openAuthModal).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — ANONYMOUS', () => {
  it('opens the injected auth modal and navigates nowhere', () => {
    act(PanelGateReason.ANONYMOUS)();

    expect(openAuthModal).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — FREE_TIER', () => {
  it('opens the pricing page on an absolute origin, in a new tab, with noopener', () => {
    act(PanelGateReason.FREE_TIER)();

    // Absolute, because the desktop webview has no worldmonitor.app origin —
    // a relative href there resolves against tauri://localhost.
    expect(openSpy).toHaveBeenCalledWith(`${PRO_ORIGIN}/pro`, '_blank', 'noopener,noreferrer');
    expect(openAuthModal).not.toHaveBeenCalled();
  });
});

describe.each([
  ['PAYMENT_ON_HOLD', () => PanelGateReason.PAYMENT_ON_HOLD],
  ['RENEWAL_FAILED', () => PanelGateReason.RENEWAL_FAILED],
])('resolveGateAction — %s', (_label, reason) => {
  it('reserves the portal tab synchronously, before awaiting the portal session', () => {
    act(reason())();

    // Synchronous: asserted with no await in between, so a pre-reserve moved
    // after the portal fetch (the popup-blocker regression) fails here.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('', '_blank', 'noopener,noreferrer');
    expect(openSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      openBillingPortal.mock.invocationCallOrder[0]!,
    );
  });

  it('hands the reserved tab to the portal so it navigates in place', () => {
    act(reason())();

    expect(openBillingPortal).toHaveBeenCalledTimes(1);
    expect(openBillingPortal).toHaveBeenCalledWith(reservedTab);
  });

  it('never sends a paying customer to the upsell page', () => {
    act(reason())();

    expect(openSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/pro'),
      expect.anything(),
      expect.anything(),
    );
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — RENEWAL_PENDING', () => {
  it('reloads to re-pull entitlements instead of opening anything', () => {
    act(PanelGateReason.RENEWAL_PENDING)();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
  });
});

describe('resolveGateAction — LAPSED', () => {
  it('lands on the pricing anchor with the caller-supplied plan preselected', () => {
    act(PanelGateReason.LAPSED, 'pro_business_yearly')();

    expect(openSpy).toHaveBeenCalledWith(
      `${PRO_ORIGIN}/pro?wm_reactivate_plan=pro_business_yearly#pricing`,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('falls back to the live subscription row when the caller supplies no plan', () => {
    getSubscription.mockReturnValue({ planKey: 'pro_monthly' });

    act(PanelGateReason.LAPSED)();

    expect(openSpy).toHaveBeenCalledWith(
      `${PRO_ORIGIN}/pro?wm_reactivate_plan=pro_monthly#pricing`,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('still reaches the pricing anchor when no plan is known at all', () => {
    // Both signals absent: the anchor must survive even without the plan
    // param — the bare /pro redirect this replaced dropped both.
    act(PanelGateReason.LAPSED, null)();

    expect(openSpy).toHaveBeenCalledWith(`${PRO_ORIGIN}/pro#pricing`, '_blank', 'noopener,noreferrer');
  });

  it('percent-encodes a plan key so it cannot break out of the query param', () => {
    act(PanelGateReason.LAPSED, 'pro&plan=evil#x')();

    expect(openSpy).toHaveBeenCalledWith(
      `${PRO_ORIGIN}/pro?wm_reactivate_plan=pro%26plan%3Devil%23x#pricing`,
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('resolveGateAction — NONE', () => {
  it('is a no-op: an ungated surface must not navigate', () => {
    act(PanelGateReason.NONE)();

    expect(openSpy).not.toHaveBeenCalled();
    expect(openAuthModal).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(openBillingPortal).not.toHaveBeenCalled();
  });
});
