import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iso3ToIso2 = JSON.parse(readFileSync(join(__dirname, '..', 'scripts', 'shared', 'iso3-to-iso2.json'), 'utf8'));

describe('seed-recovery-external-debt ISO3→ISO2', () => {
  it('iso3-to-iso2.json maps common WB API ISO3 codes to ISO2', () => {
    assert.equal(iso3ToIso2['USA'], 'US');
    assert.equal(iso3ToIso2['DEU'], 'DE');
    assert.equal(iso3ToIso2['BRA'], 'BR');
    assert.equal(iso3ToIso2['IND'], 'IN');
    assert.equal(iso3ToIso2['ZAF'], 'ZA');
  });

  it('normalizes ISO3 countryiso3code from WB response to ISO2', () => {
    const rawCode = 'DEU';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    assert.equal(iso2, 'DE');
  });

  it('passes through already-ISO2 codes', () => {
    const rawCode = 'DE';
    const iso2 = rawCode.length === 3 ? (iso3ToIso2[rawCode] ?? null) : (rawCode.length === 2 ? rawCode : null);
    assert.equal(iso2, 'DE');
  });

  it('rejects codes that are neither ISO2 nor ISO3', () => {
    for (const bad of ['', 'X', 'ABCD']) {
      const iso2 = bad.length === 3 ? (iso3ToIso2[bad] ?? null) : (bad.length === 2 ? bad : null);
      assert.equal(iso2, null, `"${bad}" should be rejected`);
    }
  });

  it('rejects WB aggregate codes (e.g. WLD, EAS) that have no ISO2 mapping', () => {
    const aggregates = ['WLD', 'EAS', 'ECS', 'LCN', 'MEA', 'SAS', 'SSF'];
    for (const agg of aggregates) {
      const iso2 = agg.length === 3 ? (iso3ToIso2[agg] ?? null) : null;
      assert.equal(iso2, null, `WB aggregate "${agg}" should not map to ISO2`);
    }
  });
});
