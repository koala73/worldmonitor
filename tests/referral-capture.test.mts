/**
 * Locks the 7-day cross-session referral propagation behavior.
 * Covers URL capture (both accepted param names), stale-record
 * eviction, successful-attribution clear, and appendRefToUrl for the
 * /pro → dashboard hero-link bridge.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? (this.store.get(key) as string) : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

interface MutableLocation { href: string; pathname: string; search: string; hash: string; }

let _localStorage: MemoryStorage;
let _loc: MutableLocation;

function setUrl(href: string): void {
  const url = new URL(href);
  _loc.href = url.toString();
  _loc.pathname = url.pathname;
  _loc.search = url.search;
  _loc.hash = url.hash;
}

before(() => {
  _localStorage = new MemoryStorage();
  _loc = { href: 'https://worldmonitor.app/', pathname: '/', search: '', hash: '' };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: _localStorage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: _loc,
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
          if (url !== undefined && url !== null) setUrl(new URL(String(url), _loc.href).toString());
        },
      },
    },
  });
});

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

beforeEach(() => {
  _localStorage.clear();
  setUrl('https://worldmonitor.app/');
});

const {
  captureReferralFromUrl,
  loadActiveReferral,
  clearReferralOnAttribution,
  appendRefToUrl,
  isAffiliateCode,
  REFERRAL_CAPTURE_KEY,
  REFERRAL_TTL_MS,
} = await import('../src/services/referral-capture.ts');

describe('captureReferralFromUrl', () => {
  it('captures ?ref= into localStorage and strips from URL', () => {
    setUrl('https://worldmonitor.app/?ref=abc123');
    const captured = captureReferralFromUrl();
    assert.equal(captured, 'abc123');
    assert.equal(_loc.href, 'https://worldmonitor.app/');
    const raw = _localStorage.getItem(REFERRAL_CAPTURE_KEY);
    assert.ok(raw);
    const parsed = JSON.parse(raw as string);
    assert.equal(parsed.code, 'abc123');
    assert.equal(typeof parsed.capturedAt, 'number');
  });

  it('captures ?wm_referral= (dashboard-forward param name)', () => {
    setUrl('https://worldmonitor.app/?wm_referral=xyz789');
    const captured = captureReferralFromUrl();
    assert.equal(captured, 'xyz789');
    assert.equal(_loc.href, 'https://worldmonitor.app/');
  });

  it('prefers wm_referral over ref when both are present', () => {
    setUrl('https://worldmonitor.app/?ref=old&wm_referral=new');
    const captured = captureReferralFromUrl();
    assert.equal(captured, 'new');
    // Both should still be stripped from URL.
    assert.ok(!_loc.href.includes('ref='));
    assert.ok(!_loc.href.includes('wm_referral='));
  });

  it('returns null when no referral param is present', () => {
    setUrl('https://worldmonitor.app/?other=value');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_loc.href, 'https://worldmonitor.app/?other=value');
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('preserves non-referral query params when stripping', () => {
    setUrl('https://worldmonitor.app/?ref=abc&topic=brief');
    captureReferralFromUrl();
    assert.equal(_loc.href, 'https://worldmonitor.app/?topic=brief');
  });

  it('rejects invalid codes (whitespace, special chars) without crashing', () => {
    setUrl('https://worldmonitor.app/?ref=' + encodeURIComponent('<script>alert(1)</script>'));
    const captured = captureReferralFromUrl();
    assert.equal(captured, null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
    // But still strips the hostile param from the URL so it doesn't linger visibly.
    assert.ok(!_loc.href.includes('ref='));
  });

  it('rejects excessively long codes', () => {
    const huge = 'a'.repeat(100);
    setUrl(`https://worldmonitor.app/?ref=${huge}`);
    assert.equal(captureReferralFromUrl(), null);
  });

  it('accepts underscore and hyphen in codes', () => {
    setUrl('https://worldmonitor.app/?ref=some_code-v2');
    assert.equal(captureReferralFromUrl(), 'some_code-v2');
  });
});

describe('internal source tags are never affiliate codes', () => {
  it('strips ?ref=welcome-* without capturing it', () => {
    setUrl('https://worldmonitor.app/dashboard?ref=welcome-hero');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
    assert.equal(_loc.href, 'https://worldmonitor.app/dashboard');
  });

  it('strips ?wm_referral=welcome-* without capturing it', () => {
    setUrl('https://worldmonitor.app/dashboard?wm_referral=welcome-nav');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('rejects the seo-* corpus namespace too', () => {
    setUrl('https://worldmonitor.app/?ref=seo-country');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('is case-insensitive so a hand-typed tag cannot slip through', () => {
    setUrl('https://worldmonitor.app/?ref=Welcome-Hero');
    assert.equal(captureReferralFromUrl(), null);
  });

  it('still captures a real code riding alongside an internal tag', () => {
    setUrl('https://worldmonitor.app/dashboard?ref=welcome-hero&wm_referral=sharerA');
    assert.equal(captureReferralFromUrl(), 'sharerA');
    assert.equal(loadActiveReferral(), 'sharerA');
  });

  it('falls through to ref= when wm_referral carries the internal tag', () => {
    setUrl('https://worldmonitor.app/dashboard?wm_referral=welcome-hero&ref=sharerB');
    assert.equal(captureReferralFromUrl(), 'sharerB');
    assert.equal(loadActiveReferral(), 'sharerB');
  });

  it('evicts a stored internal tag captured before this guard existed', () => {
    // Real state on returning visitors: the welcome CTAs shipped `?ref=welcome-*`
    // for months, so live localStorage carries poisoned codes with up to 7 days
    // left on the clock. Reject them on read, not just on capture.
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ code: 'welcome-depth-n3', capturedAt: Date.now() }));
    assert.equal(loadActiveReferral(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('refuses to forward an internal tag through appendRefToUrl', () => {
    assert.equal(
      appendRefToUrl('https://worldmonitor.app/dashboard', 'welcome-final'),
      'https://worldmonitor.app/dashboard',
    );
  });

  it('leaves affiliate codes that merely contain the namespace word', () => {
    setUrl('https://worldmonitor.app/?ref=welcomehero');
    assert.equal(captureReferralFromUrl(), 'welcomehero');
    setUrl('https://worldmonitor.app/?ref=partner-welcome-x');
    assert.equal(captureReferralFromUrl(), 'partner-welcome-x');
  });

  it('rejects the bare namespace, not just its hyphenated children', () => {
    // `?ref=welcome` is a shape that already circulates (see the redirect
    // fixture in tests/pro-welcome-auth-probe.test.mts) — reserving
    // `welcome-` but not `welcome` would leave the plainest spelling open.
    setUrl('https://worldmonitor.app/?ref=welcome');
    assert.equal(captureReferralFromUrl(), null);
    setUrl('https://worldmonitor.app/?ref=seo');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('strips both params and stores nothing when each carries an internal tag', () => {
    setUrl('https://worldmonitor.app/dashboard?ref=welcome-hero&wm_referral=seo-country');
    assert.equal(captureReferralFromUrl(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
    assert.equal(_loc.href, 'https://worldmonitor.app/dashboard');
  });

  it('captures a real code that repeats the SAME param behind an internal tag', () => {
    // Deleting the param drops every occurrence, so reading only the first
    // value would silently discard the affiliate's code during the window
    // where cached welcome HTML still emits `?ref=welcome-*`.
    setUrl('https://worldmonitor.app/dashboard?ref=welcome-hero&ref=sharerC');
    assert.equal(captureReferralFromUrl(), 'sharerC');
    assert.equal(loadActiveReferral(), 'sharerC');
    assert.equal(_loc.href, 'https://worldmonitor.app/dashboard');
  });
});

describe('isAffiliateCode (the policy every checkout path must apply)', () => {
  it('accepts a well-formed affiliate code', () => {
    assert.equal(isAffiliateCode('sharerA'), true);
    assert.equal(isAffiliateCode('some_code-v2'), true);
  });

  it('rejects internal source tags in either namespace, any case', () => {
    for (const code of ['welcome-hero', 'Welcome-Hero', 'welcome', 'seo-country', 'SEO']) {
      assert.equal(isAffiliateCode(code), false, `${code} must not be treated as an affiliate code`);
    }
  });

  it('rejects malformed codes so callers that never went through capture are covered', () => {
    // startCheckout merges a caller-passed code ahead of the stored one; the
    // `?checkoutReferral=` URL param reaches it without any charset check.
    assert.equal(isAffiliateCode('has spaces'), false);
    assert.equal(isAffiliateCode('a'.repeat(65)), false);
    assert.equal(isAffiliateCode(''), false);
  });
});

describe('loadActiveReferral', () => {
  it('returns the stored code when non-stale', () => {
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ code: 'abc', capturedAt: Date.now() - 1_000 }));
    assert.equal(loadActiveReferral(), 'abc');
  });

  it('returns null and clears when record is older than TTL', () => {
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ code: 'abc', capturedAt: Date.now() - REFERRAL_TTL_MS - 1_000 }));
    assert.equal(loadActiveReferral(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('returns null and clears for malformed JSON', () => {
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, '{not json');
    assert.equal(loadActiveReferral(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('returns null and clears for records missing code field', () => {
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ capturedAt: Date.now() }));
    assert.equal(loadActiveReferral(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('returns null when nothing is stored', () => {
    assert.equal(loadActiveReferral(), null);
  });

  it('returns null and clears for previously-valid codes that fail re-validation', () => {
    // A future stored-format migration could leave unexpected chars; re-validate on read.
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ code: 'has spaces', capturedAt: Date.now() }));
    assert.equal(loadActiveReferral(), null);
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });
});

describe('clearReferralOnAttribution', () => {
  it('removes the stored referral', () => {
    _localStorage.setItem(REFERRAL_CAPTURE_KEY, JSON.stringify({ code: 'abc', capturedAt: Date.now() }));
    clearReferralOnAttribution();
    assert.equal(_localStorage.getItem(REFERRAL_CAPTURE_KEY), null);
  });

  it('is safe to call when nothing is stored', () => {
    assert.doesNotThrow(() => clearReferralOnAttribution());
  });
});

describe('appendRefToUrl', () => {
  it('appends wm_referral to a bare URL', () => {
    assert.equal(
      appendRefToUrl('https://worldmonitor.app', 'abc'),
      'https://worldmonitor.app/?wm_referral=abc',
    );
  });

  it('preserves existing query params', () => {
    assert.equal(
      appendRefToUrl('https://worldmonitor.app/?topic=brief', 'abc'),
      'https://worldmonitor.app/?topic=brief&wm_referral=abc',
    );
  });

  it('returns input unchanged when refCode is falsy', () => {
    assert.equal(appendRefToUrl('https://worldmonitor.app', undefined), 'https://worldmonitor.app');
    assert.equal(appendRefToUrl('https://worldmonitor.app', null), 'https://worldmonitor.app');
    assert.equal(appendRefToUrl('https://worldmonitor.app', ''), 'https://worldmonitor.app');
  });

  it('returns input unchanged for invalid codes', () => {
    assert.equal(
      appendRefToUrl('https://worldmonitor.app', 'bad code with spaces'),
      'https://worldmonitor.app',
    );
  });

  it('handles relative URLs via string concat fallback', () => {
    assert.equal(appendRefToUrl('/pro', 'abc'), '/pro?wm_referral=abc');
    assert.equal(appendRefToUrl('#pricing', 'abc'), '#pricing?wm_referral=abc');
  });
});

describe('round-trip: capture → load → clear', () => {
  it('captures from /pro?ref=, loads on dashboard, clears after attribution', () => {
    // 1. /pro with ref
    setUrl('https://worldmonitor.app/pro?ref=sharerA');
    captureReferralFromUrl();

    // 2. Navigate to dashboard (URL now clean) and read back
    setUrl('https://worldmonitor.app/');
    assert.equal(loadActiveReferral(), 'sharerA');

    // 3. After successful paid attribution
    clearReferralOnAttribution();
    assert.equal(loadActiveReferral(), null);
  });

  it('second capture in same session replaces prior code (new share link wins)', () => {
    setUrl('https://worldmonitor.app/?ref=first');
    captureReferralFromUrl();
    assert.equal(loadActiveReferral(), 'first');

    setUrl('https://worldmonitor.app/?ref=second');
    captureReferralFromUrl();
    assert.equal(loadActiveReferral(), 'second');
  });
});
