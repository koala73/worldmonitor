import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GTFS_RT_MAX_BYTES,
  GtfsRtError,
  gtfsRtCacheKey,
  gtfsrtAdapter,
  parseGtfsRtServiceAlerts,
} from '../scripts/lib/gtfsrt.mjs';

const ADAPTER_SOURCE = readFileSync(
  new URL('../scripts/lib/gtfsrt.mjs', import.meta.url),
  'utf8',
);
const FIXTURE = readFileSync(
  new URL('./fixtures/gtfsrt-ttc-alerts.pb', import.meta.url),
);

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeVarint(value) {
  const bytes = [];
  let n = BigInt(value);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Uint8Array.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeBytes(fieldNumber, bytes) {
  return concat(encodeTag(fieldNumber, 2), encodeVarint(bytes.length), bytes);
}

function encodeString(fieldNumber, text) {
  return encodeBytes(fieldNumber, new TextEncoder().encode(text));
}

function encodeVarintField(fieldNumber, value) {
  return concat(encodeTag(fieldNumber, 0), encodeVarint(value));
}

function encodeTranslation(text, language = 'en') {
  return encodeBytes(1, concat(encodeString(1, text), encodeString(2, language)));
}

function encodeAlertFeed({
  id = 'alert-1',
  headerText = 'Route delayed',
  descriptionText = 'Construction',
  cause = 10,
  effect = 3,
  routeId = '501',
  stopId = '1234',
  start = 1_700_000_000,
} = {}) {
  const header = concat(
    encodeString(1, '2.0'),
    encodeVarintField(2, 0),
    encodeVarintField(3, 1_700_000_100),
  );
  const alert = concat(
    encodeBytes(1, encodeVarintField(1, start)),
    encodeBytes(5, concat(encodeString(2, routeId), encodeString(5, stopId))),
    encodeVarintField(6, cause),
    encodeVarintField(7, effect),
    encodeBytes(10, encodeTranslation(headerText)),
    encodeBytes(11, encodeTranslation(descriptionText)),
  );
  const entity = concat(encodeString(1, id), encodeBytes(5, alert));
  return concat(encodeBytes(1, header), encodeBytes(2, entity));
}

function encodeEmptyFeed(version = '2.0') {
  return encodeBytes(1, encodeString(1, version));
}

function encodeHeaderlessEntity(id = 'x') {
  return encodeBytes(2, encodeString(1, id));
}

function liveShapedResponse(body, contentType = 'application/x-protobuf') {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': 'attachment; filename=all-alerts.pb',
    },
  });
}

describe('gtfsrt protobuf parser', () => {
  it('parses a captured TTC service-alerts protobuf into alerts', () => {
    const parsed = parseGtfsRtServiceAlerts(FIXTURE);
    assert.equal(parsed.header.gtfsRealtimeVersion, '2.0');
    assert.equal(parsed.header.incrementality, 'FULL_DATASET');
    assert.ok(parsed.header.timestamp > 0);
    assert.ok(parsed.alerts.length >= 1);
    const first = parsed.alerts.find((alert) => alert.headerText);
    assert.ok(first, 'expected at least one alert with header text');
    assert.equal(typeof first.id, 'string');
    assert.ok(first.headerText.length > 0);
    assert.ok(Array.isArray(first.informedEntities));
    assert.ok(Array.isArray(first.activePeriod));
  });

  it('parses a synthetic service-alert protobuf', () => {
    const parsed = parseGtfsRtServiceAlerts(encodeAlertFeed({
      id: 'go-1',
      headerText: 'GO train delay',
      routeId: 'LW',
    }));
    assert.equal(parsed.alerts.length, 1);
    assert.equal(parsed.alerts[0].id, 'go-1');
    assert.equal(parsed.alerts[0].headerText, 'GO train delay');
    assert.equal(parsed.alerts[0].cause, 'CONSTRUCTION');
    assert.equal(parsed.alerts[0].effect, 'SIGNIFICANT_DELAYS');
    assert.equal(parsed.alerts[0].informedEntities[0].routeId, 'LW');
  });

  it('accepts a valid header-only feed as empty (zero entities is not malformed)', () => {
    const parsed = parseGtfsRtServiceAlerts(encodeEmptyFeed('2.0'));
    assert.equal(parsed.header.gtfsRealtimeVersion, '2.0');
    assert.equal(parsed.alerts.length, 0);
  });

  it('rejects a headerless protobuf as malformed, not an empty alerts feed', () => {
    assert.throws(
      () => parseGtfsRtServiceAlerts(encodeHeaderlessEntity('alert-1')),
      (error) => error instanceof GtfsRtError
        && error.code === 'MALFORMED_PROTOBUF'
        && /gtfs_realtime_version/.test(error.message),
    );
  });

  it('rejects a FeedHeader that omits gtfs_realtime_version', () => {
    const headerNoVersion = encodeBytes(1, encodeVarintField(2, 0));
    assert.throws(
      () => parseGtfsRtServiceAlerts(headerNoVersion),
      (error) => error instanceof GtfsRtError && error.code === 'MALFORMED_PROTOBUF',
    );
  });

  it('rejects an HTML body as malformed, not an empty alerts feed', () => {
    const html = new TextEncoder().encode('<html><body>Service Unavailable</body></html>');
    assert.throws(
      () => parseGtfsRtServiceAlerts(html),
      (error) => error instanceof GtfsRtError && error.code === 'MALFORMED_PROTOBUF',
    );
  });
});

describe('gtfsrtAdapter(feedUrl)', () => {
  it('is agency-parameterised: cache keys include the feed URL', () => {
    const ttc = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
    const go = 'https://api.example.go/gtfs-rt/alerts';
    assert.equal(gtfsRtCacheKey(ttc), `gtfsrt:${ttc}`);
    assert.equal(gtfsRtCacheKey(go), `gtfsrt:${go}`);
    assert.notEqual(gtfsRtCacheKey(ttc), gtfsRtCacheKey(go));
  });

  it('fetches a feedUrl, uses CHROME_UA, rejects redirects, and caches per URL', async () => {
    const feedUrl = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
    const otherUrl = 'https://gtfsrt.example.test/alerts';
    const bytes = encodeAlertFeed({ id: 'ttc-live', headerText: 'Line 1 delay' });
    const seen = [];
    const cache = new Map();
    async function fakeFetch(url, init) {
      seen.push({ url, redirect: init.redirect, ua: init.headers['User-Agent'] });
      assert.equal(init.redirect, 'error');
      assert.match(init.headers['User-Agent'], /Chrome\/134/);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/x-protobuf' },
      });
    }

    const first = await gtfsrtAdapter(feedUrl, {
      fetch: fakeFetch,
      allowedHosts: ['gtfsrt.ttc.ca'],
      cache,
    });
    const again = await gtfsrtAdapter(feedUrl, {
      fetch: fakeFetch,
      allowedHosts: ['gtfsrt.ttc.ca'],
      cache,
    });
    assert.equal(seen.length, 1, 'second call with the same feed URL must hit the cache');
    assert.equal(first.alerts[0].id, 'ttc-live');
    assert.equal(again.alerts[0].headerText, 'Line 1 delay');
    assert.equal(first.feedUrl, feedUrl);
    assert.ok(cache.has(gtfsRtCacheKey(feedUrl)));
    assert.equal(cache.has(gtfsRtCacheKey(otherUrl)), false);
  });

  it('rejects http:// feed URLs before fetch', async () => {
    await assert.rejects(
      () => gtfsrtAdapter('http://gtfsrt.ttc.ca/alerts/all?format=binary', {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => {
          throw new Error('must not fetch');
        },
      }),
      (error) => error instanceof GtfsRtError && error.code === 'HOST_NOT_ALLOWED',
    );
  });

  it('rejects file:// feed URLs before fetch', async () => {
    await assert.rejects(
      () => gtfsrtAdapter('file:///etc/passwd', {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => {
          throw new Error('must not fetch');
        },
      }),
      (error) => error instanceof GtfsRtError && error.code === 'HOST_NOT_ALLOWED',
    );
  });

  it('rejects a host outside the allowlist', async () => {
    await assert.rejects(
      () => gtfsrtAdapter('https://evil.example/alerts.pb', {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => {
          throw new Error('must not fetch');
        },
      }),
      (error) => error instanceof GtfsRtError && error.code === 'HOST_NOT_ALLOWED',
    );
  });

  it('rejects HTTP 404 without inventing a feed', async () => {
    await assert.rejects(
      () => gtfsrtAdapter('https://gtfsrt.ttc.ca/missing', {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => new Response('', { status: 404 }),
      }),
      (error) => error instanceof GtfsRtError && error.code === 'HTTP_ERROR',
    );
  });

  it('enforces the byte cap', async () => {
    await assert.rejects(
      () => gtfsrtAdapter('https://gtfsrt.ttc.ca/alerts/all?format=binary', {
        allowedHosts: ['gtfsrt.ttc.ca'],
        maxBytes: 8,
        fetch: async () => new Response(new Uint8Array(32), {
          status: 200,
          headers: { 'content-length': '32' },
        }),
      }),
      (error) => error instanceof GtfsRtError && error.code === 'RESPONSE_TOO_LARGE',
    );
    assert.ok(GTFS_RT_MAX_BYTES >= 64_000);
  });

  it('does not bind fetch to globalThis', () => {
    assert.equal(ADAPTER_SOURCE.includes('fetch.bind'), false);
    assert.equal(ADAPTER_SOURCE.includes('fetch.bind(globalThis)'), false);
  });

  it('does not import a seeder', () => {
    assert.equal(ADAPTER_SOURCE.includes('seed-ttc-alerts'), false);
    assert.equal(ADAPTER_SOURCE.includes('../seed-'), false);
  });

  it('live-shaped 200 + headerless protobuf is ingest failure, not a healthy empty snapshot', async () => {
    const feedUrl = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
    await assert.rejects(
      () => gtfsrtAdapter(feedUrl, {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => liveShapedResponse(encodeHeaderlessEntity('alert-1')),
      }),
      (error) => error instanceof GtfsRtError && error.code === 'MALFORMED_PROTOBUF',
    );
  });

  it('live-shaped 200 + HTML body is ingest failure, not a healthy empty snapshot', async () => {
    const feedUrl = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
    const html = new TextEncoder().encode('<!DOCTYPE html><html><h1>IIS error</h1></html>');
    await assert.rejects(
      () => gtfsrtAdapter(feedUrl, {
        allowedHosts: ['gtfsrt.ttc.ca'],
        fetch: async () => liveShapedResponse(html, 'text/html'),
      }),
      (error) => error instanceof GtfsRtError && error.code === 'MALFORMED_PROTOBUF',
    );
  });

  it('live-shaped 200 + valid empty feed still returns zero alerts', async () => {
    const feedUrl = 'https://gtfsrt.ttc.ca/alerts/all?format=binary';
    const snapshot = await gtfsrtAdapter(feedUrl, {
      allowedHosts: ['gtfsrt.ttc.ca'],
      fetch: async () => liveShapedResponse(encodeEmptyFeed('2.0')),
    });
    assert.equal(snapshot.header.gtfsRealtimeVersion, '2.0');
    assert.equal(snapshot.alerts.length, 0);
  });
});
