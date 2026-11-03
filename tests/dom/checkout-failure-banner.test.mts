import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DODO_PRODUCTS } from '@/config/products';
import { resolveCheckoutContext } from '../../shared/checkout-attribution';
import { loadCheckoutAttempt, saveCheckoutAttempt } from '@/services/checkout-attempt';

const { startCheckout } = vi.hoisted(() => ({
  startCheckout: vi.fn(async () => true),
}));

vi.mock('@/bootstrap/sentry-defer', () => ({ enqueueSentryCall: vi.fn() }));
vi.mock('@/services/i18n', () => ({
  t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
}));
vi.mock('@/services/checkout', async () => ({
  ...await import('@/services/checkout-attempt'),
  startCheckout,
}));

import { showCheckoutFailureBanner } from '@/components/checkout-failure-banner';

function saveAttempt(productId: string) {
  saveCheckoutAttempt({
    version: 2,
    productId,
    startedAt: Date.now(),
    context: resolveCheckoutContext({ surface: 'dashboard' }),
  });
}

describe('checkout failure retry', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    startCheckout.mockReset();
    startCheckout.mockResolvedValue(true);
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  it('clears an invalid saved product and replaces retry with recovery feedback', async () => {
    saveAttempt('pro_monthly');
    showCheckoutFailureBanner('failed');
    document.querySelector<HTMLButtonElement>('#cf-retry-btn')?.click();

    await vi.waitFor(() => {
      expect(document.querySelector('#cf-retry-btn')).toBeNull();
    });
    expect(startCheckout).not.toHaveBeenCalled();
    expect(loadCheckoutAttempt()).toBeNull();
    expect(document.getElementById('checkout-failure-banner')?.textContent)
      .toContain("That product isn't available. Please refresh and try again.");
    expect(document.getElementById('cf-dismiss-btn')).not.toBeNull();
  });

  it('retries a valid saved product and removes the banner on success', async () => {
    saveAttempt(DODO_PRODUCTS.PRO_MONTHLY);
    showCheckoutFailureBanner('failed');
    document.querySelector<HTMLButtonElement>('#cf-retry-btn')?.click();

    await vi.waitFor(() => {
      expect(document.getElementById('checkout-failure-banner')).toBeNull();
    });
    expect(startCheckout).toHaveBeenCalledWith(DODO_PRODUCTS.PRO_MONTHLY, expect.any(Object), expect.any(Object));
  });

  it('keeps a valid attempt and re-enables retry after a temporary failure', async () => {
    startCheckout.mockResolvedValue(false);
    saveAttempt(DODO_PRODUCTS.PRO_MONTHLY);
    showCheckoutFailureBanner('failed');
    const retry = document.querySelector<HTMLButtonElement>('#cf-retry-btn')!;
    retry.click();
    expect(retry.disabled).toBe(true);

    await vi.waitFor(() => {
      expect(startCheckout).toHaveBeenCalledTimes(1);
      expect(retry.disabled).toBe(false);
    });
    expect(loadCheckoutAttempt()?.productId).toBe(DODO_PRODUCTS.PRO_MONTHLY);
    expect(retry.textContent).toBe('Try again');
  });
});
