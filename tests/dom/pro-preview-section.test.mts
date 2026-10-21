/**
 * ProPreviewSection gating states (plan U4, R7-R9).
 *
 * The load-bearing contract is R9: while access is resolving, or when
 * entitlement verification terminally failed, the component renders NOTHING —
 * an outage must never manufacture an upgrade prompt (the WORLDMONITOR-NY
 * failure class). The rest: anonymous gets the sign-in branch, settled free
 * gets sample + consent + CTA with mission attribution, entitled gets
 * nothing, dismissal persists and reopens only on explicit interaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  auth: { user: null as null | { id: string }, isPending: false },
  tierResolved: true,
  verification: 'verified' as string,
  gateReason: 'FREE_TIER' as 'NONE' | 'ANONYMOUS' | 'FREE_TIER',
  billingRefined: false,
};

const analytics = {
  trackProPreviewViewed: vi.fn(),
  trackProPreviewCta: vi.fn(),
  trackProPreviewDismissed: vi.fn(),
};
const openUpgradeCheckout = vi.fn(async () => {});
const unsubAuth = vi.fn();
const unsubEnt = vi.fn();
const unsubVer = vi.fn();
const unsubBilling = vi.fn();
const billingListeners: Array<() => void> = [];

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => state.auth,
  subscribeAuthState: () => unsubAuth,
}));
vi.mock('@/services/entitlements', () => ({
  getEntitlementVerificationStatus: () => state.verification,
  onEntitlementChange: () => unsubEnt,
  onEntitlementVerificationChange: () => unsubVer,
}));
vi.mock('@/services/widget-store', () => ({
  isProTierResolved: () => state.tierResolved,
}));
vi.mock('@/services/panel-gating', () => ({
  PanelGateReason: { NONE: 'NONE', ANONYMOUS: 'ANONYMOUS', FREE_TIER: 'FREE_TIER' },
  getPanelGateReason: () => state.gateReason,
  resolveBillingAwareGateReason: (reason: string) =>
    state.billingRefined ? 'PAYMENT_ON_HOLD' : reason,
}));
vi.mock('@/services/billing', () => ({
  onSubscriptionChange: (listener: () => void) => {
    billingListeners.push(listener);
    return unsubBilling;
  },
}));
vi.mock('@/services/analytics', () => analytics);
vi.mock('@/services/upgrade-flow', () => ({ openUpgradeCheckout }));
vi.mock('@/utils/legal-links', () => ({
  createCheckoutConsentElement: () => {
    const el = document.createElement('div');
    el.className = 'checkout-consent-marker';
    return el;
  },
}));

const { ProPreviewSection } = await import('@/components/ProPreviewSection');

function makeSection() {
  return new ProPreviewSection({
    missionId: 'osint-newsroom',
    panelKey: 'gdelt-intel',
    previewId: 'intel-memory',
    unlockCopy: 'Pro unlocks intel memory.',
    renderSample: () => {
      const el = document.createElement('div');
      el.className = 'sample-marker';
      return el;
    },
  });
}

// Controllable IntersectionObserver: the component's viewed emit is
// visibility-gated (a render is not a view), so tests drive intersection
// explicitly via intersectAll().
const ioInstances: Array<{ cb: IntersectionObserverCallback; targets: Element[] }> = [];
function intersectAll(): void {
  for (const inst of ioInstances) {
    inst.cb(
      inst.targets.map((t) => ({ isIntersecting: true, target: t }) as IntersectionObserverEntry),
      {} as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.clearAllMocks();
  ioInstances.length = 0;
  billingListeners.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    private entry: { cb: IntersectionObserverCallback; targets: Element[] };
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, targets: [] };
      ioInstances.push(this.entry);
    }
    observe(el: Element) { this.entry.targets.push(el); }
    disconnect() { this.entry.targets.length = 0; }
    unobserve() {}
  });
  state.auth = { user: { id: 'u1' }, isPending: false };
  state.tierResolved = true;
  state.verification = 'verified';
  state.gateReason = 'FREE_TIER';
  state.billingRefined = false;
});

describe('R9 — uncertainty never upsells', () => {
  it('renders nothing while auth is pending', () => {
    state.auth = { user: null, isPending: true };
    const el = makeSection().getElement();
    expect(el.hidden).toBe(true);
    expect(el.querySelector('button')).toBeNull();
    expect(analytics.trackProPreviewViewed).not.toHaveBeenCalled();
  });

  it('renders nothing while entitlement verification is still running', () => {
    state.tierResolved = false;
    state.verification = 'pending';
    const el = makeSection().getElement();
    expect(el.hidden).toBe(true);
    expect(el.querySelector('button')).toBeNull();
  });

  it('renders nothing on terminal verification failure for a signed-in user', () => {
    state.tierResolved = false;
    state.verification = 'unavailable';
    const el = makeSection().getElement();
    expect(el.hidden).toBe(true);
    expect(el.textContent).not.toContain('Upgrade');
  });
});

describe('gating branches', () => {
  it('entitled users get nothing — the panel shows real content instead', () => {
    state.gateReason = 'NONE';
    const el = makeSection().getElement();
    expect(el.hidden).toBe(true);
    expect(analytics.trackProPreviewViewed).not.toHaveBeenCalled();
  });

  it('anonymous gets the sample and a Sign In branch without checkout consent', () => {
    state.auth = { user: null, isPending: false };
    state.gateReason = 'ANONYMOUS';
    const el = makeSection().getElement();
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.sample-marker')).not.toBeNull();
    expect(el.querySelector('.pro-preview__cta')?.textContent).toBe('Sign In');
    expect(el.querySelector('.checkout-consent-marker')).toBeNull();
    // Render alone is not a view — only intersection emits.
    expect(analytics.trackProPreviewViewed).not.toHaveBeenCalled();
    intersectAll();
    expect(analytics.trackProPreviewViewed).toHaveBeenCalledWith('osint-newsroom', 'gdelt-intel');
  });

  it('settled free gets sample, copy, consent, and an Upgrade CTA (viewed once)', () => {
    const section = makeSection();
    const el = section.getElement();
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.sample-marker')).not.toBeNull();
    expect(el.textContent).toContain('Pro unlocks intel memory.');
    expect(el.querySelector('.checkout-consent-marker')).not.toBeNull();
    expect(el.querySelector('.pro-preview__cta')?.textContent).toBe('Upgrade to Pro');
    // Below-fold renders never count; the first intersection counts once.
    expect(analytics.trackProPreviewViewed).not.toHaveBeenCalled();
    intersectAll();
    intersectAll();
    expect(analytics.trackProPreviewViewed).toHaveBeenCalledTimes(1);
  });
});

describe('CTA attribution', () => {
  it('routes the upgrade through the shared flow with mission attribution', async () => {
    const el = makeSection().getElement();
    (el.querySelector('.pro-preview__cta') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(openUpgradeCheckout).toHaveBeenCalled());
    expect(analytics.trackProPreviewCta).toHaveBeenCalledWith('osint-newsroom', 'gdelt-intel');
    expect(openUpgradeCheckout).toHaveBeenCalledWith({
      missionId: 'osint-newsroom',
      panelKey: 'gdelt-intel',
    });
  });
});

describe('billing limbo (#4771)', () => {
  it('a paying customer with a billing problem never sees a fresh-checkout CTA', () => {
    state.billingRefined = true;
    const el = makeSection().getElement();
    expect(el.hidden).toBe(true);
    expect(el.textContent).not.toContain('Upgrade');
    expect(analytics.trackProPreviewViewed).not.toHaveBeenCalled();
  });

  it('reacts when billing changes without an entitlement event', () => {
    const section = makeSection();
    expect(section.getElement().hidden).toBe(false);

    state.billingRefined = true;
    for (const listener of [...billingListeners]) listener();

    expect(section.getElement().hidden).toBe(true);
    expect(section.getElement().textContent).not.toContain('Upgrade');
  });
});

describe('teardown', () => {
  it('destroy() releases every subscription and detaches the element', () => {
    const host = document.createElement('div');
    const section = makeSection();
    host.appendChild(section.getElement());
    section.destroy();
    expect(unsubAuth).toHaveBeenCalledOnce();
    expect(unsubEnt).toHaveBeenCalledOnce();
    expect(unsubVer).toHaveBeenCalledOnce();
    expect(unsubBilling).toHaveBeenCalledOnce();
    expect(host.childElementCount).toBe(0);
  });
});

describe('dismissal (R8)', () => {
  it('persists across instances and reopens only on explicit interaction', () => {
    const first = makeSection();
    const dismiss = first.getElement().querySelector('.pro-preview__dismiss') as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss Pro preview');
    dismiss.click();
    expect(analytics.trackProPreviewDismissed).toHaveBeenCalledWith('osint-newsroom', 'gdelt-intel');
    expect(first.getElement().querySelector('.pro-preview__reopen')).not.toBeNull();

    // Simulated reload: a fresh instance sees the persisted dismissal.
    const second = makeSection();
    const el = second.getElement();
    expect(el.querySelector('.pro-preview__cta')).toBeNull();
    const reopen = el.querySelector('.pro-preview__reopen') as HTMLButtonElement;
    expect(reopen).not.toBeNull();
    reopen.click();
    expect(el.querySelector('.pro-preview__cta')?.textContent).toBe('Upgrade to Pro');
  });

  it('keeps dismiss and reopen decisions when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const section = makeSection();

    (section.getElement().querySelector('.pro-preview__dismiss') as HTMLButtonElement).click();
    expect(section.getElement().querySelector('.pro-preview__reopen')).not.toBeNull();

    (section.getElement().querySelector('.pro-preview__reopen') as HTMLButtonElement).click();
    expect(section.getElement().querySelector('.pro-preview__cta')).not.toBeNull();
  });
});
