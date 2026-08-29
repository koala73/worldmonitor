import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalystEngine, applyScope, haversineKm } from './analystEngine.js';

// Stub world: a square "Texland" region, flights + ships + fires around it.
const TEXLAND = { name: 'Texland', ring: [[-100, 28], [-94, 28], [-94, 33], [-100, 33]] };
const FLIGHTS = [
  { id: 'SWA1', lat: 30.2, lon: -97.7, altitudeM: 11000, speedMps: 240, military: false, onGround: false, routeOrigin: 'AUS', routeDestination: 'LAX' },
  { id: 'RCH01', lat: 31.0, lon: -97.0, altitudeM: 13500, speedMps: 250, military: true, onGround: false, routeOrigin: null, routeDestination: null },
  { id: 'N123', lat: 45.0, lon: -122.0, altitudeM: 2000, speedMps: 80, military: false, onGround: false, routeOrigin: null, routeDestination: null },
  { id: 'GND1', lat: 30.19, lon: -97.66, altitudeM: 150, speedMps: 5, military: false, onGround: true, routeOrigin: null, routeDestination: null },
];
const SHIPS = [
  { id: 'EVERGIVEN', lat: 29.5, lon: -94.9, speedKts: 12, shipType: 'Cargo', destination: 'OAKLAND', navStatus: 'under way' },
  { id: 'SLOWBOAT', lat: 29.6, lon: -95.0, speedKts: 0.2, shipType: 'Tanker', destination: 'HOUSTON', navStatus: 'anchored' },
];
const FIRES = [
  { id: 'FIRE-1', lat: 30.5, lon: -98.2, frp: 1500 },
  { id: 'FIRE-2', lat: 30.6, lon: -98.1, frp: 90 },
  { id: 'FIRE-3', lat: 51.9, lon: -121.9, frp: 2400 },
];

function makeEngine() {
  return createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'ais-live-vessels': SHIPS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    getViewContext: () => ({ lat: 30.27, lon: -97.74, viewRadiusKm: 150 }),
  });
}

/** Same world, but Contacts is up with a subject far from the parked camera. */
function makeContactsEngine(subject) {
  return createAnalystEngine({
    getRecords: (key) => ({ flights: FLIGHTS, 'ais-live-vessels': SHIPS, 'local-firms': FIRES }[key] || []),
    resolveRegionRing: async (name) => (/texland/i.test(name) ? TEXLAND : null),
    // Parked far away, as a high-altitude camera often is.
    getViewContext: () => ({ lat: 45.0, lon: -122.0, viewRadiusKm: 150 }),
    getContextSubject: () => subject,
  });
}

test('analyst: a radius query centers on the active contact, not the parked camera', async () => {
  // Field case: the Contacts panel counted a contact-centred window while the
  // camera sat off-coast at 441 km, so "how many within 250 km" answered from
  // the camera and disagreed with what the operator could see.
  const subject = { lat: 30.2, lon: -97.7, label: 'SWA1' };
  const r = await makeContactsEngine(subject).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.ok, true);
  // Austin-area flights, not the Oregon one the camera is parked over.
  assert.equal(r.count, 3);
  assert.equal(r.centeredOn, 'SWA1', 'the answer names the centre it measured from');
  assert.ok(r.coverage.scope.includes('@SWA1'));
});

test('analyst: an explicit center still wins over the active contact', async () => {
  const subject = { lat: 30.2, lon: -97.7, label: 'SWA1' };
  const r = await makeContactsEngine(subject).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250, center: { lat: 45.0, lon: -122.0 } },
    limit: 50,
  });
  assert.equal(r.count, 1, 'only the Oregon flight is within 250 km of the given center');
  assert.equal(r.centeredOn, undefined, 'an explicit center is not relabelled');
});

test('analyst: with Contacts off, radius still centers on the view', async () => {
  const r = await makeContactsEngine(null).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.count, 1, 'view-centred behaviour is unchanged outside Contacts');
  assert.equal(r.centeredOn, undefined);
  assert.equal(r.coverage.scope, 'radius:250km');
});

test('analyst: a subject without usable coordinates cannot lend its name to a camera-centred count', async () => {
  // The label is the only thing telling the operator WHICH centre produced the
  // number. A subject present but position-less fell back to the camera and
  // kept the contact's name on the answer, so a camera-centred count read as
  // contact-centred with nothing in the payload to catch it.
  const r = await makeContactsEngine({ lat: null, lon: null, label: 'SWA1' }).query({
    layers: ['flights'],
    scope: { kind: 'radius', km: 250 },
    limit: 50,
  });
  assert.equal(r.count, 1, 'the count is the camera-centred one it actually measured');
  assert.equal(r.centeredOn, undefined, 'and it must not claim a centre it did not use');
  assert.equal(r.coverage.scope, 'radius:250km');
  assert.equal(r.scopeLabel, 'within 250 km');
});

test('analyst: every scope names itself in words', async () => {
  // Rule 3 of the counting contract: a bare number is what made two honest
  // answers look like a contradiction, so each scope carries its own phrasing.
  const subject = { lat: 30.2, lon: -97.7, label: 'DYNO11' };
  const centred = await makeContactsEngine(subject).query({
    layers: ['flights'], scope: { kind: 'radius', km: 250 }, limit: 1,
  });
  assert.equal(centred.scopeLabel, 'within 250 km of DYNO11');

  const plainRadius = await makeContactsEngine(null).query({
    layers: ['flights'], scope: { kind: 'radius', km: 250 }, limit: 1,
  });
  assert.equal(plainRadius.scopeLabel, 'within 250 km');

  const inView = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'view' }, limit: 1,
  });
  assert.equal(inView.scopeLabel, 'in view');

  const region = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'region', name: 'Texland' }, limit: 1,
  });
  assert.equal(region.scopeLabel, 'over Texland');

  const anywhere = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' }, limit: 1,
  });
  assert.equal(anywhere.scopeLabel, 'anywhere in the loaded data');
});

test('analyst: count flights over a region', async () => {
  const r = await makeEngine().query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' }, limit: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3, 'Oregon flight excluded');
  assert.ok(r.coverage.scope.includes('Texland'));
});

test('analyst: attribute filter — above 40,000 ft (~12,192 m)', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'altitudeM', op: 'gt', value: 12192 }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['RCH01']);
});

test('analyst: military flag + region compose', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'region', name: 'Texland' },
    filters: [{ field: 'military', op: 'eq', value: true }],
  });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'RCH01');
});

test('analyst: ships headed to Oakland (destination contains)', async () => {
  const r = await makeEngine().query({
    layers: ['ais-live-vessels'], scope: { kind: 'anywhere' },
    filters: [{ field: 'destination', op: 'contains', value: 'oakland' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['EVERGIVEN']);
});

test('analyst: superlative — biggest fire in view radius', async () => {
  const r = await makeEngine().query({
    layers: ['local-firms'], scope: { kind: 'view' }, sortBy: 'frp', limit: 1,
  });
  assert.equal(r.items[0].id, 'FIRE-1', 'BC monster is out of view scope');
  assert.equal(r.summary.frpMax, 1500);
});

test('analyst: nearest sorting attaches distanceKm ascending', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'view' }, sortBy: 'distance', limit: 3,
  });
  assert.ok(r.items[0].distanceKm <= r.items[1].distanceKm);
  assert.ok(Number.isFinite(r.items[0].distanceKm));
});

test('analyst: follow-up re-filters the remembered set without re-snapshot', async () => {
  const eng = makeEngine();
  await eng.query({ layers: ['flights'], scope: { kind: 'region', name: 'Texland' } });
  const r = await eng.query({ followUp: true, filters: [{ field: 'onGround', op: 'eq', value: true }] });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'GND1');
  assert.equal(r.coverage.followUp, true);
});

test('analyst: unresolved region is an honest failure, not empty success', async () => {
  const r = await makeEngine().query({ layers: ['flights'], scope: { kind: 'region', name: 'Atlantis' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Atlantis/);
});

test('analyst: route fields queryable from cached enrichment only', async () => {
  const r = await makeEngine().query({
    layers: ['flights'], scope: { kind: 'anywhere' },
    filters: [{ field: 'routeDestination', op: 'eq', value: 'LAX' }],
  });
  assert.deepEqual(r.items.map((i) => i.id), ['SWA1'], 'null route fields never match');
});

test('helpers: haversine sanity + scope radius', () => {
  const km = haversineKm(30.2672, -97.7431, 29.7604, -95.3698); // Austin→Houston
  assert.ok(km > 200 && km < 280, `Austin-Houston ~235km, got ${km}`);
  const scoped = applyScope(FLIGHTS, { kind: 'radius' }, { center: { lat: 30.27, lon: -97.74 }, km: 50 });
  assert.deepEqual(scoped.map((f) => f.id).sort(), ['GND1', 'SWA1']);
});
