/**
 * The dashboard's Pro Yearly re-quote through the real dialog factory.
 * Confirming fades the quote dialog out and removes it 200 ms later, and the
 * factory skips a dialog whose id is still mounted. A refusal and fresh
 * quote that arrive inside that window must still reach the subscriber.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { showCheckoutConfirmDialog } from '@/services/checkout-dialog-factory';
import { runProAnnualSwitchFlow } from '@/services/pro-business-upgrade-dialog';
import type { ProBusinessUpgradeResponse } from '@/services/billing';

const QUOTE = {
  kind: 'preview',
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'pro_annual',
  chargeAmount: 10496,
  currency: 'USD',
  renewalAmount: 35999,
  renewalCurrency: 'USD',
  renewalDate: '2027-11-26T10:00:00Z',
  billingPeriod: 'annual',
  discounted: true,
  percentOff: 60,
} as unknown as ProBusinessUpgradeResponse;
const LIST_QUOTE = { ...QUOTE, chargeAmount: 33503, discounted: false, percentOff: null } as unknown as ProBusinessUpgradeResponse;

class PromoEnded extends Error {}

function confirmButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  const button = buttons.find((b) => b.textContent === 'Switch now');
  if (!button) throw new Error('no Switch now button');
  return button;
}

const openDialogText = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((d) => d.style.opacity !== '0')
    .map((d) => d.textContent ?? '');

afterEach(() => {
  document.body.replaceChildren();
});

describe('dashboard Pro Yearly re-quote dialog', () => {
  it('shows the fresh quote even when it arrives before the old dialog is removed', async () => {
    const replies: Array<() => Promise<ProBusinessUpgradeResponse>> = [
      async () => QUOTE,
      async () => { throw new PromoEnded('PROMO_ENDED'); },
      async () => LIST_QUOTE,
    ];
    await runProAnnualSwitchFlow({
      planKey: 'pro_monthly',
      fallback: () => { throw new Error('fallback ran'); },
      requestSwitch: () => replies.shift()!(),
      currentUserId: () => 'user_a',
      openPortal: () => {},
      afterSuccess: () => {},
      showDialog: showCheckoutConfirmDialog,
      errorKind: (err) => (err instanceof PromoEnded ? 'PROMO_ENDED' : null),
      reportError: () => {},
    });
    confirmButton().click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = openDialogText();
    expect(open).toHaveLength(1);
    expect(open[0]).toContain('The offer is no longer available and your plan has not changed.');
    expect(open[0]).toContain('$335.03');
  });
});
