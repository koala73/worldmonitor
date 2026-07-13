import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { normalizeKey } from '../scripts/lib/openapi-codegen.mjs';

// Guards the generated OpenAPI examples injected by
// scripts/openapi-inject-examples.mjs (umbrella #4599, workstream #4610).
// The sebuf generator emits shape-only docs, so a fresh regenerate must be
// followed by the injector for every operation to keep request/response
// examples in the published specs.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const JSON_MEDIA = 'application/json';

const serviceSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();

// Expected accepted-value sets for the curated example overrides, sourced from
// the SAME server-side constants the injector reads so the test can't drift
// from the handlers. Read as text (no TS/JSON import) to stay runner-agnostic.
const CURATED = (() => {
  const filterContract = JSON.parse(
    readFileSync(resolve(root, 'shared/openapi-filter-param-contracts.json'), 'utf8'),
  );
  const chokepointIds = new Set(filterContract.intelligenceChokepointIds ?? []);
  const scenarioSrc = readFileSync(
    resolve(root, 'server/worldmonitor/supply-chain/v1/scenario-templates.ts'),
    'utf8',
  );
  const scenarioIds = new Set([...scenarioSrc.matchAll(/\bid:\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]));
  const llmSrc = readFileSync(resolve(root, 'server/_shared/llm.ts'), 'utf8');
  const llmProviderType = llmSrc.match(/export type LlmProviderName = ([^;]+);/);
  assert.ok(llmProviderType, 'expected LlmProviderName union in server/_shared/llm.ts');
  const llmProviders = new Set([...llmProviderType[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.ok(llmProviders.size > 0, 'expected at least one LLM provider in LlmProviderName');
  const gdeltSrc = readFileSync(resolve(root, 'scripts/seed-gdelt-intel.mjs'), 'utf8');
  const gdeltTopics = new Set([...gdeltSrc.matchAll(/\bid:\s*['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]));
  const geographySrc = readFileSync(resolve(root, 'scripts/shared/geography.js'), 'utf8');
  const regionIdsMatch = geographySrc.match(/\bREGION_IDS\s*=\s*\[([\s\S]*?)\]/);
  const regionIds = new Set(regionIdsMatch ? [...regionIdsMatch[1].matchAll(/['"`]([a-z0-9-]+)['"`]/g)].map((m) => m[1]) : []);
  const consumerSrc = readFileSync(resolve(root, 'server/worldmonitor/consumer-prices/v1/get-consumer-price-basket-series.ts'), 'utf8');
  const consumerRangesMatch = consumerSrc.match(/VALID_RANGES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  const consumerRanges = new Set(consumerRangesMatch ? [...consumerRangesMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : []);
  const basketMatch = consumerSrc.match(/\bDEFAULT_BASKET\s*=\s*['"`]([^'"`]+)['"`]/);
  const consumerBaskets = new Set([basketMatch?.[1] ?? 'essentials-ae']);
  return { chokepointIds, scenarioIds, llmProviders, gdeltTopics, regionIds, consumerRanges, consumerBaskets };
})();

// Mirror of scripts/openapi-inject-examples.mjs override routing (normalizeKey is
// imported from the shared codegen module the injector uses, so it can't drift).
function curatedCategory(name) {
  const key = normalizeKey(name);
  if (key.includes('chokepointid')) return 'chokepoint';
  if (key.includes('scenarioid')) return 'scenario';
  if (key.includes('icao24')) return 'icao24';
  if (key === 'seriesid' || key === 'seriesids') return 'series';
  return null;
}

function refName(ref) {
  assert.ok(ref.startsWith('#/components/schemas/'), `unsupported ref ${ref}`);
  return decodeURIComponent(ref.slice('#/components/schemas/'.length));
}

function resolveSchema(schema, spec) {
  if (!schema?.$ref) return schema;
  const name = refName(schema.$ref);
  const resolved = spec.components?.schemas?.[name];
  assert.ok(resolved, `missing schema ref ${schema.$ref}`);
  return resolved;
}

function schemaType(schema) {
  const t = Array.isArray(schema?.type) ? schema.type.find((v) => v !== 'null') : schema?.type;
  if (t) return t;
  if (schema?.properties || schema?.additionalProperties) return 'object';
  if (schema?.items) return 'array';
  return undefined;
}

function validateExample(value, schema, spec, label, seen = new Set()) {
  schema = schema ?? {};
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return;
    seen = new Set([...seen, schema.$ref]);
    schema = resolveSchema(schema, spec);
  }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${label}: const mismatch`);
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), `${label}: enum mismatch`);
  if (schema.nullable && value === null) return;
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) validateExample(value, part, spec, label, seen);
    return;
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union)) {
    const matched = union.some((part) => {
      try {
        validateExample(value, part, spec, label, seen);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matched, `${label}: did not match any union member`);
    return;
  }

  const type = schemaType(schema);
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${label}: expected array`);
    for (const item of value) validateExample(item, schema.items ?? {}, spec, `${label}[]`, seen);
    return;
  }
  if (type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${label}: missing required property ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validateExample(child, schema.properties[key], spec, `${label}.${key}`, seen);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateExample(child, schema.additionalProperties, spec, `${label}.${key}`, seen);
      }
    }
    return;
  }
  if (type === 'integer') {
    assert.equal(typeof value, 'number', `${label}: expected integer number`);
    assert.ok(Number.isInteger(value), `${label}: expected integer`);
  } else if (type === 'number') {
    assert.equal(typeof value, 'number', `${label}: expected number`);
  } else if (type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${label}: expected boolean`);
  } else if (type === 'string') {
    assert.equal(typeof value, 'string', `${label}: expected string`);
    assert.doesNotMatch(value, /_UNSPECIFIED$/, `${label}: must not use an unspecified enum sentinel`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum)) assert.ok(value >= schema.minimum, `${label}: below minimum`);
    if (Number.isFinite(schema.maximum)) assert.ok(value <= schema.maximum, `${label}: above maximum`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength)) assert.ok(value.length >= schema.minLength, `${label}: below minLength`);
    if (Number.isFinite(schema.maxLength)) assert.ok(value.length <= schema.maxLength, `${label}: above maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label}: pattern mismatch`);
  }
}

function isDocumentedCodeParam(param) {
  const text = `${param.name} ${param.description ?? ''}`.toLowerCase();
  return /country|iata|iso 4217|iso 3166|iso 639|wto member code|world bank indicator code|cpc category|un comtrade reporter code|hs commodity code/.test(text);
}

function operationEntries(spec) {
  const entries = [];
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!HTTP_METHODS.has(method) || !op || typeof op !== 'object') continue;
      entries.push({ path, method, op });
    }
  }
  return entries;
}

function successResponses(op) {
  return Object.entries(op.responses ?? {}).filter(([code, response]) =>
    String(code).startsWith('2') && String(code).length === 3 && response?.content?.[JSON_MEDIA]?.schema,
  );
}

// Collect every curated example occurrence (params + top-level request-body
// fields, flattening array values) tagged with its category and op context.
function collectCuratedExamples() {
  const found = [];
  for (const file of serviceSpecs) {
    const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
    for (const { path, method, op } of operationEntries(spec)) {
      const opText = `${method} ${path}`.toLowerCase();
      for (const param of op.parameters ?? []) {
        const cat = curatedCategory(param.name);
        if (!cat) continue;
        const schema = resolveSchema(param.schema ?? {}, spec);
        const values = Array.isArray(param.example) ? param.example : [param.example];
        for (const value of values) {
          found.push({ cat, value, opText, hasEnum: Array.isArray(schema.enum), enumValues: schema.enum, where: `${file} ${method.toUpperCase()} ${path} param ${param.name}` });
        }
      }
      const bodyExample = op.requestBody?.content?.[JSON_MEDIA]?.example;
      if (bodyExample && typeof bodyExample === 'object' && !Array.isArray(bodyExample)) {
        for (const [field, raw] of Object.entries(bodyExample)) {
          const cat = curatedCategory(field);
          if (!cat) continue;
          const values = Array.isArray(raw) ? raw : [raw];
          for (const value of values) {
            found.push({ cat, value, opText, hasEnum: false, enumValues: undefined, where: `${file} ${method.toUpperCase()} ${path} body ${field}` });
          }
        }
      }
    }
  }
  return found;
}

function assertOperationExamples(spec, label) {
  let operations = 0;
  let requestExpected = 0;
  let responseExpected = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    operations++;
    const opLabel = `${label}: ${method.toUpperCase()} ${path}`;

    for (const param of op.parameters ?? []) {
      requestExpected++;
      assert.notEqual(param.example, undefined, `${opLabel}: parameter ${param.name} missing example`);
      validateExample(param.example, param.schema, spec, `${opLabel} parameter ${param.name}`);
      if (isDocumentedCodeParam(param)) {
        assert.notEqual(param.example, 'example', `${opLabel}: parameter ${param.name} needs a documented code example`);
      }
    }

    const requestMedia = op.requestBody?.content?.[JSON_MEDIA];
    if (requestMedia?.schema) {
      requestExpected++;
      assert.notEqual(requestMedia.example, undefined, `${opLabel}: request body missing example`);
      validateExample(requestMedia.example, requestMedia.schema, spec, `${opLabel} requestBody`);
    }

    const success = Object.entries(op.responses ?? {}).filter(([code, response]) =>
      /^2\d\d$/.test(code) && response?.content?.[JSON_MEDIA]?.schema,
    );
    assert.ok(success.length > 0, `${opLabel}: expected a JSON success response`);
    responseExpected++;
    for (const [code, response] of success) {
      const media = response.content[JSON_MEDIA];
      assert.notEqual(media.example, undefined, `${opLabel}: ${code} response missing example`);
      validateExample(media.example, media.schema, spec, `${opLabel} ${code} response`);
    }
  }
  return { operations, requestExpected, responseExpected };
}

function assertRecordBaselineSampleTypes(spec, label, validTypes) {
  let checked = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    if (!path.includes('record-baseline-snapshot')) continue;
    const opLabel = label + ': ' + method.toUpperCase() + ' ' + path;
    const example = op.requestBody?.content?.[JSON_MEDIA]?.example;
    for (const update of example?.updates ?? []) {
      checked++;
      assert.ok(
        validTypes.has(update.type),
        opLabel + " sample type '" + update.type + "' is not an accepted VALID_BASELINE_TYPES member; " +
          'the handler would silently skip it',
      );
    }
  }
  assert.ok(checked > 0, label + ': expected at least one record-baseline-snapshot update example to check');
}

function collectTopLevelFieldExamples(spec, label, opPredicate, field) {
  const found = [];
  for (const { path, method, op } of operationEntries(spec)) {
    if (!opPredicate({ path, method, op })) continue;
    const where = `${label} ${method.toUpperCase()} ${path}`;
    const requestExample = op.requestBody?.content?.[JSON_MEDIA]?.example;
    if (requestExample && typeof requestExample === 'object' && !Array.isArray(requestExample) && Object.hasOwn(requestExample, field)) {
      found.push({ value: requestExample[field], where: `${where} request body ${field}` });
    }
    for (const [code, response] of successResponses(op)) {
      const responseExample = response.content?.[JSON_MEDIA]?.example;
      if (responseExample && typeof responseExample === 'object' && !Array.isArray(responseExample) && Object.hasOwn(responseExample, field)) {
        found.push({ value: responseExample[field], where: `${where} ${code} response ${field}` });
      }
    }
  }
  return found;
}

function assertSummarizeProviderExamples(spec, label) {
  const examples = collectTopLevelFieldExamples(
    spec,
    label,
    ({ op }) => String(op.operationId ?? '').includes('SummarizeArticle'),
    'provider',
  );
  assert.ok(examples.length >= 3, `${label}: expected SummarizeArticle provider examples`);
  for (const { value, where } of examples) {
    assert.notEqual(value, 'worldmonitor', `${where}: worldmonitor is not accepted by getProviderCredentials()`);
    assert.ok(CURATED.llmProviders.has(value), `${where}: provider '${value}' is not an LlmProviderName`);
  }
}

function assertConsumerPriceResponseRanges(spec, label) {
  const operationIds = new Set(['ListConsumerPriceCategories', 'ListConsumerPriceMovers']);
  const examples = collectTopLevelFieldExamples(
    spec,
    label,
    ({ op }) => operationIds.has(String(op.operationId ?? '')),
    'range',
  ).filter(({ where }) => where.includes(' response '));
  assert.equal(examples.length, operationIds.size, `${label}: expected consumer-price response range examples`);
  for (const { value, where } of examples) {
    assert.notEqual(value, 'example', `${where}: placeholder range`);
    assert.ok(CURATED.consumerRanges.has(value), `${where}: range '${value}' is not an accepted consumer-price range`);
  }
}

function assertComputeEnergyShockChokepointEcho(spec, label) {
  let checked = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    if (op.operationId !== 'ComputeEnergyShockScenario') continue;
    const param = (op.parameters ?? []).find((p) => p?.name === 'chokepoint_id');
    assert.ok(param, `${label}: ${method.toUpperCase()} ${path} missing chokepoint_id parameter`);
    assert.notEqual(param.example, 'example', `${label}: ${method.toUpperCase()} ${path} placeholder chokepoint_id`);
    assert.ok(CURATED.chokepointIds.has(param.example), `${label}: chokepoint_id '${param.example}' is not registered`);
    const responseChokepointId = op.responses?.['200']?.content?.[JSON_MEDIA]?.example?.chokepointId;
    assert.equal(
      responseChokepointId,
      param.example,
      `${label}: ${method.toUpperCase()} ${path} chokepoint_id request and chokepointId response examples must match`,
    );
    checked++;
  }
  assert.ok(checked > 0, `${label}: expected ComputeEnergyShockScenario chokepoint example to check`);
}

function assertRouteIntelligenceHs2Example(spec, label) {
  let checked = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    if (op.operationId !== 'RouteIntelligence') continue;
    const param = (op.parameters ?? []).find((p) => p?.name === 'hs2');
    assert.ok(param, `${label}: ${method.toUpperCase()} ${path} missing hs2 parameter`);
    assert.equal(param.example, '27', `${label}: ${method.toUpperCase()} ${path} hs2 example must use the 2-digit default`);
    assert.match(String(param.example), /^\d{2}$/, `${label}: ${method.toUpperCase()} ${path} hs2 example must be two digits`);
    const cargoParam = (op.parameters ?? []).find((p) => p?.name === 'cargoType');
    assert.ok(cargoParam, `${label}: ${method.toUpperCase()} ${path} missing cargoType parameter`);
    assert.equal(cargoParam.example, 'container', `${label}: ${method.toUpperCase()} ${path} cargoType must keep the documented default`);
    const responseCargoType = op.responses?.['200']?.content?.[JSON_MEDIA]?.example?.cargoType;
    assert.equal(responseCargoType, cargoParam.example, `${label}: ${method.toUpperCase()} ${path} cargoType request/response examples must match`);
    checked++;
  }
  assert.ok(checked > 0, `${label}: expected RouteIntelligence hs2 example to check`);
}

function collectParamExamples(spec, label, operationId, paramName) {
  const found = [];
  for (const { path, method, op } of operationEntries(spec)) {
    if (op.operationId !== operationId) continue;
    const param = (op.parameters ?? []).find((p) => p?.name === paramName);
    assert.ok(param, `${label}: ${method.toUpperCase()} ${path} missing ${paramName} parameter`);
    const values = Array.isArray(param.example) ? param.example : [param.example];
    for (const value of values) found.push({ value, where: `${label} ${method.toUpperCase()} ${path} param ${paramName}` });
  }
  assert.ok(found.length > 0, `${label}: expected ${operationId}.${paramName} examples to check`);
  return found;
}

function assertParamExampleSet(specs, operationId, paramName, acceptedValues) {
  for (const [label, spec] of specs) {
    for (const { value, where } of collectParamExamples(spec, label, operationId, paramName)) {
      assert.notEqual(value, 'example', `${where}: placeholder example`);
      assert.notEqual(value, 'example1', `${where}: pattern-only placeholder example`);
      assert.ok(acceptedValues.has(value), `${where}: '${value}' is not an accepted example value`);
    }
  }
}

function normalizeClosedValue(value) {
  return String(value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/[),.;:]+$/g, '')
    .trim();
}

function splitClosedValueList(text) {
  return String(text)
    .replace(/\bor\b/g, ',')
    .replace(/\band\b/g, ',')
    .split(',')
    .map((part) => normalizeClosedValue(part))
    .filter((value) => value && value.toLowerCase() !== 'default' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value));
}

function closedValuesFromDescription(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return new Set();
  const match = text.match(
    /\b(?:one of|supported values?|valid values?|allowed values?|accepted values?)\b(?:\s*(?:are|is|:))?\s*([^.;]+)/i,
  ) ?? text.match(
    /\b(?:cabin class|stop filter|sort order|sort mode|summarization mode|fuel mode|policy category|status)\s*:\s*([^.;]+)/i,
  ) ?? text.match(/\bTopic ID\s*\(([^)]+)\)/i);
  if (!match) return new Set();
  const segment = match[1] ?? '';
  const quoted = [...segment.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return new Set(quoted.length > 0 ? splitClosedValueList(quoted.join(',')) : splitClosedValueList(segment));
}

function assertClosedValueParamExamples(spec, label) {
  let checked = 0;
  for (const { path, method, op } of operationEntries(spec)) {
    for (const param of op.parameters ?? []) {
      if (!param?.schema || param.in === 'header') continue;
      if (Array.isArray(param.schema.enum) && param.schema.enum.length > 0) continue;
      const accepted = closedValuesFromDescription(param.description ?? param.schema.description);
      if (accepted.size === 0) continue;
      const values = Array.isArray(param.example) ? param.example : [param.example];
      for (const value of values) {
        const where = `${label} ${method.toUpperCase()} ${path} param ${param.name}`;
        assert.notEqual(value, 'example', `${where}: placeholder example`);
        assert.notEqual(value, 'example1', `${where}: pattern-only placeholder example`);
        assert.ok(accepted.has(String(value)), `${where}: '${value}' is outside documented values ${[...accepted].join(', ')}`);
        checked++;
      }
    }
  }
  return checked;
}

function assertIssue4827Cluster7ResidueFixed(specs) {
  const cases = [
    {
      operationId: 'GetSectorSummary',
      paramName: 'period',
      accepted: new Set(['1d', '1w', '1m']),
    },
    {
      operationId: 'SearchGdeltDocuments',
      paramName: 'timespan',
      accepted: new Set(['15min', '1h', '24h']),
    },
    {
      operationId: 'GetTradeBarriers',
      paramName: 'measure_type',
      accepted: new Set(['SPS', 'TBT']),
    },
    {
      operationId: 'GetPopulationExposure',
      paramName: 'mode',
      accepted: new Set(['countries', 'exposure']),
    },
    {
      operationId: 'GetTheaterPosture',
      paramName: 'theater',
      accepted: new Set(['indo-pacific', 'european', 'middle-east']),
    },
  ];

  for (const { operationId, paramName, accepted } of cases) {
    let found = 0;
    for (const [label, spec] of specs) {
      if (!operationEntries(spec).some(({ op }) => op.operationId === operationId)) continue;
      for (const { value, where } of collectParamExamples(spec, label, operationId, paramName)) {
        assert.notEqual(value, 'example', `${where}: placeholder example`);
        assert.notEqual(value, 'daily', `${where}: generic period example is not documented`);
        assert.notEqual(value, 'all', `${where}: generic type example is not documented`);
        assert.notEqual(value, '2026-01-15T12:00:00Z', `${where}: datetime heuristic is not documented`);
        assert.ok(accepted.has(String(value)), `${where}: '${value}' is outside documented values ${[...accepted].join(', ')}`);
        found++;
      }
    }
    assert.ok(found > 0, `expected issue #4827 cluster-7 examples for ${operationId}.${paramName}`);
  }
}

function assertScenarioStatusPollExample(spec, label) {
  const example = spec.paths?.['/api/scenario/v1/get-scenario-status']?.get
    ?.responses?.['200']?.content?.[JSON_MEDIA]?.example;
  assert.ok(example && typeof example === 'object' && !Array.isArray(example), `${label}: missing get-scenario-status 200 example`);
  assert.ok(['pending', 'processing', 'done', 'failed'].includes(example.status), `${label}: impossible scenario status '${example.status}'`);
  if (example.status === 'done') {
    assert.ok(example.result && typeof example.result === 'object', `${label}: done status must include result`);
    assert.ok(!Object.hasOwn(example, 'error') || example.error === '', `${label}: done status must not include a populated error`);
    assert.ok(example.result.template && typeof example.result.template === 'object', `${label}: done result must include template`);
    assert.notEqual(example.result.template.name, 'WorldMonitor Analyst', `${label}: worker writes a template key, not a display name`);
    const affected = Array.isArray(example.result.affectedChokepointIds) ? example.result.affectedChokepointIds : [];
    for (const id of affected) {
      assert.ok(CURATED.chokepointIds.has(id), `${label}: affected chokepoint '${id}' is not registered`);
    }
    const expectedTemplateName = affected.length > 0 ? affected.join('+') : 'tariff_shock';
    assert.equal(example.result.template.name, expectedTemplateName, `${label}: template.name must match the worker template key`);
  } else if (example.status === 'failed') {
    assert.ok(typeof example.error === 'string' && example.error, `${label}: failed status must include error`);
    assert.ok(!Object.hasOwn(example, 'result'), `${label}: failed status must not include result`);
  } else {
    assert.ok(!Object.hasOwn(example, 'result'), `${label}: ${example.status} status must not include result`);
    assert.ok(!Object.hasOwn(example, 'error') || example.error === '', `${label}: ${example.status} status must not include a populated error`);
  }
}

// Honeypot fields are hidden anti-bot inputs (marked by a schema description
// containing "honeypot"). The handlers silently discard any non-empty value, so
// a populated request example is a fake-success trap and contradicts the field's
// own "real submissions leave it empty" description (#4768). Walk a request
// example against its schema and flag any populated honeypot-marked property.
function collectHoneypotViolations(example, schema, spec, label, seen = new Set()) {
  const violations = [];
  if (!schema || typeof schema !== 'object') return violations;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return violations;
    seen = new Set([...seen, schema.$ref]);
    schema = resolveSchema(schema, spec);
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) violations.push(...collectHoneypotViolations(example, part, spec, label, seen));
    return violations;
  }
  const type = schemaType(schema);
  if (type === 'object' && example && typeof example === 'object' && !Array.isArray(example)) {
    for (const [key, child] of Object.entries(example)) {
      const propSchema = schema.properties?.[key];
      if (!propSchema) continue;
      const resolved = propSchema.$ref ? resolveSchema(propSchema, spec) : propSchema;
      const description = String(resolved?.description ?? propSchema.description ?? '').toLowerCase();
      if (description.includes('honeypot')) violations.push(`${label}.${key}`);
      violations.push(...collectHoneypotViolations(child, propSchema, spec, `${label}.${key}`, seen));
    }
  } else if (type === 'array' && Array.isArray(example)) {
    for (const item of example) violations.push(...collectHoneypotViolations(item, schema.items ?? {}, spec, `${label}[]`, seen));
  }
  return violations;
}

function countHoneypotSchemaFields(spec) {
  let count = 0;
  for (const s of Object.values(spec.components?.schemas ?? {})) {
    for (const p of Object.values(s?.properties ?? {})) {
      if (String(p?.description ?? '').toLowerCase().includes('honeypot')) count++;
    }
  }
  return count;
}

function honeypotRequestViolations(spec, label) {
  const violations = [];
  for (const { path, method, op } of operationEntries(spec)) {
    const media = op.requestBody?.content?.[JSON_MEDIA];
    if (!media?.schema || media.example === undefined) continue;
    violations.push(
      ...collectHoneypotViolations(media.example, media.schema, spec, `${label} ${method.toUpperCase()} ${path} requestBody`),
    );
  }
  return violations;
}

describe('OpenAPI examples contract', () => {
  // Bump these exact surface counts when adding or removing proto services/RPCs.
  it('audits the known service operation surface', () => {
    assert.equal(serviceSpecs.length, 35, `expected 35 service specs, found ${serviceSpecs.length}`);
    const total = serviceSpecs.reduce((sum, file) => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      return sum + operationEntries(spec).length;
    }, 0);
    assert.equal(total, 195, `expected 195 OpenAPI operations, found ${total}`);
  });

  it('adds schema-valid request and response examples to every service JSON spec', () => {
    const totals = { operations: 0, requestExpected: 0, responseExpected: 0 };
    for (const file of serviceSpecs) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      const result = assertOperationExamples(spec, file);
      totals.operations += result.operations;
      totals.requestExpected += result.requestExpected;
      totals.responseExpected += result.responseExpected;
    }
    assert.equal(totals.operations, 195);
    assert.ok(totals.requestExpected >= 137, `expected at least 137 request example targets, found ${totals.requestExpected}`);
    assert.equal(totals.responseExpected, 195);
  });

  // record-baseline-snapshot's nested updates[].type is a bare string (no schema
  // enum), so the field-name heuristic used to emit 'all', which the handler
  // rejects (VALID_BASELINE_TYPES has no 'all'), silently skipping the update and
  // contradicting the 200 example. Guard the curated override against a regen
  // reverting it across the per-service JSON/YAML specs and unified bundle.
  it('uses a real accepted baseline type in the record-baseline-snapshot sample', () => {
    const contract = JSON.parse(
      readFileSync(resolve(root, 'shared/openapi-filter-param-contracts.json'), 'utf8'),
    );
    const validTypes = new Set(contract.infrastructureTemporalBaselineTypes ?? []);
    assert.ok(validTypes.size > 0, 'expected infrastructureTemporalBaselineTypes in the filter-param contract');

    const specs = [
      [
        'InfrastructureService.openapi.json',
        JSON.parse(readFileSync(resolve(apiDir, 'InfrastructureService.openapi.json'), 'utf8')),
      ],
      [
        'InfrastructureService.openapi.yaml',
        loadYaml(readFileSync(resolve(apiDir, 'InfrastructureService.openapi.yaml'), 'utf8')),
      ],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];

    for (const [label, spec] of specs) {
      assertRecordBaselineSampleTypes(spec, label, validTypes);
    }
  });

  it('adds request and response examples to every per-service YAML spec', () => {
    let operations = 0;
    for (const file of serviceSpecs) {
      const yamlFile = file.replace(/\.json$/, '.yaml');
      const spec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      operations += assertOperationExamples(spec, yamlFile).operations;
    }
    assert.equal(operations, 195);
  });

  it('adds request and response examples to the unified OpenAPI bundle', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    const result = assertOperationExamples(bundle, 'worldmonitor.openapi.yaml');
    assert.equal(result.operations, 195);
    assert.equal(result.responseExpected, 195);
  });

  // A honeypot field (hidden anti-bot input) is silently discarded by the
  // handlers when non-empty, so a populated request example is a fake-success
  // trap and contradicts the field's own "leave it empty" description (#4768).
  // The injector must drop honeypot-marked fields from every generated request
  // example across the JSON specs, per-service YAML, and unified bundle.
  it('omits honeypot fields from every request example', () => {
    const violations = [];
    let guardedFields = 0;
    for (const file of serviceSpecs) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      guardedFields += countHoneypotSchemaFields(spec);
      violations.push(...honeypotRequestViolations(spec, file));

      const yamlFile = file.replace(/\.json$/, '.yaml');
      const yamlSpec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      violations.push(...honeypotRequestViolations(yamlSpec, yamlFile));
    }
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    violations.push(...honeypotRequestViolations(bundle, 'worldmonitor.openapi.yaml'));

    assert.ok(guardedFields >= 2, `expected honeypot-marked schema fields to guard, found ${guardedFields}`);
    assert.deepEqual(violations, [], `request examples must omit honeypot fields; populated: ${violations.join(', ')}`);
  });

  it('the examples injector reports the specs as in-sync (idempotent)', () => {
    try {
      execFileSync('node', [resolve(root, 'scripts/openapi-inject-examples.mjs'), '--check'], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch (err) {
      const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || '';
      throw new Error(`openapi-inject-examples --check failed:\n${detail}`);
    }
  });
});

describe('OpenAPI curated example values', () => {
  // These parameters have accepted-value sets the field-name heuristic can't
  // infer; the injector's override map pins each to a real value the handlers
  // accept. Guards against a regression to a rejected placeholder.
  it('pins chokepoint / scenario / icao24 / FRED examples to accepted values', () => {
    const found = collectCuratedExamples();
    const byCat = (cat) => found.filter((f) => f.cat === cat);

    // chokepointId (4 SupplyChain params) + chokepointIds (register-webhook body).
    const chokepoints = byCat('chokepoint');
    assert.ok(chokepoints.length >= 5, `expected >=5 chokepoint id examples, found ${chokepoints.length}`);
    for (const f of chokepoints) {
      assert.notEqual(f.value, 'suez-canal', `${f.where}: 'suez-canal' is not a registry chokepoint id`);
      assert.ok(CURATED.chokepointIds.has(f.value), `${f.where}: chokepoint example '${f.value}' is not an accepted id`);
    }

    // scenarioId (run-scenario body) must be a registered SCENARIO_TEMPLATES id.
    const scenarios = byCat('scenario');
    assert.ok(scenarios.length >= 1, `expected >=1 scenario id example, found ${scenarios.length}`);
    for (const f of scenarios) {
      assert.notEqual(f.value, 'oil-price-shock', `${f.where}: 'oil-price-shock' is not a registered scenario template`);
      assert.ok(CURATED.scenarioIds.has(f.value), `${f.where}: scenario example '${f.value}' is not a SCENARIO_TEMPLATES id`);
    }

    // icao24 (3 params) + icao24s (aircraft-details-batch body) — lowercase 6-hex.
    const icaos = byCat('icao24');
    assert.ok(icaos.length >= 4, `expected >=4 icao24 examples, found ${icaos.length}`);
    for (const f of icaos) {
      assert.notEqual(f.value, 'example', `${f.where}: placeholder icao24`);
      assert.match(String(f.value), /^[0-9a-f]{6}$/, `${f.where}: icao24 example '${f.value}' is not a 6-hex Mode-S address`);
    }

    // series_id / seriesIds: FRED (no enum) needs a real series; BLS (enum) must stay valid.
    const series = byCat('series');
    const fred = series.filter((f) => f.opText.includes('fred'));
    const bls = series.filter((f) => !f.opText.includes('fred'));
    assert.ok(fred.length >= 2, `expected >=2 FRED series examples, found ${fred.length}`);
    for (const f of fred) {
      assert.ok(!['example', 'example-id'].includes(f.value), `${f.where}: placeholder FRED series id '${f.value}'`);
      assert.match(String(f.value), /^[A-Z][A-Z0-9._]*$/, `${f.where}: FRED series id '${f.value}' does not look like a real series`);
    }
    assert.ok(bls.length >= 1, `expected the BLS series_id example, found ${bls.length}`);
    for (const f of bls) {
      assert.ok(
        f.hasEnum && Array.isArray(f.enumValues) && f.enumValues.includes(f.value),
        `${f.where}: BLS series id '${f.value}' must stay within its schema enum`,
      );
    }
  });

  it('uses an ISO datetime example for webcam lastUpdated', () => {
    const spec = JSON.parse(readFileSync(resolve(apiDir, 'WebcamService.openapi.json'), 'utf8'));
    const example = spec.paths?.['/api/webcam/v1/get-webcam-image']?.get
      ?.responses?.['200']?.content?.[JSON_MEDIA]?.example?.lastUpdated;
    assert.equal(example, '2026-01-15T12:00:00.000Z');
  });

  it('uses accepted LLM providers in SummarizeArticle examples', () => {
    const specs = [
      ['NewsService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'NewsService.openapi.json'), 'utf8'))],
      ['NewsService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'NewsService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];

    for (const [label, spec] of specs) {
      assertSummarizeProviderExamples(spec, label);
    }
  });

  it('uses accepted closed-value parameter examples from prose descriptions', () => {
    assert.ok(CURATED.gdeltTopics.size > 0, 'expected seeded GDELT topic ids');
    assert.ok(CURATED.regionIds.size > 0, 'expected regional intelligence ids');
    assert.ok(CURATED.consumerRanges.size > 0, 'expected consumer-price ranges');
    assert.ok(CURATED.consumerBaskets.size > 0, 'expected consumer-price basket ids');

    const intelligenceSpecs = [
      ['IntelligenceService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.json'), 'utf8'))],
      ['IntelligenceService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];
    assertParamExampleSet(intelligenceSpecs, 'GetGdeltTopicTimeline', 'topic', CURATED.gdeltTopics);
    assertParamExampleSet(intelligenceSpecs, 'GetRegionalSnapshot', 'region_id', CURATED.regionIds);
    assertParamExampleSet(intelligenceSpecs, 'GetRegimeHistory', 'region_id', CURATED.regionIds);
    assertParamExampleSet(intelligenceSpecs, 'GetRegionalBrief', 'region_id', CURATED.regionIds);
    for (const [label, spec] of intelligenceSpecs) {
      assertComputeEnergyShockChokepointEcho(spec, label);
    }

    const consumerSpecs = [
      ['ConsumerPricesService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'ConsumerPricesService.openapi.json'), 'utf8'))],
      ['ConsumerPricesService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'ConsumerPricesService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];
    for (const operationId of ['GetConsumerPriceOverview', 'GetConsumerPriceBasketSeries', 'ListConsumerPriceCategories', 'ListRetailerPriceSpreads']) {
      assertParamExampleSet(consumerSpecs, operationId, 'basket_slug', CURATED.consumerBaskets);
    }
    for (const operationId of ['GetConsumerPriceBasketSeries', 'ListConsumerPriceCategories', 'ListConsumerPriceMovers']) {
      assertParamExampleSet(consumerSpecs, operationId, 'range', CURATED.consumerRanges);
    }

    const aviationSpecs = [
      ['AviationService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'AviationService.openapi.json'), 'utf8'))],
      ['AviationService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'AviationService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];
    const flightOps = ['SearchGoogleFlights', 'SearchGoogleDates'];
    for (const operationId of flightOps) {
      assertParamExampleSet(aviationSpecs, operationId, 'cabin_class', new Set(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']));
      assertParamExampleSet(aviationSpecs, operationId, 'max_stops', new Set(['ANY', 'NON_STOP', 'ONE_STOP', 'TWO_PLUS_STOPS']));
      assertParamExampleSet(aviationSpecs, operationId, 'departure_window', new Set(['6-20']));
      for (const [label, spec] of aviationSpecs) {
        for (const { value, where } of collectParamExamples(spec, label, operationId, 'airlines')) {
          assert.notEqual(value, 'example', `${where}: placeholder airline`);
          assert.notEqual(value, 'JFK', `${where}: airport-code placeholder is not an airline`);
          assert.notEqual(value, 'LHR', `${where}: airport-code placeholder is not an airline`);
          assert.match(String(value), /^[A-Z0-9]{2}$/, `${where}: airline example '${value}' must be an IATA airline code`);
        }
      }
    }
    assertParamExampleSet(aviationSpecs, 'SearchGoogleFlights', 'sort_by', new Set(['CHEAPEST', 'DURATION', 'DEPARTURE_TIME', 'ARRIVAL_TIME']));

    const newsSpecs = [
      ['NewsService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'NewsService.openapi.json'), 'utf8'))],
      ['NewsService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'NewsService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];
    for (const [label, spec] of newsSpecs) {
      const mode = spec.paths?.['/api/news/v1/summarize-article']?.post
        ?.requestBody?.content?.[JSON_MEDIA]?.example?.mode;
      assert.ok(['brief', 'analysis', 'translate'].includes(mode), `${label}: summarize-article mode '${mode}' is not documented`);
    }

    for (const [label, spec] of consumerSpecs) {
      assertConsumerPriceResponseRanges(spec, label);
    }
  });

  it('keeps prose-enumerated parameter examples inside their documented closed sets', () => {
    let checked = 0;
    for (const file of serviceSpecs) {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      checked += assertClosedValueParamExamples(spec, file);

      const yamlFile = file.replace(/\.json$/, '.yaml');
      const yamlSpec = loadYaml(readFileSync(resolve(apiDir, yamlFile), 'utf8'));
      checked += assertClosedValueParamExamples(yamlSpec, yamlFile);
    }
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    checked += assertClosedValueParamExamples(bundle, 'worldmonitor.openapi.yaml');
    assert.ok(checked >= 20, `expected at least 20 prose-enumerated parameter examples, checked ${checked}`);
  });

  it('keeps the issue #4827 cluster-7 residue examples inside their documented closed sets', () => {
    const specs = [
      ['MarketService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'MarketService.openapi.json'), 'utf8'))],
      ['MarketService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'MarketService.openapi.yaml'), 'utf8'))],
      ['IntelligenceService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.json'), 'utf8'))],
      ['IntelligenceService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'IntelligenceService.openapi.yaml'), 'utf8'))],
      ['TradeService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'TradeService.openapi.json'), 'utf8'))],
      ['TradeService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'TradeService.openapi.yaml'), 'utf8'))],
      ['DisplacementService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'DisplacementService.openapi.json'), 'utf8'))],
      ['DisplacementService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'DisplacementService.openapi.yaml'), 'utf8'))],
      ['MilitaryService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'MilitaryService.openapi.json'), 'utf8'))],
      ['MilitaryService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'MilitaryService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];
    assertIssue4827Cluster7ResidueFixed(specs);
  });

  it('uses a plausible get-scenario-status poll response example', () => {
    const specs = [
      ['ScenarioService.openapi.json', JSON.parse(readFileSync(resolve(apiDir, 'ScenarioService.openapi.json'), 'utf8'))],
      ['ScenarioService.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'ScenarioService.openapi.yaml'), 'utf8'))],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];

    for (const [label, spec] of specs) {
      assertScenarioStatusPollExample(spec, label);
    }
  });

  it('uses a two-digit hs2 example for RouteIntelligence', () => {
    const specs = [
      [
        'ShippingV2Service.openapi.json',
        JSON.parse(readFileSync(resolve(apiDir, 'ShippingV2Service.openapi.json'), 'utf8')),
      ],
      [
        'ShippingV2Service.openapi.yaml',
        loadYaml(readFileSync(resolve(apiDir, 'ShippingV2Service.openapi.yaml'), 'utf8')),
      ],
      ['worldmonitor.openapi.yaml', loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'))],
    ];

    for (const [label, spec] of specs) {
      assertRouteIntelligenceHs2Example(spec, label);
    }
  });
});
