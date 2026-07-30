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
