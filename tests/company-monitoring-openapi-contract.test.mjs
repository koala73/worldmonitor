import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { load as loadYaml } from 'js-yaml';

import {
  COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS,
  COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS,
} from '../scripts/openapi-inject-company-monitoring-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const specs = [
  [
    'service JSON',
    JSON.parse(readFileSync(resolve(root, 'docs/api/CompanyMonitoringService.openapi.json'), 'utf8')),
    '',
  ],
  [
    'service YAML',
    loadYaml(readFileSync(resolve(root, 'docs/api/CompanyMonitoringService.openapi.yaml'), 'utf8')),
    '',
  ],
  [
    'unified YAML',
    loadYaml(readFileSync(resolve(root, 'docs/api/worldmonitor.openapi.yaml'), 'utf8')),
    'worldmonitor_company_monitoring_v1_',
  ],
];

const CURSOR_PATTERN = /^cmc1\.[A-Za-z0-9_-]{16,1536}\.[A-Za-z0-9_-]{43}$/;

// NOTE: the injector's hand-copied constraints are cross-checked against the
// proto-derived GENERATED_MESSAGE_RULES in tests/company-monitoring-contract.test.mts —
// that check needs the generated .ts and this suite is plain .mjs (no TS loader).

describe('Company Monitoring generated OpenAPI contract', () => {
  for (const [label, spec, prefix] of specs) {
    it(`${label} preserves repeated-string item constraints`, () => {
      for (const [schemaName, propertyName, contract] of COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS) {
        const items = spec.components.schemas[`${prefix}${schemaName}`].properties[propertyName].items;
        for (const [key, value] of Object.entries(contract)) {
          assert.deepEqual(items[key], value, `${schemaName}.${propertyName}.items.${key}`);
        }
        assert.equal(items.maxItems, undefined, `${schemaName}.${propertyName}.items must not use maxItems`);
      }
      for (const [path, parameterName, contract] of COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS) {
        const parameter = spec.paths[path].get.parameters.find(
          (entry) => entry.in === 'query' && entry.name === parameterName,
        );
        assert.ok(parameter, `${path} query ${parameterName}`);
        for (const [key, value] of Object.entries(contract)) {
          assert.deepEqual(parameter.schema.items[key], value, `${path} ${parameterName}.items.${key}`);
        }
      }
    });

    it(`${label} publishes only signed opaque cursors`, () => {
      const schema = (name) => spec.components.schemas[`${prefix}${name}`];
      const companyLimit = schema('GetCompanyMonitoringStatusResponse').properties.companyLimit;
      assert.equal(companyLimit.const, 500);
      for (const [schemaName, propertyName] of [
        ['SnapshotBoundary', 'pollCursor'],
        ['ListMonitoredCompaniesResponse', 'nextCursor'],
        ['ListCompanyEventImpactsResponse', 'nextCursor'],
        ['ListCompanyEventChangesResponse', 'nextCursor'],
      ]) {
        assert.match(schema(schemaName).properties[propertyName].pattern, /^\^cmc1/);
      }
      for (const path of [
        '/api/company-monitoring/v1/list-monitored-companies',
        '/api/company-monitoring/v1/list-company-event-impacts',
        '/api/company-monitoring/v1/list-company-event-changes',
      ]) {
        const cursor = spec.paths[path].get.parameters.find((entry) => entry.name === 'cursor');
        assert.match(cursor.example, CURSOR_PATTERN, `${path} cursor example`);
      }
    });
  }

  it('the Company Monitoring OpenAPI injector is idempotent', () => {
    execFileSync('node', ['scripts/openapi-inject-company-monitoring-contract.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
