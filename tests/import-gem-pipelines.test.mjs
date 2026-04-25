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
    // Schema convention: the field is named `capacityMbd` (the customary
    // industry abbreviation) but the VALUE is in millions of barrels per
    // day, NOT thousands — matching the existing on-main hand-curated rows
    // (e.g. CPC pipeline ships as `capacityMbd: 1.4` for 1.4M bbl/d).
    // So 400_000 bbl/d ÷ 1_000_000 = 0.4 capacityMbd.
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
  // Compute the repeat count from the floor + the fixture row count so this
  // test stays correct if the fixture is trimmed or the floor is raised. The
  // hardcoded `for (let i = 0; i < 70; i++)` was fragile — Greptile P2 on PR
  // #3406. +5 over the floor leaves a safety margin without inflating the test.
  const REGISTRY_FLOOR = 200;

  test('emitted gas registry passes validateRegistry', () => {
    const { gas } = parseGemPipelines(fixture);
    const reps = Math.ceil(REGISTRY_FLOOR / gas.length) + 5;
    const repeated = [];
    for (let i = 0; i < reps; i++) {
      for (const p of gas) repeated.push({ ...p, id: `${p.id}-rep${i}` });
    }
    const reg = {
      pipelines: Object.fromEntries(repeated.map((p) => [p.id, p])),
    };
    assert.equal(validateRegistry(reg), true);
  });

  test('emitted oil registry passes validateRegistry', () => {
    const { oil } = parseGemPipelines(fixture);
    const reps = Math.ceil(REGISTRY_FLOOR / oil.length) + 5;
    const repeated = [];
    for (let i = 0; i < reps; i++) {
      for (const p of oil) repeated.push({ ...p, id: `${p.id}-rep${i}` });
    }
    const reg = {
      pipelines: Object.fromEntries(repeated.map((p) => [p.id, p])),
    };
    assert.equal(validateRegistry(reg), true);
  });
});

describe('import-gem-pipelines — determinism (review-fix #3)', () => {
  test('two parser runs on identical input produce identical output', () => {
    // Regression: pre-fix, lastEvidenceUpdate used new Date() per run, so
    // re-running parseGemPipelines on the same JSON on different days
    // produced different output → noisy diffs every quarterly re-import.
    // Now derived from envelope.downloadedAt, so output is byte-identical.
    const r1 = JSON.stringify(parseGemPipelines(fixture));
    const r2 = JSON.stringify(parseGemPipelines(fixture));
    assert.equal(r1, r2);
  });

  test('lastEvidenceUpdate derives from envelope.downloadedAt', () => {
    // Fixture has downloadedAt: 2026-04-25 → emitted as 2026-04-25T00:00:00Z.
    const { gas } = parseGemPipelines(fixture);
    for (const p of gas) {
      assert.equal(p.evidence.lastEvidenceUpdate, '2026-04-25T00:00:00Z');
    }
  });

  test('missing downloadedAt → epoch sentinel (loud failure, not silent today)', () => {
    // If the operator forgets the date field, the emitted timestamp should
    // be obviously wrong rather than today's wall clock — surfaces the
    // gap in code review of the data file.
    const noDate = { ...fixture };
    delete noDate.downloadedAt;
    delete noDate.sourceVersion;
    const { gas } = parseGemPipelines(noDate);
    for (const p of gas) {
      assert.equal(p.evidence.lastEvidenceUpdate, '1970-01-01T00:00:00Z');
    }
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
