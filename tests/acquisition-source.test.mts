import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_COOKIE_NAME,
  ACQUISITION_TTL_MS,
  acquisitionCheckoutMetadata,
  acquisitionCookieStorage,
  acquisitionFromCheckoutMetadata,
  captureFirstTouchAcquisition,
  firstTouchSetCookie,
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
      path: '/pro',
      firstSeen: '2026-10-24',
    });
  });

  it('records the exact landing path but never its query or hash', () => {
    const source = parseAcquisitionSource({
      search: '?utm_source=chatgpt.com&email=someone%40example.com#section',
      pathname: '/countries/iran/',
      referrer: '',
      now: NOW,
    });
    assert.equal(source.path, '/countries/iran/');
    assert.equal(source.landing, 'countries');
    assert.doesNotMatch(JSON.stringify(source), /email|example|section/);
  });

  it('stores no path for a page outside the listed families', () => {
    const source = parseAcquisitionSource({ search: '', pathname: '/product', referrer: '', now: NOW });
    assert.equal(source.landing, undefined);
    assert.equal(source.path, undefined);
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
    assert.equal(source.path, '/');
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
    assert.equal(landing('/chokepoints/strait-of-hormuz/'), 'chokepoints');
    assert.equal(landing('/countries/iran/'), 'countries');
    assert.equal(landing('/crises/iran-israel/'), 'crises');
    assert.equal(landing('/compare/worldmonitor-vs-liveuamap/'), 'compare');
    assert.equal(landing('/tools/fear-and-greed-index/'), 'tools');
    assert.equal(landing('/research'), 'research');
    assert.equal(landing('/agent/'), 'agent');
    assert.equal(landing('/blog/hormuz'), 'blog');
    assert.equal(landing('/product'), undefined);
    assert.equal(landing('/blogroll'), undefined);
    assert.equal(landing('/toolshed/x'), undefined);
  });

  it('keeps every landing family it assigns through validation', () => {
    for (const pathname of ['/chokepoints/a/', '/countries/a/', '/crises/a/', '/compare/a/', '/tools/a/', '/research/a/', '/agent/', '/blog/a/']) {
      const source = parseAcquisitionSource({ search: '', pathname, referrer: '', now: NOW });
      assert.equal(normalizeAcquisitionSource(source)?.landing, source.landing, pathname);
      assert.ok(source.landing, pathname);
    }
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

  it('keeps a safe landing path inside a listed family', () => {
    for (const path of ['/', '/countries/iran/', '/blog/posts/hormuz-2026_v2.html', '/docs/a~b', '/tools/caf%C3%A9/']) {
      assert.equal(normalizeAcquisitionSource({ path })?.path, path, path);
    }
  });

  it('drops a landing path that is unsafe, too long or outside the listed families', () => {
    const rejected: unknown[] = [
      'countries/iran/',
      '/countries/iran/?utm_source=x',
      '/countries/iran/#top',
      '/countries/<script>/',
      '/countries/iran /',
      '/countries/"x"/',
      `/countries/${'a'.repeat(120)}`,
      '/product',
      '/blogroll',
      '//evil.example/countries/',
      42,
      null,
    ];
    for (const path of rejected) {
      assert.equal(normalizeAcquisitionSource({ medium: 'cpc', path })?.path, undefined, String(path));
    }
    const atLimit = `/countries/${'a'.repeat(120 - '/countries/'.length)}`;
    assert.equal(normalizeAcquisitionSource({ path: atLimit })?.path, atLimit);
  });

  it('drops a landing path whose family contradicts the recorded landing', () => {
    assert.deepEqual(
      normalizeAcquisitionSource({ landing: 'pricing', path: '/countries/iran/' }),
      { landing: 'pricing' },
    );
    assert.deepEqual(
      normalizeAcquisitionSource({ landing: 'countries', path: '/countries/iran/' }),
      { landing: 'countries', path: '/countries/iran/' },
    );
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
      acquisitionCheckoutMetadata({ source: 'twitter', referrer: 't.co', landing: 'pricing', path: '/pro/', firstSeen: '2026-10-24' }),
      {
        wm_acq_source: 'twitter',
        wm_acq_referrer: 't.co',
        wm_acq_landing: 'pricing',
        wm_acq_path: '/pro/',
        wm_acq_first_seen: '2026-10-24',
      },
    );
  });

  it('re-validates its input so a crafted value never reaches provider metadata', () => {
    assert.deepEqual(acquisitionCheckoutMetadata({ referrer: 'bad host', medium: 'cpc' }), { wm_acq_medium: 'cpc' });
    assert.deepEqual(acquisitionCheckoutMetadata({ path: '/countries/iran/?q=1', medium: 'cpc' }), { wm_acq_medium: 'cpc' });
    assert.deepEqual(acquisitionCheckoutMetadata(undefined), {});
  });
});

describe('acquisitionFromCheckoutMetadata', () => {
  it('reads back exactly what acquisitionCheckoutMetadata wrote', () => {
    const source = { source: 'twitter', medium: 'social', campaign: 'launch', referrer: 't.co', landing: 'countries', path: '/countries/iran/', firstSeen: '2026-10-24' };
    assert.deepEqual(acquisitionFromCheckoutMetadata(acquisitionCheckoutMetadata(source)), source);
  });

  it('reads a checkout stamped before the path existed', () => {
    assert.deepEqual(
      acquisitionFromCheckoutMetadata({ wm_acq_referrer: 't.co', wm_acq_landing: 'countries' }),
      { referrer: 't.co', landing: 'countries' },
    );
  });

  it('drops a crafted path from provider metadata', () => {
    assert.deepEqual(
      acquisitionFromCheckoutMetadata({ wm_acq_landing: 'countries', wm_acq_path: '/countries/<img>/' }),
      { landing: 'countries' },
    );
  });

  it('ignores unrelated metadata keys and re-validates values', () => {
    assert.deepEqual(
      acquisitionFromCheckoutMetadata({
        wm_user_id: 'user_1',
        wm_attribution: 'mcp',
        affonso_referral: 'abc',
        wm_acq_referrer: 'direct',
        wm_acq_first_seen: '2026-02-31',
        wm_acq_campaign: '<script>',
      }),
      { referrer: 'direct', campaign: 'script' },
    );
  });

  it('returns null when no acquisition key is usable', () => {
    assert.equal(acquisitionFromCheckoutMetadata({ wm_user_id: 'user_1' }), null);
    assert.equal(acquisitionFromCheckoutMetadata(undefined), null);
    assert.equal(acquisitionFromCheckoutMetadata(['wm_acq_source']), null);
  });
});

describe('firstTouchSetCookie', () => {
  const HORMUZ_FROM_CHATGPT = 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/?utm_source=chatgpt.com';

  function cookieRecord(setCookie: string | null): Record<string, unknown> {
    assert.ok(setCookie, 'expected a Set-Cookie value');
    const pair = setCookie.split(';')[0]!;
    assert.ok(pair.startsWith(`${ACQUISITION_COOKIE_NAME}=`), pair);
    return JSON.parse(decodeURIComponent(pair.slice(ACQUISITION_COOKIE_NAME.length + 1)));
  }

  function storedCookie(record: Record<string, unknown>): string {
    return `theme=dark; ${ACQUISITION_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(record))}`;
  }

  it('records an AI-assistant landing on a content page that sent no referrer', () => {
    const setCookie = firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader: null, referrer: null, now: NOW });
    assert.deepEqual(cookieRecord(setCookie), {
      source: 'chatgpt-com',
      referrer: 'direct',
      landing: 'chokepoints',
      path: '/chokepoints/strait-of-hormuz/',
      firstSeen: '2026-10-24',
      capturedAt: NOW,
    });
  });

  it('keeps the largest accepted record under half the 4096-byte browser cookie limit', () => {
    const longest = `/countries/${'%/'.repeat(60)}`.slice(0, 120);
    const label = 'r'.repeat(63);
    const longestHost = `${label}.${label}.${label}.${'r'.repeat(253 - 3 * 64)}`;
    const setCookie = firstTouchSetCookie({
      url: `https://www.worldmonitor.app${longest}?utm_source=${'s'.repeat(80)}&utm_medium=${'m'.repeat(80)}&utm_campaign=${'c'.repeat(80)}`,
      cookieHeader: null,
      referrer: `https://${longestHost}/`,
      now: NOW,
    });
    assert.equal(cookieRecord(setCookie).path, longest);
    assert.equal(cookieRecord(setCookie).referrer, longestHost);
    assert.ok(setCookie!.length > 1024, `fixture exercises the encoding-heavy worst case (${setCookie!.length} bytes)`);
    assert.ok(setCookie!.length < 2048, `Set-Cookie is ${setCookie!.length} bytes`);
  });

  it('keeps a stored record written before the path existed', () => {
    const cookieHeader = storedCookie({ source: 'reddit', referrer: 'reddit.com', landing: 'countries', capturedAt: NOW - 1_000 });
    assert.equal(firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader, referrer: null, now: NOW }), null);
    const storage = acquisitionCookieStorage({ cookie: cookieHeader }, { hostname: 'www.worldmonitor.app', protocol: 'https:' });
    assert.deepEqual(loadFirstTouchAcquisition(storage, NOW), { source: 'reddit', referrer: 'reddit.com', landing: 'countries' });
  });

  it('writes the cookie a later checkout reads back', () => {
    const setCookie = firstTouchSetCookie({
      url: HORMUZ_FROM_CHATGPT, cookieHeader: 'theme=dark', referrer: 'https://chatgpt.com/', now: NOW,
    });
    const doc = { cookie: setCookie!.split(';')[0]! };
    const storage = acquisitionCookieStorage(doc, { hostname: 'www.worldmonitor.app', protocol: 'https:' });
    assert.deepEqual(loadFirstTouchAcquisition(storage, NOW + 1_000), {
      source: 'chatgpt-com',
      referrer: 'chatgpt.com',
      landing: 'chokepoints',
      path: '/chokepoints/strait-of-hormuz/',
      firstSeen: '2026-10-24',
    });
  });

  it('carries the browser path\'s cookie attributes, readable by page script', () => {
    const setCookie = firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader: '', referrer: '', now: NOW })!;
    const attributes = setCookie.split(';').slice(1).map((part) => part.trim());
    assert.deepEqual(attributes.sort(), ['SameSite=Lax', 'Secure', 'domain=.worldmonitor.app', 'max-age=7776000', 'path=/']);
    assert.doesNotMatch(setCookie, /httponly/i);
  });

  it('stays host-only on a preview host', () => {
    const setCookie = firstTouchSetCookie({
      url: 'https://worldmonitor-git-x.vercel.app/blog/x/', cookieHeader: null, referrer: null, now: NOW,
    })!;
    assert.doesNotMatch(setCookie, /domain=/);
    assert.equal(cookieRecord(setCookie).landing, 'blog');
  });

  it('writes nothing when an unexpired first touch is already stored', () => {
    const cookieHeader = storedCookie({ source: 'reddit', referrer: 'reddit.com', landing: 'homepage', capturedAt: NOW - 1_000 });
    assert.equal(firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader, referrer: null, now: NOW }), null);
  });

  it('replaces an expired record with this visit', () => {
    const cookieHeader = storedCookie({ source: 'reddit', referrer: 'reddit.com', capturedAt: NOW - ACQUISITION_TTL_MS - 1 });
    const record = cookieRecord(firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader, referrer: null, now: NOW }));
    assert.equal(record.source, 'chatgpt-com');
    assert.equal(record.capturedAt, NOW);
  });

  it('replaces a malformed record with this visit', () => {
    const cookieHeader = `${ACQUISITION_COOKIE_NAME}=%7Bnot-json`;
    const record = cookieRecord(firstTouchSetCookie({ url: HORMUZ_FROM_CHATGPT, cookieHeader, referrer: null, now: NOW }));
    assert.equal(record.landing, 'chokepoints');
  });
});
