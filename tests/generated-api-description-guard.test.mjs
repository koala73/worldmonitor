import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const HIGH_RISK_SCHEMA_NAME =
  /(?:Cii|CountryRisk|CountryIntelBrief|RegionalBrief|StrategicRisk|ComputeEnergyShockScenario|Scenario|FearGreed|FeedDigest|NewsItem|Resilience|Chokepoint|FlowEstimate|StrategicProduct)/i;

// Existing generated-description debt discovered by the Audit Council guard.
// New entries must be fixed in proto comments or explicitly added here with review context.
const LEGACY_HIGH_RISK_DESCRIPTION_GAPS = new Set([
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.assessment',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.chokepointConfidence',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.chokepointId',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.comtradeCoverage',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.countryCode',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.coverageLevel',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.crudeLossKbd',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.dataAvailable',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.degraded',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.disruptionPct',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.effectiveCoverDays',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.gulfCrudeShare',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.ieaStocksCoverage',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.limitations',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.liveFlowRatio',
  'IntelligenceService.openapi.json:ComputeEnergyShockScenarioResponse.portwatchCoverage',
  'IntelligenceService.openapi.json:RegionalBrief.keyDevelopments',
  'IntelligenceService.openapi.json:RegionalBrief.model',
  'IntelligenceService.openapi.json:RegionalBrief.provider',
  'IntelligenceService.openapi.json:RegionalBrief.regimeTrajectory',
  'IntelligenceService.openapi.json:RegionalBrief.regionId',
  'IntelligenceService.openapi.json:RegionalBrief.riskOutlook',
  'IntelligenceService.openapi.json:RegionalBrief.situationRecap',
  'IntelligenceService.openapi.json:ScenarioLane.consequences',
  'IntelligenceService.openapi.json:ScenarioLane.probability',
  'IntelligenceService.openapi.json:ScenarioLane.triggerIds',
  'MarketService.openapi.json:FearGreedCategory.contribution',
  'MarketService.openapi.json:FearGreedCategory.degraded',
  'MarketService.openapi.json:FearGreedCategory.inputsJson',
  'MarketService.openapi.json:FearGreedCategory.score',
  'MarketService.openapi.json:FearGreedCategory.weight',
  'MarketService.openapi.json:FearGreedSectorPerformance.change1d',
  'MarketService.openapi.json:FearGreedSectorPerformance.name',
  'MarketService.openapi.json:FearGreedSectorPerformance.symbol',
  'MarketService.openapi.json:GetFearGreedIndexResponse.aaiiBear',
  'MarketService.openapi.json:GetFearGreedIndexResponse.aaiiBull',
  'MarketService.openapi.json:GetFearGreedIndexResponse.cnnFearGreed',
  'MarketService.openapi.json:GetFearGreedIndexResponse.cnnLabel',
  'MarketService.openapi.json:GetFearGreedIndexResponse.compositeLabel',
  'MarketService.openapi.json:GetFearGreedIndexResponse.compositeScore',
  'MarketService.openapi.json:GetFearGreedIndexResponse.fedRate',
  'MarketService.openapi.json:GetFearGreedIndexResponse.hySpread',
  'MarketService.openapi.json:GetFearGreedIndexResponse.pctAbove200d',
  'MarketService.openapi.json:GetFearGreedIndexResponse.previousScore',
  'MarketService.openapi.json:GetFearGreedIndexResponse.putCallRatio',
  'MarketService.openapi.json:GetFearGreedIndexResponse.seededAt',
  'MarketService.openapi.json:GetFearGreedIndexResponse.vix',
  'MarketService.openapi.json:GetFearGreedIndexResponse.yield10y',
  'ResilienceService.openapi.json:GetResilienceRankingResponse.coverage',
  'ResilienceService.openapi.json:GetResilienceRankingResponse.fetchedAt',
  'ResilienceService.openapi.json:GetResilienceRankingResponse.partial',
  'ResilienceService.openapi.json:GetResilienceRankingResponse.scored',
  'ResilienceService.openapi.json:GetResilienceRankingResponse.total',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.dataVersion',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.deployedCommitSha',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.formulaTag',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.generatedAt',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.manifestVersion',
  'ResilienceService.openapi.json:GetResilienceRuntimeManifestResponse.vercelEnv',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.baselineScore',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.change30d',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.countryCode',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.dataVersion',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.imputationShare',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.level',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.lowConfidence',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.overallScore',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.stressFactor',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.stressScore',
  'ResilienceService.openapi.json:GetResilienceScoreResponse.trend',
  'ResilienceService.openapi.json:ResilienceDimension.coverage',
  'ResilienceService.openapi.json:ResilienceDimension.id',
  'ResilienceService.openapi.json:ResilienceDimension.imputedWeight',
  'ResilienceService.openapi.json:ResilienceDimension.observedWeight',
  'ResilienceService.openapi.json:ResilienceDimension.score',
  'ResilienceService.openapi.json:ResilienceDomain.id',
  'ResilienceService.openapi.json:ResilienceDomain.score',
  'ResilienceService.openapi.json:ResilienceDomain.weight',
  'ResilienceService.openapi.json:ResilienceRankingCacheState.count',
  'ResilienceService.openapi.json:ResilienceRankingCacheState.fetchedAt',
  'ResilienceService.openapi.json:ResilienceRankingCacheState.scored',
  'ResilienceService.openapi.json:ResilienceRankingCacheState.total',
  'ResilienceService.openapi.json:ResilienceRankingItem.countryCode',
  'ResilienceService.openapi.json:ResilienceRankingItem.level',
  'ResilienceService.openapi.json:ResilienceRankingItem.lowConfidence',
  'ResilienceService.openapi.json:ResilienceRankingItem.overallCoverage',
  'ResilienceService.openapi.json:ResilienceRankingItem.overallScore',
  'ResilienceService.openapi.json:ResilienceRankingItem.rankStable',
  'ResilienceService.openapi.json:ResilienceRuntimeCacheState.historyPrefix',
  'ResilienceService.openapi.json:ResilienceRuntimeCacheState.intervalMethodology',
  'ResilienceService.openapi.json:ResilienceRuntimeCacheState.intervalPrefix',
  'ResilienceService.openapi.json:ResilienceRuntimeCacheState.rankingKey',
  'ResilienceService.openapi.json:ResilienceRuntimeCacheState.scorePrefix',
  'ResilienceService.openapi.json:ResilienceRuntimeFlag.enabled',
  'ResilienceService.openapi.json:ResilienceRuntimeFlag.name',
  'ScenarioService.openapi.json:GetScenarioStatusResponse.status',
  'ScenarioService.openapi.json:ScenarioTemplate.id',
  'ScenarioService.openapi.json:ScenarioTemplate.name',
  'ShippingV2Service.openapi.json:ChokepointExposure.chokepointId',
  'ShippingV2Service.openapi.json:ChokepointExposure.chokepointName',
  'ShippingV2Service.openapi.json:ChokepointExposure.exposurePct',
  'SupplyChainService.openapi.json:ChokepointExposureSummary.chokepointId',
  'SupplyChainService.openapi.json:ChokepointExposureSummary.chokepointName',
  'SupplyChainService.openapi.json:ChokepointExposureSummary.exposurePct',
  'SupplyChainService.openapi.json:ChokepointInfo.activeWarnings',
  'SupplyChainService.openapi.json:ChokepointInfo.affectedRoutes',
  'SupplyChainService.openapi.json:ChokepointInfo.aisDisruptions',
  'SupplyChainService.openapi.json:ChokepointInfo.congestionLevel',
  'SupplyChainService.openapi.json:ChokepointInfo.description',
  'SupplyChainService.openapi.json:ChokepointInfo.directions',
  'SupplyChainService.openapi.json:ChokepointInfo.disruptionScore',
  'SupplyChainService.openapi.json:ChokepointInfo.id',
  'SupplyChainService.openapi.json:ChokepointInfo.lat',
  'SupplyChainService.openapi.json:ChokepointInfo.lon',
  'SupplyChainService.openapi.json:ChokepointInfo.name',
  'SupplyChainService.openapi.json:GetChokepointHistoryResponse.chokepointId',
  'SupplyChainService.openapi.json:GetChokepointHistoryResponse.fetchedAt',
  'SupplyChainService.openapi.json:StrategicProduct.hs4',
  'SupplyChainService.openapi.json:StrategicProduct.label',
  'SupplyChainService.openapi.json:StrategicProduct.primaryChokepointId',
  'SupplyChainService.openapi.json:StrategicProduct.topExporterIso2',
  'SupplyChainService.openapi.json:StrategicProduct.topExporterShare',
  'SupplyChainService.openapi.json:StrategicProduct.totalValueUsd',
]);

const MISLEADING_DESCRIPTION_PATTERNS = [
  /^todo\b/i,
  /^tbd\b/i,
  /^string$/i,
  /^number$/i,
  /^boolean$/i,
  /^object$/i,
];

function generatedJsonSpecs() {
  return readdirSync(apiDir)
    .filter((name) => name.endsWith('.openapi.json'))
    .sort();
}

function generatedQuerySpecs() {
  const serviceJsonSpecs = generatedJsonSpecs().map((file) => ({
    file,
    spec: JSON.parse(readFileSync(resolve(apiDir, file), 'utf8')),
  }));

  return [
    ...serviceJsonSpecs,
    {
      file: 'worldmonitor.openapi.yaml',
      spec: YAML.parse(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8')),
    },
  ];
}

function hasDescription(schema) {
  return (
    (typeof schema.description === 'string' && schema.description.trim().length > 0) ||
    (typeof schema.items?.description === 'string' && schema.items.description.trim().length > 0) ||
    Boolean(schema.$ref || schema.items?.$ref)
  );
}

function descriptionText(schema) {
  if (typeof schema.description === 'string') return schema.description.trim();
  if (typeof schema.items?.description === 'string') return schema.items.description.trim();
  return '';
}

function collectHighRiskProperties() {
  const rows = [];
  for (const file of generatedJsonSpecs()) {
    const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
    for (const [schemaName, schema] of Object.entries(spec.components?.schemas ?? {})) {
      if (!HIGH_RISK_SCHEMA_NAME.test(schemaName)) continue;
      for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
        rows.push({
          key: `${file}:${schemaName}.${propertyName}`,
          description: descriptionText(propertySchema),
          hasDescription: hasDescription(propertySchema),
        });
      }
    }
  }
  return rows;
}

const HTTP_OPERATION_KEYS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

function parameterDescriptionText(parameter) {
  if (typeof parameter.description === 'string') return parameter.description.trim();
  return '';
}

function collectQueryParameters() {
  const rows = [];
  for (const { file, spec } of generatedQuerySpecs()) {
    for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
      const pathParameters = Array.isArray(pathItem?.parameters) ? pathItem.parameters : [];
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!HTTP_OPERATION_KEYS.has(method)) continue;
        const operationParameters = Array.isArray(operation?.parameters) ? operation.parameters : [];
        for (const parameter of [...pathParameters, ...operationParameters]) {
          if (parameter?.in !== 'query') continue;
          rows.push({
            key: file + ':' + method.toUpperCase() + ' ' + route + ' ?' + parameter.name,
            description: parameterDescriptionText(parameter),
          });
        }
      }
    }
  }
  return rows;
}

describe('generated OpenAPI description guard for high-risk documentation claims', () => {
  it('requires high-risk public fields to have generated descriptions or an explicit legacy-gap entry', () => {
    const actualGaps = collectHighRiskProperties()
      .filter((row) => !row.hasDescription)
      .map((row) => row.key)
      .sort();

    const unexpectedGaps = actualGaps.filter((key) => !LEGACY_HIGH_RISK_DESCRIPTION_GAPS.has(key));
    assert.deepEqual(
      unexpectedGaps,
      [],
      `High-risk generated OpenAPI fields are missing descriptions and are not allowlisted:\n${unexpectedGaps.join('\n')}`,
    );

    const staleAllowlist = [...LEGACY_HIGH_RISK_DESCRIPTION_GAPS]
      .filter((key) => !actualGaps.includes(key))
      .sort();
    assert.deepEqual(
      staleAllowlist,
      [],
      `Generated OpenAPI description gap allowlist has stale entries; remove them:\n${staleAllowlist.join('\n')}`,
    );
  });

  it('rejects placeholder descriptions on high-risk generated public fields', () => {
    const placeholders = collectHighRiskProperties()
      .filter((row) => row.description && MISLEADING_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(row.description)))
      .map((row) => `${row.key}: ${row.description}`)
      .sort();

    assert.deepEqual(
      placeholders,
      [],
      `High-risk generated OpenAPI fields have placeholder descriptions:\n${placeholders.join('\n')}`,
    );
  });

  it('requires every generated query parameter to have a description', () => {
    const missingDescriptions = collectQueryParameters()
      .filter((row) => !row.description)
      .map((row) => row.key)
      .sort();

    assert.deepEqual(
      missingDescriptions,
      [],
      'Generated OpenAPI query parameters are missing descriptions:\n' + missingDescriptions.join('\n'),
    );

    const placeholders = collectQueryParameters()
      .filter((row) => row.description && MISLEADING_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(row.description)))
      .map((row) => row.key + ': ' + row.description)
      .sort();

    assert.deepEqual(
      placeholders,
      [],
      'Generated OpenAPI query parameters have placeholder descriptions:\n' + placeholders.join('\n'),
    );
  });
});
