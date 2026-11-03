/**
 * Telemetry URL redaction (#8369-1, re-cut). Vercel Analytics redacts per
 * event, the boot strip removes only params nobody reads, and DebugBear RUM
 * (tests/debugbear-rum.test.mts) holds its collector while the shared list
 * still matches the live URL. One list feeds all of them.
 *
 * Run: node --test tests/telemetry-url-redaction.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  redactAnalyticsUrl,
  stripSensitiveParamsFromUrl,
} from '../src/bootstrap/secondary-startup.ts';
import {
  SENSITIVE_URL_PARAM_RE,
  redactSensitiveUrl,
  urlCarriesSensitiveParams,
} from '../shared/sensitive-url-params.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('Vercel Analytics URL redaction', () => {
  it('strips checkout secrets, invite tokens, referral, and Clerk params', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard?email=a@b.com&license_key=SEKRET&subscription_id=sub_1&payment_id=pay_1&accept-business-invite=g1&token=tok123&access_token=qsecret&ref=abc&wm_referral=xyz&__clerk_handshake=h&__clerk_ticket=t&__clerk_foo=bar&checkoutProduct=pro&checkoutDiscount=SAVE&tab=news',
    });
    // Parsed params, never substrings: URLSearchParams re-encodes '@' as %40,
    // so `!includes('a@b.com')` could not fail.
    const params = new URL(redacted.url).searchParams;
    for (const key of ['email', 'license_key', 'subscription_id', 'payment_id', 'accept-business-invite', 'token', 'access_token', 'ref', 'wm_referral', '__clerk_handshake', '__clerk_ticket', '__clerk_foo', 'checkoutProduct', 'checkoutDiscount']) {
      assert.equal(params.get(key), null, `${key} must be redacted`);
    }
    assert.equal(params.get('tab'), 'news', 'benign params survive');
  });

  it('keeps a redacted absolute URL absolute', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard?token=tok123&tab=news',
    });
    assert.ok(redacted.url.startsWith('https://www.worldmonitor.app/'), redacted.url);
  });

  it('scrubs OAuth-style hash fragments without a ?', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard#access_token=xyz&token_type=Bearer',
    });
    assert.ok(!redacted.url.includes('xyz'));
  });

  it('scrubs fragment-carried params', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard#/r?ref=abc&checkoutProduct=pro&keep=1',
    });
    assert.ok(!redacted.url.includes('ref=abc'));
    assert.ok(!redacted.url.includes('checkoutProduct'));
    assert.ok(redacted.url.includes('keep=1'));
  });

  it('keeps a redacted relative URL relative', () => {
    assert.equal(redactSensitiveUrl('/dashboard?ref=abc&tab=news', 'https://www.worldmonitor.app'), '/dashboard?tab=news');
    assert.equal(redactSensitiveUrl('/?ref=abc', 'https://www.worldmonitor.app'), '/');
  });

  it('returns the original event object when nothing is sensitive', () => {
    const event = { type: 'pageview', url: 'https://www.worldmonitor.app/dashboard?tab=news' } as const;
    assert.equal(redactAnalyticsUrl(event), event);
  });

  it('beforeSend redacts before sampling, so no sampled event skips redaction', () => {
    const src = read('src/bootstrap/secondary-startup.ts');
    assert.match(src, /beforeSend:\s*\(event\)\s*=>\s*\{\s*const redacted = redactAnalyticsUrl\(event\);/);
  });
});

describe('boot-time URL strip', () => {
  function runBootStrip(href: string): string[] {
    const replaced: string[] = [];
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href },
        history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      },
    });
    try {
      stripSensitiveParamsFromUrl();
      return replaced;
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  }

  it('removes unread secrets (email, license_key)', () => {
    const replaced = runBootStrip('https://www.worldmonitor.app/dashboard?email=a@b.com&license_key=SEKRET&tab=news');
    assert.equal(replaced.length, 1);
    const params = new URLSearchParams(replaced[0]!.split('?')[1]);
    assert.equal(params.get('email'), null);
    assert.equal(params.get('license_key'), null);
    assert.equal(params.get('tab'), 'news');
  });

  it('preserves params deferred consumers must still read', () => {
    // captureReferralFromUrl, capturePendingCheckoutIntentFromUrl, the invite
    // acceptor, handleCheckoutReturn, and the Clerk SDK (__clerk_status /
    // __clerk_ticket, read after requestIdleCallback) all run after main.ts.
    for (const href of [
      'https://www.worldmonitor.app/dashboard?ref=abc&checkoutProduct=pro&accept-business-invite=g1&token=tok123&subscription_id=sub_1&tab=news',
      'https://www.worldmonitor.app/?__clerk_status=verified&__clerk_created_session=sess_1&__clerk_ticket=tkt_1',
      'https://www.worldmonitor.app/dashboard#/r?ref=abc&checkoutProduct=pro',
    ]) {
      assert.equal(runBootStrip(href).length, 0, href);
    }
  });

  it('runs in main.ts before analytics and RUM init', () => {
    const main = read('src/main.ts');
    const strip = main.indexOf('stripSensitiveParamsFromUrl();');
    assert.ok(strip > 0, 'main.ts must call stripSensitiveParamsFromUrl()');
    assert.ok(strip < main.indexOf('void initAnalytics();'));
    assert.ok(strip < main.indexOf('initVercelAnalytics();'));
    assert.ok(strip < main.indexOf('initDebugBearRum();'));
  });
});

describe('one sensitive-param list for every telemetry vendor', () => {
  it('the DebugBear gate matches exactly what analytics redacts', () => {
    for (const key of ['ref', 'wm_referral', 'accept-business-invite', 'token', 'invite_token', '__clerk_ticket', '__clerk_status', '__clerk_handshake', 'checkoutReferral', 'email', 'license_key']) {
      const href = `https://www.worldmonitor.app/dashboard?${key}=v&tab=news`;
      assert.equal(urlCarriesSensitiveParams(href), true, `${key} must hold DebugBear`);
      const redacted = redactAnalyticsUrl({ type: 'pageview', url: href });
      assert.equal(new URL(redacted.url).searchParams.get(key), null, `${key} must be redacted for Vercel`);
    }
    assert.equal(urlCarriesSensitiveParams('https://www.worldmonitor.app/dashboard?tab=news&utm_source=x'), false);
    assert.equal(urlCarriesSensitiveParams(undefined), false);
  });

  it('Vercel, Umami, and both DebugBear loaders import the shared list', () => {
    for (const rel of ['src/bootstrap/secondary-startup.ts', 'src/services/analytics.ts', 'src/bootstrap/debugbear-rum.ts', 'pro-test/src/debugbear-rum.ts']) {
      assert.match(read(rel), /sensitive-url-params/, `${rel} must use the shared list`);
    }
    assert.ok(SENSITIVE_URL_PARAM_RE.test('__clerk_db_jwt'));
  });
});
