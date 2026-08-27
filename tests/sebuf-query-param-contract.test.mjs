import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { collectQueryParamContractViolations } from '../scripts/lib/sebuf-query-param-contract.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const OPENAPI_NOOP_PARAMS = [
  ['AviationService.openapi.json', '/api/aviation/v1/list-airport-delays', ['page_size', 'cursor', 'region', 'min_severity']],
  ['ClimateService.openapi.json', '/api/climate/v1/list-climate-anomalies', ['page_size', 'cursor', 'min_severity']],
  ['ConflictService.openapi.json', '/api/conflict/v1/list-acled-events', ['page_size', 'cursor']],
  ['ConflictService.openapi.json', '/api/conflict/v1/list-ucdp-events', ['start', 'end', 'page_size', 'cursor']],
  ['CyberService.openapi.json', '/api/cyber/v1/list-cyber-threats', ['start', 'end']],
  ['EconomicService.openapi.json', '/api/economic/v1/get-energy-capacity', ['years']],
  ['EconomicService.openapi.json', '/api/economic/v1/list-world-bank-indicators', ['page_size', 'cursor']],
  ['InfrastructureService.openapi.json', '/api/infrastructure/v1/list-internet-outages', ['page_size', 'cursor']],
  ['IntelligenceService.openapi.json', '/api/intelligence/v1/search-gdelt-documents', ['timespan', 'tone_filter', 'sort']],
  ['MaritimeService.openapi.json', '/api/maritime/v1/list-navigational-warnings', ['page_size', 'cursor']],
  ['MarketService.openapi.json', '/api/market/v1/get-sector-summary', ['period']],
  ['MilitaryService.openapi.json', '/api/military/v1/get-theater-posture', ['theater']],
  ['MilitaryService.openapi.json', '/api/military/v1/list-military-flights', ['operator', 'aircraft_type']],
  ['NaturalService.openapi.json', '/api/natural/v1/list-natural-events', ['days']],
  ['PredictionService.openapi.json', '/api/prediction/v1/list-prediction-markets', ['cursor']],
  ['ResearchService.openapi.json', '/api/research/v1/list-arxiv-papers', ['cursor', 'query']],
  ['SeismologyService.openapi.json', '/api/seismology/v1/list-earthquakes', ['start', 'end', 'cursor', 'min_magnitude']],
  ['TradeService.openapi.json', '/api/trade/v1/get-trade-barriers', ['countries', 'measure_type']],
  ['TradeService.openapi.json', '/api/trade/v1/get-trade-restrictions', ['countries']],
  ['UnrestService.openapi.json', '/api/unrest/v1/list-unrest-events', ['page_size', 'cursor', 'min_severity', 'ne_lat', 'ne_lon', 'sw_lat', 'sw_lon']],
  ['WildfireService.openapi.json', '/api/wildfire/v1/list-fire-detections', ['start', 'end', 'page_size', 'cursor', 'ne_lat', 'ne_lon', 'sw_lat', 'sw_lon']],
];

function fixture() {
  const root = createTempDir('wm-sebuf-query-');
  mkdirSync(join(root, 'proto/worldmonitor/demo/v1'), { recursive: true });
  mkdirSync(join(root, 'server/worldmonitor/demo/v1'), { recursive: true });
  return root;
}

function writeProto(root, fieldSource) {
  writeFileSync(join(root, 'proto/worldmonitor/demo/v1/list_things.proto'), [
    'syntax = "proto3";',
    '',
    'package worldmonitor.demo.v1;',
    '',
    'import "sebuf/http/annotations.proto";',
    '',
    'message ListThingsRequest {',
    fieldSource,
    '}',
  ].join('\n'));
}

function writeHandler(root, body) {
  writeFileSync(join(root, 'server/worldmonitor/demo/v1/list-things.ts'), body);
}

describe('sebuf query-param implementation contract', () => {
  it('generated OpenAPI operation params disclose every documented no-op', () => {
    for (const [file, path, names] of OPENAPI_NOOP_PARAMS) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const params = spec.paths?.[path]?.get?.parameters;
      assert.ok(Array.isArray(params), file + ': missing GET parameters for ' + path);
      for (const name of names) {
        const param = params.find((candidate) => candidate.name === name);
        assert.ok(param, file + ': missing query param ' + name + ' on ' + path);
        assert.match(
          String(param.description ?? ''),
          /Accepted but currently ignored; no-op/,
          file + ': ' + path + ' ' + name + ' must disclose accepted-but-ignored/no-op behavior',
        );
      }
    }
  });

  it('documents the military flights cursor as implemented rather than a no-op', () => {
    const spec = JSON.parse(readFileSync(resolve(apiDir, 'MilitaryService.openapi.json'), 'utf8'));
    const params = spec.paths?.['/api/military/v1/list-military-flights']?.get?.parameters;
    assert.ok(Array.isArray(params), 'MilitaryService.openapi.json: missing list-military-flights parameters');
    const cursor = params.find((candidate) => candidate.name === 'cursor');
    assert.ok(cursor, 'MilitaryService.openapi.json: missing cursor query parameter');
    assert.doesNotMatch(
      String(cursor.description ?? ''),
      /Accepted but currently ignored; no-op/,
      'implemented military pagination must not be generated as accepted-but-ignored',
    );

    const contractSource = readFileSync(resolve(root, 'scripts/lib/sebuf-query-param-contract.mjs'), 'utf8');
    assert.doesNotMatch(
      contractSource,
      /worldmonitor\/military\/v1\/list_military_flights\.proto:cursor/,
      'implemented military cursor must be removed from the forced no-op registry',
    );
  });

  it('documents calendar date bounds as implemented rather than no-ops', () => {
    const operations = [
      ['EconomicService.openapi.json', '/api/economic/v1/get-economic-calendar'],
      ['MarketService.openapi.json', '/api/market/v1/list-earnings-calendar'],
    ];

    for (const [file, path] of operations) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const params = spec.paths?.[path]?.get?.parameters;
      assert.ok(Array.isArray(params), file + ': missing GET parameters for ' + path);
      for (const name of ['fromDate', 'toDate']) {
        const param = params.find((candidate) => candidate.name === name);
        assert.ok(param, file + ': missing query param ' + name + ' on ' + path);
        assert.doesNotMatch(
          String(param.description ?? ''),
          /Accepted but currently ignored; no-op/,
          file + ': implemented ' + name + ' must not be documented as a no-op',
        );
      }
    }

    const contractSource = readFileSync(resolve(root, 'scripts/lib/sebuf-query-param-contract.mjs'), 'utf8');
    assert.doesNotMatch(
      contractSource,
      /(?:get_economic_calendar|list_earnings_calendar)\.proto:(?:fromDate|toDate)/,
      'implemented calendar bounds must be removed from the forced no-op registry',
    );
  });

  it('flags unannotated query params that handlers do not reference', () => {
    const root = fixture();
    writeProto(root, [
      '  // Optional search query.',
      '  string query = 1 [(sebuf.http.query) = { name: "query" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /declared but not referenced/);
  });

  it('accepts active query params referenced through generated camelCase request properties', () => {
    const root = fixture();
    writeProto(root, [
      '  // Maximum items per page.',
      '  int32 page_size = 1 [(sebuf.http.query) = { name: "page_size" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, req) { return { limit: req.pageSize }; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.deepEqual(violations, []);
  });

  it('does not accept unrelated objects with matching property names as query param usage', () => {
    const root = fixture();
    writeProto(root, [
      '  // Maximum items per page.',
      '  int32 page_size = 1 [(sebuf.http.query) = { name: "page_size" }];',
    ].join('\n'));
    writeHandler(root, [
      'export async function listThings(_ctx, _req) {',
      '  const cacheMeta = { pageSize: 25 };',
      '  return { limit: cacheMeta.pageSize };',
      '}',
      '',
    ].join('\n'));

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /declared but not referenced/);
  });

  it('allows documented no-op query params marked with the proto field option', () => {
    const root = fixture();
    writeProto(root, [
      '  // Accepted but currently ignored; no-op until the seed-cache handler supports this filter.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }, (sebuf.http.unimplemented) = true];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations, stats } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.deepEqual(violations, []);
    assert.equal(stats.unimplementedFields, 1);
  });

  it('flags forced no-op registry entries missing the proto field option', () => {
    const root = fixture();
    writeProto(root, [
      '  // Accepted but currently ignored; no-op until the seed-cache handler supports this filter.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, req) { return { cursor: req.cursor }; }\n');

    const { violations } = collectQueryParamContractViolations(root, {
      scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']),
      forcedNoopQueryParams: new Set(['worldmonitor/demo/v1/list_things.proto:cursor']),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /no-op registry but is not marked unimplemented/);
  });

  it('requires no-op annotations to be visible in generated OpenAPI comments', () => {
    const root = fixture();
    writeProto(root, [
      '  // Cursor for next page.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }, (sebuf.http.unimplemented) = true];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /does not disclose/);
  });
});
