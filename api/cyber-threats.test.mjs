import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler, {
  __resetCyberThreatsState,
  __testDedupeThreats,
  __testParseFeodoRecords,
} from './cyber-threats.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URLHAUS_KEY = process.env.URLHAUS_AUTH_KEY;
const ORIGINAL_OTX_KEY = process.env.OTX_API_KEY;
const ORIGINAL_ABUSEIPDB_KEY = process.env.ABUSEIPDB_API_KEY;

function makeRequest(path = '/api/cyber-threats', ip = '198.51.100.10') {
  const headers = new Headers();
  headers.set('x-forwarded-for', ip);
  return new Request(`https://intelhq.io${path}`, { headers });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

// Mock that handles all 5 source URLs + geo enrichment
function createMockFetch({ feodo, urlhaus, c2intel, otx, abuseipdb, geo } = {}) {
  return async (url) => {
    const target = String(url);
    if (target.includes('feodotracker.abuse.ch') && feodo) return feodo(target);
    if (target.includes('urlhaus-api.abuse.ch') && urlhaus) return urlhaus(target);
    if (target.includes('raw.githubusercontent.com') && target.includes('C2IntelFeeds') && c2intel) return c2intel(target);
    if (target.includes('otx.alienvault.com') && otx) return otx(target);
    if (target.includes('api.abuseipdb.com') && abuseipdb) return abuseipdb(target);
    if ((target.includes('ipwho.is') || target.includes('ipapi.co')) && geo) return geo(target);
    // Default: return 404 for unconfigured sources
    return new Response('not found', { status: 404 });
  };
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.URLHAUS_AUTH_KEY = ORIGINAL_URLHAUS_KEY;
  process.env.OTX_API_KEY = ORIGINAL_OTX_KEY;
  process.env.ABUSEIPDB_API_KEY = ORIGINAL_ABUSEIPDB_KEY;
  __resetCyberThreatsState();
});

test('Feodo parser accepts online and recent offline entries, filters stale', () => {
  const nowMs = Date.parse('2026-02-15T12:00:00.000Z');
  const records = [
    {
      ip_address: '1.2.3.4',
      status: 'online',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'QakBot',
    },
    {
      ip_address: '5.6.7.8',
      status: 'offline',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'Emotet',
    },
    {
      ip_address: '9.9.9.9',
      status: 'online',
      first_seen: '2025-10-01 10:00:00 UTC',
      last_online: '2025-10-02 10:00:00 UTC',
      malware: 'generic',
    },
    {
      ip_address: '2.2.2.2',
      first_seen: '2026-02-14 10:00:00 UTC',
      last_online: '2026-02-15 10:00:00 UTC',
      malware: 'generic',
    },
  ];

  const parsed = __testParseFeodoRecords(records, { nowMs, days: 14 });
  // online + offline (recent) + no-status (recent) = 3; stale (9.9.9.9) filtered
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].indicator, '1.2.3.4');
  assert.equal(parsed[0].severity, 'critical');
  assert.equal(parsed[1].indicator, '5.6.7.8');
  assert.equal(parsed[1].severity, 'medium');
  assert.equal(parsed[0].firstSeen?.endsWith('Z'), true);
  assert.equal(parsed[0].lastSeen?.endsWith('Z'), true);
});

test('dedupes by source + indicatorType + indicator', () => {
  const deduped = __testDedupeThreats([
    {
      id: 'a',
      source: 'feodo',
      type: 'c2_server',
      indicatorType: 'ip',
      indicator: '1.2.3.4',
      severity: 'high',
      tags: ['a'],
      firstSeen: '2026-02-10T00:00:00.000Z',
      lastSeen: '2026-02-11T00:00:00.000Z',
    },
    {
      id: 'b',
      source: 'feodo',
      type: 'c2_server',
      indicatorType: 'ip',
      indicator: '1.2.3.4',
      severity: 'critical',
      tags: ['b'],
      firstSeen: '2026-02-12T00:00:00.000Z',
      lastSeen: '2026-02-13T00:00:00.000Z',
    },
    {
      id: 'c',
      source: 'urlhaus',
      type: 'malicious_url',
      indicatorType: 'domain',
      indicator: 'bad.example',
      severity: 'medium',
      tags: [],
      firstSeen: '2026-02-11T00:00:00.000Z',
      lastSeen: '2026-02-11T01:00:00.000Z',
    },
  ]);

  assert.equal(deduped.length, 2);
  const feodo = deduped.find((item) => item.source === 'feodo');
  assert.equal(feodo?.severity, 'critical');
  assert.equal(feodo?.tags.includes('a'), true);
  assert.equal(feodo?.tags.includes('b'), true);
});

test('API aggregates from all 5 sources', async () => {
  process.env.URLHAUS_AUTH_KEY = 'test-key';
  process.env.OTX_API_KEY = 'test-otx';
  process.env.ABUSEIPDB_API_KEY = 'test-abuse';

  globalThis.fetch = createMockFetch({
    feodo: () => jsonResponse([
      {
        ip_address: '1.2.3.4',
        status: 'online',
        last_online: '2026-02-15T10:00:00.000Z',
        first_seen: '2026-02-14T10:00:00.000Z',
        malware: 'QakBot',
        country: 'GB',
        lat: 51.5,
        lon: -0.12,
      },
    ]),
    urlhaus: () => jsonResponse({
      urls: [{
        url: 'http://5.5.5.5/malware.exe',
        host: '5.5.5.5',
        url_status: 'online',
        threat: 'malware_download',
        tags: ['malware'],
        dateadded: '2026-02-14T08:00:00.000Z',
        latitude: 48.86,
        longitude: 2.35,
        country: 'FR',
      }],
    }),
    c2intel: () => textResponse(
      '#ip,ioc\n10.10.10.10,Possible Cobaltstrike C2 IP\n10.10.10.11,Possible Metasploit C2 IP',
    ),
    otx: () => jsonResponse({
      results: [{
        indicator: '20.20.20.20',
        title: 'APT threat',
        tags: ['apt', 'c2'],
        created: '2026-02-13T00:00:00.000Z',
        modified: '2026-02-14T00:00:00.000Z',
      }],
    }),
    abuseipdb: () => jsonResponse({
      data: [{
        ipAddress: '30.30.30.30',
        abuseConfidenceScore: 98,
        lastReportedAt: '2026-02-15T06:00:00.000Z',
        countryCode: 'CN',
        latitude: 39.9,
        longitude: 116.4,
      }],
    }),
    geo: () => jsonResponse({ success: true, latitude: 40.0, longitude: -74.0, country_code: 'US' }),
  });

  const response = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.20'));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.sources.feodo.ok, true);
  assert.equal(body.sources.urlhaus.ok, true);
  assert.equal(body.sources.c2intel.ok, true);
  assert.equal(body.sources.otx.ok, true);
  assert.equal(body.sources.abuseipdb.ok, true);
  // 5 sources, all with coords (3 native + 3 via geo enrichment mock)
  assert.equal(body.data.length >= 5, true);
});

test('API works with only free sources when keys missing', async () => {
  delete process.env.URLHAUS_AUTH_KEY;
  delete process.env.OTX_API_KEY;
  delete process.env.ABUSEIPDB_API_KEY;

  globalThis.fetch = createMockFetch({
    feodo: () => jsonResponse([
      {
        ip_address: '1.2.3.4',
        status: 'online',
        last_online: '2026-02-15T10:00:00.000Z',
        first_seen: '2026-02-14T10:00:00.000Z',
        malware: 'QakBot',
        country: 'GB',
        lat: 51.5,
        lon: -0.12,
      },
    ]),
    c2intel: () => textResponse('#ip,ioc\n10.10.10.10,Possible Cobaltstrike C2 IP'),
  });

  const response = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.11'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Cache'), 'MISS');

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.partial, false);
  assert.equal(body.sources.feodo.ok, true);
  assert.equal(body.sources.c2intel.ok, true);
  assert.equal(body.sources.urlhaus.ok, false);
  assert.equal(body.sources.urlhaus.reason, 'missing_auth_key');
  assert.equal(body.sources.otx.ok, false);
  assert.equal(body.sources.otx.reason, 'missing_api_key');
  assert.equal(body.sources.abuseipdb.ok, false);
  assert.equal(body.sources.abuseipdb.reason, 'missing_api_key');
  assert.equal(Array.isArray(body.data), true);
});

test('API marks partial=true when URLhaus is enabled but fails', async () => {
  process.env.URLHAUS_AUTH_KEY = 'test-key';
  delete process.env.OTX_API_KEY;
  delete process.env.ABUSEIPDB_API_KEY;

  globalThis.fetch = createMockFetch({
    feodo: () => jsonResponse([
      {
        ip_address: '1.2.3.4',
        status: 'online',
        last_online: '2026-02-15T10:00:00.000Z',
        first_seen: '2026-02-14T10:00:00.000Z',
        malware: 'QakBot',
        country: 'GB',
        lat: 51.5,
        lon: -0.12,
      },
    ]),
    urlhaus: () => new Response('boom', { status: 500 }),
    c2intel: () => textResponse('#ip,ioc\n10.10.10.10,Possible Cobaltstrike C2 IP'),
  });

  const response = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.12'));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.partial, true);
  assert.equal(body.sources.urlhaus.ok, false);
  assert.equal(body.sources.urlhaus.reason, 'urlhaus_http_500');
});

test('API returns memory cache hit on repeated request', async () => {
  delete process.env.URLHAUS_AUTH_KEY;
  delete process.env.OTX_API_KEY;
  delete process.env.ABUSEIPDB_API_KEY;

  let feodoCalls = 0;
  globalThis.fetch = createMockFetch({
    feodo: () => {
      feodoCalls += 1;
      return jsonResponse([
        {
          ip_address: '1.2.3.4',
          status: 'online',
          last_online: '2026-02-15T10:00:00.000Z',
          first_seen: '2026-02-14T10:00:00.000Z',
          malware: 'QakBot',
          country: 'GB',
          lat: 51.5,
          lon: -0.12,
        },
      ]);
    },
    c2intel: () => textResponse('#ip,ioc\n10.10.10.10,Possible Cobaltstrike C2 IP'),
  });

  const first = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.13'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(feodoCalls, 1);

  globalThis.fetch = async () => {
    throw new Error('network should not be hit for memory cache');
  };

  const second = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.13'));
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('X-Cache'), 'MEMORY-HIT');
  assert.equal(feodoCalls, 1);
});

test('API returns stale fallback when upstream fails after fresh cache TTL', async () => {
  delete process.env.URLHAUS_AUTH_KEY;
  delete process.env.OTX_API_KEY;
  delete process.env.ABUSEIPDB_API_KEY;

  const baseNow = Date.parse('2026-02-15T12:00:00.000Z');
  const originalDateNow = Date.now;
  Date.now = () => baseNow;

  try {
    globalThis.fetch = createMockFetch({
      feodo: () => jsonResponse([
        {
          ip_address: '1.2.3.4',
          status: 'online',
          last_online: '2026-02-15T10:00:00.000Z',
          first_seen: '2026-02-14T10:00:00.000Z',
          malware: 'QakBot',
          country: 'GB',
          lat: 51.5,
          lon: -0.12,
        },
      ]),
      c2intel: () => textResponse('#ip,ioc\n10.10.10.10,Possible Cobaltstrike C2 IP'),
    });

    const first = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.14'));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache'), 'MISS');

    Date.now = () => baseNow + (11 * 60 * 1000);
    globalThis.fetch = async () => {
      throw new Error('forced upstream failure');
    };

    const stale = await handler(makeRequest('/api/cyber-threats?limit=100&days=14', '198.51.100.14'));
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('X-Cache'), 'STALE');

    const body = await stale.json();
    assert.equal(body.success, true);
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data.length >= 1, true);
  } finally {
    Date.now = originalDateNow;
  }
});
