/**
 * Wiring lock for the #4771 billing-aware UX surfaces.
 *
 * The banner and panel-layout are DOM modules that can't be imported under
 * `tsx --test` (no jsdom), so — per the repo's established pattern — this
 * locks the integration with source-text assertions. The pure state logic
 * itself is behavior-tested in tests/billing-state.test.mts.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('payment-failure-banner billing-state wiring (#4771)', () => {
  it('derives the banner from the shared billing UX state, not raw on_hold checks', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /deriveBillingUxState\(getSubscription\(\), getEntitlementState\(\), Date\.now\(\)\)/);
    assert.match(src, /getBillingBannerVariant\(/);
    assert.doesNotMatch(
      src,
      /sub\.status !== 'on_hold'/,
      'banner must not hand-roll on_hold detection anymore — billing-state.ts owns state derivation',
    );
  });

  it('re-renders on BOTH subscription and entitlement changes', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /onSubscriptionChange\(/);
    assert.match(src, /onEntitlementChange\(/);
  });

  it('scopes dismissal to the variant dismiss key and clears all keys on recovery', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /sessionStorage\.getItem\(variant\.dismissKey\)/);
    assert.match(src, /sessionStorage\.setItem\(variant\.dismissKey, '1'\)/);
    assert.match(src, /for \(const key of BILLING_BANNER_DISMISS_KEYS\) sessionStorage\.removeItem\(key\)/);
  });

  it('resolves banner copy through i18n with the variant keys', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /t\(variant\.messageKey\)/);
    assert.match(src, /t\(variant\.actionLabelKey\)/);
  });

  it('tears down a stale banner on variant switch and short-circuits same-variant re-renders', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    // A pending→failed transition must remove the old element and rebuild;
    // a same-variant event must not stack a duplicate. Dropping either half
    // ships stacked/stale banners invisibly (no jsdom in this suite).
    assert.match(
      src,
      /if \(existing\) \{\s*\n\s*if \(existingVariant === variant\.dismissKey\) return;\s*\n\s*existing\.remove\(\);\s*\n\s*\}/,
    );
    assert.match(src, /banner\.dataset\.variant = variant\.dismissKey;/);
  });

  it('every banner variant key resolves in en.json, and on_hold copy is byte-identical to the pre-#4771 banner', async () => {
    // Dynamic t(variant.messageKey) calls are invisible to the static i18n
    // key-existence gate, so lock key validity here instead.
    const en = JSON.parse(await read('src/locales/en.json')) as {
      components: { billingState: Record<string, string> };
    };
    const billingState = en.components.billingState;
    const { getBillingBannerVariant } = await import('../src/services/billing-state.ts');
    for (const state of ['on_hold', 'renewal_verification_pending', 'renewal_verification_failed'] as const) {
      const v = getBillingBannerVariant(state);
      assert.ok(v);
      for (const key of [v.messageKey, v.actionLabelKey]) {
        if (key === null) continue;
        const leaf = key.replace('components.billingState.', '');
        assert.equal(typeof billingState[leaf], 'string', `${key} must exist in en.json`);
      }
    }
    // Issue #4771 AC: the on_hold payment-failure banner remains intact.
    assert.equal(
      billingState.onHoldBannerMessage,
      'Payment failed. Update your payment method to keep your subscription active.',
    );
  });
});

describe('panel-layout billing-state wiring (#4771)', () => {
  it('refines FREE_TIER through the billing-aware resolver, hoisted once per gating pass', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(src, /const billingAwareFreeTier = resolveBillingAwareGateReason\(PanelGateReason\.FREE_TIER\);/);
    assert.match(src, /if \(reason === PanelGateReason\.FREE_TIER\) reason = billingAwareFreeTier;/);
  });

  it('re-runs panel gating when the subscription row changes (verification verdicts arrive there)', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(
      src,
      /unsubscribeSubscriptionChange = onSubscriptionChange\(\(\) => \{\s*\n\s*this\.updatePanelGating\(getAuthState\(\)\);/,
    );
  });

  it('routes billing-portal gate actions through the popup-blocker-safe pre-reserve pattern', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(src, /case PanelGateReason\.PAYMENT_ON_HOLD:\s*\n\s*case PanelGateReason\.RENEWAL_FAILED:/);
    assert.match(src, /prereserveBillingPortalTab\(\)/);
  });
});

describe('widget-agent structured billing denial (#4771)', () => {
  it('returns the structured billing-verification denial before the generic 403', async () => {
    const src = await read('api/widget-agent.ts');
    assert.match(src, /getBillingVerificationDenial/, 'widget-agent must import/use the shared denial helper');
    const denialIdx = src.indexOf('getBillingVerificationDenial(ent');
    const genericIdx = src.indexOf("json({ error: 'Pro subscription required' }, 403");
    assert.ok(denialIdx > 0, 'billing denial must be evaluated with the fetched entitlements');
    assert.ok(genericIdx > 0, 'generic 403 fallback should remain for true free users');
    assert.ok(
      denialIdx < genericIdx,
      'billing-verification denial must run BEFORE the generic Pro-subscription-required 403',
    );
  });
});

describe('Panel CTA copy coverage (#4771)', () => {
  it('has a gated-CTA entry for every billing gate reason', async () => {
    const src = await read('src/components/Panel.ts');
    for (const reason of ['PAYMENT_ON_HOLD', 'RENEWAL_PENDING', 'RENEWAL_FAILED', 'LAPSED']) {
      assert.match(
        src,
        new RegExp(`case PanelGateReason\\.${reason}:`),
        `gatedCtaEntry must cover PanelGateReason.${reason} — a missing entry silently skips the lock`,
      );
    }
  });

  it('billing CTA keys stay OUT of the first-paint shell namespaces', async () => {
    const src = await read('src/components/Panel.ts');
    const billingKeys = src.match(/t\('components\.billingState\.[a-zA-Z]+'\)/g) ?? [];
    assert.equal(billingKeys.length, 8, 'expected the 8 billing-state CTA strings');
    assert.doesNotMatch(
      src,
      /t\('premium\.billing/,
      'premium.* is shell-inlined at first paint; billing CTA copy must live under components.billingState',
    );
  });
});

describe('returning-subscriber surfaces (#4799)', () => {
  it('uses the lapsed billing state and prior plan on the Pro banner', async () => {
    const src = await read('src/components/ProBanner.ts');
    assert.match(src, /deriveBillingUxState\(/);
    assert.match(src, /onSubscriptionChange\(/);
    assert.match(src, /components\.billingState\.lapsedDesc/);
    assert.match(src, /components\.billingState\.resubscribe/);
    assert.match(src, /getReactivationHref\(/);
    assert.match(src, /cancelPendingBannerRemoval\(\)/);
    assert.match(src, /pendingBannerRemoval/);
    assert.match(
      src,
      /if \(dismissedThisSession\) return;\s+cancelPendingBannerRemoval\(\);\s+bannerEl\?\.classList\.remove\('pro-banner-out'\);/,
      'reversed entitlement fades must restore visibility without cancelling explicit dismissals',
    );
  });

  it('uses the lapsed billing state and prior plan in Unified Settings', async () => {
    const src = await read('src/components/UnifiedSettings.ts');
    assert.match(src, /deriveBillingUxState\(/);
    assert.match(src, /onSubscriptionChange\(/);
    assert.match(src, /components\.billingState\.lapsedDesc/);
    assert.match(src, /components\.billingState\.resubscribe/);
    assert.match(src, /getReactivationHref\(/);
  });

  it('lets the pricing page honor a returning subscriber plan preference', async () => {
    const src = await read('pro-test/src/components/PricingSection.tsx');
    assert.match(src, /wm_reactivate_plan/);
    assert.match(src, /endsWith\('_annual'\)/);
  });
});
