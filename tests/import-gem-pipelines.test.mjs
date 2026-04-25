// @ts-check
//
// Tests for scripts/import-gem-pipelines.mjs — the GEM Oil & Gas Infrastructure
// Tracker → registry-shape parser. Test-first per the plan's Execution note: the
// schema-sentinel + status/productClass/capacity-unit mapping is the highest-
// risk failure mode, so coverage for it lands before the implementation does.
//
// Fixture: tests/fixtures/gem-pipelines-sample.json — operator-shape JSON
// (Excel pre-converted externally; the parser is local-file-only, no xlsx
// dep, no runtime URL fetch).

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGemPipelines, REQUIRED_COLUMNS } from '../scripts/import-gem-pipelines.mjs';
import { validateRegistry } from '../scripts/_pipeline-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, 'fixtures/gem-pipelines-sample.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

describe('import-gem-pipelines — schema sentinel', () => {
  test('REQUIRED_COLUMNS is exported and non-empty', () => {
    assert.ok(Array.isArray(REQUIRED_COLUMNS));
    assert.ok(REQUIRED_COLUMNS.length >= 5);
  });

  test('throws on missing required column', () => {
    const broken = {
      ...fixture,
      pipelines: fixture.pipelines.map((p) => {
        const { name: _drop, ...rest } = p;
        return rest;
      }),
    };
    assert.throws(
      () => parseGemPipelines(broken),
      /missing|name|schema/i,
      'parser must throw on column drift, not silently accept',
    );
  });

  test('throws on non-object input', () => {
    assert.throws(() => parseGemPipelines(null), /input/i);
    assert.throws(() => parseGemPipelines([]), /input|pipelines/i);
  });

  test('throws when pipelines field is missing', () => {
    assert.throws(() => parseGemPipelines({ source: 'test' }), /pipelines/i);
  });
});

describe('import-gem-pipelines — fuel split', () => {
  test('splits gas + oil into two arrays', () => {
    const { gas, oil } = parseGemPipelines(fixture);
    assert.equal(gas.length, 3, 'fixture has 3 gas rows');
    assert.equal(oil.length, 3, 'fixture has 3 oil rows');
  });

  test('gas pipelines do NOT carry productClass (gas registry forbids it)', () => {
    const { gas } = parseGemPipelines(fixture);
    for (const p of gas) {
      assert.equal(p.productClass, undefined, `${p.name}: gas should not have productClass`);
    }
  });

  test('every oil pipeline declares a productClass from the enum', () => {
    const { oil } = parseGemPipelines(fixture);
    for (const p of oil) {
      assert.ok(
        ['crude', 'products', 'mixed'].includes(p.productClass),
        `${p.name} has invalid productClass: ${p.productClass}`,
      );
    }
  });
});

describe('import-gem-pipelines — status mapping', () => {
  test("'Operating' maps to physicalState='flowing'", () => {
    const { gas, oil } = parseGemPipelines(fixture);
    const op = [...gas, ...oil].filter((p) => p.name.includes('Operating'));
    assert.ok(op.length > 0);
    for (const p of op) {
      assert.equal(p.evidence.physicalState, 'flowing');
    }
  });

  test("'Construction' maps to physicalState='unknown' (planned/not commissioned)", () => {
    const { gas } = parseGemPipelines(fixture);
    const ctr = gas.find((p) => p.name.includes('Construction'));
    assert.ok(ctr);
    assert.equal(ctr.evidence.physicalState, 'unknown');
  });

  test("'Cancelled' / 'Mothballed' map to physicalState='offline'", () => {
    const { gas, oil } = parseGemPipelines(fixture);
    const cancelled = gas.find((p) => p.name.includes('Cancelled'));
    const mothballed = oil.find((p) => p.name.includes('Mothballed'));
    assert.ok(cancelled);
    assert.ok(mothballed);
    assert.equal(cancelled.evidence.physicalState, 'offline');
    assert.equal(mothballed.evidence.physicalState, 'offline');
  });
});

describe('import-gem-pipelines — productClass mapping', () => {
  test("'Crude Oil' product → productClass='crude'", () => {
    const { oil } = parseGemPipelines(fixture);
    const crude = oil.find((p) => p.name.includes('Crude Oil Trunk'));
    assert.ok(crude);
    assert.equal(crude.productClass, 'crude');
  });

  test("'Refined Products' product → productClass='products'", () => {
    const { oil } = parseGemPipelines(fixture);
    const refined = oil.find((p) => p.name.includes('Refined Products'));
    assert.ok(refined);
    assert.equal(refined.productClass, 'products');
  });
});

describe('import-gem-pipelines — capacity-unit conversion', () => {
  test('gas capacity in bcm/y is preserved unchanged', () => {
    const { gas } = parseGemPipelines(fixture);
    const opGas = gas.find((p) => p.name.includes('Operating'));
    assert.ok(opGas);
    assert.equal(opGas.capacityBcmYr, 24);
  });

  test('oil capacity in bbl/d is converted to Mbd (thousand barrels per day)', () => {
    const { oil } = parseGemPipelines(fixture);
    const crude = oil.find((p) => p.name.includes('Crude Oil Trunk'));
    assert.ok(crude);
    // 400_000 bbl/d ÷ 1000 = 400 Mbd. NOTE: our schema's `capacityMbd` field
    // name uses the abbreviation Mbd but the value SHOULD be in millions of
    // barrels per day per the existing on-main hand-curated rows (e.g. CPC
    // pipeline = 1.4 capacityMbd = 1.4 million bbl/d). So 400_000 bbl/d =
    // 0.4 capacityMbd.
    assert.equal(crude.capacityMbd, 0.4);
  });

  test('oil capacity already in Mbd is preserved unchanged', () => {
    const { oil } = parseGemPipelines(fixture);
    const refined = oil.find((p) => p.name.includes('Refined Products'));
    assert.ok(refined);
    assert.equal(refined.capacityMbd, 0.65);
  });
});

describe('import-gem-pipelines — minimum-viable evidence', () => {
  test('every emitted candidate has physicalStateSource=gem', () => {
    const { gas, oil } = parseGemPipelines(fixture);
    for (const p of [...gas, ...oil]) {
      assert.equal(p.evidence.physicalStateSource, 'gem');
    }
  });

  test('every emitted candidate has classifierVersion=gem-import-v1', () => {
    const { gas, oil } = parseGemPipelines(fixture);
    for (const p of [...gas, ...oil]) {
      assert.equal(p.evidence.classifierVersion, 'gem-import-v1');
    }
  });

  test('every emitted candidate has classifierConfidence ≤ 0.5', () => {
    const { gas, oil } = parseGemPipelines(fixture);
    for (const p of [...gas, ...oil]) {
      assert.ok(p.evidence.classifierConfidence <= 0.5);
      assert.ok(p.evidence.classifierConfidence >= 0);
    }
  });

  test('every emitted candidate has empty sanctionRefs and null operatorStatement', () => {
    const { gas, oil } = parseGemPipelines(fixture);
    for (const p of [...gas, ...oil]) {
      assert.deepEqual(p.evidence.sanctionRefs, []);
      assert.equal(p.evidence.operatorStatement, null);
    }
  });
});

describe('import-gem-pipelines — registry-shape conformance', () => {
  test('emitted gas registry passes validateRegistry', () => {
    // Build a synthetic registry of just the GEM-emitted gas rows; meets the
    // validator's MIN_PIPELINES_PER_REGISTRY=8 floor by repeating the 3 fixture
    // rows so we exercise the schema, not the count.
    const { gas } = parseGemPipelines(fixture);
    const repeated = [];
    for (let i = 0; i < 3; i++) {
      for (const p of gas) repeated.push({ ...p, id: `${p.id}-rep${i}` });
    }
    const reg = {
      pipelines: Object.fromEntries(repeated.map((p) => [p.id, p])),
    };
    assert.equal(validateRegistry(reg), true);
  });

  test('emitted oil registry passes validateRegistry', () => {
    const { oil } = parseGemPipelines(fixture);
    const repeated = [];
    for (let i = 0; i < 3; i++) {
      for (const p of oil) repeated.push({ ...p, id: `${p.id}-rep${i}` });
    }
    const reg = {
      pipelines: Object.fromEntries(repeated.map((p) => [p.id, p])),
    };
    assert.equal(validateRegistry(reg), true);
  });
});

describe('import-gem-pipelines — coordinate validity', () => {
  test('rows with invalid lat/lon are dropped (not silently kept with lat=0)', () => {
    const broken = {
      ...fixture,
      pipelines: [
        ...fixture.pipelines,
        {
          name: 'Test Bad Coords',
          operator: 'X',
          fuel: 'Natural Gas',
          product: '',
          fromCountry: 'XX',
          toCountry: 'YY',
          transitCountries: [],
          capacity: 5,
          capacityUnit: 'bcm/y',
          lengthKm: 100,
          status: 'Operating',
          startYear: 2020,
          startLat: 200, // out of range
          startLon: 0,
          endLat: 0,
          endLon: 0,
        },
      ],
    };
    const { gas } = parseGemPipelines(broken);
    const bad = gas.find((p) => p.name.includes('Bad Coords'));
    assert.equal(bad, undefined, 'row with out-of-range lat must be dropped, not coerced');
  });
});
