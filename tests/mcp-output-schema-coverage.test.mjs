// Parity test for the per-tool spec `outputSchema` field (v1.6.0).
//
// Covers:
//   1. Every tool in TOOL_REGISTRY declares a non-empty outputSchema with at
//      least one key on outputSchema.properties. Failures name the tool so a
//      future PR adding a tool without an outputSchema fails loudly.
//   2. Every fixture in tests/fixtures/jmespath-samples/ validates against the
//      schema declared by the tool that produced it. Drift between declared
//      schema and the real response shape fails the test by tool name.
//   3. The reverse direction of 2: no tool may declare a list-item field that
//      is absent from every captured row. Schema validation alone cannot see
//      this — `properties` without `required` admits a payload that omits a
//      declared key, which is how get_market_data advertised `changePercent`
//      while every seeder wrote `change`.
//   4. tools/list emits outputSchema on every advertised tool — surfacing the
//      field at the wire boundary in addition to the in-process registry.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validate } from './helpers/json-schema-mini.mjs';
import { buildProducerBackedMarketFixture } from './helpers/mcp-producer-fixtures.mjs';

const VALID_KEY = 'wm_test_key_output_schema';
const originalEnv = { ...process.env };

async function freshMod() {
  return import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
}

describe('api/mcp.ts — per-tool outputSchema coverage (v1.7.0)', () => {
  let mod;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    mod = await freshMod();
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // --------------------------------------------------------------------
  // Test 1 — every tool declares a non-empty outputSchema
  // --------------------------------------------------------------------
  // For cache tools (those with no `_execute`), the envelope helper
  // `cacheEnvelope(dataProperties)` always produces a top-level
  // `properties: { cached_at, stale, data }` — so a "≥1 top-level key"
  // check would pass even for `cacheEnvelope({})` with an empty data map.
  // Drill into `properties.data.properties` for envelope-style tools to
  // catch that foot-gun and ensure the load-bearing per-tool data shape is
  // actually described.
  it('every tool in TOOL_REGISTRY declares a non-empty outputSchema with at least one properties key (and, for cache tools, at least one data.properties key)', () => {
    const registry = mod.__testing__.TOOL_REGISTRY ?? [];
    assert.ok(registry.length > 0, 'TOOL_REGISTRY extraction must not be empty');
    assert.equal(
      new Set(registry.map((tool) => tool.name)).size,
      registry.length,
      'TOOL_REGISTRY tool identities must be unique',
    );
    const failures = [];
    for (const tool of registry) {
      const schema = tool.outputSchema;
      if (!schema || typeof schema !== 'object') {
        failures.push(`${tool.name}: outputSchema missing or non-object`);
        continue;
      }
      const props = schema.properties;
      if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
        failures.push(`${tool.name}: outputSchema.properties is empty`);
        continue;
      }
      // Cache tool ⇔ no `_execute`. For these, the top-level shape is the
      // uniform envelope; the per-tool description lives in data.properties.
      const isCacheTool = tool._execute === undefined;
      if (isCacheTool) {
        const dataProps = props.data?.properties;
        if (!dataProps || typeof dataProps !== 'object' || Object.keys(dataProps).length === 0) {
          failures.push(`${tool.name}: cache tool outputSchema.properties.data.properties is empty (cacheEnvelope was called with an empty data map)`);
        }
      }
    }
    assert.deepEqual(failures, [], `tools missing outputSchema:\n  ${failures.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 2 — every captured fixture validates against its tool's schema
  // --------------------------------------------------------------------
  // tests/fixtures/jmespath-samples/README.md maps each fixture file to a tool.
  // Drift between declared schema and the real response shape fails by tool.
  const FIXTURES = [
    { file: 'fat-get-market-data.response.json', tool: 'get_market_data' },
    { file: 'medium-get-conflict-events.response.json', tool: 'get_conflict_events' },
    { file: 'thin-get-chokepoint-status.response.json', tool: 'get_chokepoint_status' },
  ];
  for (const { file, tool: toolName } of FIXTURES) {
    it(`${toolName} declared outputSchema validates the captured fixture (${file})`, () => {
      const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
      const fixturePath = path.join(fixtureDir, 'fixtures', 'jmespath-samples', file);
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      const errors = validate(tool.outputSchema, fixture);
      assert.deepEqual(errors, [], `fixture ${file} fails schema:\n  ${errors.join('\n  ')}`);
    });
  }

  it('get_market_data schema validates a deterministic producer-backed fixture', () => {
    const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
    const captured = JSON.parse(readFileSync(
      path.join(fixtureDir, 'fixtures', 'jmespath-samples', 'fat-get-market-data.response.json'),
      'utf8',
    ));
    const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === 'get_market_data');
    assert.ok(tool, 'tool get_market_data not found in registry');
    const errors = validate(tool.outputSchema, buildProducerBackedMarketFixture(captured));
    assert.deepEqual(errors, [], `producer-backed market fixture fails schema:\n  ${errors.join('\n  ')}`);
  });

  it('interactive cache-tool schemas declare the authoritative fields consumed by their apps', () => {
    const dataProperties = (toolName) => {
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      return tool.outputSchema.properties.data.properties;
    };

    const newsStory = dataProperties('get_news_intelligence').insights.properties.topStories.items.properties;
    assert.ok(newsStory.primaryTitle, 'news schema must declare primaryTitle');
    assert.ok(newsStory.primarySource, 'news schema must declare primarySource');
    assert.ok(newsStory.threatLevel, 'news schema must declare threatLevel');
    assert.deepEqual(newsStory.sourceProvenance.required, [
      'risk', 'type', 'riskDeclared', 'typeDeclared', 'riskReviewed', 'typeReviewed',
    ]);
    assert.deepEqual(newsStory.sourceProvenance.properties.risk.enum, [
      'low', 'medium', 'high', 'unknown',
    ]);
    assert.deepEqual(newsStory.sourceProvenance.properties.type.enum, [
      'wire', 'gov', 'intel', 'mainstream', 'market', 'tech', 'other', 'unknown',
    ]);
    assert.ok(newsStory.sourceProvenance.properties.stateAffiliated);
    assert.deepEqual(newsStory.countryCode.type, ['string', 'null']);
    assert.equal(newsStory.title, undefined, 'news schema must not advertise the drifted title field');
    assert.equal(newsStory.summary, undefined, 'news schema must not advertise the drifted summary field');

    // #4925 item 3: get_news_intelligence is a cache tool, so the raw
    // news:insights:v1 blob is served and _postFilter only narrows and caps.
    // Every field below is written by scripts/seed-insights.mjs and already
    // reaches the client; the schema simply did not admit to them, which left
    // an agent unable to weigh how well-corroborated a story is.
    for (const field of [
      'uniqueSourceCount', 'sources', 'memberTitles', 'lastUpdated', 'sourceTier',
      'entityCorroboration', 'corroborationSourceCount',
      'upstreamImportanceScore', 'effectiveImportanceScore', 'credibilityScore',
    ]) {
      assert.ok(newsStory[field], `news schema must declare ${field} (served by scripts/seed-insights.mjs)`);
    }
    assert.equal(
      newsStory.sources.items.type,
      'string',
      'topStories[].sources is a list of outlet names, not the citation records get_world_brief serves under the same key',
    );

    // The two brief tools emit corroboration too, and had no served-shape
    // enforcement at all before #4925. Assert the declarations here so a
    // schema-versus-emit divergence is caught even if the behavioural suites
    // (mcp-world-brief-corroboration, mcp-country-brief-grounding) are edited.
    const rpcTool = (toolName) => {
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      return tool;
    };

    const worldStory = rpcTool('get_world_brief').outputSchema.properties.topStories.items.properties;
    for (const field of [
      'title', 'sourceCount', 'uniqueSourceCount', 'corroborationSourceCount',
      'entityCorroboration', 'sourceTier', 'sources',
    ]) {
      assert.ok(worldStory[field], `get_world_brief topStories must declare ${field}`);
    }
    assert.equal(
      worldStory.memberTitles,
      undefined,
      'get_world_brief deliberately omits memberTitles on output-budget grounds; declaring it would promise bytes the projector does not send',
    );

    const grounding = rpcTool('get_country_brief').outputSchema.properties.groundingStories.items.properties;
    for (const field of ['title', 'source', 'corroborationCount', 'mentionCount', 'storyPhase']) {
      assert.ok(grounding[field], `get_country_brief groundingStories must declare ${field}`);
    }
    assert.deepEqual(grounding.storyPhase.enum, [
      'STORY_PHASE_UNSPECIFIED', 'STORY_PHASE_BREAKING', 'STORY_PHASE_DEVELOPING',
      'STORY_PHASE_SUSTAINED', 'STORY_PHASE_FADING',
    ]);

    const disasters = dataProperties('get_natural_disasters');
    const earthquake = disasters.earthquakes.properties.earthquakes.items.properties;
    assert.ok(earthquake.occurredAt, 'earthquake schema must declare occurredAt');
    assert.ok(earthquake.depthKm, 'earthquake schema must declare depthKm');
    assert.ok(earthquake.location.properties.latitude, 'earthquake latitude must be nested under location');
    assert.equal(earthquake.time, undefined, 'earthquake schema must not advertise the drifted time field');
    assert.equal(earthquake.latitude, undefined, 'earthquake schema must not advertise a flat latitude');

    const fire = disasters.fires.properties.fireDetections.items.properties;
    assert.ok(fire.location.properties.longitude, 'fire longitude must be nested under location');
    assert.ok(fire.region, 'fire schema must declare region');
    assert.deepEqual(fire.confidence.enum, [
      'FIRE_CONFIDENCE_HIGH',
      'FIRE_CONFIDENCE_NOMINAL',
      'FIRE_CONFIDENCE_LOW',
      'FIRE_CONFIDENCE_UNSPECIFIED',
    ]);
    assert.equal(fire.latitude, undefined, 'fire schema must not advertise a flat latitude');

    const markets = dataProperties('get_prediction_markets')['markets-bootstrap'].properties;
    for (const bucket of ['geopolitical', 'tech', 'finance']) {
      const market = markets[bucket].items.properties;
      assert.deepEqual(
        { type: market.yesPrice.type, minimum: market.yesPrice.minimum, maximum: market.yesPrice.maximum },
        { type: 'number', minimum: 0, maximum: 100 },
        `${bucket} must declare yesPrice on its authoritative 0-100 scale`,
      );
      assert.equal(market.probability, undefined, `${bucket} must not advertise the drifted probability field`);
    }

    // get_market_data advertised `changePercent` on all five quote
    // lists and `flow` on ETF rows; the seeders write `change` (a percent --
    // scripts/shared/market-quote-provider.mjs maps Finnhub `dp`) and
    // `estFlow` (scripts/seed-etf-flows.mjs). Every agent projecting per the
    // schema's own hint got null for every row.
    const marketData = dataProperties('get_market_data');
    const quoteLists = [
      ['stocks-bootstrap', 'quotes'],
      ['commodities-bootstrap', 'quotes'],
      ['crypto', 'quotes'],
      ['gulf-quotes', 'quotes'],
      ['sectors', 'sectors'],
    ];
    for (const [section, list] of quoteLists) {
      const row = marketData[section].properties[list].items.properties;
      assert.ok(row.change, `${section}.${list}[] must declare the served \`change\` key`);
      assert.equal(
        row.changePercent, undefined,
        `${section}.${list}[] must not advertise the drifted changePercent field`,
      );
    }
    const etfRow = marketData['etf-flows'].properties.etfs.items.properties;
    assert.ok(etfRow.estFlow, 'etf-flows.etfs[] must declare the served `estFlow` key');
    assert.equal(etfRow.flow, undefined, 'etf-flows.etfs[] must not advertise the drifted flow field');
  });

  // --------------------------------------------------------------------
  // Test 2c — no declared list-item field is absent from EVERY captured row
  // --------------------------------------------------------------------
  // Test 2 validates the fixture against the schema, which is a one-way check:
  // JSON Schema `properties` without `required` admits a payload that omits a
  // declared key entirely, so "schema promises changePercent, seeder writes
  // change" validated clean in both directions for this tool's whole life.
  //
  // This is the missing direction. Scoped to ARRAY ROWS because list rows are
  // homogeneous -- a declared row field served on 0 of N rows is a phantom the
  // agent will project to null, whereas envelope-level flags (`rateLimited`,
  // `currentValuationCount`, `unavailable`) are legitimately omit-when-absent
  // and are deliberately not covered here.
  //
  // Pre-existing phantoms outside this fix's blast radius are listed explicitly
  // rather than silently skipped, so the count can only go down. Each is the
  // same defect class -- schema key never written by the producer:
  const KNOWN_PHANTOM_ROW_FIELDS = new Set([
    // Serves `locationName` (+ latitude/longitude) -- scripts/seed-iran-events.mjs.
    'get_conflict_events.data.iran-events.events[].country',
    'get_conflict_events.data.iran-events.events[].location',
    // Serves staticBaseline/dynamicScore/combinedScore, never a flat `score`.
    'get_conflict_events.data.scores.ciiScores[].score',
    // Baseline rows serve id/name/mbd/lat/lon; `relayId` is also read by the
    // tool's own `chokepoint` filter, so aligning it is a behaviour decision,
    // not a rename.
    'get_chokepoint_status.data.chokepoint-baselines.chokepoints[].relayId',
  ]);

  // Walks the schema alongside the values actually observed at each node, so
  // the row check runs wherever a fixture supplies rows -- not just at paths
  // this test hardcodes.
  function collectPhantomRowFields(schema, values, path, out) {
    if (!schema || typeof schema !== 'object') return;
    const objects = values.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
    const arrays = values.filter(Array.isArray);

    if (schema.properties && objects.length > 0) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        const observed = objects.map((o) => o[key]).filter((v) => v !== undefined && v !== null);
        if (observed.length > 0) collectPhantomRowFields(subSchema, observed, `${path}.${key}`, out);
      }
    }
    if (schema.items && arrays.length > 0) {
      const rows = arrays.flat().filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (rows.length === 0) return;
      const served = new Set();
      for (const row of rows) for (const key of Object.keys(row)) served.add(key);
      for (const key of Object.keys(schema.items.properties ?? {})) {
        if (!served.has(key)) out.push({ field: `${path}[].${key}`, rows: rows.length });
      }
      collectPhantomRowFields(schema.items, rows, `${path}[]`, out);
    }
  }

  for (const { file, tool: toolName } of FIXTURES) {
    it(`${toolName} declares no list-item field that is absent from every captured row (${file})`, () => {
      const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
      const fixture = JSON.parse(
        readFileSync(path.join(fixtureDir, 'fixtures', 'jmespath-samples', file), 'utf8'),
      );
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);

      const found = [];
      collectPhantomRowFields(tool.outputSchema, [fixture], toolName, found);
      const unexpected = found.filter(({ field }) => !KNOWN_PHANTOM_ROW_FIELDS.has(field));
      assert.deepEqual(
        unexpected.map(({ field, rows }) => `${field} (served on 0 of ${rows} rows)`),
        [],
        `${toolName} advertises row fields the captured payload never serves — an agent projecting ` +
        'them gets null for every row. Align the schema to the producer, or the producer to the schema.',
      );

      // A fixed phantom must leave the allowlist, or the list rots into cover
      // for the next regression.
      const stillListed = new Set(found.map(({ field }) => field));
      const staleAllowlist = [...KNOWN_PHANTOM_ROW_FIELDS]
        .filter(field => field.startsWith(`${toolName}.`) && !stillListed.has(field));
      assert.deepEqual(
        staleAllowlist, [],
        'KNOWN_PHANTOM_ROW_FIELDS entries are no longer phantom — delete them from the allowlist',
      );
    });
  }

  // --------------------------------------------------------------------
  // Test 3 — outputSchema is emitted on the wire for every tool in tools/list
  // --------------------------------------------------------------------
  // Unconditional emit per decision-point-1 — we want LLM clients to see the
  // schema on 2025-03-26 sessions too (clients ignore unknown fields per spec).
  it('tools/list emits outputSchema on every tool, regardless of MCP_PROTOCOL_FLOOR_2025_06_18', async () => {
    const res = await mod.default(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const tools = body.result?.tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      mod.__testing__.TOOL_REGISTRY.map((tool) => tool.name).sort(),
      'tools/list names must match TOOL_REGISTRY exactly',
    );
    const missing = tools.filter(t => !t.outputSchema || typeof t.outputSchema !== 'object'
      || !t.outputSchema.properties || Object.keys(t.outputSchema.properties).length === 0)
      .map(t => t.name);
    assert.deepEqual(missing, [], `tools on the wire missing outputSchema:\n  ${missing.join('\n  ')}`);
  });

  // --------------------------------------------------------------------
  // Test 4 — buildPublicTool returns a deep-clone, NOT a reference into the
  // module-level outputSchema literal. Mutating the returned object must not
  // corrupt the registry's source-of-truth schema for the next caller.
  // --------------------------------------------------------------------
  it('buildPublicTool deep-clones outputSchema', () => {
    const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === 'get_market_data');
    const pub = mod.buildPublicTool(tool, { compressDescriptions: true });
    assert.notEqual(pub.outputSchema, tool.outputSchema, 'should not be the same object');
    // Mutate the public copy and confirm the registry value is unchanged.
    pub.outputSchema.poisoned = true;
    assert.equal('poisoned' in tool.outputSchema, false, 'mutation leaked back into TOOL_REGISTRY');
  });

  // --------------------------------------------------------------------
  // Test 5 — verbatim-passthrough parity against the generated OpenAPI spec.
  //
  // Every tool below ends its `_execute` in `return res.json()`, so the
  // gateway response reaches the caller byte-for-byte. The gateway
  // `JSON.stringify`s the proto-generated struct with no case conversion,
  // which makes docs/api/*.openapi.json the response contract for this class.
  // A declared outputSchema property that does not exist there is advertised
  // fiction.
  //
  // This is the seam that was missing when get_country_risk shipped a schema
  // sharing ZERO field names with its response: it promised snake_case
  // `country_code` / a numeric `cii` / `components{unrest,conflict,security,
  // news}` / `travelAdvisory` / `sanctionsExposure` against a camelCase
  // `countryCode` / `cii: CiiScore` / `cii.components{ciiContribution,
  // geoConvergence, militaryActivity, newsActivity}` / `advisoryLevel` /
  // `sanctionsActive`+`sanctionsCount` wire shape. Every read came back null,
  // so the MCP-Apps widget rendered active OFAC sanctions as "None" and an
  // all-upstreams-down response as a calm country. The RPC arm of
  // mcp-tool-output-contracts could not catch it: it stubs `_execute` with a
  // minimal shape derived from the same declaration, so the fiction validated
  // against itself.
  //
  // Tools that reshape inside `_execute` are deliberately out of scope — the
  // gateway response is not what they return.
  // --------------------------------------------------------------------
  // `generate_forecasts` is verbatim too but declares `_apiPaths: []`, so it
  // has no OpenAPI operation to check against and cannot be listed here.
  const VERBATIM_PASSTHROUGH_TOOLS = [
    'analyze_situation',
    'get_country_risk',
    'get_defense_industrial_base',
    'get_demographics_capability',
    'get_food_stocks',
    'get_intel_timeline',
    'get_mineral_production',
    'get_resilience_indicators',
    'get_similar_events',
    'list_five_factor_scorecards',
    'search_flight_prices_by_date',
    'search_flights',
    'search_intel_history',
  ];

  // Pre-existing instances of the same defect, recorded rather than hidden.
  // Each entry pins the EXACT drift, not merely "drifts somehow": a bare
  // non-empty check would let a tool delete one fabricated field, add a
  // different one, and stay "justified" — shipping new fiction on a tool the
  // guard nominally covers. Movement in either direction reds instead, so an
  // entry cannot rot into a blanket exemption.
  const KNOWN_DRIFT = new Map([
    ['analyze_situation', {
      why: 'DeductSituationResponse is {analysis, model, provider}',
      names: ['deduction', 'confidence', 'signals', 'framework', 'generatedAt'],
      types: [],
    }],
    ['search_flights', {
      why: 'SearchGoogleFlightsResponse carries degraded/error/flights',
      names: ['search_metadata', 'flights[].currency', 'flights[].airline', 'flights[].total_duration', 'flights[].segments'],
      types: [],
    }],
    ['search_flight_prices_by_date', {
      why: 'SearchGoogleDatesResponse carries dates/degraded/error',
      names: ['prices', 'search_metadata'],
      types: [],
    }],
  ]);

  function loadOpenApiOperations() {
    const specsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'api');
    const operations = new Map();
    for (const file of readdirSync(specsDir).filter(f => f.endsWith('.openapi.json'))) {
      const spec = JSON.parse(readFileSync(path.join(specsDir, file), 'utf8'));
      for (const [route, methods] of Object.entries(spec.paths ?? {})) {
        for (const [method, op] of Object.entries(methods ?? {})) {
          operations.set(`${method.toUpperCase()} ${route}`, { op, spec });
        }
      }
    }
    return operations;
  }

  function deref(schema, spec) {
    const seen = new Set();
    while (schema?.$ref) {
      if (seen.has(schema.$ref)) return null;
      seen.add(schema.$ref);
      schema = spec.components?.schemas?.[schema.$ref.replace('#/components/schemas/', '')];
    }
    return schema ?? null;
  }

  // Resolve the 200 JSON response schema through its $ref chain and return its
  // properties, each dereferenced so a $ref'd field carries a type and its own
  // nested properties. Arrays are resolved through `items` as well: flight
  // responses carry their load-bearing contract inside array elements. `unresolved`
  // names any $ref that did not resolve: those would otherwise become untyped
  // `{}` and silently turn a real mismatch into a pass, so the caller asserts
  // the list is empty rather than shrinking coverage quietly.
  function wireResponseProperties({ op, spec }) {
    const schema = deref(op?.responses?.['200']?.content?.['application/json']?.schema, spec);
    if (!schema?.properties) return null;
    const unresolved = [];
    const resolve = (node, path) => {
      const target = deref(node, spec);
      if (!target) {
        unresolved.push(path || '<root>');
        return {};
      }
      const out = {};
      if (target.type === 'array' && target.items) {
        out.type = 'array';
        out.items = resolve(target.items, `${path}[]`);
        return { ...target, ...out };
      }
      for (const [key, sub] of Object.entries(target.properties ?? {})) {
        const here = path ? `${path}.${key}` : key;
        out[key] = resolve(sub, here);
      }
      return { ...target, properties: out };
    };
    return { properties: resolve(schema, '').properties ?? {}, unresolved };
  }

  // The two comparisons the population loop and the positive control below
  // both run through, so a control cannot pass against a copy of the rule.
  // Both recurse through objects and arrays: the load-bearing content of the
  // get_country_risk schema is nested (cii.combinedScore, cii.components.*),
  // and flight contracts put their fields under array items. A top-level-only
  // check would leave both subtrees unanchored.
  function declaredButNotOnWire(outputSchema, wireProps, path = '') {
    const drift = [];
    for (const [key, declared] of Object.entries(outputSchema?.properties ?? {})) {
      const here = path ? `${path}.${key}` : key;
      const wire = wireProps[key];
      if (!wire) { drift.push(here); continue; }
      if (declared?.type === 'array' && wire.type === 'array') {
        if (declared.items && wire.items) {
          drift.push(...declaredButNotOnWire({ properties: declared.items.properties }, wire.items.properties, `${here}[]`));
        }
        continue;
      }
      if (declared?.properties && wire.properties) {
        drift.push(...declaredButNotOnWire(declared, wire.properties, here));
      }
    }
    return drift;
  }

  // Name parity alone would have missed half the get_country_risk bug: `cii`
  // exists on the wire, but as a CiiScore object against a declared
  // ['number','null']. Compare types wherever both sides state one.
  function declaredTypeMismatches(outputSchema, wireProps, path = '') {
    const mismatches = [];
    for (const [key, declared] of Object.entries(outputSchema?.properties ?? {})) {
      const here = path ? `${path}.${key}` : key;
      const wire = wireProps[key];
      if (!wire) continue;
      const wireType = wire.type;
      if (wireType && declared?.type) {
        // `null` is a legitimate declaration widening: proto scalars are absent
        // rather than null, but a tool may still admit null for a missing field.
        const declaredTypes = (Array.isArray(declared.type) ? declared.type : [declared.type])
          .filter(t => t !== 'null');
        const compatible = declaredTypes.length === 0 || declaredTypes.some(t => t === wireType
          || (t === 'number' && wireType === 'integer')
          || (t === 'integer' && wireType === 'number'));
        if (!compatible) {
          mismatches.push(`${here}: declared ${JSON.stringify(declared.type)}, wire is ${JSON.stringify(wireType)}`);
        }
      }
      if (declared?.type === 'array' && wire.type === 'array' && declared.items && wire.items) {
        mismatches.push(...declaredTypeMismatches(
          { properties: declared.items.properties },
          wire.items.properties,
          `${here}[]`,
        ));
        continue;
      }
      if (declared?.properties && wire.properties) {
        mismatches.push(...declaredTypeMismatches(declared, wire.properties, here));
      }
    }
    return mismatches;
  }

  // The missing direction. Declared-but-not-on-wire catches invented fields;
  // this catches a REMOVED one. `upstreamUnavailable` is the field this whole
  // guard exists to protect — drop it from the schema and an agent silently
  // loses the outage-versus-calm distinction, with every other check green.
  const SAFETY_FLAG = /degraded|unavailable|stale|error|partial/i;
  function undeclaredSafetyFlags(outputSchema, wireProps) {
    const declared = new Set(Object.keys(outputSchema?.properties ?? {}));
    return Object.keys(wireProps).filter(k => SAFETY_FLAG.test(k) && !declared.has(k));
  }

  for (const toolName of VERBATIM_PASSTHROUGH_TOOLS) {
    it(`${toolName} declares only fields its OpenAPI response actually carries`, () => {
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      assert.equal(typeof tool._execute, 'function', `${toolName} is listed as an RPC passthrough but has no _execute`);
      assert.equal(
        (tool._apiPaths ?? []).length, 1,
        `${toolName} must declare exactly one _apiPaths entry to be checked against a single OpenAPI operation`,
      );

      const entry = loadOpenApiOperations().get(tool._apiPaths[0].replace(/\s+/g, ' ').trim());
      assert.ok(entry, `${toolName}: no OpenAPI operation for "${tool._apiPaths[0]}"`);
      const wire = wireResponseProperties(entry);
      assert.ok(wire, `${toolName}: OpenAPI operation declares no resolvable 200 JSON response schema`);
      // An unresolvable $ref would become an untyped {} and quietly make that
      // property unverifiable — shrink coverage loudly, never silently.
      assert.deepEqual(
        wire.unresolved, [],
        `${toolName}: OpenAPI response has unresolvable $refs, so these fields cannot be checked: ${JSON.stringify(wire.unresolved)}`,
      );

      const drift = declaredButNotOnWire(tool.outputSchema, wire.properties);
      const mismatches = declaredTypeMismatches(tool.outputSchema, wire.properties);
      // Safety flags are never part of a name/type exemption. A known drift
      // entry may pin legacy data fields, but it must not bypass the outage
      // discriminator check that protects downstream readers.
      assert.deepEqual(
        undeclaredSafetyFlags(tool.outputSchema, wire.properties), [],
        `${toolName}'s response carries a degraded-state flag its outputSchema never declares. An agent cannot ` +
          'distinguish "no data" from "everything is fine" without it.',
      );
      const known = KNOWN_DRIFT.get(toolName);
      if (known) {
        assert.deepEqual(
          drift.slice().sort(), known.names.slice().sort(),
          `${toolName}'s recorded drift moved (${known.why}). Update or delete its KNOWN_DRIFT entry — an entry that ` +
            'no longer describes the actual drift is no longer a justified exemption.',
        );
        assert.deepEqual(
          mismatches.slice().sort(), known.types.slice().sort(),
          `${toolName}'s recorded type drift moved (${known.why}). Update or delete its KNOWN_DRIFT entry.`,
        );
        return;
      }
      assert.deepEqual(
        drift, [],
        `${toolName} declares outputSchema properties that its response does not carry: ${JSON.stringify(drift)}\n` +
          `  wire properties: ${JSON.stringify(Object.keys(wire.properties))}\n` +
          '  `_execute` returns res.json() verbatim, so an agent reading these gets null.',
      );
      assert.deepEqual(
        mismatches, [],
        `${toolName} declares outputSchema property types its response contradicts:\n  ${mismatches.join('\n  ')}`,
      );

    });
  }

  // The list above is hand-written, so an omission is silent: a new tool that
  // returns the gateway response verbatim would simply never be checked, which
  // is how this defect class survives. Derive the candidate set mechanically
  // and require the list to match it exactly, so adding such a tool without
  // enrolling it fails here instead of shipping unguarded.
  // Matches a tail-position `return res.json()` — the whole definition of
  // "verbatim". Read against the TRANSPILED function body, which drops the
  // trailing semicolon (`return res.json()}`), so both forms are accepted. If
  // a future transpiler reshapes this further the set collapses toward empty
  // and the assertion fails loudly rather than quietly covering nothing.
  const RETURNS_RESPONSE_VERBATIM = /return\s+(?:res|response)\.json\(\)\s*;?\s*\}\s*$/;

  it('VERBATIM_PASSTHROUGH_TOOLS enrolls every RPC tool that returns the gateway response verbatim', () => {
    const candidates = mod.__testing__.TOOL_REGISTRY
      .filter(t => typeof t._execute === 'function'
        && RETURNS_RESPONSE_VERBATIM.test(t._execute.toString())
        // A tool with no single declared OpenAPI operation has no contract to
        // check against; `generate_forecasts` declares `_apiPaths: []`.
        && (t._apiPaths ?? []).length === 1)
      .map(t => t.name)
      .sort();

    // Floor first: without it, the way to clear a red from a transpiler
    // reshape is to empty the hand list too, at which point deepEqual([], [])
    // passes and every per-tool guard above vanishes with nothing failing.
    assert.ok(
      candidates.length >= 10,
      `only ${candidates.length} verbatim-passthrough tools were derived from the registry — the detection regex ` +
        'has stopped matching. Fix the regex; do NOT empty VERBATIM_PASSTHROUGH_TOOLS to match, which would ' +
        'silently delete every per-tool parity check.',
    );
    assert.deepEqual(
      [...VERBATIM_PASSTHROUGH_TOOLS].sort(),
      candidates,
      'VERBATIM_PASSTHROUGH_TOOLS is out of step with the registry — add the newly-listed tool(s) so their ' +
        'declared outputSchema is checked against the OpenAPI response, or remove any that no longer ' +
        'return res.json() verbatim.',
    );
  });

  // Verbatim-by-SPREAD: `_execute` returns `{ ...res.json(), <extra keys> }`,
  // so every response field still passes through unchanged and the same defect
  // class applies — but the tail-position regex above can never enrol it.
  // `get_country_brief` is exactly this, and it carried the same bug
  // (`country_code` against a camelCase wire, plus a declared `framework` and
  // `provider` the response never had). Guarding only the literal-return form
  // would leave the second half of that fix unprotected.
  //
  // `adds` lists the keys `_execute` layers on top; they are legitimately
  // absent from the wire, so they are subtracted before comparing.
  const SPREAD_PASSTHROUGH_TOOLS = new Map([
    ['get_country_brief', { adds: ['digestCoverage', 'groundingStories'] }],
  ]);

  for (const [toolName, { adds }] of SPREAD_PASSTHROUGH_TOOLS) {
    it(`${toolName} declares only fields its OpenAPI response carries, plus its own additions`, () => {
      const tool = mod.__testing__.TOOL_REGISTRY.find(t => t.name === toolName);
      assert.ok(tool, `tool ${toolName} not found in registry`);
      assert.equal(
        (tool._apiPaths ?? []).length, 1,
        `${toolName} must declare exactly one _apiPaths entry to be checked against a single OpenAPI operation`,
      );

      const entry = loadOpenApiOperations().get(tool._apiPaths[0].replace(/\s+/g, ' ').trim());
      assert.ok(entry, `${toolName}: no OpenAPI operation for "${tool._apiPaths[0]}"`);
      const wire = wireResponseProperties(entry);
      assert.ok(wire, `${toolName}: OpenAPI operation declares no resolvable 200 JSON response schema`);
      assert.deepEqual(wire.unresolved, [], `${toolName}: OpenAPI response has unresolvable $refs`);

      const drift = declaredButNotOnWire(tool.outputSchema, wire.properties)
        .filter(name => !adds.includes(name));
      assert.deepEqual(
        drift, [],
        `${toolName} declares outputSchema properties that neither its response nor its own _execute provides: ` +
          `${JSON.stringify(drift)}\n  wire properties: ${JSON.stringify(Object.keys(wire.properties))}\n` +
          `  _execute adds: ${JSON.stringify(adds)}`,
      );
      assert.deepEqual(
        declaredTypeMismatches(tool.outputSchema, wire.properties), [],
        `${toolName} declares outputSchema property types its response contradicts`,
      );

      // Every declared addition must really be an addition — an `adds` entry
      // that the wire now carries is a stale carve-out hiding real coverage.
      const stale = adds.filter(name => name in wire.properties);
      assert.deepEqual(
        stale, [],
        `${toolName}: ${JSON.stringify(stale)} now exist(s) on the wire, so listing them as _execute additions ` +
          'exempts real fields from the check — remove them from `adds`.',
      );
    });
  }

  // Positive control: the assertion above is an "expect nothing" check over a
  // population, which stays green if the comparison itself is broken. Prove it
  // can fail by running a schema with a fabricated field through the same
  // function the loop uses.
  it('the drift comparisons flag a fabricated field and a contradicted type (positive control)', () => {
    const wireProps = {
      countryCode: { type: 'string' },
      cii: { type: 'object' },
      sanctionsActive: { type: 'boolean' },
    };

    const faithful = {
      properties: {
        countryCode: { type: 'string' },
        cii: { type: ['object', 'null'] },
        sanctionsActive: { type: 'boolean' },
      },
    };
    assert.deepEqual(declaredButNotOnWire(faithful, wireProps), [], 'a schema matching the wire must report no drift');
    assert.deepEqual(declaredTypeMismatches(faithful, wireProps), [], 'a nullable object against an object wire type is compatible');

    // The shape get_country_risk actually shipped: three invented names plus a
    // `cii` that exists but was declared a number.
    const shipped = {
      properties: {
        country_code: { type: 'string' },
        cii: { type: ['number', 'null'] },
        components: { type: 'object' },
        sanctionsExposure: { type: ['object', 'array', 'null'] },
      },
    };
    assert.deepEqual(
      declaredButNotOnWire(shipped, wireProps),
      ['country_code', 'components', 'sanctionsExposure'],
      'the invented names must be reported as drift',
    );
    assert.deepEqual(
      declaredTypeMismatches(shipped, wireProps),
      ['cii: declared ["number","null"], wire is "object"'],
      'a name that exists but whose declared type contradicts the wire must still be reported',
    );
  });

  // The comparisons recurse, and a recursion that silently stops descending
  // looks identical to a clean pass. Prove it reaches nested properties.
  it('the drift comparisons descend into nested properties (positive control)', () => {
    const wireProps = {
      cii: {
        type: 'object',
        properties: {
          combinedScore: { type: 'number' },
          components: { type: 'object', properties: { ciiContribution: { type: 'number' } } },
        },
      },
    };
    const faithful = {
      properties: {
        cii: {
          type: 'object',
          properties: {
            combinedScore: { type: 'number' },
            components: { type: 'object', properties: { ciiContribution: { type: 'number' } } },
          },
        },
      },
    };
    assert.deepEqual(declaredButNotOnWire(faithful, wireProps), []);
    assert.deepEqual(declaredTypeMismatches(faithful, wireProps), []);

    // A fabricated name and a contradicted type, both two levels down — the
    // depth at which get_country_risk's real content lives.
    const drifted = {
      properties: {
        cii: {
          type: 'object',
          properties: {
            combinedScore: { type: 'string' },
            components: { type: 'object', properties: { unrest: { type: 'number' } } },
          },
        },
      },
    };
    assert.deepEqual(
      declaredButNotOnWire(drifted, wireProps),
      ['cii.components.unrest'],
      'a fabricated nested field must be reported with its full path',
    );
    assert.deepEqual(
      declaredTypeMismatches(drifted, wireProps),
      ['cii.combinedScore: declared "string", wire is "number"'],
      'a nested type contradiction must be reported with its full path',
    );
  });

  it('the drift comparisons descend into array item properties (positive control)', () => {
    const wireProps = {
      flights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            durationMinutes: { type: 'number' },
            legs: { type: 'array' },
          },
        },
      },
    };
    const drifted = {
      properties: {
        flights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              durationMinutes: { type: 'string' },
              airline: { type: 'string' },
            },
          },
        },
      },
    };
    assert.deepEqual(
      declaredButNotOnWire(drifted, wireProps),
      ['flights[].airline'],
      'array item names must be reported with their full path',
    );
    assert.deepEqual(
      declaredTypeMismatches(drifted, wireProps),
      ['flights[].durationMinutes: declared "string", wire is "number"'],
      'array item type contradictions must be reported with their full path',
    );
  });

  it('undeclaredSafetyFlags reports a dropped degraded-state flag (positive control)', () => {
    const wireProps = {
      countryCode: { type: 'string' },
      upstreamUnavailable: { type: 'boolean' },
      degraded: { type: 'boolean' },
    };
    assert.deepEqual(
      undeclaredSafetyFlags({ properties: { countryCode: {}, upstreamUnavailable: {}, degraded: {} } }, wireProps),
      [],
      'a schema declaring every safety flag must report nothing',
    );
    assert.deepEqual(
      undeclaredSafetyFlags({ properties: { countryCode: {} } }, wireProps),
      ['upstreamUnavailable', 'degraded'],
      'dropping the outage flags must be reported — that is the half of the fix that matters most',
    );
  });
});
