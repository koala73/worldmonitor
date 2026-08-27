// Parity test for the per-tool spec `outputSchema` field (v1.6.0).
//
// Covers:
//   1. Every tool in TOOL_REGISTRY declares a non-empty outputSchema with at
//      least one key on outputSchema.properties. Failures name the tool so a
//      future PR adding a tool without an outputSchema fails loudly.
//   2. Every fixture in tests/fixtures/jmespath-samples/ validates against the
//      schema declared by the tool that produced it. Drift between declared
//      schema and the real response shape fails the test by tool name.
//   3. tools/list emits outputSchema on every advertised tool — surfacing the
//      field at the wire boundary in addition to the in-process registry.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validate } from './helpers/json-schema-mini.mjs';

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
  });

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
    'get_similar_events',
    'search_flight_prices_by_date',
    'search_flights',
    'search_intel_history',
  ];

  // Pre-existing instances of the same defect, recorded rather than hidden.
  // Each entry is load-bearing in both directions: an unlisted tool that
  // starts drifting fails, and a listed tool that stops drifting ALSO fails,
  // so a fix cannot leave a stale exemption behind.
  const KNOWN_DRIFT = new Map([
    ['analyze_situation', 'declares deduction/confidence/signals/framework/generatedAt; DeductSituationResponse is {analysis, model, provider}'],
    ['search_flights', 'declares search_metadata, which SearchGoogleFlightsResponse does not carry'],
    ['search_flight_prices_by_date', 'declares prices/search_metadata; SearchGoogleDatesResponse carries dates/degraded/error'],
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
  // top-level properties, each dereferenced so a $ref'd field carries a type.
  function wireResponseProperties({ op, spec }) {
    const schema = deref(op?.responses?.['200']?.content?.['application/json']?.schema, spec);
    if (!schema?.properties) return null;
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties)) out[key] = deref(sub, spec) ?? {};
    return out;
  }

  // The two comparisons the population loop and the positive control below
  // both run through, so a control cannot pass against a copy of the rule.
  function declaredButNotOnWire(outputSchema, wireProps) {
    return Object.keys(outputSchema?.properties ?? {}).filter(k => !(k in wireProps));
  }

  // Name parity alone would have missed half the get_country_risk bug: `cii`
  // exists on the wire, but as a CiiScore object against a declared
  // ['number','null']. Compare types wherever both sides state one.
  function declaredTypeMismatches(outputSchema, wireProps) {
    const mismatches = [];
    for (const [key, declared] of Object.entries(outputSchema?.properties ?? {})) {
      const wireType = wireProps[key]?.type;
      if (!wireType || !declared?.type) continue;
      // `null` is a legitimate declaration widening: proto scalars are absent
      // rather than null, but a tool may still admit null for a missing field.
      const declaredTypes = (Array.isArray(declared.type) ? declared.type : [declared.type])
        .filter(t => t !== 'null');
      if (declaredTypes.length === 0) continue;
      const compatible = declaredTypes.some(t => t === wireType
        || (t === 'number' && wireType === 'integer')
        || (t === 'integer' && wireType === 'number'));
      if (!compatible) {
        mismatches.push(`${key}: declared ${JSON.stringify(declared.type)}, wire is ${JSON.stringify(wireType)}`);
      }
    }
    return mismatches;
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
      const wireProps = wireResponseProperties(entry);
      assert.ok(wireProps, `${toolName}: OpenAPI operation declares no resolvable 200 JSON response schema`);

      const drift = declaredButNotOnWire(tool.outputSchema, wireProps);
      const mismatches = declaredTypeMismatches(tool.outputSchema, wireProps);
      const known = KNOWN_DRIFT.get(toolName);
      if (known) {
        assert.ok(
          drift.length + mismatches.length > 0,
          `${toolName} is in KNOWN_DRIFT ("${known}") but no longer drifts — delete its KNOWN_DRIFT entry so the guard stays live for this tool`,
        );
        return;
      }
      assert.deepEqual(
        drift, [],
        `${toolName} declares outputSchema properties that its response does not carry: ${JSON.stringify(drift)}\n` +
          `  wire properties: ${JSON.stringify(Object.keys(wireProps))}\n` +
          '  `_execute` returns res.json() verbatim, so an agent reading these gets null.',
      );
      assert.deepEqual(
        mismatches, [],
        `${toolName} declares outputSchema property types its response contradicts:\n  ${mismatches.join('\n  ')}`,
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
});
