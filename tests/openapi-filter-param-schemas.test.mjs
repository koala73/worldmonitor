import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import YAML from 'yaml';

const ISO2_CODES = Object.keys(JSON.parse(readFileSync('shared/iso2-to-iso3.json', 'utf8'))).sort();
const FILTER_PARAM_CONTRACTS = JSON.parse(readFileSync('shared/openapi-filter-param-contracts.json', 'utf8'));
const PREDICTION_MARKET_CATEGORIES = [
  ...FILTER_PARAM_CONTRACTS.predictionMarketTechCategories,
  ...FILTER_PARAM_CONTRACTS.predictionMarketFinanceCategories,
];

const EXPECTED_ENUMS = [
  ['ConflictService', '/api/conflict/v1/get-humanitarian-summary', 'get', 'country_code', ISO2_CODES],
  ['CyberService', '/api/cyber/v1/list-cyber-threats', 'get', 'type', [
    'CYBER_THREAT_TYPE_C2_SERVER',
    'CYBER_THREAT_TYPE_MALWARE_HOST',
    'CYBER_THREAT_TYPE_PHISHING',
    'CYBER_THREAT_TYPE_MALICIOUS_URL',
  ]],
  ['CyberService', '/api/cyber/v1/list-cyber-threats', 'get', 'source', [
    'CYBER_THREAT_SOURCE_FEODO',
    'CYBER_THREAT_SOURCE_URLHAUS',
    'CYBER_THREAT_SOURCE_C2INTEL',
    'CYBER_THREAT_SOURCE_OTX',
    'CYBER_THREAT_SOURCE_ABUSEIPDB',
  ]],
  ['CyberService', '/api/cyber/v1/list-cyber-threats', 'get', 'min_severity', [
    'CRITICALITY_LEVEL_LOW',
    'CRITICALITY_LEVEL_MEDIUM',
    'CRITICALITY_LEVEL_HIGH',
    'CRITICALITY_LEVEL_CRITICAL',
  ]],
  ['EconomicService', '/api/economic/v1/get-bls-series', 'get', 'series_id', FILTER_PARAM_CONTRACTS.economicBlsSeriesIds],
  ['ForecastService', '/api/forecast/v1/get-forecasts', 'get', 'domain', FILTER_PARAM_CONTRACTS.forecastDomains],
  ['InfrastructureService', '/api/infrastructure/v1/list-service-statuses', 'get', 'status', [
    'SERVICE_OPERATIONAL_STATUS_OPERATIONAL',
    'SERVICE_OPERATIONAL_STATUS_DEGRADED',
    'SERVICE_OPERATIONAL_STATUS_PARTIAL_OUTAGE',
    'SERVICE_OPERATIONAL_STATUS_MAJOR_OUTAGE',
    'SERVICE_OPERATIONAL_STATUS_MAINTENANCE',
  ]],
  ['InfrastructureService', '/api/infrastructure/v1/get-temporal-baseline', 'get', 'type', FILTER_PARAM_CONTRACTS.infrastructureTemporalBaselineTypes],
  ['IntelligenceService', '/api/intelligence/v1/compute-energy-shock', 'get', 'chokepoint_id', FILTER_PARAM_CONTRACTS.intelligenceChokepointIds],
  ['IntelligenceService', '/api/intelligence/v1/compute-energy-shock', 'get', 'fuel_mode', FILTER_PARAM_CONTRACTS.intelligenceFuelModes],
  ['MarketService', '/api/market/v1/get-country-stock-index', 'get', 'country_code', Object.keys(FILTER_PARAM_CONTRACTS.marketCountryStockIndexes)],
  ['MilitaryService', '/api/military/v1/list-military-bases', 'get', 'type', FILTER_PARAM_CONTRACTS.militaryBaseTypes],
  ['MilitaryService', '/api/military/v1/list-military-bases', 'get', 'kind', FILTER_PARAM_CONTRACTS.militaryBaseKinds],
  ['PredictionService', '/api/prediction/v1/list-prediction-markets', 'get', 'category', PREDICTION_MARKET_CATEGORIES],
  ['ResearchService', '/api/research/v1/list-tech-events', 'get', 'type', FILTER_PARAM_CONTRACTS.researchTechEventTypes],
  ['ResearchService', '/api/research/v1/list-hackernews-items', 'get', 'feed_type', FILTER_PARAM_CONTRACTS.researchHackerNewsFeedTypes],
];

const EXPECTED_PATTERNS = [
  ['NewsService', '/api/news/v1/summarize-article-cache', 'get', 'cache_key', FILTER_PARAM_CONTRACTS.newsSummarizeArticleCacheKeyPattern],
  ['TradeService', '/api/trade/v1/list-comtrade-flows', 'get', 'cmd_code', FILTER_PARAM_CONTRACTS.tradeComtradeCmdCodePattern],
];

function readJsonSpec(service) {
  return JSON.parse(readFileSync(`docs/api/${service}.openapi.json`, 'utf8'));
}

function readUnifiedSpec() {
  return YAML.parse(readFileSync('docs/api/worldmonitor.openapi.yaml', 'utf8'));
}

function getParam(spec, path, method, name) {
  const params = spec.paths[path]?.[method]?.parameters ?? [];
  return params.find((param) => param.in === 'query' && param.name === name);
}

describe('OpenAPI filter parameter schemas', () => {
  it('documents issue-listed allow-list filters as query parameter enums in service JSON specs', () => {
    for (const [service, path, method, name, expected] of EXPECTED_ENUMS) {
      const param = getParam(readJsonSpec(service), path, method, name);
      assert.ok(param, `${service} ${name} parameter exists`);
      assert.deepEqual(param.schema?.enum, expected, `${service} ${name} enum`);
    }
  });

  it('documents issue-listed pattern filters in service JSON specs', () => {
    for (const [service, path, method, name, expected] of EXPECTED_PATTERNS) {
      const param = getParam(readJsonSpec(service), path, method, name);
      assert.ok(param, `${service} ${name} parameter exists`);
      assert.equal(param.schema?.pattern, expected, `${service} ${name} pattern`);
    }
  });

  it('omits proto zero-value sentinels from public query parameter enums', () => {
    for (const file of readdirSync('docs/api').filter((entry) => entry.endsWith('.openapi.json'))) {
      const spec = JSON.parse(readFileSync(`docs/api/${file}`, 'utf8'));
      for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
        for (const [method, operation] of Object.entries(pathItem ?? {})) {
          for (const param of operation?.parameters ?? []) {
            if (param.in !== 'query' || !Array.isArray(param.schema?.enum)) continue;
            assert.ok(
              !param.schema.enum.some((value) => String(value).endsWith('_UNSPECIFIED')),
              `${file} ${method.toUpperCase()} ${path} ${param.name} should omit _UNSPECIFIED`,
            );
          }
        }
      }
    }
  });

  it('keeps documented examples aligned with accepted tokens', () => {
    const bls = getParam(readJsonSpec('EconomicService'), '/api/economic/v1/get-bls-series', 'get', 'series_id');
    assert.match(bls.description, /USPRIV/);
    assert.doesNotMatch(bls.description, /CES0500000001|CIU1010000000000A/);

    const techEvents = getParam(readJsonSpec('ResearchService'), '/api/research/v1/list-tech-events', 'get', 'type');
    assert.match(techEvents.description, /conference/);
    assert.doesNotMatch(techEvents.description, /conferences/);

    const hn = getParam(readJsonSpec('ResearchService'), '/api/research/v1/list-hackernews-items', 'get', 'feed_type');
    assert.match(hn.description, /job/);
  });

  it('applies the same filter contracts to the unified OpenAPI bundle', () => {
    const spec = readUnifiedSpec();
    for (const [, path, method, name, expected] of EXPECTED_ENUMS) {
      const param = getParam(spec, path, method, name);
      assert.ok(param, `${path} ${name} parameter exists`);
      assert.deepEqual(param.schema?.enum, expected, `${path} ${name} enum`);
    }
    for (const [, path, method, name, expected] of EXPECTED_PATTERNS) {
      const param = getParam(spec, path, method, name);
      assert.ok(param, `${path} ${name} parameter exists`);
      assert.equal(param.schema?.pattern, expected, `${path} ${name} pattern`);
    }
  });
});
