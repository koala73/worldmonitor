#!/usr/bin/env node
/**
 * Restore Company Monitoring repeated-string constraints that
 * protoc-gen-openapiv3 currently emits on the array item with the wrong
 * keyword (maxItems) or omits entirely. The proto and generated request
 * validator remain authoritative; this injector keeps the published service
 * specs and unified bundle faithful to that contract.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './lib/openapi-codegen.mjs';
import { isMainModule } from './lib/main-module.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '..');
const apiDir = resolve(root, 'docs/api');
const CHECK = process.argv.includes('--check');
const LOGICAL_COMPANY_ID = '^cm_company_[0-9A-HJKMNP-TV-Z]{26}$';
const LOGICAL_CLAIM_ID = '^cm_claim_[0-9A-HJKMNP-TV-Z]{26}$';

const monitoredLifecycleItem = {
  type: 'string',
  pattern: '^(?:active|paused|removed|MONITORED_COMPANY_LIFECYCLE_(?:ACTIVE|PAUSED|REMOVED))$',
  description: 'Accepted values are active, paused, and removed.',
};
const coverageItem = {
  type: 'string',
  pattern: '^(?:awaiting_first_scan|adequate|partial|stale|unavailable|needs_confirmation|COMPANY_COVERAGE_STATE_(?:AWAITING_FIRST_SCAN|ADEQUATE|PARTIAL|STALE|UNAVAILABLE|NEEDS_CONFIRMATION))$',
  description: 'Accepted values are awaiting_first_scan, adequate, partial, stale, unavailable, and needs_confirmation.',
};
const impactDirectionItem = {
  type: 'string',
  pattern: '^(?:positive|negative|mixed|MATERIAL_IMPACT_DIRECTION_(?:POSITIVE|NEGATIVE|MIXED))$',
  description: 'Accepted values are positive, negative, and mixed.',
};
const impactLifecycleItem = {
  type: 'string',
  pattern: '^(?:admitted|corrected|retracted|MATERIAL_IMPACT_LIFECYCLE_(?:ADMITTED|CORRECTED|RETRACTED))$',
  description: 'Accepted values are admitted, corrected, and retracted.',
};

export const COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS = [
  ['MonitoredCompanyInput', 'aliases', {
    type: 'string',
    minLength: 1,
    'x-max-utf8-bytes': 256,
  }],
  ['MonitoredCompanyInput', 'domains', {
    type: 'string',
    minLength: 1,
    maxLength: 253,
    pattern: '^(?:www\\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.?$',
  }],
  ['MonitoredCompanyInput', 'identifiers', {
    type: 'string',
    minLength: 1,
    'x-max-utf8-bytes': 512,
  }],
  ['MonitoredCompanyInput', 'xHandles', {
    type: 'string',
    maxLength: 16,
    pattern: '^@?[A-Za-z0-9_]{1,15}$',
  }],
  ['MonitoredCompanyInput', 'locations', {
    type: 'string',
    minLength: 1,
    'x-max-utf8-bytes': 256,
  }],
  ['MonitoredCompanyPatch', 'removeClaimIds', {
    type: 'string',
    pattern: LOGICAL_CLAIM_ID,
  }],
  ['ListMonitoredCompaniesRequest', 'lifecycles', monitoredLifecycleItem],
  ['ListMonitoredCompaniesRequest', 'coverageStates', coverageItem],
  ['ListCompanyEventImpactsRequest', 'companyIds', {
    type: 'string',
    pattern: LOGICAL_COMPANY_ID,
  }],
  ['ListCompanyEventImpactsRequest', 'directions', impactDirectionItem],
  ['ListCompanyEventImpactsRequest', 'lifecycles', impactLifecycleItem],
];

export const COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS = [
  ['/api/company-monitoring/v1/list-monitored-companies', 'lifecycle', monitoredLifecycleItem],
  ['/api/company-monitoring/v1/list-monitored-companies', 'coverage', coverageItem],
  ['/api/company-monitoring/v1/list-company-event-impacts', 'company_id', {
    type: 'string',
    pattern: LOGICAL_COMPANY_ID,
  }],
  ['/api/company-monitoring/v1/list-company-event-impacts', 'direction', impactDirectionItem],
  ['/api/company-monitoring/v1/list-company-event-impacts', 'lifecycle', impactLifecycleItem],
];

const targets = [
  {
    path: resolve(apiDir, 'CompanyMonitoringService.openapi.json'),
    format: 'json',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'CompanyMonitoringService.openapi.yaml'),
    format: 'yaml',
    prefix: '',
  },
  {
    path: resolve(apiDir, 'worldmonitor.openapi.yaml'),
    format: 'yaml',
    prefix: 'worldmonitor_company_monitoring_v1_',
  },
];

function cleanItemSchema(schema) {
  const next = { ...schema };
  for (const key of [
    'maxItems',
    'minItems',
    'maxLength',
    'minLength',
    'pattern',
    'x-max-utf8-bytes',
  ]) delete next[key];
  return next;
}

function injectObject(spec, prefix) {
  for (const [schemaName, propertyName, contract] of COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS) {
    const property = spec.components?.schemas?.[`${prefix}${schemaName}`]?.properties?.[propertyName];
    if (!property?.items) throw new Error(`${prefix}${schemaName}.${propertyName} is missing from OpenAPI`);
    property.items = { ...cleanItemSchema(property.items), ...contract };
  }
  for (const [path, parameterName, contract] of COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS) {
    const parameter = spec.paths?.[path]?.get?.parameters?.find(
      (entry) => entry?.in === 'query' && entry.name === parameterName,
    );
    if (!parameter?.schema?.items) throw new Error(`${path} query ${parameterName} is missing from OpenAPI`);
    parameter.schema.items = { ...cleanItemSchema(parameter.schema.items), ...contract };
  }
}

function indentOf(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function blockEnd(lines, start, indent) {
  let index = start + 1;
  while (index < lines.length) {
    if (lines[index].trim() && indentOf(lines[index]) <= indent) break;
    index++;
  }
  return index;
}

function yamlScalar(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function renderItems(contract) {
  return [
    '                    items:',
    ...Object.entries(contract).map(([key, value]) => `                        ${key}: ${yamlScalar(value)}`),
  ];
}

function patchComponentItem(lines, prefix, schemaName, propertyName, contract) {
  const fullSchemaName = `${prefix}${schemaName}`;
  const schemaIndex = lines.findIndex(
    (line) => indentOf(line) === 8 && line.trim() === `${fullSchemaName}:`,
  );
  if (schemaIndex === -1) throw new Error(`OpenAPI YAML is missing ${fullSchemaName}`);
  const schemaEnd = blockEnd(lines, schemaIndex, 8);
  const propertyIndex = lines.findIndex(
    (line, index) => index > schemaIndex
      && index < schemaEnd
      && indentOf(line) === 16
      && line.trim() === `${propertyName}:`,
  );
  if (propertyIndex === -1) throw new Error(`OpenAPI YAML is missing ${fullSchemaName}.${propertyName}`);
  const propertyEnd = blockEnd(lines, propertyIndex, 16);
  const itemsIndex = lines.findIndex(
    (line, index) => index > propertyIndex
      && index < propertyEnd
      && indentOf(line) === 20
      && line.trim() === 'items:',
  );
  if (itemsIndex === -1) throw new Error(`OpenAPI YAML is missing ${fullSchemaName}.${propertyName}.items`);
  lines.splice(itemsIndex, blockEnd(lines, itemsIndex, 20) - itemsIndex, ...renderItems(contract));
}

function patchQueryItem(lines, path, parameterName, contract) {
  const pathIndex = lines.indexOf(`    ${path}:`);
  if (pathIndex === -1) throw new Error(`OpenAPI YAML is missing ${path}`);
  const pathEnd = blockEnd(lines, pathIndex, 4);
  const parameterIndex = lines.findIndex(
    (line, index) => index > pathIndex
      && index < pathEnd
      && indentOf(line) === 16
      && line.trim() === `- name: ${parameterName}`,
  );
  if (parameterIndex === -1) throw new Error(`OpenAPI YAML is missing ${path} query ${parameterName}`);
  const parameterEnd = blockEnd(lines, parameterIndex, 16);
  const itemsIndex = lines.findIndex(
    (line, index) => index > parameterIndex
      && index < parameterEnd
      && indentOf(line) === 20
      && line.trim() === 'items:',
  );
  if (itemsIndex === -1) throw new Error(`OpenAPI YAML is missing ${path} query ${parameterName}.items`);
  lines.splice(itemsIndex, blockEnd(lines, itemsIndex, 20) - itemsIndex, ...renderItems(contract));
}

function injectYaml(raw, prefix) {
  const lines = raw.split('\n');
  for (const [schemaName, propertyName, contract] of COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS) {
    patchComponentItem(lines, prefix, schemaName, propertyName, contract);
  }
  for (const [path, parameterName, contract] of COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS) {
    patchQueryItem(lines, path, parameterName, contract);
  }
  return lines.join('\n');
}

export function injectCompanyMonitoringOpenApi({ check = false } = {}) {
  const changed = [];
  for (const target of targets) {
    const before = readFileSync(target.path, 'utf8');
    let output;
    if (target.format === 'json') {
      const spec = JSON.parse(before);
      injectObject(spec, target.prefix);
      output = serialize(spec);
    } else {
      output = injectYaml(before, target.prefix);
    }
    if (before === output) continue;
    changed.push(target.path);
    if (!check) writeFileSync(target.path, output);
  }
  return changed;
}

// realpath BOTH sides — `resolve()` does not follow symlinks, so on a symlinked checkout
// (/tmp -> /private/tmp) the naive comparison is false and this script silently exits 0
// having done nothing, which the --check gate reads as "the specs are faithful".
if (isMainModule(import.meta.url, process.argv[1])) {
  const changed = injectCompanyMonitoringOpenApi({ check: CHECK });
  if (CHECK && changed.length > 0) {
    for (const path of changed) console.error(`${path} is missing Company Monitoring OpenAPI constraints`);
    process.exitCode = 1;
  }
}
