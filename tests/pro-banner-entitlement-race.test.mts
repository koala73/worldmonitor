/**
 * #5728 — Pro banner must not mount for entitled users during the
 * Clerk-hydration / entitlement-unknown window, and the pre-paint strip
 * must honor a cached entitlement hint.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  applyProBannerEntitlementHint,
  decideProBannerMount,
  isPremiumEntitlementHint,
  resolveBannerPremium,
  PRO_BANNER_ENTITLEMENT_HINT_KEY,
  PRO_BANNER_ENTITLEMENT_HINT_VALUE,
  type ProBannerDecisionInput,
} from '@/services/pro-banner-policy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const base = (overrides: Partial<ProBannerDecisionInput> = {}): ProBannerDecisionInput => ({
  inIframe: false,
  dismissed: false,
  hasPremiumAccess: false,
  premiumHint: false,
  authPending: false,
  clerkConfigured: true,
  signedIn: false,
  entitlementLoaded: false,
  ...overrides,
});

describe('decideProBannerMount (#5728)', () => {
  it('suppresses in iframes and when dismissed', () => {
    assert.equal(decideProBannerMount(base({ inIframe: true })), 'suppress');
    assert.equal(decideProBannerMount(base({ dismissed: true })), 'suppress');
  });

  it('suppresses whenever live premium access is true', () => {
    assert.equal(decideProBannerMount(base({ hasPremiumAccess: true })), 'suppress');
    assert.equal(
      decideProBannerMount(base({
        hasPremiumAccess: true,
        authPending: true,
        premiumHint: false,
      })),
      'suppress',
    );
  });

  it('defers while Clerk auth is still hydrating (the init race)', () => {
    // getCurrentClerkUser() is null during this window even for cookie-backed
    // Pro sessions — the old signed-in-only guard skipped and mounted the upsell.
    assert.equal(
      decideProBannerMount(base({
        authPending: true,
        clerkConfigured: true,
        signedIn: false,
        entitlementLoaded: false,
      })),
      'defer',
    );
  });

  it('suppresses (no empty reserved strip) when a premium hint exists during hydration', () => {
    assert.equal(
      decideProBannerMount(base({
        authPending: true,
        clerkConfigured: true,
        premiumHint: true,
      })),
      'suppress',
    );
  });

  it('defers for signed-in users until the first entitlement snapshot', () => {
    assert.equal(
      decideProBannerMount(base({
        signedIn: true,
        entitlementLoaded: false,
        authPending: false,
      })),
      'defer',
    );
  });

  it('mounts for settled signed-out free users (and clears stale hints via caller)', () => {
    assert.equal(
      decideProBannerMount(base({
        signedIn: false,
        authPending: false,
        entitlementLoaded: false,
        premiumHint: true, // stale after sign-out
      })),
      'mount',
    );
  });

  it('mounts for signed-in free users once entitlement is loaded', () => {
    assert.equal(
      decideProBannerMount(base({
        signedIn: true,
        entitlementLoaded: true,
        hasPremiumAccess: false,
      })),
      'mount',
    );
  });

  it('does not stick on authPending when Clerk is not configured', () => {
    // Without a publishable key, isPending never settles — still show free upsell.
    assert.equal(
      decideProBannerMount(base({
        authPending: true,
        clerkConfigured: false,
        signedIn: false,
      })),
      'mount',
    );
  });

  it('mounts after authPending clears even when Clerk permanently failed to load', () => {
    // clerk.ts notifies pending subscribers on initClerk failure so
    // isPending flips false with signedIn still false — free upsell must appear.
    assert.equal(
      decideProBannerMount(base({
        authPending: false,
        clerkConfigured: true,
        signedIn: false,
        entitlementLoaded: false,
      })),
      'mount',
    );
  });
});

describe('resolveBannerPremium (#5728 sign-out + local keys)', () => {
  it('treats settled signed-out without local unlock as free despite stale raw premium', () => {
    assert.deepEqual(
      resolveBannerPremium({
        authPending: false,
        signedIn: false,
        localUnlockPremium: false,
        rawPremium: true, // stale isEntitled from previous account
        accountBackedPremium: true,
      }),
      { premium: false, accountBacked: false },
    );
  });

  it('keeps local unlock premium when signed out (desktop / tester keys)', () => {
    assert.deepEqual(
      resolveBannerPremium({
        authPending: false,
        signedIn: false,
        localUnlockPremium: true,
        rawPremium: true,
        accountBackedPremium: false,
      }),
      { premium: true, accountBacked: false },
    );
  });

  it('reports account-backed when Convex/Clerk pro while signed in', () => {
    assert.deepEqual(
      resolveBannerPremium({
        authPending: false,
        signedIn: true,
        localUnlockPremium: false,
        rawPremium: true,
        accountBackedPremium: true,
      }),
      { premium: true, accountBacked: true },
    );
  });

  it('defers to raw premium while auth is still pending', () => {
    assert.deepEqual(
      resolveBannerPremium({
        authPending: true,
        signedIn: false,
        localUnlockPremium: false,
        rawPremium: false,
        accountBackedPremium: false,
      }),
      { premium: false, accountBacked: false },
    );
  });
});

describe('entitlement hint helpers', () => {
  it('recognizes only the canonical pro value', () => {
    assert.equal(isPremiumEntitlementHint(PRO_BANNER_ENTITLEMENT_HINT_VALUE), true);
    assert.equal(isPremiumEntitlementHint('1'), false);
    assert.equal(isPremiumEntitlementHint(null), false);
    assert.equal(isPremiumEntitlementHint(''), false);
  });

  it('applyProBannerEntitlementHint writes and clears the shared key', () => {
    const store = new Map<string, string>();
    const storage = {
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    applyProBannerEntitlementHint(storage, true);
    assert.equal(store.get(PRO_BANNER_ENTITLEMENT_HINT_KEY), PRO_BANNER_ENTITLEMENT_HINT_VALUE);
    applyProBannerEntitlementHint(storage, false);
    assert.equal(store.has(PRO_BANNER_ENTITLEMENT_HINT_KEY), false);
  });
});

describe('pre-paint reservation honors entitlement hint', () => {
  function runPrepaint(storageSeed: Record<string, string>): Set<string> {
    const html = readFileSync(resolve(root, 'index.html'), 'utf-8');
    const script = html.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/);
    assert.ok(script, 'Expected data-wm-prepaint script');

    const classes = new Set<string>();
    const storage = new Map(Object.entries(storageSeed));
    const windowObj: { self?: unknown; top?: unknown } = {};
    windowObj.self = windowObj;
    windowObj.top = windowObj;

    runInNewContext(script[1], {
      document: {
        documentElement: {
          dataset: {},
          classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
          },
          removeAttribute: () => {},
        },
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
      location: { hostname: 'www.worldmonitor.app' },
      window: windowObj,
      Date,
    });
    return classes;
  }

  it('reserves the banner strip for free visitors without a dismiss or hint', () => {
    const classes = runPrepaint({});
    assert.ok(classes.has('wm-pro-banner-reserved'));
  });

  it('does not reserve when the entitlement hint says pro', () => {
    const classes = runPrepaint({
      [PRO_BANNER_ENTITLEMENT_HINT_KEY]: PRO_BANNER_ENTITLEMENT_HINT_VALUE,
    });
    assert.equal(classes.has('wm-pro-banner-reserved'), false);
  });

  it('still skips reservation when dismissed (even without a pro hint)', () => {
    const classes = runPrepaint({
      'wm-pro-banner-launched-dismissed': String(Date.now()),
    });
    assert.equal(classes.has('wm-pro-banner-reserved'), false);
  });
});

describe('wiring contracts (#5728)', () => {
  it('ProBanner uses account-backed resolution and auth/entitlement retries', () => {
    const src = readFileSync(resolve(root, 'src/components/ProBanner.ts'), 'utf-8');
    assert.match(src, /decideProBannerMount\(/);
    assert.match(src, /resolveBannerPremium\(/);
    assert.match(src, /subscribeAuthState\(/);
    assert.match(src, /isClerkAuthEnabled\(/);
    assert.match(src, /accountBacked/);
    assert.match(src, /hasLocalUnlockPremium/);
    assert.match(src, /writePremiumHint\(true\)/);
    assert.match(src, /writePremiumHint\(false\)/);
  });

  it('Clerk load failure settles pending auth subscribers without dropping the queue', () => {
    const src = readFileSync(resolve(root, 'src/services/clerk.ts'), 'utf-8');
    assert.match(src, /notifyPendingSubscribersOfHydrationFailure\(/);
    assert.match(
      src,
      /catch \(e\) \{[\s\S]*?notifyPendingSubscribersOfHydrationFailure\(\);[\s\S]*?throw e;/,
    );
    // Must NOT splice the queue on failure — a later successful retry still needs attachPendingSubscribers.
    const failureFn = src.match(
      /function notifyPendingSubscribersOfHydrationFailure\(\): void \{[\s\S]*?\n\}/,
    )?.[0] ?? '';
    assert.ok(failureFn.includes('for (const cb of pendingSubscribers)'));
    assert.doesNotMatch(failureFn, /\.splice\(/);
  });

  it('resetEntitlementState notifies listeners so free surfaces re-evaluate', () => {
    const src = readFileSync(resolve(root, 'src/services/entitlements.ts'), 'utf-8');
    assert.match(
      src,
      /export function resetEntitlementState\(\): void \{[\s\S]*?for \(const cb of listeners\)/,
    );
    assert.match(src, /cb\(null\)/);
  });

  it('checkout success paths write the pro banner entitlement hint', () => {
    const checkout = readFileSync(resolve(root, 'src/services/checkout.ts'), 'utf-8');
    assert.match(checkout, /applyProBannerEntitlementHint\(localStorage, true\)/);
    const ret = readFileSync(resolve(root, 'src/services/checkout-return.ts'), 'utf-8');
    assert.match(ret, /markJustPaidProBannerHint/);
    assert.match(ret, /applyProBannerEntitlementHint\(localStorage, true\)/);
  });

  it('pre-paint script and policy share the same hint key/value', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf-8');
    const script = html.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.match(
      script,
      new RegExp(`localStorage\\.getItem\\('${PRO_BANNER_ENTITLEMENT_HINT_KEY}'\\)==='${PRO_BANNER_ENTITLEMENT_HINT_VALUE}'`),
    );
    assert.match(script, /!entitledHint\)document\.documentElement\.classList\.add\('wm-pro-banner-reserved'\)/);
  });

  it('CSP script-src still pins the updated pre-paint script hash', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf-8');
    const script = html.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const hash = createHash('sha256').update(script!).digest('base64');
    const vercel = readFileSync(resolve(root, 'vercel.json'), 'utf-8');
    assert.ok(
      vercel.includes(`'sha256-${hash}'`),
      `vercel.json CSP must include sha256-${hash} for the pre-paint script`,
    );
  });
});
