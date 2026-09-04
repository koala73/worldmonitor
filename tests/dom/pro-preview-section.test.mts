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
};

const analytics = {
  trackProPreviewViewed: vi.fn(),
  trackProPreviewCta: vi.fn(),
  trackProPreviewDismissed: vi.fn(),
};
const startCheckout = vi.fn(async () => true);

vi.mock('@/services/auth-state', () => ({
  getAuthState: () => state.auth,
  subscribeAuthState: () => () => {},
}));
vi.mock('@/services/entitlements', () => ({
  getEntitlementVerificationStatus: () => state.verification,
  onEntitlementChange: () => () => {},
}));
vi.mock('@/services/widget-store', () => ({
  isProTierResolved: () => state.tierResolved,
}));
vi.mock('@/services/panel-gating', () => ({
  PanelGateReason: { NONE: 'NONE', ANONYMOUS: 'ANONYMOUS', FREE_TIER: 'FREE_TIER' },
  getPanelGateReason: () => state.gateReason,
}));
vi.mock('@/services/analytics', () => analytics);
vi.mock('@/services/checkout', () => ({ startCheckout }));
vi.mock('@/config/products', () => ({ DEFAULT_UPGRADE_PRODUCT: 'pdt_test' }));
vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => false }));
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

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  state.auth = { user: { id: 'u1' }, isPending: false };
  state.tierResolved = true;
  state.verification = 'verified';
  state.gateReason = 'FREE_TIER';
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
    expect(analytics.trackProPreviewViewed).toHaveBeenCalledTimes(1);
  });
});

describe('CTA attribution', () => {
  it('routes the upgrade through checkout with mission attribution', async () => {
    const el = makeSection().getElement();
    (el.querySelector('.pro-preview__cta') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(startCheckout).toHaveBeenCalled());
    expect(analytics.trackProPreviewCta).toHaveBeenCalledWith('osint-newsroom', 'gdelt-intel');
    expect(startCheckout).toHaveBeenCalledWith('pdt_test', undefined, {
      analyticsSurface: 'mission-preview',
      analyticsAttribution: { missionId: 'osint-newsroom', panelKey: 'gdelt-intel' },
    });
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
});
