import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

function readSpec(file) {
  return JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
}

function successfulSchema(spec, path) {
  const operation = spec.paths?.[path]?.get ?? spec.paths?.[path]?.post;
  assert.ok(operation, `${path}: operation missing`);
  const ref = operation.responses?.['200']?.content?.['application/json']?.schema?.$ref;
  assert.ok(ref?.startsWith('#/components/schemas/'), `${path}: 200 response schema ref missing`);
  const schemaName = ref.split('/').pop();
  const schema = spec.components?.schemas?.[schemaName];
  assert.ok(schema, `${path}: response schema ${schemaName} missing`);
  return { operation, schema, schemaName };
}

function assertTerms(text, label, terms) {
  const normalized = String(text ?? '').toLowerCase();
  for (const term of terms) {
    assert.ok(normalized.includes(term), `${label}: expected to mention ${term}`);
  }
}

function assertAnyTerm(text, label, terms) {
  const normalized = String(text ?? "").toLowerCase();
  assert.ok(
    terms.some((term) => normalized.includes(term)),
    label + ": expected to mention one of " + terms.join(", "),
  );
}

function assertProperties(schema, label, properties) {
  for (const property of properties) {
    assert.ok(schema.properties?.[property], `${label}: missing ${property}`);
  }
}

const SEED_BACKED_CONTRACTS = [
  {
    file: 'ClimateService.openapi.json',
    path: '/api/climate/v1/list-climate-news',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'DisplacementService.openapi.json',
    path: '/api/displacement/v1/get-displacement-summary',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['absent', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'GivingService.openapi.json',
    path: '/api/giving/v1/get-giving-summary',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['absent', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'MaritimeService.openapi.json',
    path: '/api/maritime/v1/get-vessel-snapshot',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['absent', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'NaturalService.openapi.json',
    path: '/api/natural/v1/list-natural-events',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'PredictionService.openapi.json',
    path: '/api/prediction/v1/list-prediction-markets',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'RadiationService.openapi.json',
    path: '/api/radiation/v1/list-radiation-observations',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'ShippingV2Service.openapi.json',
    path: '/api/v2/shipping/route-intelligence',
    fields: ['fetchedAt'],
    operationTerms: ['empty', 'fetched_at', 'unavailable', 'degraded'],
  },
  {
    file: 'SupplyChainService.openapi.json',
    path: '/api/supply-chain/v1/get-chokepoint-status',
    fields: ['fetchedAt', 'upstreamUnavailable'],
    operationTerms: ['empty', 'upstream_unavailable=true', 'unavailable', 'degraded'],
  },
  {
    file: 'ThermalService.openapi.json',
    path: '/api/thermal/v1/list-thermal-escalations',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at', 'data_available=false', 'unavailable', 'degraded'],
  },
  {
    file: 'WildfireService.openapi.json',
    path: '/api/wildfire/v1/list-fire-detections',
    fields: ['fetchedAt', 'dataAvailable'],
    operationTerms: ['empty', 'fetched_at=0', 'data_available=false', 'unavailable', 'degraded'],
  },
];

const UNAVAILABLE_VARIANT_FILES = [
  "EconomicService.openapi.json",
  "MarketService.openapi.json",
];

describe('OpenAPI empty-200 degradation contract', () => {
  it('documents seed-backed empty responses with freshness/degraded fields', () => {
    for (const contract of SEED_BACKED_CONTRACTS) {
      const spec = readSpec(contract.file);
      const { operation, schema, schemaName } = successfulSchema(spec, contract.path);

      assertProperties(schema, `${contract.file} ${schemaName}`, contract.fields);
      assertTerms(operation.description, `${contract.file} ${contract.path} operation`, contract.operationTerms);

      for (const field of contract.fields) {
        const description = schema.properties[field]?.description;
        assertTerms(description, `${contract.file} ${schemaName}.${field}`, ['unavailable']);
        if (field !== 'upstreamUnavailable') {
          assertAnyTerm(description, `${contract.file} ${schemaName}.${field}`, ["degraded", "degradation"]);
        }
      }
    }
  });

  it("keeps explicit unavailable variants visible in economic and market schemas", () => {
    let matched = 0;

    for (const file of UNAVAILABLE_VARIANT_FILES) {
      const spec = readSpec(file);
      for (const [schemaName, schema] of Object.entries(spec.components?.schemas ?? {})) {
        if (!schema?.properties?.unavailable) continue;
        matched += 1;
        assertTerms(
          schema.properties.unavailable.description,
          file + " " + schemaName + ".unavailable",
          ["unavailable"],
        );
      }
    }

    assert.ok(matched >= 10, "expected economic/market unavailable variants, found " + matched);
  });

  it('keeps Giving provenance optional during unavailable degradation and removes false live semantics', () => {
    const spec = readSpec('GivingService.openapi.json');
    const { operation, schema } = successfulSchema(spec, '/api/giving/v1/get-giving-summary');
    const summarySchema = spec.components?.schemas?.GivingSummary;
    const provenanceSchema = spec.components?.schemas?.GivingProvenance;

    assert.ok(summarySchema, 'GivingSummary schema missing');
    assert.ok(provenanceSchema, 'GivingProvenance schema missing');
    assertProperties(summarySchema, 'GivingSummary', [
      'dataMode',
      'trendAvailable',
      'provenance',
      'activityIndexAvailable',
    ]);
    assertProperties(provenanceSchema, 'GivingProvenance', [
      'subject',
      'sourceName',
      'sourceUrl',
      'referencePeriod',
      'sourcePublishedAt',
      'measurementBasis',
      'status',
      'coveredMetricPaths',
      'includedInHighlightedAggregate',
      'reportedValue',
      'reportedUnit',
      'notes',
      'valueQualifier',
      'sourceLocator',
      'accessedAt',
      'denominator',
      'derivation',
    ]);
    assert.ok(!schema.required?.includes('summary'), 'unavailable response must not require a summary');
    assert.ok(!summarySchema.required?.includes('provenance'), 'legacy or unavailable summary must not require provenance');

    const contractText = JSON.stringify({ operation, summarySchema, provenanceSchema }).toLowerCase();
    assert.doesNotMatch(
      contractText,
      /combines live sampling|retrieves a composite global giving activity index|tracks transparent on-chain philanthropy/,
    );
    assertTerms(summarySchema.properties.activityIndex.description, 'GivingSummary.activityIndex', ['compatibility', 'sentinel']);
    assertTerms(summarySchema.properties.trend.description, 'GivingSummary.trend', ['compatibility', 'sentinel']);
    assertTerms(summarySchema.properties.dataMode.description, 'GivingSummary.dataMode', ['absent', 'legacy']);
    assertTerms(provenanceSchema.properties.status.description, 'GivingProvenance.status', ['unknown', 'unverified']);
  });
});
