import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const landingAsn = JSON.parse(readFileSync(resolve(__dirname, '../data/landing-asn.json'), 'utf-8'));

// Cable IDs defined in src/config/geo.ts (UNDERSEA_CABLES array)
const KNOWN_CABLE_IDS = [
  'marea', 'grace_hopper', 'havfrue', 'faster', 'southern_cross',
  'curie', 'seamewe6', 'flag', '2africa', 'wacs', 'eassy', 'sam1',
  'ellalink', 'apg', 'indigo', 'sjc', 'farice', 'falcon',
];

// Cable IDs referenced in api/cable-health.js (CABLE_LANDINGS)
const API_CABLE_IDS = [
  'marea', 'grace_hopper', 'havfrue', 'faster', 'southern_cross',
  'curie', 'seamewe6', 'flag', '2africa', 'wacs', 'eassy', 'sam1',
  'ellalink', 'apg', 'indigo', 'sjc', 'farice', 'falcon',
];

describe('landing-asn.json data integrity', () => {
  it('is a valid JSON object (not an array)', () => {
    assert.equal(typeof landingAsn, 'object');
    assert.equal(Array.isArray(landingAsn), false);
  });

  it('contains only known cable IDs (ignoring _comment)', () => {
    const ids = Object.keys(landingAsn).filter(k => !k.startsWith('_'));
    for (const id of ids) {
      assert.ok(
        KNOWN_CABLE_IDS.includes(id),
        `Unknown cable ID "${id}" in landing-asn.json`
      );
    }
  });

  it('covers all cables defined in the cable health API', () => {
    for (const id of API_CABLE_IDS) {
      assert.ok(
        landingAsn[id],
        `Cable "${id}" from cable health API is missing in landing-asn.json`
      );
    }
  });

  it('each cable has at least one landing point', () => {
    for (const [cableId, landings] of Object.entries(landingAsn)) {
      if (cableId.startsWith('_')) continue;
      assert.equal(typeof landings, 'object', `${cableId} should be an object`);
      const landingKeys = Object.keys(landings);
      assert.ok(landingKeys.length >= 1, `${cableId} should have at least 1 landing point`);
    }
  });

  it('each landing point has at least one ASN', () => {
    for (const [cableId, landings] of Object.entries(landingAsn)) {
      if (cableId.startsWith('_')) continue;
      for (const [landingId, asns] of Object.entries(landings)) {
        assert.ok(Array.isArray(asns), `${cableId}/${landingId} ASNs should be an array`);
        assert.ok(asns.length >= 1, `${cableId}/${landingId} should have at least 1 ASN`);
      }
    }
  });

  it('all ASNs are positive integers', () => {
    for (const [cableId, landings] of Object.entries(landingAsn)) {
      if (cableId.startsWith('_')) continue;
      for (const [landingId, asns] of Object.entries(landings)) {
        for (const asn of asns) {
          assert.equal(typeof asn, 'number', `${cableId}/${landingId} ASN ${asn} should be a number`);
          assert.ok(Number.isInteger(asn), `${cableId}/${landingId} ASN ${asn} should be an integer`);
          assert.ok(asn > 0, `${cableId}/${landingId} ASN ${asn} should be positive`);
        }
      }
    }
  });

  it('landing point IDs follow CC-City format', () => {
    const landingIdPattern = /^[A-Z]{2}-[A-Za-z\s]+$/;
    for (const [cableId, landings] of Object.entries(landingAsn)) {
      if (cableId.startsWith('_')) continue;
      for (const landingId of Object.keys(landings)) {
        assert.ok(
          landingIdPattern.test(landingId),
          `${cableId}/${landingId} should match CC-City format (e.g. "US-Virginia Beach")`
        );
      }
    }
  });

  it('no duplicate ASNs within a single landing point', () => {
    for (const [cableId, landings] of Object.entries(landingAsn)) {
      if (cableId.startsWith('_')) continue;
      for (const [landingId, asns] of Object.entries(landings)) {
        const unique = new Set(asns);
        assert.equal(
          unique.size, asns.length,
          `${cableId}/${landingId} has duplicate ASNs`
        );
      }
    }
  });

  it('key cables have expected landing points', () => {
    // Spot-check a few important cables
    const expectations = {
      marea: ['US-Virginia Beach', 'ES-Bilbao'],
      seamewe6: ['SG-Singapore', 'IN-Mumbai', 'FR-Marseille'],
      '2africa': ['GB-Bude', 'ZA-Cape Town', 'EG-Port Said'],
      faster: ['US-Oregon', 'JP-Chikura'],
    };

    for (const [cableId, expectedLandings] of Object.entries(expectations)) {
      const actualLandings = Object.keys(landingAsn[cableId] || {});
      for (const landing of expectedLandings) {
        assert.ok(
          actualLandings.includes(landing),
          `${cableId} should include landing "${landing}", has: ${actualLandings.join(', ')}`
        );
      }
    }
  });

  it('total cable count is reasonable (10-30)', () => {
    const cableCount = Object.keys(landingAsn).filter(k => !k.startsWith('_')).length;
    assert.ok(cableCount >= 10, `Expected at least 10 cables, got ${cableCount}`);
    assert.ok(cableCount <= 30, `Expected at most 30 cables, got ${cableCount}`);
  });
});
