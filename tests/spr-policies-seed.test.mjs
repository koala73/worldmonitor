import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPayload,
  validateFn,
  CANONICAL_KEY,
  SPR_POLICIES_TTL_SECONDS,
} from '../scripts/seed-spr-policies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('SPR policies registry shape', () => {
  const data = buildPayload();

  it('has referenceYear and metaSource', () => {
    assert.equal(typeof data.referenceYear, 'number');
    assert.ok(data.referenceYear >= 2025);
    assert.equal(typeof data.metaSource, 'string');
    assert.ok(data.metaSource.length > 0);
  });

  it('has updatedAt timestamp', () => {
    assert.equal(typeof data.updatedAt, 'string');
    assert.ok(new Date(data.updatedAt).getTime() > 0);
  });

  it('has policies object with at least 30 entries', () => {
    assert.equal(typeof data.policies, 'object');
    assert.ok(Object.keys(data.policies).length >= 30);
  });
});

describe('SPR policies ISO2 key validation', () => {
  const data = buildPayload();

  it('every key is valid 2-character uppercase ISO2', () => {
    const iso2Re = /^[A-Z]{2}$/;
    for (const key of Object.keys(data.policies)) {
      assert.match(key, iso2Re, `Invalid ISO2 key: ${key}`);
    }
  });
});

describe('SPR policies regime enum validation', () => {
  const data = buildPayload();
  const VALID_REGIMES = new Set([
    'mandatory_stockholding',
    'government_spr',
    'spare_capacity',
    'commercial_only',
    'none',
  ]);

  it('every entry has a valid regime', () => {
    for (const [key, entry] of Object.entries(data.policies)) {
      assert.ok(VALID_REGIMES.has(entry.regime), `Invalid regime '${entry.regime}' for ${key}`);
    }
  });

  it('every entry has non-empty source and asOf', () => {
    for (const [key, entry] of Object.entries(data.policies)) {
      assert.equal(typeof entry.source, 'string', `${key} missing source`);
      assert.ok(entry.source.length > 0, `${key} has empty source`);
      assert.equal(typeof entry.asOf, 'string', `${key} missing asOf`);
      assert.ok(entry.asOf.length > 0, `${key} has empty asOf`);
    }
  });
});

describe('SPR policies required entries', () => {
  const data = buildPayload();
  const REQUIRED = ['CN', 'IN', 'JP', 'SA', 'US'];

  for (const code of REQUIRED) {
    it(`has entry for ${code}`, () => {
      assert.ok(code in data.policies, `Missing required entry: ${code}`);
    });
  }
});

describe('SPR policies no estimatedFillPct', () => {
  const data = buildPayload();

  it('no entry has estimatedFillPct field', () => {
    for (const [key, entry] of Object.entries(data.policies)) {
      assert.ok(!('estimatedFillPct' in entry), `${key} has forbidden estimatedFillPct field`);
    }
  });
});

describe('SPR policies capacity validation', () => {
  const data = buildPayload();

  it('capacityMb is finite and >= 0 when present', () => {
    for (const [key, entry] of Object.entries(data.policies)) {
      if ('capacityMb' in entry) {
        assert.equal(typeof entry.capacityMb, 'number', `${key} capacityMb not a number`);
        assert.ok(Number.isFinite(entry.capacityMb), `${key} capacityMb is not finite`);
        assert.ok(entry.capacityMb >= 0, `${key} capacityMb is negative`);
      }
    }
  });
});

describe('SPR policies validateFn', () => {
  it('returns true for valid data', () => {
    const data = buildPayload();
    assert.ok(validateFn(data));
  });

  it('returns false for empty policies', () => {
    assert.ok(!validateFn({ policies: {} }));
  });

  it('returns false for null', () => {
    assert.ok(!validateFn(null));
  });

  it('returns false when required country is missing', () => {
    const data = buildPayload();
    delete data.policies.US;
    assert.ok(!validateFn(data));
  });

  it('returns false when entry has invalid regime', () => {
    const data = buildPayload();
    data.policies.US.regime = 'invalid_regime';
    assert.ok(!validateFn(data));
  });

  it('returns false when entry has estimatedFillPct', () => {
    const data = buildPayload();
    data.policies.US.estimatedFillPct = 50;
    assert.ok(!validateFn(data));
  });
});

describe('SPR policies exported constants', () => {
  it('CANONICAL_KEY matches expected value', () => {
    assert.equal(CANONICAL_KEY, 'energy:spr-policies:v1');
  });

  it('TTL is ~400 days', () => {
    assert.equal(SPR_POLICIES_TTL_SECONDS, 34_560_000);
    const days = SPR_POLICIES_TTL_SECONDS / 86400;
    assert.ok(days >= 399 && days <= 401, `TTL is ${days} days, expected ~400`);
  });
});

describe('SPR policies ieaMember field', () => {
  const data = buildPayload();

  it('every entry has ieaMember boolean', () => {
    for (const [key, entry] of Object.entries(data.policies)) {
      assert.equal(typeof entry.ieaMember, 'boolean', `${key} missing ieaMember`);
    }
  });
});

describe('SPR policies JSON file integrity', () => {
  it('JSON file parses without error', () => {
    const raw = readFileSync(resolve(__dirname, '..', 'scripts', 'data', 'spr-policies.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.policies);
  });
});
