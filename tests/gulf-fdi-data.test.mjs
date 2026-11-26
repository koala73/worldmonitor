import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadGulfInvestments() {
  const sourcePath = resolve(__dirname, '../src/config/gulf-fdi.ts');
  const source = readFileSync(sourcePath, 'utf-8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  });

  const module = { exports: {} };
  const evaluator = new Function('exports', 'module', transpiled.outputText);
  evaluator(module.exports, module);
  return module.exports.GULF_INVESTMENTS;
}

const GULF_INVESTMENTS = loadGulfInvestments();

const VALID_COUNTRIES = new Set(['SA', 'UAE']);
const VALID_SECTORS = new Set([
  'ports',
  'pipelines',
  'energy',
  'datacenters',
  'airports',
  'railways',
  'telecoms',
  'water',
  'logistics',
  'mining',
  'real-estate',
  'manufacturing',
]);
const VALID_STATUSES = new Set([
  'operational',
  'under-construction',
  'announced',
  'rumoured',
  'cancelled',
  'divested',
]);

describe('gulf-fdi dataset integrity', () => {
  it('contains records', () => {
    assert.ok(Array.isArray(GULF_INVESTMENTS));
    assert.ok(GULF_INVESTMENTS.length > 0);
  });

  it('has unique IDs', () => {
    const ids = GULF_INVESTMENTS.map((investment) => investment.id);
    const uniqueCount = new Set(ids).size;
    assert.equal(uniqueCount, ids.length, 'Expected all gulf-fdi IDs to be unique');
  });

  it('uses valid enum-like values', () => {
    for (const investment of GULF_INVESTMENTS) {
      assert.ok(
        VALID_COUNTRIES.has(investment.investingCountry),
        `Invalid investingCountry: ${investment.investingCountry} (${investment.id})`
      );
      assert.ok(
        VALID_SECTORS.has(investment.sector),
        `Invalid sector: ${investment.sector} (${investment.id})`
      );
      assert.ok(
        VALID_STATUSES.has(investment.status),
        `Invalid status: ${investment.status} (${investment.id})`
      );
    }
  });

  it('keeps latitude/longitude in valid ranges', () => {
    for (const investment of GULF_INVESTMENTS) {
      assert.ok(
        Number.isFinite(investment.lat) && investment.lat >= -90 && investment.lat <= 90,
        `Invalid lat for ${investment.id}: ${investment.lat}`
      );
      assert.ok(
        Number.isFinite(investment.lon) && investment.lon >= -180 && investment.lon <= 180,
        `Invalid lon for ${investment.id}: ${investment.lon}`
      );
    }
  });

  it('keeps optional numeric fields in sane bounds', () => {
    for (const investment of GULF_INVESTMENTS) {
      if (investment.investmentUSD != null) {
        assert.ok(
          Number.isFinite(investment.investmentUSD) && investment.investmentUSD > 0,
          `Invalid investmentUSD for ${investment.id}: ${investment.investmentUSD}`
        );
      }
      if (investment.stakePercent != null) {
        assert.ok(
          Number.isFinite(investment.stakePercent)
            && investment.stakePercent >= 0
            && investment.stakePercent <= 100,
          `Invalid stakePercent for ${investment.id}: ${investment.stakePercent}`
        );
      }
    }
  });

  it('validates year and URL fields when present', () => {
    for (const investment of GULF_INVESTMENTS) {
      if (investment.yearAnnounced != null) {
        assert.ok(
          Number.isInteger(investment.yearAnnounced)
            && investment.yearAnnounced >= 1990
            && investment.yearAnnounced <= 2100,
          `Invalid yearAnnounced for ${investment.id}: ${investment.yearAnnounced}`
        );
      }
      if (investment.yearOperational != null) {
        assert.ok(
          Number.isInteger(investment.yearOperational)
            && investment.yearOperational >= 1990
            && investment.yearOperational <= 2100,
          `Invalid yearOperational for ${investment.id}: ${investment.yearOperational}`
        );
      }
      if (investment.yearAnnounced != null && investment.yearOperational != null) {
        assert.ok(
          investment.yearOperational >= investment.yearAnnounced,
          `yearOperational before yearAnnounced for ${investment.id}`
        );
      }
      if (investment.sourceUrl) {
        assert.match(
          investment.sourceUrl,
          /^https?:\/\//,
          `sourceUrl must be absolute for ${investment.id}`
        );
      }
    }
  });
});

describe('gulf-fdi curated corrections (#11272)', () => {
  const byId = (id) => GULF_INVESTMENTS.find((investment) => investment.id === id);
  const byAsset = (pattern) => GULF_INVESTMENTS.filter((investment) => pattern.test(investment.assetName));

  it('credits the Telecom Italia NetCo stake to ADIA as a closed deal', () => {
    const [netco, ...others] = byAsset(/NetCo/);
    assert.equal(others.length, 0);
    assert.equal(netco.investingEntity, 'ADIA');
    assert.equal(netco.investingCountry, 'UAE');
    assert.equal(netco.status, 'operational');
    assert.equal(netco.yearOperational, 2024);
    assert.equal(netco.investmentUSD, undefined, 'ADIA did not disclose its NetCo amount');
    assert.equal(netco.stakePercent, undefined, 'ADIA did not disclose its NetCo stake');
  });

  it('keeps the Rongsheng and HAPCO Panjin stakes as separate transactions', () => {
    const rongsheng = byId('aramco-rongsheng-china');
    assert.equal(rongsheng.stakePercent, 10);
    assert.equal(rongsheng.investmentUSD, 3400);
    assert.equal(rongsheng.status, 'operational');
    assert.doesNotMatch(rongsheng.assetName, /Panjin/);

    const hapco = byId('aramco-hapco-panjin-china');
    assert.equal(hapco.stakePercent, 30);
    assert.equal(hapco.investmentUSD, undefined);
    assert.equal(hapco.status, 'under-construction');
    assert.doesNotMatch(hapco.assetName, /Rongsheng/);
  });

  it('dates the Covestro takeover to its 2024 agreement and 2025 completion', () => {
    const covestro = byId('adnoc-covestro-germany');
    assert.equal(covestro.sector, 'manufacturing');
    assert.equal(covestro.yearAnnounced, 2024);
    assert.equal(covestro.yearOperational, 2025);
  });

  it('does not give THE LINE the whole NEOM budget or a railway label', () => {
    const line = byId('neom-the-line-sa');
    assert.equal(line.sector, 'real-estate');
    assert.equal(line.investmentUSD, undefined);
    assert.doesNotMatch(line.assetType, /Rail/i);
  });

  it('cites a source for every corrected record', () => {
    for (const id of ['adia-telecom-italia', 'aramco-rongsheng-china', 'aramco-hapco-panjin-china', 'adnoc-covestro-germany', 'neom-the-line-sa']) {
      assert.match(byId(id)?.sourceUrl ?? '', /^https:\/\//, `missing sourceUrl for ${id}`);
    }
  });
});
