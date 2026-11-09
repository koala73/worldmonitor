/**
 * Regression coverage for the /pro checkout-intent-via-URL flow
 * introduced after reviewer flagged the module-state surprise-purchase
 * bug. Covers the three behavioral scenarios the reviewer asked for
 * manual smoke-testing, at the pure-function level.
 *
 * The full flow (openSignIn + Clerk redirect + doCheckout) requires a
 * browser + Clerk + Dodo SDK and is covered by manual smoke tests
 * documented in the PR description. This file exercises the boundary
 * between URL state and resume decision — the bit most likely to rot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCheckoutIntentFromSearch,
  stripCheckoutIntentFromSearch,
  buildCheckoutReturnUrl,
  CHECKOUT_PRODUCT_PARAM,
  CHECKOUT_REF_PARAM,
  CHECKOUT_DISCOUNT_PARAM,
  CHECKOUT_ATTRIBUTION_PARAM,
} from '../pro-test/src/services/checkout-intent-url.ts';
import {
  CHECKOUT_ACCOUNT_PARAM,
  CHECKOUT_HANDOFF_PARAM,
  CHECKOUT_MISSION_PARAM,
  CHECKOUT_PANEL_PARAM,
} from '../shared/checkout-attribution.ts';

// sha256("user_1") prefix, pinned in checkout-account-fingerprint.test.mts.
const FINGERPRINT = '79b0aa0042b3c056';

describe('parseCheckoutIntentFromSearch', () => {
  it('returns null when no productId param is present (normal page load)', () => {
    assert.equal(parseCheckoutIntentFromSearch(''), null);
    assert.equal(parseCheckoutIntentFromSearch('?foo=bar'), null);
    assert.equal(parseCheckoutIntentFromSearch('?ref=someone'), null);
  });

  it('returns intent with just productId when only the required param is present', () => {
    const intent = parseCheckoutIntentFromSearch(`?${CHECKOUT_PRODUCT_PARAM}=pro_monthly`);
    assert.deepEqual(intent, {
      productId: 'pro_monthly',
      referralCode: undefined,
      discountCode: undefined,
      attributionSource: undefined,
    });
  });

  it('returns full intent with optional referralCode + discountCode', () => {
    const intent = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_annual&${CHECKOUT_REF_PARAM}=abc123&${CHECKOUT_DISCOUNT_PARAM}=SAVE20`,
    );
    assert.deepEqual(intent, {
      productId: 'pro_annual',
      referralCode: 'abc123',
      discountCode: 'SAVE20',
      attributionSource: undefined,
    });
  });

  it('returns attributionSource when the MCP paid-funnel param is present (#6716)', () => {
    const intent = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_ATTRIBUTION_PARAM}=mcp-paid-funnel`,
    );
    assert.deepEqual(intent, {
      productId: 'pro_monthly',
      referralCode: undefined,
      discountCode: undefined,
      attributionSource: 'mcp-paid-funnel',
    });
  });

  it('parses only registered mission preview attribution and a desktop handoff', () => {
    const intent = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_MISSION_PARAM}=energy-security`
      + `&${CHECKOUT_PANEL_PARAM}=pipeline-status&${CHECKOUT_HANDOFF_PARAM}=desktop`,
    );
    assert.deepEqual(intent?.checkoutAttribution, {
      kind: 'mission-preview',
      missionId: 'energy-security',
      panelKey: 'pipeline-status',
    });
    assert.equal(intent?.desktopHandoff, true);

    const mismatched = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_MISSION_PARAM}=energy-security`
      + `&${CHECKOUT_PANEL_PARAM}=cii`,
    );
    assert.equal(mismatched?.checkoutAttribution, undefined);
  });

  it('parses the desktop account fingerprint only with the handoff (#10342)', () => {
    const bound = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_HANDOFF_PARAM}=desktop`
      + `&${CHECKOUT_ACCOUNT_PARAM}=${FINGERPRINT}`,
    );
    assert.equal(bound?.desktopHandoff, true);
    assert.equal(bound?.accountFingerprint, FINGERPRINT);

    // No handoff: nothing on /pro consumes the fingerprint, so it is not an intent field.
    const web = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_ACCOUNT_PARAM}=${FINGERPRINT}`,
    );
    assert.equal(web?.accountFingerprint, undefined);

    // Malformed value: dropped, the handoff itself survives.
    const bad = parseCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_HANDOFF_PARAM}=desktop&${CHECKOUT_ACCOUNT_PARAM}=user_1`,
    );
    assert.equal(bad?.desktopHandoff, true);
    assert.equal(bad?.accountFingerprint, undefined);
  });

  it('ignores unrelated query params', () => {
    const intent = parseCheckoutIntentFromSearch(
      `?utm_source=email&${CHECKOUT_PRODUCT_PARAM}=pro_monthly&utm_campaign=launch`,
    );
    assert.deepEqual(intent, {
      productId: 'pro_monthly',
      referralCode: undefined,
      discountCode: undefined,
      attributionSource: undefined,
    });
  });

  it('rejects empty productId (defensive)', () => {
    // URLSearchParams treats "?x=" as x present with empty string.
    // parser requires a truthy value — empty string is rejected like
    // missing, so a malformed URL can't surprise-trigger checkout with
    // an empty productId that doCheckout would then fail on anyway.
    assert.equal(parseCheckoutIntentFromSearch(`?${CHECKOUT_PRODUCT_PARAM}=`), null);
  });
});

describe('stripCheckoutIntentFromSearch', () => {
  it('returns empty string when only checkout-intent params were present', () => {
    assert.equal(
      stripCheckoutIntentFromSearch(`?${CHECKOUT_PRODUCT_PARAM}=pro_monthly`),
      '',
    );
    assert.equal(
      stripCheckoutIntentFromSearch(
        `?${CHECKOUT_PRODUCT_PARAM}=pro_annual&${CHECKOUT_REF_PARAM}=abc&${CHECKOUT_DISCOUNT_PARAM}=X`,
      ),
      '',
    );
  });

  it('preserves unrelated query params (utm, ref for /pro itself, etc.)', () => {
    const result = stripCheckoutIntentFromSearch(
      `?utm_source=email&${CHECKOUT_PRODUCT_PARAM}=pro_monthly&utm_campaign=launch`,
    );
    // URLSearchParams preserves insertion order for the surviving
    // params, so utm_source comes before utm_campaign in the result.
    assert.equal(result, '?utm_source=email&utm_campaign=launch');
  });

  it('returns empty string for empty input', () => {
    assert.equal(stripCheckoutIntentFromSearch(''), '');
  });

  it('strips all three checkout params together (partial cleanup would leave ghosts)', () => {
    const result = stripCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=X&${CHECKOUT_REF_PARAM}=Y&${CHECKOUT_DISCOUNT_PARAM}=Z&keep=me`,
    );
    assert.equal(result, '?keep=me');
  });

  it('strips mission preview intent', () => {
    const result = stripCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=X&${CHECKOUT_MISSION_PARAM}=crisis-desk`
      + `&${CHECKOUT_PANEL_PARAM}=cii&keep=me`,
    );
    assert.equal(result, '?keep=me');
  });

  it('keeps the desktop handoff marker and account fingerprint (#10342)', () => {
    // They say where this tab came from; only the product param triggers a
    // resume. Stripping them made the click after a dismissed account dialog,
    // or after a reload, an unchecked purchase with no desktop return.
    const result = stripCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=X&${CHECKOUT_HANDOFF_PARAM}=desktop`
      + `&${CHECKOUT_ACCOUNT_PARAM}=${FINGERPRINT}&keep=me`,
    );
    const kept = new URLSearchParams(result);
    assert.equal(kept.has(CHECKOUT_PRODUCT_PARAM), false);
    assert.equal(kept.get(CHECKOUT_HANDOFF_PARAM), 'desktop');
    assert.equal(kept.get(CHECKOUT_ACCOUNT_PARAM), FINGERPRINT);
    assert.equal(kept.get('keep'), 'me');
    // And the kept context alone is not an intent: a reload cannot re-fire.
    assert.equal(parseCheckoutIntentFromSearch(result), null);
  });

  it('is idempotent — second call on a stripped URL is a no-op', () => {
    const once = stripCheckoutIntentFromSearch(
      `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&keep=1`,
    );
    const twice = stripCheckoutIntentFromSearch(once);
    assert.equal(twice, once);
  });
});

describe('buildCheckoutReturnUrl', () => {
  it('appends checkout params to a clean current URL', () => {
    const returnUrl = buildCheckoutReturnUrl('https://worldmonitor.app/pro', 'pro_monthly');
    const url = new URL(returnUrl);
    assert.equal(url.searchParams.get(CHECKOUT_PRODUCT_PARAM), 'pro_monthly');
    assert.equal(url.searchParams.get(CHECKOUT_REF_PARAM), null);
    assert.equal(url.searchParams.get(CHECKOUT_DISCOUNT_PARAM), null);
  });

  it('overwrites stale checkout params when the user clicks a different tier', () => {
    // User clicks Pro, dismisses sign-in, clicks Enterprise. returnUrl
    // for the second click must not carry Pro's intent.
    const firstClick = buildCheckoutReturnUrl('https://worldmonitor.app/pro', 'pro_monthly');
    const secondClick = buildCheckoutReturnUrl(firstClick, 'enterprise');
    const url = new URL(secondClick);
    assert.equal(url.searchParams.get(CHECKOUT_PRODUCT_PARAM), 'enterprise');
    // Ensure no stacking — exactly one occurrence.
    assert.equal(url.searchParams.getAll(CHECKOUT_PRODUCT_PARAM).length, 1);
  });

  it('includes referralCode + discountCode when provided', () => {
    const returnUrl = buildCheckoutReturnUrl('https://worldmonitor.app/pro', 'pro_annual', {
      referralCode: 'abc',
      discountCode: 'SAVE20',
    });
    const url = new URL(returnUrl);
    assert.equal(url.searchParams.get(CHECKOUT_PRODUCT_PARAM), 'pro_annual');
    assert.equal(url.searchParams.get(CHECKOUT_REF_PARAM), 'abc');
    assert.equal(url.searchParams.get(CHECKOUT_DISCOUNT_PARAM), 'SAVE20');
  });

  it('preserves unrelated query params on the current URL (utm, etc.)', () => {
    const returnUrl = buildCheckoutReturnUrl(
      'https://worldmonitor.app/pro?utm_source=email',
      'pro_monthly',
    );
    const url = new URL(returnUrl);
    assert.equal(url.searchParams.get('utm_source'), 'email');
    assert.equal(url.searchParams.get(CHECKOUT_PRODUCT_PARAM), 'pro_monthly');
  });

  it('preserves pathname and hash (e.g., returning to /pro#enterprise)', () => {
    const returnUrl = buildCheckoutReturnUrl(
      'https://worldmonitor.app/pro#pricing',
      'pro_monthly',
    );
    const url = new URL(returnUrl);
    assert.equal(url.pathname, '/pro');
    assert.equal(url.hash, '#pricing');
  });

  it('carries preview attribution, desktop handoff and account fingerprint through sign-in', () => {
    // The fingerprint must survive the Clerk round trip: the account check
    // runs again when the post-sign-in resume fires (#10342).
    const returnUrl = buildCheckoutReturnUrl('https://worldmonitor.app/pro', 'pro_monthly', {
      checkoutAttribution: {
        missionId: 'crisis-desk',
        panelKey: 'cii',
      },
      desktopHandoff: true,
      accountFingerprint: FINGERPRINT,
    });
    const url = new URL(returnUrl);
    assert.equal(url.searchParams.get(CHECKOUT_MISSION_PARAM), 'crisis-desk');
    assert.equal(url.searchParams.get(CHECKOUT_PANEL_PARAM), 'cii');
    assert.equal(url.searchParams.get(CHECKOUT_HANDOFF_PARAM), 'desktop');
    assert.equal(url.searchParams.get(CHECKOUT_ACCOUNT_PARAM), FINGERPRINT);

    // Stale fingerprint from an earlier click is replaced, not stacked.
    const next = new URL(buildCheckoutReturnUrl(returnUrl, 'pro_annual', { desktopHandoff: true }));
    assert.equal(next.searchParams.has(CHECKOUT_ACCOUNT_PARAM), false);
  });
});

describe('reviewer scenario coverage (regression guards)', () => {
  it('scenario 1: click paid tier signed-out → sign in → checkout auto-resumes', () => {
    // 1. Signed-out click builds returnUrl with intent
    const returnUrl = buildCheckoutReturnUrl('https://worldmonitor.app/pro', 'pro_monthly', {
      referralCode: 'abc',
    });
    // 2. Clerk redirects user to returnUrl after successful sign-in
    // 3. /pro loads, tryResumeCheckoutFromUrl parses intent
    const search = new URL(returnUrl).search;
    const intent = parseCheckoutIntentFromSearch(search);
    // 4. Intent parsed; doCheckout fires with correct params
    assert.deepEqual(intent, {
      productId: 'pro_monthly',
      referralCode: 'abc',
      discountCode: undefined,
      attributionSource: undefined,
    });
  });

  it('scenario 2: click paid → dismiss sign-in → later generic sign-in does NOT resume', () => {
    // 1. User click creates returnUrl — but user never reaches Clerk's
    //    success handler (dismissed). No navigation happens; URL stays
    //    at the pre-click state (no intent params).
    const currentSearch = '?utm_source=email';  // typical marketing-page URL
    const intent = parseCheckoutIntentFromSearch(currentSearch);
    assert.equal(intent, null, 'no intent in URL because Clerk never redirected');
    // 2. Later, user clicks generic Sign In on /pro. That path calls
    //    c.openSignIn() without afterSignInUrl, so Clerk's default
    //    post-auth behavior applies — either no redirect or redirect
    //    to Clerk's configured afterSignInUrl (NOT our intent URL).
    // 3. The URL on their post-auth /pro page STILL has no intent.
    //    parseCheckoutIntentFromSearch returns null, no resume fires.
    //    Verified: the bug requires intent in URL, which requires
    //    checkout-initiated openSignIn, which requires a click on a
    //    paid tier. Generic sign-in cannot produce that URL.
  });

  it('scenario 3: reload after successful resume does NOT re-fire', () => {
    // 1. Post-redirect URL has intent
    const postRedirectSearch = `?${CHECKOUT_PRODUCT_PARAM}=pro_monthly&${CHECKOUT_REF_PARAM}=abc&utm=x`;
    const intent1 = parseCheckoutIntentFromSearch(postRedirectSearch);
    assert.equal(intent1?.productId, 'pro_monthly', 'first load parses intent');
    // 2. tryResumeCheckoutFromUrl strips intent BEFORE any await
    const stripped = stripCheckoutIntentFromSearch(postRedirectSearch);
    assert.equal(stripped, '?utm=x', 'intent params removed, utm preserved');
    // 3. User reloads the page → URL is stripped → parse returns null
    const intent2 = parseCheckoutIntentFromSearch(stripped);
    assert.equal(intent2, null, 'reload sees no intent, no re-fire');
  });
});
