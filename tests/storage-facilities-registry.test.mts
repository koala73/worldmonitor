// @ts-check
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRegistry,
  recordCount,
  STORAGE_FACILITIES_CANONICAL_KEY,
  MAX_STALE_MIN,
} from '../scripts/_storage-facility-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(__dirname, '../scripts/data/storage-facilities.json'), 'utf-8');
const registry = JSON.parse(raw) as { facilities: Record<string, any> };

describe('storage-facilities registry — schema', () => {
  test('registry passes validateRegistry', () => {
    assert.equal(validateRegistry(registry), true);
  });

  test('canonical key is stable string', () => {
    assert.equal(STORAGE_FACILITIES_CANONICAL_KEY, 'energy:storage-facilities:v1');
  });

  test('recordCount reports at least 15 facilities (MIN floor)', () => {
    assert.ok(recordCount(registry) >= 15);
  });

  test('MAX_STALE_MIN is 2× weekly cron (20160 min)', () => {
    assert.equal(MAX_STALE_MIN, 20_160);
  });
});

describe('storage-facilities registry — identity + geometry', () => {
  test('every facility.id matches its object key', () => {
    for (const [key, f] of Object.entries(registry.facilities)) {
      assert.equal(f.id, key, `${key} -> id=${f.id}`);
    }
  });

  test('every country code is ISO 3166-1 alpha-2', () => {
    const iso2 = /^[A-Z]{2}$/;
    for (const f of Object.values(registry.facilities)) {
      assert.ok(iso2.test(f.country), `bad country on ${f.id}: ${f.country}`);
    }
  });

  test('every coordinate is within Earth bounds', () => {
    for (const f of Object.values(registry.facilities)) {
      assert.ok(f.location.lat >= -90 && f.location.lat <= 90, `${f.id} lat OOB`);
      assert.ok(f.location.lon >= -180 && f.location.lon <= 180, `${f.id} lon OOB`);
    }
  });

  test('inService year is plausible (1900..2100)', () => {
    for (const f of Object.values(registry.facilities)) {
      assert.ok(f.inService >= 1900 && f.inService <= 2100, `${f.id} inService OOB: ${f.inService}`);
    }
  });
});

describe('storage-facilities registry — facility type × capacity pairing', () => {
  test('ugs facilities have capacityTwh (not capacityMb / capacityMtpa)', () => {
    const ugs = Object.values(registry.facilities).filter((f: any) => f.facilityType === 'ugs');
    assert.ok(ugs.length > 0, 'need at least one ugs facility');
    for (const f of ugs as any[]) {
      assert.equal(typeof f.capacityTwh, 'number', `${f.id} missing capacityTwh`);
      assert.ok(f.capacityTwh > 0, `${f.id} capacityTwh must be > 0`);
      assert.equal(f.workingCapacityUnit, 'TWh', `${f.id} wrong unit`);
    }
  });

  test('spr facilities have capacityMb', () => {
    const spr = Object.values(registry.facilities).filter((f: any) => f.facilityType === 'spr');
    assert.ok(spr.length > 0, 'need at least one spr facility');
    for (const f of spr as any[]) {
      assert.equal(typeof f.capacityMb, 'number', `${f.id} missing capacityMb`);
      assert.ok(f.capacityMb > 0, `${f.id} capacityMb must be > 0`);
      assert.equal(f.workingCapacityUnit, 'Mb');
    }
  });

  test('lng_export/lng_import facilities have capacityMtpa', () => {
    const lng = Object.values(registry.facilities).filter(
      (f: any) => f.facilityType === 'lng_export' || f.facilityType === 'lng_import',
    );
    assert.ok(lng.length > 0, 'need at least one LNG facility');
    for (const f of lng as any[]) {
      assert.equal(typeof f.capacityMtpa, 'number', `${f.id} missing capacityMtpa`);
      assert.ok(f.capacityMtpa > 0, `${f.id} capacityMtpa must be > 0`);
      assert.equal(f.workingCapacityUnit, 'Mtpa');
    }
  });

  test('crude_tank_farm facilities have capacityMb', () => {
    const tankFarms = Object.values(registry.facilities).filter(
      (f: any) => f.facilityType === 'crude_tank_farm',
    );
    assert.ok(tankFarms.length > 0, 'need at least one tank farm');
    for (const f of tankFarms as any[]) {
      assert.equal(typeof f.capacityMb, 'number', `${f.id} missing capacityMb`);
      assert.equal(f.workingCapacityUnit, 'Mb');
    }
  });
});

describe('storage-facilities registry — evidence contract', () => {
  test('non-operational badges carry at least one evidence source', () => {
    for (const f of Object.values(registry.facilities)) {
      if (f.evidence.physicalState === 'operational') continue;
      const hasEvidence =
        f.evidence.operatorStatement != null ||
        f.evidence.sanctionRefs.length > 0 ||
        ['ais-relay', 'satellite', 'press'].includes(f.evidence.physicalStateSource);
      assert.ok(
        hasEvidence,
        `${f.id} has no supporting evidence for state=${f.evidence.physicalState}`,
      );
    }
  });

  test('classifierConfidence is within 0..1', () => {
    for (const f of Object.values(registry.facilities)) {
      const c = f.evidence.classifierConfidence;
      assert.ok(c >= 0 && c <= 1, `${f.id} bad classifierConfidence: ${c}`);
    }
  });

  test('sanctionRefs entries carry {authority, date, url}', () => {
    for (const f of Object.values(registry.facilities)) {
      for (const ref of f.evidence.sanctionRefs) {
        assert.equal(typeof ref.authority, 'string', `${f.id} ref missing authority`);
        assert.equal(typeof ref.date, 'string', `${f.id} ref missing date`);
        assert.equal(typeof ref.url, 'string', `${f.id} ref missing url`);
        assert.ok(ref.url.startsWith('http'), `${f.id} ref url not http(s)`);
      }
    }
  });

  test('fillDisclosed=true implies fillSource string is present', () => {
    for (const f of Object.values(registry.facilities)) {
      if (f.evidence.fillDisclosed) {
        assert.equal(
          typeof f.evidence.fillSource,
          'string',
          `${f.id} fillDisclosed=true but fillSource missing`,
        );
        assert.ok(f.evidence.fillSource.length > 0, `${f.id} empty fillSource`);
      }
    }
  });
});

describe('storage-facilities registry — validateRegistry rejects bad input', () => {
  test('rejects empty object', () => {
    assert.equal(validateRegistry({}), false);
  });

  test('rejects null', () => {
    assert.equal(validateRegistry(null), false);
  });

  test('rejects below MIN_FACILITIES', () => {
    const firstKey = Object.keys(registry.facilities)[0]!;
    const bad = { facilities: { onlyOne: registry.facilities[firstKey] } };
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects a facility with no evidence', () => {
    const bad = {
      facilities: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`f${i}`, {
          id: `f${i}`, name: 'x', operator: 'y', facilityType: 'ugs',
          country: 'DE', location: { lat: 52, lon: 8 },
          capacityTwh: 10, workingCapacityUnit: 'TWh', inService: 2000,
        }]),
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects mismatched facility type × capacity unit', () => {
    const facilities = { ...registry.facilities };
    const ids = Object.keys(facilities);
    // Build a bad copy: an SPR site with capacityTwh instead of capacityMb.
    const bad = JSON.parse(JSON.stringify(registry)) as typeof registry;
    const victim = Object.values(bad.facilities).find((f: any) => f.facilityType === 'spr') as any;
    assert.ok(victim, 'precondition: registry must contain at least one spr facility');
    delete victim.capacityMb;
    victim.capacityTwh = 100;
    victim.workingCapacityUnit = 'TWh';
    assert.equal(validateRegistry(bad), false);
    assert.ok(ids.length > 0);
  });
});
