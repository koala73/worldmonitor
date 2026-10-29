import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionInfo } from '@/services/billing';

const NOW = Date.now();
const DAY = 86_400_000;

const state = vi.hoisted(() => ({
  sub: null as unknown,
  subListeners: [] as Array<(sub: unknown) => void>,
  signedInEmail: 'elie.habib@example.com',
  updateBillingEmail: vi.fn(),
  openBillingPortal: vi.fn(async () => ({ outcome: 'opened', url: 'x' })),
}));

vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: vi.fn() }));
vi.mock('@/services/i18n', () => ({
  t: (key: string, options?: Record<string, unknown>) =>
    typeof options?.email === 'string' && options.email !== '' ? `${key}[${options.email}]` : key,
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => ({ user: { id: 'u1', name: 'Elie', email: state.signedInEmail, role: 'pro' }, isPending: false }),
}));
vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => ({ planKey: 'pro_monthly', validUntil: NOW + 30 * DAY }),
  onEntitlementChange: () => () => {},
}));
vi.mock('@/services/billing', () => ({
  getSubscription: () => state.sub,
  onSubscriptionChange: (cb: (sub: unknown) => void) => {
    state.subListeners.push(cb);
    cb(state.sub);
    return () => {};
  },
  openBillingPortal: state.openBillingPortal,
  prereserveBillingPortalTab: () => null,
  updateBillingEmail: state.updateBillingEmail,
}));

import { initPaymentFailureBanner } from '@/components/payment-failure-banner';

const BOUNCED = 'elie.habbi+<b>bold</b>@example.com';

function subscription(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    planKey: 'pro_monthly',
    displayName: 'Pro',
    status: 'active',
    currentPeriodEnd: NOW + 30 * DAY,
    renewalVerificationState: null,
    billingEmail: BOUNCED,
    billingEmailBounced: true,
    ...overrides,
  };
}

function setSubscription(sub: SubscriptionInfo | null): void {
  state.sub = sub;
  for (const cb of state.subListeners) cb(sub);
}

function banner(): HTMLElement | null {
  return document.getElementById('payment-failure-banner');
}

function submitForm(): void {
  document.querySelector<HTMLFormElement>('#pf-email-form')!
    .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

describe('payment-failure banner: bounced billing email', () => {
  let teardown: () => void = () => {};

  beforeEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    state.sub = null;
    state.subListeners = [];
    state.signedInEmail = 'elie.habib@example.com';
    state.updateBillingEmail.mockReset();
  });

  afterEach(() => {
    teardown();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  it('renders the amber variant with the address as text, not markup', () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();

    const el = banner()!;
    expect(el.dataset.variant).toBe('pf-banner-dismissed-billing-email-bounced');
    expect(el.querySelector('#pf-message')?.textContent)
      .toBe(`components.billingState.billingEmailBouncedMessage[${BOUNCED}]`);
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('#pf-fix-email-btn')).not.toBeNull();
    expect(el.querySelector('#pf-update-btn')).toBeNull();
  });

  it('on_hold plus a bounce shows the red banner with both actions', () => {
    state.sub = subscription({ status: 'on_hold' });
    teardown = initPaymentFailureBanner();

    const el = banner()!;
    expect(el.dataset.variant).toBe('pf-banner-dismissed-bounced');
    expect(el.querySelector('#pf-message')?.textContent)
      .toBe(`components.billingState.onHoldBannerMessage[${BOUNCED}]`);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button[data-action]')].map((b) => b.dataset.action);
    expect(buttons).toEqual(['billing-portal', 'fix-billing-email']);

    el.querySelector<HTMLButtonElement>('#pf-update-btn')!.click();
    expect(state.openBillingPortal).toHaveBeenCalledTimes(1);
  });

  it('a non-bounced active subscriber gets no banner', () => {
    state.sub = subscription({ billingEmailBounced: false });
    teardown = initPaymentFailureBanner();
    expect(banner()).toBeNull();
  });

  it('the repair form prefills the signed-in address, shows errors inline, and confirms on success', async () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();
    banner()!.querySelector<HTMLButtonElement>('#pf-fix-email-btn')!.click();

    const input = document.querySelector<HTMLInputElement>('#pf-email-input')!;
    expect(input.value).toBe('elie.habib@example.com');
    expect(banner()!.querySelector('#pf-message')).toBeNull();

    state.updateBillingEmail.mockRejectedValueOnce(
      Object.assign(new Error('suppressed'), { data: { kind: 'EMAIL_SUPPRESSED', reason: 'bounce' } }),
    );
    input.value = ' new@example.com ';
    submitForm();
    expect(input.disabled).toBe(true);
    expect(state.updateBillingEmail).toHaveBeenCalledWith('new@example.com');
    await vi.waitFor(() => {
      expect(document.getElementById('pf-email-error')?.textContent)
        .toBe('components.billingState.billingEmailSuppressed');
    });
    expect(input.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#pf-email-save-btn')?.disabled).toBe(false);

    state.updateBillingEmail.mockResolvedValueOnce({ email: 'new@example.com' });
    submitForm();
    await vi.waitFor(() => {
      expect(document.getElementById('pf-email-updated')?.textContent)
        .toBe('components.billingState.billingEmailUpdated[new@example.com]');
    });
    expect(document.querySelector('#pf-email-form')).toBeNull();

    // The reactive subscription update is what removes the banner.
    setSubscription(subscription({ billingEmail: 'new@example.com', billingEmailBounced: false }));
    expect(banner()).toBeNull();
  });

  it('leaves the prefill empty when the signed-in address is the one bouncing', () => {
    state.signedInEmail = BOUNCED.toUpperCase();
    state.sub = subscription();
    teardown = initPaymentFailureBanner();
    banner()!.querySelector<HTMLButtonElement>('#pf-fix-email-btn')!.click();
    expect(document.querySelector<HTMLInputElement>('#pf-email-input')!.value).toBe('');
  });

  it('cancel restores the notice, and an unrelated update keeps an open form', () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();
    banner()!.querySelector<HTMLButtonElement>('#pf-fix-email-btn')!.click();
    expect(document.querySelector('#pf-email-form')).not.toBeNull();

    setSubscription(subscription({ currentPeriodEnd: NOW + 31 * DAY }));
    expect(document.querySelector('#pf-email-form')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('#pf-email-cancel-btn')!.click();
    expect(document.querySelector('#pf-email-form')).toBeNull();
    expect(banner()!.querySelector('#pf-message')?.textContent)
      .toBe(`components.billingState.billingEmailBouncedMessage[${BOUNCED}]`);
  });

  it('a changed bounced address re-renders the text and the fix handler reads the new one', () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();

    setSubscription(subscription({ billingEmail: 'second@example.com' }));
    expect(banner()!.querySelector('#pf-message')?.textContent)
      .toBe('components.billingState.billingEmailBouncedMessage[second@example.com]');

    state.signedInEmail = 'SECOND@example.com';
    banner()!.querySelector<HTMLButtonElement>('#pf-fix-email-btn')!.click();
    // Prefill is empty only when the handler compared against the current address.
    expect(document.querySelector<HTMLInputElement>('#pf-email-input')!.value).toBe('');
  });

  it('an address change while the repair form is open leaves the form alone', () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();
    banner()!.querySelector<HTMLButtonElement>('#pf-fix-email-btn')!.click();
    const input = document.querySelector<HTMLInputElement>('#pf-email-input')!;
    input.value = 'typed@example.com';

    setSubscription(subscription({ billingEmail: 'second@example.com' }));
    expect(document.querySelector<HTMLInputElement>('#pf-email-input')).toBe(input);
    expect(input.value).toBe('typed@example.com');
  });

  it('dismissal is scoped to the bounce banner key and cleared on recovery', () => {
    state.sub = subscription();
    teardown = initPaymentFailureBanner();
    document.getElementById('pf-dismiss-btn')!.click();
    expect(banner()).toBeNull();
    expect(sessionStorage.getItem('pf-banner-dismissed-billing-email-bounced')).toBe('1');

    setSubscription(subscription({ billingEmailBounced: false }));
    expect(sessionStorage.getItem('pf-banner-dismissed-billing-email-bounced')).toBeNull();
  });
});
