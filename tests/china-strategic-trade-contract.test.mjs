import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  checkCoverage,
  INTER_REQUEST_DELAY_MS,
  KEY_PREFIX,
  TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS,
  TRADE_FLOW_COVERAGE_CODES,
  TRADE_FLOW_LOCK_TTL_MS,
  TRADE_FLOW_MATRIX_SIZE,
  TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET,
} from '../scripts/seed-trade-flows.mjs';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const requiredStrategicProducts = [
  'semiconductors',
  'batteries',
  'electric_vehicles',
  'rare_earth_inputs',
  'solar_cells',
  'solar_products',
  'crude_oil',
  'lng',
  'coal',
  'iron_ore',
  'copper',
];

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('shared China strategic-product metadata', () => {
  it('records the active UN Comtrade HS 2022 revision and required products', () => {
    const metadata = JSON.parse(read('../scripts/shared/comtrade-strategic-products.json'));

    assert.equal(metadata.schemaVersion, 1);
    assert.deepEqual(
      metadata.classification,
      {
        code: 'H6',
        name: 'HS2022',
        revisionYear: 2022,
        sourceUrl: 'https://comtradeapi.un.org/files/v1/app/reference/H6.json',
      },
    );

    const byId = new Map(metadata.products.map((product) => [product.id, product]));
    for (const id of requiredStrategicProducts) {
      assert.ok(byId.has(id), `missing strategic product metadata for ${id}`);
      assert.match(byId.get(id).tradeFlowCode, /^\d{4,6}$/, `${id} needs a 4-6 digit trade-flow code`);
      if (byId.get(id).bilateralHs4Code) {
        assert.match(byId.get(id).bilateralHs4Code, /^\d{4}$/, `${id} has an invalid HS4 bilateral code`);
      }
    }

    const tradeFlowCodes = new Set(metadata.products.map((product) => product.tradeFlowCode).filter(Boolean));
    for (const code of ['2711', '271111', '854142', '854143']) {
      assert.ok(tradeFlowCodes.has(code), `missing compatibility or HS2022 strategic code ${code}`);
    }

    const tradeFlowProducts = metadata.products.filter((product) => product.tradeFlowCode);
    assert.ok(
      tradeFlowProducts.every((product) => [1, 2].includes(product.tradeFlowCoverageStage)),
      'every trade-flow product must declare its rollout coverage stage',
    );
    assert.deepEqual(
      new Set(TRADE_FLOW_COVERAGE_CODES),
      new Set(['2709', '2711', '7108', '8542', '9301']),
      'stage 1 must preserve the proven five-product coverage baseline',
    );
  });

  it('budgets two-period pacing and the matrix-wide 429 waits below the fetch deadline', () => {
    const twoPassPacingFloorMs = (TRADE_FLOW_MATRIX_SIZE - 1) * INTER_REQUEST_DELAY_MS * 2
      + INTER_REQUEST_DELAY_MS;
    const boundedRateLimitWaitMs = TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET * 60_000;

    assert.ok(
      TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS > twoPassPacingFloorMs + boundedRateLimitWaitMs,
      `fetch timeout must exceed pacing plus bounded 429 waits (${twoPassPacingFloorMs + boundedRateLimitWaitMs}ms)`,
    );
    assert.ok(
      TRADE_FLOW_LOCK_TTL_MS > TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS,
      'lock TTL must outlive the fetch-phase deadline',
    );
  });

  it('preserves the existing major China import/export dependency products', () => {
    const metadata = JSON.parse(read('../scripts/shared/comtrade-strategic-products.json'));
    const bilateralCodes = new Set(metadata.products.map((product) => product.bilateralHs4Code).filter(Boolean));

    for (const code of ['8517', '8703', '3004', '8471', '8411', '7601', '7202', '3901', '2902', '1001', '1201', '6204', '0203', '8704', '8708']) {
      assert.ok(bilateralCodes.has(code), `existing bilateral dependency code ${code} must remain available`);
    }
    assert.equal(bilateralCodes.size, 20, 'monthly bilateral seeding must remain within the existing two 10-code requests per country');
  });

  it('is consumed by both seeders and the API default-key reader without inline commodity mirrors', () => {
    const tradeSeeder = read('../scripts/seed-trade-flows.mjs');
    const bilateralSeeder = read('../scripts/seed-comtrade-bilateral-hs4.mjs');
    const handler = read('../server/worldmonitor/trade/v1/list-comtrade-flows.ts');

    for (const [label, source] of [
      ['trade seeder', tradeSeeder],
      ['bilateral seeder', bilateralSeeder],
      ['trade API handler', handler],
    ]) {
      assert.match(source, /comtrade-strategic-products\.json/, `${label} must consume the shared metadata`);
    }

    assert.doesNotMatch(tradeSeeder, /const\s+COMMODITIES\s*=\s*\[/, 'trade seeder must not carry an inline commodity list');
    assert.doesNotMatch(bilateralSeeder, /const\s+HS4_CODES\s*=\s*\[/, 'bilateral seeder must not carry an inline HS4 list');
    assert.doesNotMatch(handler, /const\s+CMD_CODES\s*=\s*\[/, 'trade API handler must not carry an inline command-code list');
  });
});

describe('China reporter coverage gate', () => {
  it('requires reporter 156 independently of aggregate and generic required-reporter coverage', () => {
    const reporters = [
      { code: '842', name: 'USA' },
      { code: '156', name: 'China', required: false },
      { code: '699', name: 'India' },
      { code: '490', name: 'Taiwan' },
    ];
    const commodities = [
      { code: '2709', desc: 'Crude' },
      { code: '8542', desc: 'Semiconductors' },
      { code: '2603', desc: 'Copper' },
    ];
    const perKeyFlows = {};
    for (const reporter of reporters) {
      for (const commodity of commodities) {
        perKeyFlows[`${KEY_PREFIX}:${reporter.code}:${commodity.code}`] = {
          flows: reporter.code === '156' ? [] : [{ year: 2024 }],
          fetchedAt: '2026-07-13T00:00:00.000Z',
        };
      }
    }

    const result = checkCoverage(perKeyFlows, reporters, commodities);
    assert.equal(result.ok, false, 'China must block publish even when it is excluded from generic reporter floors');
    assert.match(result.reason, /China.*156/i);
  });

  it('rejects reporter sets that omit reporter 156 entirely', () => {
    const reporters = [
      { code: '842', name: 'USA' },
      { code: '699', name: 'India' },
      { code: '490', name: 'Taiwan' },
    ];
    const commodities = [{ code: '2709', desc: 'Crude' }];
    const perKeyFlows = Object.fromEntries(reporters.map((reporter) => [
      `${KEY_PREFIX}:${reporter.code}:2709`,
      { flows: [{ year: 2024 }], fetchedAt: '2026-07-13T00:00:00.000Z' },
    ]));

    const result = checkCoverage(perKeyFlows, reporters, commodities);
    assert.equal(result.ok, false);
    assert.match(result.reason, /China.*156.*missing/i);
  });
});

describe('existing access and China freight paths', () => {
  it('keeps detailed bilateral data behind the current premium gate', () => {
    const handler = read('../server/worldmonitor/supply-chain/v1/get-country-products.ts');
    assert.match(handler, /isCallerPremium\(ctx\.request\)/);
    assert.match(handler, /if \(!isPro\) return empty/);
  });

  it('keeps CCFI available through the existing supply-chain seeder', () => {
    const seeder = read('../scripts/seed-supply-chain-trade.mjs');
    assert.match(seeder, /fetchCCFI\(\)/);
    assert.match(seeder, /CCFI_T/);
  });
});

describe('agent access to expanded China trade coverage', () => {
  it('filters MCP Comtrade flows by reporter before applying the default cap', () => {
    const tool = CACHE_TOOLS.find((candidate) => candidate.name === 'get_supply_chain_data');
    assert.equal(typeof tool?._postFilter, 'function');

    const usa = Array.from({ length: 24 }, (_, index) => ({
      reporterCode: '842', reporterName: 'USA', cmdCode: String(1000 + index), cmdDesc: `USA ${index}`,
    }));
    const china = Array.from({ length: 24 }, (_, index) => ({
      reporterCode: '156', reporterName: 'China', cmdCode: String(2000 + index), cmdDesc: `China ${index}`,
    }));
    const data = { flows: { flows: [...usa, ...china] } };

    tool._postFilter(data, { reporter: '156' });

    assert.equal(data.flows.flows.length, 24, 'reporter filtering must happen before the default 30-row cap');
    assert.ok(data.flows.flows.every((flow) => flow.reporterCode === '156'));
  });
});
