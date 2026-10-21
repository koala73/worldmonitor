// @ts-check
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  validateRegistry,
  recordCount,
  GAS_CANONICAL_KEY,
  OIL_CANONICAL_KEY,
  VALID_OIL_PRODUCT_CLASSES,
  VALID_SOURCES,
} from '../scripts/_pipeline-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasRaw = readFileSync(resolve(__dirname, '../scripts/data/pipelines-gas.json'), 'utf-8');
const oilRaw = readFileSync(resolve(__dirname, '../scripts/data/pipelines-oil.json'), 'utf-8');
const gas = JSON.parse(gasRaw) as { pipelines: Record<string, any> };
const oil = JSON.parse(oilRaw) as { pipelines: Record<string, any> };

describe('pipeline registries — schema', () => {
  test('gas registry passes validateRegistry', () => {
    assert.equal(validateRegistry(gas), true);
  });

  test('oil registry passes validateRegistry', () => {
    assert.equal(validateRegistry(oil), true);
  });

  test('canonical keys are stable strings', () => {
    assert.equal(GAS_CANONICAL_KEY, 'energy:pipelines:gas:v1');
    assert.equal(OIL_CANONICAL_KEY, 'energy:pipelines:oil:v1');
  });

  test('recordCount returns non-zero for both registries', () => {
    assert.ok(recordCount(gas) >= 8);
    assert.ok(recordCount(oil) >= 8);
  });
});

describe('pipeline registries — identity + geometry', () => {
  test('all ids are unique across gas + oil (no collisions)', () => {
    const gasIds = Object.keys(gas.pipelines);
    const oilIds = Object.keys(oil.pipelines);
    const overlap = gasIds.filter(id => oilIds.includes(id));
    assert.equal(overlap.length, 0, `overlapping ids: ${overlap.join(',')}`);
  });

  test('every pipeline.id matches its object key', () => {
    for (const [key, p] of Object.entries(gas.pipelines)) {
      assert.equal(p.id, key, `gas: ${key} -> id=${p.id}`);
    }
    for (const [key, p] of Object.entries(oil.pipelines)) {
      assert.equal(p.id, key, `oil: ${key} -> id=${p.id}`);
    }
  });

  test('every country code is ISO 3166-1 alpha-2', () => {
    const iso2 = /^[A-Z]{2}$/;
    const all = [...Object.values(gas.pipelines), ...Object.values(oil.pipelines)];
    for (const p of all) {
      assert.ok(iso2.test(p.fromCountry), `bad fromCountry on ${p.id}: ${p.fromCountry}`);
      assert.ok(iso2.test(p.toCountry), `bad toCountry on ${p.id}: ${p.toCountry}`);
      for (const t of p.transitCountries) {
        assert.ok(iso2.test(t), `bad transitCountry on ${p.id}: ${t}`);
      }
    }
  });

  test('endpoint coordinates are within Earth bounds', () => {
    const all = [...Object.values(gas.pipelines), ...Object.values(oil.pipelines)];
    for (const p of all) {
      assert.ok(p.startPoint.lat >= -90 && p.startPoint.lat <= 90, `${p.id} startPoint.lat OOB`);
      assert.ok(p.startPoint.lon >= -180 && p.startPoint.lon <= 180, `${p.id} startPoint.lon OOB`);
      assert.ok(p.endPoint.lat >= -90 && p.endPoint.lat <= 90, `${p.id} endPoint.lat OOB`);
      assert.ok(p.endPoint.lon >= -180 && p.endPoint.lon <= 180, `${p.id} endPoint.lon OOB`);
    }
  });
});

describe('pipeline registries — evidence', () => {
  test('non-flowing badges carry at least one evidence source', () => {
    const all = [...Object.values(gas.pipelines), ...Object.values(oil.pipelines)];
    for (const p of all) {
      if (p.evidence.physicalState === 'flowing') continue;
      const hasEvidence =
        p.evidence.operatorStatement != null ||
        p.evidence.sanctionRefs.length > 0 ||
        ['ais-relay', 'satellite', 'press', 'gem'].includes(p.evidence.physicalStateSource);
      assert.ok(hasEvidence, `${p.id} has no supporting evidence for state=${p.evidence.physicalState}`);
    }
  });

  test('classifier confidence is within 0..1', () => {
    const all = [...Object.values(gas.pipelines), ...Object.values(oil.pipelines)];
    for (const p of all) {
      const c = p.evidence.classifierConfidence;
      assert.ok(c >= 0 && c <= 1, `${p.id} bad classifierConfidence: ${c}`);
    }
  });

  test('sanctionRefs entries carry {authority, date, url}', () => {
    const all = [...Object.values(gas.pipelines), ...Object.values(oil.pipelines)];
    for (const p of all) {
      for (const ref of p.evidence.sanctionRefs) {
        assert.equal(typeof ref.authority, 'string', `${p.id} ref missing authority`);
        assert.equal(typeof ref.date, 'string', `${p.id} ref missing date`);
        assert.equal(typeof ref.url, 'string', `${p.id} ref missing url`);
        assert.ok(ref.url.startsWith('http'), `${p.id} ref url not http(s)`);
      }
    }
  });
});

describe('pipeline registries — commodity-capacity pairing', () => {
  test('gas pipelines have capacityBcmYr (not capacityMbd)', () => {
    for (const p of Object.values(gas.pipelines)) {
      assert.equal(p.commodityType, 'gas', `${p.id} should be commodityType=gas`);
      assert.equal(typeof p.capacityBcmYr, 'number', `${p.id} missing capacityBcmYr`);
      assert.ok(p.capacityBcmYr > 0, `${p.id} capacityBcmYr must be > 0`);
    }
  });

  test('oil pipelines have capacityMbd (not capacityBcmYr)', () => {
    for (const p of Object.values(oil.pipelines)) {
      assert.equal(p.commodityType, 'oil', `${p.id} should be commodityType=oil`);
      assert.equal(typeof p.capacityMbd, 'number', `${p.id} missing capacityMbd`);
      assert.ok(p.capacityMbd > 0, `${p.id} capacityMbd must be > 0`);
    }
  });
});

describe('pipeline registries — productClass', () => {
  test('every oil pipeline declares a productClass from the enum', () => {
    for (const p of Object.values(oil.pipelines)) {
      assert.ok(
        VALID_OIL_PRODUCT_CLASSES.has(p.productClass),
        `${p.id} has invalid productClass: ${p.productClass}`,
      );
    }
  });

  test('gas pipelines do not carry a productClass field', () => {
    for (const p of Object.values(gas.pipelines)) {
      assert.equal(
        p.productClass,
        undefined,
        `${p.id} should not have productClass (gas pipelines use commodity as their class)`,
      );
    }
  });

  test('validateRegistry rejects oil pipeline without productClass', () => {
    const oilSample = oil.pipelines[Object.keys(oil.pipelines)[0]!];
    const { productClass: _drop, ...stripped } = oilSample;
    const bad = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`p${i}`, { ...stripped, id: `p${i}` }]),
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });

  test('validateRegistry rejects oil pipeline with unknown productClass', () => {
    const oilSample = oil.pipelines[Object.keys(oil.pipelines)[0]!];
    const bad = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [
          `p${i}`,
          { ...oilSample, id: `p${i}`, productClass: 'diesel-only' },
        ]),
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });

  test('validateRegistry rejects gas pipeline carrying productClass', () => {
    const gasSample = gas.pipelines[Object.keys(gas.pipelines)[0]!];
    const bad = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [
          `p${i}`,
          { ...gasSample, id: `p${i}`, productClass: 'crude' },
        ]),
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });
});

describe('pipeline registries — validateRegistry rejects bad input', () => {
  test('rejects empty object', () => {
    assert.equal(validateRegistry({}), false);
  });

  test('rejects null', () => {
    assert.equal(validateRegistry(null), false);
  });

  test('rejects a pipeline with no evidence', () => {
    const bad = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`p${i}`, {
          id: `p${i}`, name: 'x', operator: 'y', commodityType: 'gas',
          fromCountry: 'US', toCountry: 'CA', transitCountries: [],
          capacityBcmYr: 1, startPoint: { lat: 0, lon: 0 }, endPoint: { lat: 1, lon: 1 },
        }])
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });

  test('rejects below MIN_PIPELINES_PER_REGISTRY', () => {
    const bad = { pipelines: { onlyOne: gas.pipelines[Object.keys(gas.pipelines)[0]!] } };
    assert.equal(validateRegistry(bad), false);
  });
});

describe('pipeline registries — GEM source enum', () => {
  test('VALID_SOURCES exported and includes the existing six members plus gem', () => {
    // Same source-of-truth pattern as VALID_OIL_PRODUCT_CLASSES (PR #3383):
    // export the Set so future tests can't drift from the validator.
    assert.ok(VALID_SOURCES.has('operator'));
    assert.ok(VALID_SOURCES.has('regulator'));
    assert.ok(VALID_SOURCES.has('press'));
    assert.ok(VALID_SOURCES.has('satellite'));
    assert.ok(VALID_SOURCES.has('ais-relay'));
    assert.ok(VALID_SOURCES.has('gem'));
  });

  test('validateRegistry accepts GEM-sourced minimum-viable evidence (state=unknown)', () => {
    // GEM rows ship as state=unknown until classifier promotes them.
    // physicalStateSource='gem' is sufficient evidence per the audit.
    const gasSample = gas.pipelines[Object.keys(gas.pipelines)[0]!];
    const good = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`p${i}`, {
          ...gasSample,
          id: `p${i}`,
          evidence: {
            physicalState: 'unknown',
            physicalStateSource: 'gem',
            commercialState: 'unknown',
            operatorStatement: null,
            sanctionRefs: [],
            classifierVersion: 'gem-import-v1',
            classifierConfidence: 0.4,
            lastEvidenceUpdate: '2026-04-25T00:00:00Z',
          },
        }])
      ),
    };
    assert.equal(validateRegistry(good), true);
  });

  test('validateRegistry accepts GEM-sourced offline row (state=offline + only source=gem)', () => {
    // Per plan U1 audit: 'gem' is evidence-bearing for non-flowing badges,
    // parity with press/satellite/ais-relay. An offline row with no operator
    // statement and no sanctionRefs but physicalStateSource='gem' should pass
    // validation (the public-badge derivation downstream will then map it
    // to "disputed" via the external-signal rule).
    const gasSample = gas.pipelines[Object.keys(gas.pipelines)[0]!];
    const good = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`p${i}`, {
          ...gasSample,
          id: `p${i}`,
          evidence: {
            physicalState: 'offline',
            physicalStateSource: 'gem',
            commercialState: 'unknown',
            operatorStatement: null,
            sanctionRefs: [],
            classifierVersion: 'gem-import-v1',
            classifierConfidence: 0.4,
            lastEvidenceUpdate: '2026-04-25T00:00:00Z',
          },
        }])
      ),
    };
    assert.equal(validateRegistry(good), true);
  });

  test('validateRegistry still rejects unknown physicalStateSource values', () => {
    // Adding 'gem' must not loosen the enum — unknown sources still fail.
    const gasSample = gas.pipelines[Object.keys(gas.pipelines)[0]!];
    const bad = {
      pipelines: Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`p${i}`, {
          ...gasSample,
          id: `p${i}`,
          evidence: {
            ...gasSample.evidence,
            physicalStateSource: 'rumor',
          },
        }])
      ),
    };
    assert.equal(validateRegistry(bad), false);
  });
});
