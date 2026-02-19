import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler, {
  __testProcessNgaSignals,
  __testComputeHealthMap,
  __testIsCableRelated,
  __testMatchCableByName,
  __testFindNearestCable,
  __testParseCoordinates,
} from './cable-health.js';

const ORIGINAL_FETCH = globalThis.fetch;

function makeRequest(path = '/api/cable-health', ip = '198.51.100.10') {
  const headers = new Headers();
  headers.set('x-forwarded-for', ip);
  return new Request(`https://worldmonitor.app${path}`, { headers });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ── isCableRelated ──

test('isCableRelated detects cable keywords', () => {
  assert.equal(__testIsCableRelated('SUBMARINE CABLE repair in progress'), true);
  assert.equal(__testIsCableRelated('CABLESHIP CS Reliance on station'), true);
  assert.equal(__testIsCableRelated('cable laying operations'), true);
  assert.equal(__testIsCableRelated('fiber optic maintenance'), true);
  assert.equal(__testIsCableRelated('TELECOMMUNICATIONS CABLE route'), true);
});

test('isCableRelated rejects non-cable text', () => {
  assert.equal(__testIsCableRelated('vessel traffic in the area'), false);
  assert.equal(__testIsCableRelated('naval exercise commenced'), false);
  assert.equal(__testIsCableRelated('pipeline inspection'), false);
});

// ── matchCableByName ──

test('matchCableByName matches known cable names', () => {
  assert.equal(__testMatchCableByName('Operations near MAREA cable route'), 'marea');
  assert.equal(__testMatchCableByName('GRACE HOPPER submarine cable'), 'grace_hopper');
  assert.equal(__testMatchCableByName('SEA-ME-WE cable system advisory'), 'seamewe6');
  assert.equal(__testMatchCableByName('SMW6 maintenance window'), 'seamewe6');
  assert.equal(__testMatchCableByName('2AFRICA cable segment'), '2africa');
  assert.equal(__testMatchCableByName('FALCON cable route'), 'falcon');
  assert.equal(__testMatchCableByName('ELLA LINK transatlantic'), 'ellalink');
  assert.equal(__testMatchCableByName('ELLALINK cable'), 'ellalink');
});

test('matchCableByName returns null for unknown cables', () => {
  assert.equal(__testMatchCableByName('unknown cable system'), null);
  assert.equal(__testMatchCableByName('random text with no cable name'), null);
});

// ── parseCoordinates ──

test('parseCoordinates parses DMS coordinates', () => {
  const coords = __testParseCoordinates('36-50N 075-59W TO 43-16N 002-56W');
  assert.equal(coords.length, 2);
  // First coord: ~36.83N, ~75.98W
  assert.ok(coords[0][0] > 36 && coords[0][0] < 37);
  assert.ok(coords[0][1] < -75 && coords[0][1] > -76);
  // Second coord: ~43.27N, ~2.93W
  assert.ok(coords[1][0] > 43 && coords[1][0] < 44);
  assert.ok(coords[1][1] < -2 && coords[1][1] > -3);
});

test('parseCoordinates handles southern and eastern hemispheres', () => {
  const coords = __testParseCoordinates('33-52S 151-13E');
  assert.equal(coords.length, 1);
  assert.ok(coords[0][0] < 0); // South
  assert.ok(coords[0][1] > 0); // East
});

test('parseCoordinates returns empty for text without coordinates', () => {
  assert.deepEqual(__testParseCoordinates('no coordinates here'), []);
});

// ── findNearestCable ──

test('findNearestCable matches MAREA near Virginia Beach', () => {
  const result = __testFindNearestCable(36.85, -75.98);
  assert.ok(result);
  assert.equal(result.cableId, 'marea');
  assert.ok(result.distanceDeg < 1);
});

test('findNearestCable matches southern_cross near Sydney', () => {
  const result = __testFindNearestCable(-33.87, 151.21);
  assert.ok(result);
  assert.equal(result.cableId, 'southern_cross');
});

test('findNearestCable returns null for remote ocean coordinates', () => {
  // Middle of the South Pacific, far from any landing
  const result = __testFindNearestCable(-45, -140);
  assert.equal(result, null);
});

test('findNearestCable respects MAX_DIST_DEG threshold', () => {
  // Very far from any cable landing
  const result = __testFindNearestCable(80, 0);
  assert.equal(result, null);
});

// ── processNgaSignals ──

test('processNgaSignals extracts fault signal from cable-related warning', () => {
  const warnings = [{
    text: 'SUBMARINE CABLE FAULT reported on MAREA cable route. 36-50N 075-58W. CABLE DAMAGE confirmed.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '42',
  }];

  const signals = __testProcessNgaSignals(warnings);
  assert.ok(signals.length >= 1);

  const faultSignal = signals.find(s => s.kind === 'operator_fault');
  assert.ok(faultSignal);
  assert.equal(faultSignal.cableId, 'marea');
  assert.equal(faultSignal.severity, 1.0);
  assert.ok(faultSignal.confidence > 0);
  assert.equal(faultSignal.evidence.length, 1);
  assert.equal(faultSignal.evidence[0].source, 'NGA');
});

test('processNgaSignals extracts repair activity signal', () => {
  const warnings = [{
    text: 'CABLESHIP CS RELIANCE CABLE operations in area. SUBMARINE CABLE laying. 43-16N 002-56W. ON STATION.',
    issueDate: '141000Z FEB 2026',
    navArea: 'III',
    msgYear: '2026',
    msgNumber: '33',
  }];

  const signals = __testProcessNgaSignals(warnings);
  const repairSignal = signals.find(s => s.kind === 'repair_activity');
  assert.ok(repairSignal);
  assert.ok(repairSignal.severity >= 0.5);
  assert.ok(repairSignal.confidence > 0);
});

test('processNgaSignals skips non-cable warnings', () => {
  const warnings = [{
    text: 'Naval exercise in area. All vessels advised to keep clear. 36-50N 075-58W.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '99',
  }];

  const signals = __testProcessNgaSignals(warnings);
  assert.equal(signals.length, 0);
});

test('processNgaSignals matches cable by geometry when name not found', () => {
  const warnings = [{
    text: 'SUBMARINE CABLE operations. CABLE repair. 36-51N 075-59W.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '50',
  }];

  const signals = __testProcessNgaSignals(warnings);
  assert.ok(signals.length >= 1);
  // Should match marea by proximity to Virginia Beach landing
  assert.equal(signals[0].cableId, 'marea');
});

test('processNgaSignals produces advisory (not fault) for non-fault cable warning', () => {
  const warnings = [{
    text: 'SUBMARINE CABLE MAREA maintenance advisory. Vessels avoid area. 36-50N 075-58W.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '55',
  }];

  const signals = __testProcessNgaSignals(warnings);
  const advisory = signals.find(s => s.kind === 'operator_fault');
  assert.ok(advisory);
  assert.equal(advisory.severity, 0.6); // Advisory severity, not 1.0 fault
});

test('processNgaSignals assigns higher confidence for name-matched vs geometry-matched', () => {
  const nameWarning = [{
    text: 'SUBMARINE CABLE FAULT on MAREA. CABLE DAMAGE confirmed. 36-50N 075-58W.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '60',
  }];

  const geoWarning = [{
    text: 'SUBMARINE CABLE FAULT reported. CABLE DAMAGE. 36-50N 075-58W.',
    issueDate: '151200Z FEB 2026',
    navArea: 'IV',
    msgYear: '2026',
    msgNumber: '61',
  }];

  const nameSignals = __testProcessNgaSignals(nameWarning);
  const geoSignals = __testProcessNgaSignals(geoWarning);

  const nameFault = nameSignals.find(s => s.kind === 'operator_fault');
  const geoFault = geoSignals.find(s => s.kind === 'operator_fault');

  assert.ok(nameFault);
  assert.ok(geoFault);
  assert.ok(nameFault.confidence > geoFault.confidence,
    `Name-match confidence (${nameFault.confidence}) should exceed geometry-match (${geoFault.confidence})`);
});

// ── computeHealthMap ──

test('computeHealthMap produces fault status for high-severity operator fault', () => {
  const now = new Date().toISOString();
  const signals = [{
    cableId: 'marea',
    ts: now,
    severity: 1.0,
    confidence: 0.9,
    ttlSeconds: 5 * 86400,
    kind: 'operator_fault',
    evidence: [{ source: 'NGA', summary: 'Fault confirmed', ts: now }],
  }];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.marea);
  assert.equal(health.marea.status, 'fault');
  assert.ok(health.marea.score >= 0.80);
  assert.ok(health.marea.confidence > 0);
  assert.equal(health.marea.evidence.length, 1);
});

test('computeHealthMap produces degraded status for moderate signals', () => {
  const now = new Date().toISOString();
  const signals = [{
    cableId: 'curie',
    ts: now,
    severity: 0.6,
    confidence: 0.9,
    ttlSeconds: 3 * 86400,
    kind: 'operator_fault',
    evidence: [{ source: 'NGA', summary: 'Advisory', ts: now }],
  }];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.curie);
  assert.equal(health.curie.status, 'degraded');
  assert.ok(health.curie.score >= 0.50);
  assert.ok(health.curie.score < 0.80);
});

test('computeHealthMap produces ok status for low-severity signals', () => {
  const now = new Date().toISOString();
  const signals = [{
    cableId: 'flag',
    ts: now,
    severity: 0.3,
    confidence: 0.5,
    ttlSeconds: 3 * 86400,
    kind: 'repair_activity',
    evidence: [{ source: 'NGA', summary: 'Ship nearby', ts: now }],
  }];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.flag);
  assert.equal(health.flag.status, 'ok');
  assert.ok(health.flag.score < 0.50);
});

test('computeHealthMap caps repair-only signal at degraded (never fault)', () => {
  const now = new Date().toISOString();
  const signals = [{
    cableId: 'faster',
    ts: now,
    severity: 0.9,
    confidence: 0.95,
    ttlSeconds: 24 * 3600,
    kind: 'repair_activity',
    evidence: [{ source: 'NGA', summary: 'Cable ship on station', ts: now }],
  }];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.faster);
  // Repair activity alone should cap at degraded, not fault
  assert.equal(health.faster.status, 'degraded');
});

test('computeHealthMap promotes to fault when both operator_fault and repair_activity present', () => {
  const now = new Date().toISOString();
  const signals = [
    {
      cableId: 'seamewe6',
      ts: now,
      severity: 1.0,
      confidence: 0.9,
      ttlSeconds: 5 * 86400,
      kind: 'operator_fault',
      evidence: [{ source: 'NGA', summary: 'Fault reported', ts: now }],
    },
    {
      cableId: 'seamewe6',
      ts: now,
      severity: 0.8,
      confidence: 0.85,
      ttlSeconds: 24 * 3600,
      kind: 'repair_activity',
      evidence: [{ source: 'NGA', summary: 'Repair ship on station', ts: now }],
    },
  ];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.seamewe6);
  assert.equal(health.seamewe6.status, 'fault');
});

test('computeHealthMap decays old signals beyond TTL', () => {
  const oldTs = new Date(Date.now() - 10 * 86400 * 1000).toISOString(); // 10 days ago
  const signals = [{
    cableId: 'wacs',
    ts: oldTs,
    severity: 1.0,
    confidence: 0.9,
    ttlSeconds: 5 * 86400, // 5-day TTL → fully decayed after 5 days
    kind: 'operator_fault',
    evidence: [{ source: 'NGA', summary: 'Old fault', ts: oldTs }],
  }];

  const health = __testComputeHealthMap(signals);
  // Signal is fully decayed (10 days old, 5-day TTL), should not appear
  assert.equal(health.wacs, undefined);
});

test('computeHealthMap limits evidence to 3 items', () => {
  const now = new Date().toISOString();
  const signals = [
    { cableId: 'apg', ts: now, severity: 0.8, confidence: 0.9, ttlSeconds: 5 * 86400, kind: 'operator_fault', evidence: [{ source: 'NGA', summary: 'Ev1', ts: now }] },
    { cableId: 'apg', ts: now, severity: 0.7, confidence: 0.8, ttlSeconds: 5 * 86400, kind: 'operator_fault', evidence: [{ source: 'NGA', summary: 'Ev2', ts: now }] },
    { cableId: 'apg', ts: now, severity: 0.6, confidence: 0.7, ttlSeconds: 5 * 86400, kind: 'repair_activity', evidence: [{ source: 'NGA', summary: 'Ev3', ts: now }] },
    { cableId: 'apg', ts: now, severity: 0.5, confidence: 0.6, ttlSeconds: 5 * 86400, kind: 'repair_activity', evidence: [{ source: 'NGA', summary: 'Ev4', ts: now }] },
  ];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.apg);
  assert.ok(health.apg.evidence.length <= 3);
});

test('computeHealthMap returns empty for empty signals', () => {
  const health = __testComputeHealthMap([]);
  assert.deepEqual(health, {});
});

test('computeHealthMap handles multiple cables independently', () => {
  const now = new Date().toISOString();
  const signals = [
    { cableId: 'marea', ts: now, severity: 1.0, confidence: 0.9, ttlSeconds: 5 * 86400, kind: 'operator_fault', evidence: [{ source: 'NGA', summary: 'Fault', ts: now }] },
    { cableId: 'curie', ts: now, severity: 0.3, confidence: 0.5, ttlSeconds: 3 * 86400, kind: 'repair_activity', evidence: [{ source: 'NGA', summary: 'Maintenance', ts: now }] },
  ];

  const health = __testComputeHealthMap(signals);
  assert.ok(health.marea);
  assert.ok(health.curie);
  assert.equal(health.marea.status, 'fault');
  assert.equal(health.curie.status, 'ok');
});

// ── API handler integration ──

/** Build an NGA-style issueDate string (e.g. "191200Z FEB 2026") for right now. */
function ngaNowDateString() {
  const now = new Date();
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${dd}${hh}${mm}Z ${months[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
}

test('API returns valid response with mocked NGA data', async () => {
  const issueDate = ngaNowDateString();

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('msi.nga.mil')) {
      return jsonResponse([
        {
          text: 'SUBMARINE CABLE FAULT on MAREA. CABLE DAMAGE confirmed. 36-50N 075-58W.',
          issueDate,
          navArea: 'IV',
          msgYear: '2026',
          msgNumber: '100',
        },
      ]);
    }
    return new Response('not found', { status: 404 });
  };

  const response = await handler(makeRequest());
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(body.generatedAt);
  assert.ok(body.cables);
  assert.ok(body.cables.marea);
  assert.equal(body.cables.marea.status, 'fault');
  assert.ok(body.cables.marea.score >= 0.80);
  assert.ok(Array.isArray(body.cables.marea.evidence));
});

test('API returns empty cables when NGA returns no warnings', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('msi.nga.mil')) {
      return jsonResponse([]);
    }
    return new Response('not found', { status: 404 });
  };

  const response = await handler(makeRequest());
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(body.generatedAt);
  assert.deepEqual(body.cables, {});
});

test('API handles NGA upstream failure gracefully', async () => {
  globalThis.fetch = async () => {
    throw new Error('network failure');
  };

  const response = await handler(makeRequest());
  // Should still return 200 with empty cables since fetchNgaWarnings catches errors
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body.cables, {});
});

test('API returns CORS headers', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('msi.nga.mil')) return jsonResponse([]);
    return new Response('not found', { status: 404 });
  };

  const response = await handler(makeRequest());
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.includes('application/json'));
});

test('API handles OPTIONS preflight request', async () => {
  const req = new Request('https://worldmonitor.app/api/cable-health', {
    method: 'OPTIONS',
    headers: new Headers({ 'x-forwarded-for': '198.51.100.10' }),
  });

  const response = await handler(req);
  assert.equal(response.status, 204);
});
