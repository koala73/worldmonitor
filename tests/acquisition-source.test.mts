import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_COOKIE_NAME,
  ACQUISITION_TTL_MS,
  acquisitionCheckoutMetadata,
  acquisitionCookieStorage,
  captureFirstTouchAcquisition,
  loadFirstTouchAcquisition,
  normalizeAcquisitionSource,
  parseAcquisitionSource,
  type AcquisitionStorage,
} from '../shared/acquisition-source.ts';

class MemoryStorage implements AcquisitionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

describe('parseAcquisitionSource', () => {
  it('records UTM tags, the external referrer host and the landing page family', () => {
    const source = parseAcquisitionSource({
      search: '?utm_source=Twitter&utm_medium=Social&utm_campaign=Hormuz%20Launch&ref=abc',
      pathname: '/pro',
      referrer: 'https://t.co/xyz?secret=1',
      now: NOW,
    });
    assert.deepEqual(source, {
      source: 'twitter',
      medium: 'social',
      campaign: 'hormuz-launch',
      referrer: 't.co',
      landing: 'pricing',
      firstSeen: '2026-10-24',
    });
  });

  it('keeps only the referrer hostname, never its path or query', () => {
    const source = parseAcquisitionSource({
      search: '',
      pathname: '/',
      referrer: 'https://www.google.com/search?q=private+query',
      now: NOW,
    });
    assert.equal(source.referrer, 'google.com');
    assert.equal(source.landing, 'homepage');
    assert.equal(source.source, undefined);
  });

  it('labels a visit with no referrer as direct', () => {
    const source = parseAcquisitionSource({ search: '', pathname: '/dashboard', referrer: '', now: NOW });
    assert.equal(source.referrer, 'direct');
    assert.equal(source.landing, 'dashboard');
  });

  it('buckets the landing path into a closed page family', () => {
    const landing = (pathname: string) =>
      parseAcquisitionSource({ search: '', pathname, referrer: '', now: NOW }).landing;
    assert.equal(landing('/'), 'homepage');
    assert.equal(landing('/Dashboard/'), 'dashboard');
    assert.equal(landing('/pro/checkout'), 'pricing');
    assert.equal(landing('/mcp'), 'developer_mcp');
    assert.equal(landing('/api/docs'), 'developer_mcp');
    assert.equal(landing('/docs/privacy'), 'documentation');
    assert.equal(landing('/use-cases/osint'), 'use-cases');
    assert.equal(landing('/blog/hormuz'), undefined);
    assert.equal(landing('/product'), undefined);
  });

  it('treats a non-http referrer as direct', () => {
    const source = parseAcquisitionSource({
      search: '',
      pathname: '/',
      referrer: 'android-app://com.google.android.gm/',
      now: NOW,
    });
    assert.equal(source.referrer, 'direct');
  });
});

describe('normalizeAcquisitionSource', () => {
  it('drops unknown keys and malformed values instead of forwarding them', () => {
    const source = normalizeAcquisitionSource({
      source: '<script>',
      medium: 'cpc',
      campaign: 'x'.repeat(500),
      referrer: 'not a host',
      landing: 'admin',
      firstSeen: '2026-13-99',
      email: 'someone@example.com',
    });
    assert.deepEqual(source, {
      source: 'script',
      medium: 'cpc',
      campaign: 'x'.repeat(64),
    });
  });

  it('returns null for non-objects and for objects with no usable field', () => {
    assert.equal(normalizeAcquisitionSource(null), null);
    assert.equal(normalizeAcquisitionSource('direct'), null);
    assert.equal(normalizeAcquisitionSource([]), null);
    assert.equal(normalizeAcquisitionSource({ referrer: '' }), null);
  });
});

describe('first-touch storage', () => {
  it('keeps the first visit and ignores later ones', () => {
    const storage = new MemoryStorage();
    const first = captureFirstTouchAcquisition(storage, {
      search: '?utm_source=reddit', pathname: '/', referrer: 'https://www.reddit.com/r/osint', now: NOW,
    });
    assert.equal(first?.source, 'reddit');

    const later = captureFirstTouchAcquisition(storage, {
      search: '?utm_source=newsletter', pathname: '/pro', referrer: '', now: NOW + 1_000,
    });
    assert.deepEqual(later, first);
    assert.deepEqual(loadFirstTouchAcquisition(storage, NOW + 2_000), first);
  });

  it('replaces an expired record with the current visit', () => {
    const storage = new MemoryStorage();
    captureFirstTouchAcquisition(storage, { search: '?utm_source=reddit', pathname: '/', referrer: '', now: NOW });
    const later = NOW + ACQUISITION_TTL_MS + 1;
    assert.equal(loadFirstTouchAcquisition(storage, later), null);
    const fresh = captureFirstTouchAcquisition(storage, { search: '?utm_source=hn', pathname: '/', referrer: '', now: later });
    assert.equal(fresh?.source, 'hn');
  });

  it('clears a malformed stored record', () => {
    const storage = new MemoryStorage();
    storage.setItem(ACQUISITION_COOKIE_NAME, '{not json');
    assert.equal(loadFirstTouchAcquisition(storage, NOW), null);
    assert.equal(storage.values.has(ACQUISITION_COOKIE_NAME), false);
  });

  it('degrades to no attribution when storage is missing or throws', () => {
    const throwing: AcquisitionStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    const visit = { search: '?utm_source=x', pathname: '/', referrer: '', now: NOW };
    assert.equal(captureFirstTouchAcquisition(null, visit), null);
    assert.equal(captureFirstTouchAcquisition(throwing, visit), null);
    assert.equal(loadFirstTouchAcquisition(throwing, NOW), null);
  });
});

describe('acquisitionCookieStorage', () => {
  it('shares the cookie across worldmonitor.app hosts', () => {
    const doc = { cookie: '' };
    const storage = acquisitionCookieStorage(doc, { hostname: 'finance.worldmonitor.app', protocol: 'https:' });
    storage.setItem(ACQUISITION_COOKIE_NAME, '{"a":1}');
    assert.match(doc.cookie, /^wm-acq=/);
    assert.match(doc.cookie, /domain=\.worldmonitor\.app/);
    assert.match(doc.cookie, /Secure/);
  });

  it('stays host-only off the production domain and ignores other keys', () => {
    const doc = { cookie: '' };
    const storage = acquisitionCookieStorage(doc, { hostname: 'localhost', protocol: 'http:' });
    storage.setItem('other-key', 'x');
    assert.equal(doc.cookie, '');
    storage.setItem(ACQUISITION_COOKIE_NAME, 'v');
    assert.doesNotMatch(doc.cookie, /domain=/);
    assert.doesNotMatch(doc.cookie, /Secure/);
  });

  it('reads the value back from a cookie header with other cookies', () => {
    const doc = { cookie: `a=1; ${ACQUISITION_COOKIE_NAME}=${encodeURIComponent('{"x":"y"}')}; b=2` };
    const storage = acquisitionCookieStorage(doc, { hostname: 'www.worldmonitor.app', protocol: 'https:' });
    assert.equal(storage.getItem(ACQUISITION_COOKIE_NAME), '{"x":"y"}');
  });
});

describe('acquisitionCheckoutMetadata', () => {
  it('maps each present field to a wm_acq_* key', () => {
    assert.deepEqual(
      acquisitionCheckoutMetadata({ source: 'twitter', referrer: 't.co', landing: 'pricing', firstSeen: '2026-10-24' }),
      {
        wm_acq_source: 'twitter',
        wm_acq_referrer: 't.co',
        wm_acq_landing: 'pricing',
        wm_acq_first_seen: '2026-10-24',
      },
    );
  });

  it('re-validates its input so a crafted value never reaches provider metadata', () => {
    assert.deepEqual(acquisitionCheckoutMetadata({ referrer: 'bad host', medium: 'cpc' }), { wm_acq_medium: 'cpc' });
    assert.deepEqual(acquisitionCheckoutMetadata(undefined), {});
  });
});
