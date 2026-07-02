import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OPENAPI_DIR = join(ROOT, 'docs/api');
const JSON_SPEC_SUFFIX = '.openapi.json';
const YAML_SPEC_SUFFIX = '.openapi.yaml';
const ISO2_TO_ISO3 = JSON.parse(readFileSync(join(ROOT, 'shared/iso2-to-iso3.json'), 'utf8'));
const FILTER_PARAM_CONTRACTS = JSON.parse(readFileSync(join(ROOT, 'shared/openapi-filter-param-contracts.json'), 'utf8'));

const PREDICTION_MARKET_CATEGORIES = [
  ...FILTER_PARAM_CONTRACTS.predictionMarketTechCategories,
  ...FILTER_PARAM_CONTRACTS.predictionMarketFinanceCategories,
];

function quotedList(values) {
  return values.map((value) => `"${value}"`).join(', ');
}

export const OPENAPI_FILTER_PARAM_SCHEMA_OVERRIDES = [
  {
    path: '/api/conflict/v1/get-humanitarian-summary',
    method: 'get',
    name: 'country_code',
    schema: { type: 'string', enum: Object.keys(ISO2_TO_ISO3).sort() },
  },
  {
    path: '/api/economic/v1/get-bls-series',
    method: 'get',
    name: 'series_id',
    description: `BLS/FRED-backed series ID. Supported values: ${quotedList(FILTER_PARAM_CONTRACTS.economicBlsSeriesIds)}.`,
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.economicBlsSeriesIds },
  },
  {
    path: '/api/forecast/v1/get-forecasts',
    method: 'get',
    name: 'domain',
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.forecastDomains },
  },
  {
    path: '/api/infrastructure/v1/get-temporal-baseline',
    method: 'get',
    name: 'type',
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.infrastructureTemporalBaselineTypes },
  },
  {
    path: '/api/intelligence/v1/compute-energy-shock',
    method: 'get',
    name: 'chokepoint_id',
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.intelligenceChokepointIds },
  },
  {
    path: '/api/intelligence/v1/compute-energy-shock',
    method: 'get',
    name: 'fuel_mode',
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.intelligenceFuelModes },
  },
  {
    path: '/api/market/v1/get-country-stock-index',
    method: 'get',
    name: 'country_code',
    schema: { type: 'string', enum: Object.keys(FILTER_PARAM_CONTRACTS.marketCountryStockIndexes) },
  },
  {
    path: '/api/military/v1/list-military-bases',
    method: 'get',
    name: 'type',
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.militaryBaseTypes },
  },
  {
    path: '/api/military/v1/list-military-bases',
    method: 'get',
    name: 'kind',
    schema: {
      type: 'string',
      enum: FILTER_PARAM_CONTRACTS.militaryBaseKinds,
    },
  },
  {
    path: '/api/news/v1/summarize-article-cache',
    method: 'get',
    name: 'cache_key',
    schema: { type: 'string', pattern: FILTER_PARAM_CONTRACTS.newsSummarizeArticleCacheKeyPattern },
  },
  {
    path: '/api/prediction/v1/list-prediction-markets',
    method: 'get',
    name: 'category',
    schema: {
      type: 'string',
      enum: PREDICTION_MARKET_CATEGORIES,
    },
  },
  {
    path: '/api/research/v1/list-tech-events',
    method: 'get',
    name: 'type',
    description: `Event type filter: ${quotedList(FILTER_PARAM_CONTRACTS.researchTechEventTypes)}. Empty = all.`,
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.researchTechEventTypes },
  },
  {
    path: '/api/research/v1/list-hackernews-items',
    method: 'get',
    name: 'feed_type',
    description: `Feed type: ${quotedList(FILTER_PARAM_CONTRACTS.researchHackerNewsFeedTypes)}. Defaults to "top".`,
    schema: { type: 'string', enum: FILTER_PARAM_CONTRACTS.researchHackerNewsFeedTypes },
  },
  {
    path: '/api/trade/v1/list-comtrade-flows',
    method: 'get',
    name: 'cmd_code',
    schema: { type: 'string', pattern: FILTER_PARAM_CONTRACTS.tradeComtradeCmdCodePattern },
  },
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function queryNameToPropertyName(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function targetKey(target) {
  return `${target.path}\0${target.method}\0${target.name}`;
}

function pickSchemaContract(schema, fallbackType) {
  const contract = {};
  if (schema.type || fallbackType) contract.type = schema.type || fallbackType;
  if (Array.isArray(schema.enum)) {
    contract.enum = schema.enum.filter((value) => !String(value).endsWith('_UNSPECIFIED'));
  }
  if (typeof schema.pattern === 'string') contract.pattern = schema.pattern;
  return contract.enum || contract.pattern ? contract : null;
}

function findRequestSchema(spec, operationId) {
  const schemas = spec.components?.schemas || {};
  const exactName = operationId + 'Request';
  if (schemas[exactName]) return schemas[exactName];
  const suffixMatches = Object.entries(schemas).filter(([name]) => name.endsWith('_' + exactName));
  return suffixMatches.length === 1 ? suffixMatches[0]?.[1] : undefined;
}

function collectTargets(spec) {
  const byKey = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem?.[method];
      if (!operation?.operationId || !Array.isArray(operation.parameters)) continue;
      const requestSchema = findRequestSchema(spec, operation.operationId);
      const properties = requestSchema?.properties || {};
      for (const parameter of operation.parameters) {
        if (parameter?.in !== 'query' || !parameter.name) continue;
        const propertySchema = properties[queryNameToPropertyName(parameter.name)];
        if (!propertySchema) continue;
        const schema = pickSchemaContract(propertySchema, parameter.schema?.type);
        if (!schema) continue;
        const target = { path, method, name: parameter.name, schema };
        byKey.set(targetKey(target), target);
      }
    }
  }

  for (const override of OPENAPI_FILTER_PARAM_SCHEMA_OVERRIDES) {
    byKey.set(targetKey(override), cloneJson(override));
  }
  return [...byKey.values()];
}

export function applyOpenApiFilterParamSchemas(spec) {
  let changed = false;
  for (const target of collectTargets(spec)) {
    const operation = spec.paths?.[target.path]?.[target.method];
    if (!operation?.parameters) continue;
    const parameter = operation.parameters.find((p) => p?.in === 'query' && p.name === target.name);
    if (!parameter) continue;
    const nextSchema = { ...(parameter.schema || {}), ...cloneJson(target.schema) };
    if (JSON.stringify(parameter.schema || {}) !== JSON.stringify(nextSchema)) {
      parameter.schema = nextSchema;
      changed = true;
    }
    if (target.description && parameter.description !== target.description) {
      parameter.description = target.description;
      changed = true;
    }
  }
  return changed;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function quoteYaml(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function schemaLines(schema) {
  const lines = ['                  schema:'];
  if (schema.type) lines.push(`                    type: ${schema.type}`);
  if (Array.isArray(schema.enum)) {
    lines.push('                    enum:');
    for (const value of schema.enum) lines.push(`                        - ${quoteYaml(value)}`);
  }
  if (schema.pattern) lines.push(`                    pattern: ${quoteYaml(schema.pattern)}`);
  return lines;
}

function patchYamlTarget(text, target) {
  const lines = text.split('\n');
  const pathNeedle = `    ${target.path}:`;
  const pathIndex = lines.findIndex((line) => line === pathNeedle);
  if (pathIndex === -1) return text;

  let pathEnd = lines.length;
  for (let i = pathIndex + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith('    /')) {
      pathEnd = i;
      break;
    }
  }

  const methodNeedle = `        ${target.method}:`;
  const methodIndex = lines.findIndex((line, i) => i > pathIndex && i < pathEnd && line === methodNeedle);
  if (methodIndex === -1) return text;

  let methodEnd = pathEnd;
  for (let i = methodIndex + 1; i < pathEnd; i++) {
    if (/^        [a-z]+:$/.test(lines[i] || '')) {
      methodEnd = i;
      break;
    }
  }

  const nameNeedle = `                - name: ${target.name}`;
  const paramIndex = lines.findIndex((line, i) => i > methodIndex && i < methodEnd && line === nameNeedle);
  if (paramIndex === -1) return text;

  let paramEnd = methodEnd;
  for (let i = paramIndex + 1; i < methodEnd; i++) {
    if ((lines[i] || '').startsWith('                - name:') || (lines[i] || '').startsWith('            responses:')) {
      paramEnd = i;
      break;
    }
  }

  if (target.description) {
    const descriptionIndex = lines.findIndex((line, i) => i > paramIndex && i < paramEnd && line.startsWith('                  description:'));
    if (descriptionIndex !== -1) {
      lines[descriptionIndex] = `                  description: ${quoteYaml(target.description)}`;
    } else {
      const inIndex = lines.findIndex((line, i) => i > paramIndex && i < paramEnd && line === '                  in: query');
      if (inIndex !== -1) {
        lines.splice(inIndex + 1, 0, `                  description: ${quoteYaml(target.description)}`);
        paramEnd++;
        methodEnd++;
        pathEnd++;
      }
    }
  }

  const schemaIndex = lines.findIndex((line, i) => i > paramIndex && i < paramEnd && line === '                  schema:');
  if (schemaIndex === -1) return lines.join('\n');

  let schemaEnd = paramEnd;
  for (let i = schemaIndex + 1; i < paramEnd; i++) {
    const line = lines[i] || '';
    if (line.trim() && countIndent(line) <= 18) {
      schemaEnd = i;
      break;
    }
  }

  lines.splice(schemaIndex, schemaEnd - schemaIndex, ...schemaLines(target.schema));
  return lines.join('\n');
}

function patchYamlText(text, targets) {
  let next = text;
  for (const target of targets) {
    next = patchYamlTarget(next, target);
  }
  return next;
}

function processJsonFile(file, check) {
  const before = readFileSync(file, 'utf8');
  const spec = JSON.parse(before);
  const changed = applyOpenApiFilterParamSchemas(spec);
  if (!changed) return false;
  const after = JSON.stringify(spec);
  if (check) return true;
  writeFileSync(file, after);
  return true;
}

function readJsonSpec(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectTargetsFromJsonFiles(files) {
  const byKey = new Map();
  for (const file of files) {
    for (const target of collectTargets(readJsonSpec(file))) {
      byKey.set(targetKey(target), target);
    }
  }
  return [...byKey.values()];
}

function processYamlFile(file, check, targets) {
  const before = readFileSync(file, 'utf8');
  const after = patchYamlText(before, targets);
  if (before === after) return false;
  if (check) return true;
  writeFileSync(file, after);
  return true;
}

export function applyOpenApiFilterParamSchemaFiles({ check = false } = {}) {
  const changed = [];
  const entries = readdirSync(OPENAPI_DIR).sort();
  const jsonEntries = entries.filter((entry) => entry.endsWith(JSON_SPEC_SUFFIX));

  for (const entry of jsonEntries) {
    const file = join(OPENAPI_DIR, entry);
    if (processJsonFile(file, check)) changed.push(entry);
  }

  const jsonFiles = jsonEntries.map((entry) => join(OPENAPI_DIR, entry));
  const allTargets = collectTargetsFromJsonFiles(jsonFiles);

  for (const entry of entries) {
    if (!entry.endsWith(YAML_SPEC_SUFFIX)) continue;
    const file = join(OPENAPI_DIR, entry);
    const jsonPeerEntry = entry.replace(YAML_SPEC_SUFFIX, JSON_SPEC_SUFFIX);
    const jsonPeer = join(OPENAPI_DIR, jsonPeerEntry);
    const targets = jsonEntries.includes(jsonPeerEntry)
      ? collectTargets(readJsonSpec(jsonPeer))
      : allTargets;
    if (processYamlFile(file, check, targets)) changed.push(entry);
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const changed = applyOpenApiFilterParamSchemaFiles({ check });
  if (check && changed.length > 0) {
    console.error('OpenAPI filter parameter schemas are stale:');
    for (const file of changed) console.error(`  ${file}`);
    console.error('Run: node scripts/apply-openapi-filter-param-schemas.mjs');
    process.exit(1);
  }
  if (changed.length > 0) {
    console.log(`Updated OpenAPI filter parameter schemas in ${changed.length} file(s).`);
  }
}
