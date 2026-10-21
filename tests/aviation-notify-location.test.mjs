// #6626 — aviation_closure / notam_closure must carry lat/lon/city so
// proximity alerting can treat an airport as a declared site.
//
// Expected coordinates are literals from src/config/airports.ts (the registry
// the issue names), not recomputed from the helper under test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { airportNotifyLocation } from '../scripts/lib/airport-notify-location.mjs';
import { AIRPORTS } from '../scripts/seed-aviation.mjs';

const aviationSrc = readFileSync(
  fileURLToPath(new URL('../scripts/seed-aviation.mjs', import.meta.url)),
  'utf8',
);
const configSrc = readFileSync(
  fileURLToPath(new URL('../src/config/airports.ts', import.meta.url)),
  'utf8',
);

// Toronto Pearson — aviationstack + notam row; seeder already had coords.
const YYZ = { city: 'Toronto', lat: 43.6777, lon: -79.6248 };
// JFK — was FAA-only-shaped (no lat/lon); now inline in the seeder registry.
const JFK = { city: 'New York', lat: 40.6413, lon: -73.7781 };

describe('airportNotifyLocation', () => {
  it('copies city/lat/lon from a registry row', () => {
    assert.deepEqual(
      airportNotifyLocation({ city: 'Toronto', lat: 43.6777, lon: -79.6248 }),
      YYZ,
    );
  });

  it('reads alert-envelope location.latitude/longitude', () => {
    assert.deepEqual(
      airportNotifyLocation({
        city: 'Toronto',
        location: { latitude: 43.6777, longitude: -79.6248 },
      }),
      YYZ,
    );
  });

  it('omits 0,0 placeholders so proximity never treats the Gulf of Guinea as JFK', () => {
    assert.deepEqual(
      airportNotifyLocation({
        city: 'New York',
        location: { latitude: 0, longitude: 0 },
      }),
      { city: 'New York' },
    );
  });

  it('keeps a real point that sits on the equator or the prime meridian', () => {
    // Only the exact 0,0 pair is a placeholder; a single zero axis is a real place.
    assert.deepEqual(airportNotifyLocation({ city: 'A', lat: 0, lon: 45 }), { city: 'A', lat: 0, lon: 45 });
    assert.deepEqual(airportNotifyLocation({ city: 'B', lat: 51, lon: 0 }), { city: 'B', lat: 51, lon: 0 });
  });

  it('drops both axes when only one is usable', () => {
    assert.deepEqual(airportNotifyLocation({ city: 'A', lat: 43.6777 }), { city: 'A' });
    assert.deepEqual(airportNotifyLocation({ city: 'A', lon: -79.6248 }), { city: 'A' });
    assert.deepEqual(airportNotifyLocation({ city: 'A', lat: NaN, lon: 12 }), { city: 'A' });
  });

  it('rejects non-number coordinates instead of coercing them to a finite 0', () => {
    // Number(''), Number([]), Number(null) and Number(false) all coerce to 0 —
    // publishing a Gulf-of-Guinea axis beside a real one. typeof guards it.
    for (const bad of ['', [], null, false, '43.6777']) {
      assert.deepEqual(
        airportNotifyLocation({ city: 'A', lat: bad, lon: 113.9 }),
        { city: 'A' },
        `lat: ${JSON.stringify(bad)} must not coerce into a published coordinate`,
      );
    }
  });

  it('emits coordinates with no city when the row has no usable city', () => {
    assert.deepEqual(airportNotifyLocation({ lat: 1, lon: 2 }), { lat: 1, lon: 2 });
    assert.deepEqual(airportNotifyLocation({ city: '   ', lat: 1, lon: 2 }), { lat: 1, lon: 2 });
  });

  it('returns {} for a missing row', () => {
    assert.deepEqual(airportNotifyLocation(null), {});
    assert.deepEqual(airportNotifyLocation(undefined), {});
  });
});

describe('#6626 — the airport registry can locate every closure it can publish', () => {
  const notamRows = AIRPORTS.filter((a) => a.sources.includes('notam'));
  const aviationstackRows = AIRPORTS.filter((a) => a.sources.includes('aviationstack'));

  it('has NOTAM and AviationStack rows to check', () => {
    assert.ok(notamRows.length > 0, 'no notam-sourced rows found — the guard below would be vacuous');
    assert.ok(aviationstackRows.length > 0, 'no aviationstack-sourced rows found');
  });

  // This is the guard that would have caught the shipped gap: 27 NOTAM airports
  // (JFK, LAX, ATL, Beirut, Damascus, Baghdad, Tehran, Bandar Abbas, Gaborone…)
  // carried no coordinates and depended on a src/config/airports.ts read that
  // throws ENOENT in the scripts-rooted Railway container.
  it('resolves coordinates for every notam_closure-reachable airport', () => {
    const unlocated = notamRows
      .filter((a) => airportNotifyLocation(a).lat === undefined)
      .map((a) => `${a.iata}/${a.icao}`);
    assert.deepEqual(unlocated, [], `notam_closure would publish unlocated: ${unlocated.join(', ')}`);
  });

  it('resolves coordinates for every aviation_closure-reachable airport', () => {
    const unlocated = aviationstackRows
      .filter((a) => airportNotifyLocation(a).lat === undefined)
      .map((a) => `${a.iata}/${a.icao}`);
    assert.deepEqual(unlocated, [], `aviation_closure would publish unlocated: ${unlocated.join(', ')}`);
  });

  it('holds the seeder registry in coordinate parity with src/config/airports.ts', () => {
    // Both files exist in a checkout and in CI, so drift fails here rather than
    // degrading silently at runtime where only one of them ships.
    const configByIcao = new Map();
    const rowRe = /\{\s*iata:\s*'([A-Z]{3})'\s*,\s*icao:\s*'([A-Z0-9]{3,4})'[^}]*?lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*lon:\s*(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = rowRe.exec(configSrc)) !== null) {
      configByIcao.set(m[2], { lat: Number(m[3]), lon: Number(m[4]) });
    }
    assert.ok(configByIcao.size > 50, `parsed only ${configByIcao.size} config rows — regex drifted, guard would be vacuous`);

    const drift = [];
    for (const row of AIRPORTS) {
      const cfg = configByIcao.get(row.icao);
      if (!cfg || row.lat === undefined) continue; // not in both registries
      if (row.lat !== cfg.lat || row.lon !== cfg.lon) {
        drift.push(`${row.icao}: seeder ${row.lat},${row.lon} vs config ${cfg.lat},${cfg.lon}`);
      }
    }
    assert.deepEqual(drift, [], `registry drift: ${drift.join(' | ')}`);
  });

  it('locates the two airports that appear in no other registry', () => {
    for (const icao of ['OIKB', 'FBSK']) {
      const row = AIRPORTS.find((a) => a.icao === icao);
      assert.ok(row, `${icao} missing from the seeder registry`);
      const site = airportNotifyLocation(row);
      assert.equal(typeof site.lat, 'number', `${icao} must publish a latitude`);
      assert.equal(typeof site.lon, 'number', `${icao} must publish a longitude`);
    }
  });

  it('still carries the reference coordinates for YYZ and JFK', () => {
    assert.deepEqual(airportNotifyLocation(AIRPORTS.find((a) => a.iata === 'YYZ')), YYZ);
    assert.deepEqual(airportNotifyLocation(AIRPORTS.find((a) => a.iata === 'JFK')), JFK);
  });
});

// The publishers are asserted through source text, not behaviour: neither
// dispatch function is exported, and publishNotificationEvent is a private
// side-effect function (Upstash SETNX + LPUSH) with no injectable transport --
// the same constraint tests/notification-relay-coalesce-key.test.mjs documents
// for this module family.
//
// A gap-bounded regex is NOT sufficient here. The previous guard allowed
// `[\s\S]{0,800}` between the eventType anchor and the spread, which reaches
// well past the payload object: moving a spread OUT of `payload:` to a sibling
// key -- where it publishes nothing -- kept every test in this file green.
// Extracting the payload object literal and asserting inside it kills that
// mutant; asserting the resolver call separately pins the argument.
function payloadObjectFor(eventType) {
  const anchor = aviationSrc.indexOf(`eventType: '${eventType}'`);
  assert.notEqual(anchor, -1, `no publisher found for ${eventType}`);
  const open = aviationSrc.indexOf('payload: {', anchor);
  assert.notEqual(open, -1, `no payload object found for ${eventType}`);
  const start = aviationSrc.indexOf('{', open);
  let depth = 0;
  for (let i = start; i < aviationSrc.length; i += 1) {
    if (aviationSrc[i] === '{') depth += 1;
    else if (aviationSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) return aviationSrc.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced payload object for ${eventType}`);
}

describe('#6626 — both closure publishers thread the site fields', () => {
  it('aviation_closure resolves from the alert row and spreads it INSIDE payload', () => {
    assert.match(
      aviationSrc,
      /const site = airportNotifyLocation\(a\);/,
      'aviation_closure must resolve the site fields from the alert row it already holds',
    );
    assert.match(
      payloadObjectFor('aviation_closure'),
      /\.\.\.site,/,
      'the resolved site fields must be spread INSIDE payload — a spread outside payload publishes nothing',
    );
  });

  it('notam_closure reuses the ICAO registry row and spreads it INSIDE payload', () => {
    assert.match(
      aviationSrc,
      /const airport = AIRPORTS\.find\(a => a\.icao === icao\)/,
      'notam_closure must capture the existing ICAO lookup once (no second resolution)',
    );
    assert.match(
      aviationSrc,
      /const site = airportNotifyLocation\(airport\);/,
      'notam_closure must resolve the site fields from the row it already found for countryCode',
    );
    assert.match(
      payloadObjectFor('notam_closure'),
      /\.\.\.site,/,
      'the resolved site fields must be spread INSIDE payload',
    );
  });

  it('warns when a closure publishes with no coordinates, like the countryCode miss', () => {
    const warns = aviationSrc.match(/publishing unlocated \(invisible to proximity rules\)/g) ?? [];
    assert.equal(warns.length, 2, 'both publishers must warn when they publish an unlocated closure');
  });

  it('does not reach outside scripts/ on the notify path', () => {
    // src/config/airports.ts is absent from the scripts-rooted Railway
    // container; the notify path must never depend on reading it.
    const helperSrc = readFileSync(
      fileURLToPath(new URL('../scripts/lib/airport-notify-location.mjs', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(helperSrc, /\.\.[\\/]src[\\/]/, 'the notify helper must not read repo-root src/');
    assert.doesNotMatch(helperSrc, /readFileSync/, 'the notify helper must not read files at runtime');
  });
});
