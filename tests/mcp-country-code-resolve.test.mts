// Country-designator resolution for the MCP tool layer (WORLDMONITOR-Y2).
//
// The four country-scoped RPC tools used to coerce their argument with
// `String(params.country_code ?? '').toUpperCase().slice(0, 2)`. Truncation is
// not merely lossy here — it is silently WRONG. The downstream proto only
// enforces `^[A-Z]{2}$` (proto/worldmonitor/intelligence/v1/get_country_risk.proto),
// so a country NAME truncated to two letters passes validation and returns a
// different country's intelligence:
//
//     "Iraq"   -> "IR" -> Iran          "China"  -> "CH" -> Switzerland
//     "Israel" -> "IS" -> Iceland       "Nigeria"-> "NI" -> Nicaragua
//
// Only the residue that truncates to something invalid ("" from a missing arg)
// ever reached Sentry as an HTTP 400. The wrong-country answers were silent.
//
// These cases pin the resolution ladder, the two data invariants its ORDER
// rests on, agreement with the sibling CommonJS resolver, and — through the
// real MCP handler — that the tools now send the resolved code downstream.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCountryToken, resolveCountryCode } from '../shared/country-code-resolve.ts';
import COUNTRY_NAMES from '../shared/country-names.json' with { type: 'json' };
import ISO3_TO_ISO2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const require = createRequire(import.meta.url);
const ENV_KEY = 'operator_test_key_country_code_resolve';
const MCP_URL = 'https://api.worldmonitor.app/api/mcp';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalLog = console.log;
const originalWarn = console.warn;

describe('resolveCountryCode — the wrong-country regressions', () => {
  // Each of these truncates to a DIFFERENT real country under the old
  // `.slice(0, 2)`. The second column is what the bug returned.
  const wrongCountry: Array<[string, string, string]> = [
    ['Iraq', 'IQ', 'IR (Iran)'],
    ['China', 'CN', 'CH (Switzerland)'],
    ['Israel', 'IL', 'IS (Iceland)'],
    ['Indonesia', 'ID', 'IN (India)'],
    ['Nigeria', 'NG', 'NI (Nicaragua)'],
    ['Germany', 'DE', 'GE (Georgia)'],
  ];

  for (const [input, expected, wasWrongly] of wrongCountry) {
    it(`resolves ${JSON.stringify(input)} to ${expected}, not ${wasWrongly}`, () => {
      assert.equal(resolveCountryCode(input), expected);
    });
  }
});

describe('resolveCountryCode — the ladder', () => {
  it('passes through alpha-2, case-insensitively', () => {
    assert.equal(resolveCountryCode('IQ'), 'IQ');
    assert.equal(resolveCountryCode('iq'), 'IQ');
    assert.equal(resolveCountryCode('  De  '), 'DE');
  });

  it('accepts real alpha-2 codes the local maps omit', () => {
    // The two maps are geojson-derived and incomplete. Gating the alpha-2 path
    // on their contents rejected eight real ISO 3166-1 codes, turning requests
    // the tool schema promises to accept into JSON-RPC -32602. Shape is the
    // only correct test for a bare code.
    for (const code of ['CX', 'TK', 'BV', 'SJ', 'YT', 'RE', 'MQ', 'GP']) {
      assert.equal(resolveCountryCode(code), code, `${code} is a valid ISO 3166-1 alpha-2 code`);
    }
  });

  it('passes an unassigned two-letter code through rather than rejecting it', () => {
    // `XX` is not a country, so it cannot yield the WRONG country — it fails
    // honestly downstream. That is a different and lesser problem than
    // truncating a NAME, which yields a valid code for a real other country.
    // Pinned so the trade-off is a recorded decision, not an accident.
    assert.equal(resolveCountryCode('XX'), 'XX');
    assert.equal(resolveCountryCode('ZZ'), 'ZZ');
  });

  it('maps alpha-3', () => {
    assert.equal(resolveCountryCode('IRQ'), 'IQ');
    assert.equal(resolveCountryCode('chn'), 'CN');
    assert.equal(resolveCountryCode('DEU'), 'DE');
  });

  it('maps names and aliases', () => {
    assert.equal(resolveCountryCode('United Kingdom'), 'GB');
    assert.equal(resolveCountryCode('Burma'), 'MM');
    assert.equal(resolveCountryCode('Ivory Coast'), 'CI');
    assert.equal(resolveCountryCode('Czechia'), 'CZ');
  });

  it('prefers the alias map over bare alpha-2 passthrough for UK', () => {
    // `UK` satisfies ^[A-Z]{2}$ but is NOT the ISO code for the United Kingdom
    // (GB is; UK is only exceptionally reserved). Passthrough-first would send
    // `UK` downstream. This is the single case where step order is observable.
    assert.equal(resolveCountryCode('UK'), 'GB');
    assert.equal(resolveCountryCode('uk'), 'GB');
  });

  it('resolves three-character aliases that have no alpha-3 entry', () => {
    // `drc` and `uae` live only in the name map — if the ladder consulted the
    // alpha-3 map first and returned on a miss, both would fail.
    assert.equal(resolveCountryCode('DRC'), 'CD');
    assert.equal(resolveCountryCode('UAE'), 'AE');
    assert.equal(resolveCountryCode('USA'), 'US');
  });

  it('folds diacritics and curly apostrophes', () => {
    assert.equal(resolveCountryCode("Cote d'Ivoire"), 'CI');
    assert.equal(resolveCountryCode('Côte d’Ivoire'), 'CI');
  });

  it('resolves a trailing historical parenthetical', () => {
    assert.equal(resolveCountryCode('Russia (Soviet Union)'), 'RU');
    assert.equal(resolveCountryCode('Myanmar (Burma)'), 'MM');
    assert.equal(resolveCountryCode('Yemen (North Yemen)'), 'YE');
  });

  it('resolves a CODE paired with a parenthetical name', () => {
    // The first cut computed the stripped form but only retried the NAME map
    // with it, while the alpha-2/alpha-3 steps still tested the raw string —
    // so every code-plus-parenthetical form returned null even though the old
    // truncation got all of them right. `Iraq (IQ)` worked and `IQ (Iraq)` did
    // not, which is the asymmetry that exposed it.
    assert.equal(resolveCountryCode('GB (United Kingdom)'), 'GB');
    assert.equal(resolveCountryCode('IQ (Iraq)'), 'IQ');
    assert.equal(resolveCountryCode('Iraq (IQ)'), 'IQ');
    assert.equal(resolveCountryCode('DEU (Germany)'), 'DE');
  });

  it('recombines a split country name rather than answering for the neighbour', () => {
    // `Samoa (American)` must not resolve to Samoa. A recombination that hits
    // an exact key in the curated name map IS that country by construction.
    assert.equal(resolveCountryCode('Samoa (American)'), 'AS');
    assert.equal(resolveCountryCode('Sudan (South)'), 'SS');
    assert.equal(resolveCountryCode('Guinea (Equatorial)'), 'GQ');
    assert.equal(resolveCountryCode('Niger (Republic)'), 'NE');
  });

  it('returns null when a parenthetical disambiguator contradicts the base name', () => {
    // The exact bug class this module exists to close: discarding the
    // parenthetical made `Congo (DRC)` answer as CG (Republic of the Congo)
    // and `China (Taiwan)` as CN. Ambiguous input must fail, not guess.
    assert.equal(resolveCountryCode('Congo (DRC)'), null);
    assert.equal(resolveCountryCode('China (Taiwan)'), null);
    // The name map holds composite keys that are territorial CLAIMS, not names
    // (`morocco western sahara` -> MA), so recombination alone would answer
    // Morocco here. The disagreement gate must run first.
    assert.equal(resolveCountryCode('Western Sahara (Morocco)'), null);
  });

  it('still resolves a two-letter modifier that is not itself a country name', () => {
    // Regression guard on the gate above: comparing via the full ladder rather
    // than name-map hits would let `DR` self-resolve as bare alpha-2, read this
    // as a disagreement, and reject a perfectly good designator.
    assert.equal(resolveCountryCode('Congo (DR)'), 'CD');
    assert.equal(resolveCountryCode('Republic of Korea (Democratic)'), 'KP');
  });

  it('rejects an over-long designator without doing quadratic work', () => {
    // The parenthetical match is quadratic in input length and the argument
    // arrives from an LLM over the network: ~192KB burned ~46s of Edge CPU per
    // request before the length gate. The assertion is on TIME, because the
    // return value was already null — nothing else in the suite would notice.
    const pathological = 'a ('.repeat(64_000);
    const started = Date.now();
    assert.equal(resolveCountryCode(pathological), null);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 250, `resolution took ${elapsed}ms — the length gate is not holding`);
  });

  it('accepts the longest real designator in the shipped data', () => {
    // Positive control for the length cap: prove it is not so tight that it
    // rejects genuine input.
    const longest = Object.keys(COUNTRY_NAMES).reduce((a, b) => (b.length > a.length ? b : a), '');
    assert.ok(longest.length > 20, `guard: expected a long key, got ${JSON.stringify(longest)}`);
    assert.ok(resolveCountryCode(longest), `longest real name did not resolve: ${JSON.stringify(longest)}`);
  });

  // Generated sweep. The hand-written parenthetical cases all use inputs whose
  // stem is unambiguous — precisely the ones that could not catch a stem
  // collapse. For every multi-word name, drop one token: where the remaining
  // stem is itself a key for a DIFFERENT country, `<stem> (<dropped>)` must
  // never silently answer as the stem's country.
  it('never collapses a split name onto a different country', () => {
    const names = COUNTRY_NAMES as Record<string, string>;
    const wrong: Array<{ probe: string; got: string | null; stem: string }> = [];
    for (const [key, iso2] of Object.entries(names)) {
      const tokens = key.split(' ');
      if (tokens.length < 2) continue;
      for (let i = 0; i < tokens.length; i++) {
        const stem = [...tokens.slice(0, i), ...tokens.slice(i + 1)].join(' ');
        const stemIso2 = names[stem];
        if (!stemIso2 || stemIso2 === iso2) continue;
        const probe = `${stem} (${tokens[i]})`;
        const got = resolveCountryCode(probe);
        if (got === stemIso2) wrong.push({ probe, got, stem });
      }
    }
    assert.deepEqual(wrong, [],
      'a dropped token must not leave the answer pointing at the stem country');
  });

  it('returns null rather than guessing', () => {
    for (const bad of ['', '   ', 'Foo', 'ZZZ', 'not a country', '12', null, undefined, 42, {}]) {
      assert.equal(resolveCountryCode(bad as unknown), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it('does not resolve inherited Object.prototype keys', () => {
    // The maps are JSON objects indexed by a caller-derived key, so a bare
    // `map[key]` truthiness check reaches the prototype chain: `__proto__`
    // yielded Object.prototype and `constructor` the Object constructor —
    // both truthy, so they escaped as a NON-STRING despite the `string | null`
    // return type and flowed into `encodeURIComponent(code)` downstream.
    // Only already-lowercase keys reach this (normalization lowercases, so
    // `toString` becomes `tostring` and misses), but that is incidental, not a
    // guard. Assert the whole class, not the two live instances.
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__']) {
      assert.equal(resolveCountryCode(key), null, `expected null for ${JSON.stringify(key)}`);
    }
  });

  it('never returns a non-string', () => {
    const probes = ['__proto__', 'constructor', 'Iraq', 'IRQ', 'iq', 'UK', 'Foo', ''];
    for (const probe of probes) {
      const resolved = resolveCountryCode(probe);
      assert.ok(resolved === null || typeof resolved === 'string',
        `${probe} -> ${typeof resolved} ${String(resolved).slice(0, 40)}`);
    }
  });

  it('never returns a value that would fail the downstream proto pattern', () => {
    const probes = ['Iraq', 'IRQ', 'iq', 'UK', 'Côte d’Ivoire', 'Russia (Soviet Union)', 'DRC'];
    for (const probe of probes) {
      const resolved = resolveCountryCode(probe);
      assert.ok(resolved && /^[A-Z]{2}$/.test(resolved), `${probe} -> ${resolved}`);
    }
  });
});

// The ladder's ORDER is only safe because of two properties of the shipped
// data. If a future regeneration of country-names.json breaks either one, the
// order has to be revisited — so assert the properties, not just the outcomes.
describe('data invariants the ladder order depends on', () => {
  it('the name map has exactly one two-character key, and it is uk', () => {
    const twoChar = Object.keys(COUNTRY_NAMES).filter((k) => k.length === 2);
    assert.deepEqual(twoChar, ['uk'],
      'a new two-character alias would shadow a legitimate alpha-2 argument, because the name map is consulted first');
  });

  it('no three-character name key disagrees with the alpha-3 map', () => {
    const conflicts = Object.entries(COUNTRY_NAMES as Record<string, string>)
      .filter(([key]) => key.length === 3)
      .map(([key, iso2]) => ({ key, iso2, viaIso3: (ISO3_TO_ISO2 as Record<string, string>)[key.toUpperCase()] }))
      .filter((row) => row.viaIso3 && row.viaIso3 !== row.iso2);
    assert.deepEqual(conflicts, [],
      'the name map wins over the alpha-3 map, so a disagreement would silently change which country resolves');
  });
});

// Four resolvers now exist for this data and none can import another (CJS vs
// ESM vs browser). tests/notification-relay-country-scope-5359.test.mjs records
// what drift already cost once: a 12-entry stub of the name resolver silently
// narrowed country scoping in production. Pin agreement instead of trusting it.
describe('agreement with shared/country-name-to-iso2.cjs', () => {
  const { countryNameToIso2, COUNTRY_NAME_TO_ISO2 } = require('../shared/country-name-to-iso2.cjs');

  it('resolves every key of the .cjs MERGED map identically', () => {
    // Enumerate the merged export, not the raw JSON. The .cjs layers an
    // EXTRA_ALIASES table on top of country-names.json, so a test keyed on the
    // JSON is blind by construction to the one entry where the two resolvers
    // could differ — and it passed green while `Bosnia-Herzegovina` resolved
    // in the .cjs and returned null here.
    const disagreements = Object.keys(COUNTRY_NAME_TO_ISO2)
      .map((key) => ({ key, ours: resolveCountryCode(key), theirs: countryNameToIso2(key) }))
      .filter((row) => row.ours !== row.theirs);
    assert.deepEqual(disagreements, []);
  });

  it('carries the .cjs EXTRA_ALIASES entries the generated JSON lacks', () => {
    // Positive control for the enumeration above: assert the alias exists
    // outside country-names.json, so a future refactor that drops the local
    // EXTRA_ALIASES table fails here instead of silently narrowing coverage.
    assert.equal((COUNTRY_NAMES as Record<string, string>)['bosnia herzegovina'], undefined,
      'guard: this alias must NOT be in the generated JSON, or this test proves nothing');
    assert.equal(resolveCountryCode('Bosnia-Herzegovina'), 'BA');
    assert.equal(resolveCountryCode('bosnia herzegovina'), 'BA');
  });

  it('normalizes tokens identically', () => {
    // The .cjs does not export its normalizer, so compare through lookups:
    // identical normalization means identical resolution for every probe.
    // (An idempotency check of normalizeCountryToken against itself was here
    // and proved nothing about the sibling — dropped rather than left to imply
    // cross-implementation coverage it never provided.)
    const probes = ["Côte d'Ivoire", 'Côte d’Ivoire', 'Bosnia & Herzegovina', 'Timor-Leste',
      'Korea, Republic of', '  Spaced   Out  ', 'St. Kitts and Nevis', 'Bosnia-Herzegovina'];
    for (const probe of probes) {
      assert.equal(resolveCountryCode(probe), countryNameToIso2(probe), probe);
    }
  });

  it('adds alpha-3, which the .cjs lacks', () => {
    assert.equal(countryNameToIso2('IRQ'), null, 'guard: the .cjs still has no alpha-3 step');
    assert.equal(resolveCountryCode('IRQ'), 'IQ');
  });

  it('deliberately diverges from the .cjs on an ambiguous parenthetical', () => {
    // Not a superset: the .cjs discards the parenthetical unconditionally,
    // which is right for its curated UCDP feed and wrong for caller text.
    // Pin the divergence so it reads as a decision, not drift.
    assert.equal(countryNameToIso2('Congo (DRC)'), 'CG');
    assert.equal(resolveCountryCode('Congo (DRC)'), null);
  });
});

// The regression guard that makes the fix stick: no MCP tool executor may
// coerce a country argument by truncation again.
describe('no MCP executor truncates a country code', () => {
  it('no registry file coerces a country code by truncation', () => {
    // Scan every registry module, not just the one that had the bug — the same
    // two-line coercion in a sibling tool file would be just as silent.
    const registryDir = fileURLToPath(new URL('../api/mcp/registry/', import.meta.url));
    const offenders = readdirSync(registryDir)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => readFileSync(join(registryDir, name), 'utf8').split('\n')
        .map((line, i) => ({ file: name, no: i + 1, line: line.trim() }))
        .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//')
          && /country_?[Cc]ode/.test(line) && /\.slice\(\s*0\s*,\s*2\s*\)/.test(line)));
    assert.deepEqual(offenders, [],
      'truncating a country name to two letters yields a VALID code for the WRONG country — resolve it instead');
  });
});

describe('country tools resolve their argument end-to-end', () => {
  function makeDeps() {
    const pipe = makePipelineMock();
    return {
      resolveBearerToContext: async () => null,
      validateProMcpToken: async () => null,
      getEntitlements: async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true, apiAccess: true },
        validUntil: Date.now() + 86_400_000,
      }),
      validateUserApiKey: async () => null,
      guardUserApiKeyValidation: async () => null,
      redisPipeline: pipe.pipeline,
    };
  }

  /** Capture every downstream URL and answer with a minimal valid payload. */
  function stubDownstream(payload: Record<string, unknown>) {
    const urls: string[] = [];
    globalThis.fetch = async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    return urls;
  }

  /** Same, but also records each request's body — get_country_brief POSTs. */
  function stubDownstreamWithBodies(payload: Record<string, unknown>) {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = async (input: unknown, init: { body?: unknown } = {}) => {
      calls.push({ url: String(input), body: typeof init.body === 'string' ? init.body : '' });
      return new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    return calls;
  }

  async function callTool(tool: string, params: Record<string, unknown>) {
    const request = new Request(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
      body: JSON.stringify(callBody(tool, params, 1)),
    });
    const response = await mcpHandler(request, makeDeps());
    assert.equal(response.status, 200, 'transport status');
    return response.json();
  }

  beforeEach(() => {
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    delete process.env.MCP_TELEMETRY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    console.log = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('get_country_risk sends IQ downstream when the agent says "Iraq"', async () => {
    const urls = stubDownstream({
      countryCode: 'IQ', countryName: 'Iraq', advisoryLevel: 'do-not-travel',
      sanctionsActive: false, sanctionsCount: 0, fetchedAt: 0, upstreamUnavailable: false,
    });
    await callTool('get_country_risk', { country_code: 'Iraq' });
    const risk = urls.find((u) => u.includes('/api/intelligence/v1/get-country-risk'));
    assert.ok(risk, `no downstream call: ${JSON.stringify(urls)}`);
    assert.match(risk, /country_code=IQ(?:&|$)/,
      `sent the wrong country: ${risk}`);
  });

  // get_airspace / get_maritime_activity do not forward a country code at all —
  // they translate it to a bounding box via COUNTRY_BBOXES. That is precisely
  // how the truncation stayed invisible: `Iraq` -> `IR` is a REAL key, so the
  // existing `if (!bbox)` guard passed and the tool queried Iran's box.
  const IRAQ_BBOX = 'sw_lat=29.1&sw_lon=38.77&ne_lat=37.37&ne_lon=48.53';
  const IRAN_BBOX = 'sw_lat=25.2&sw_lon=44.06&ne_lat=39.69&ne_lon=62.75';

  it('get_airspace queries Iraq\'s bounding box, not Iran\'s, for "Iraq"', async () => {
    const urls = stubDownstream({ country_code: 'IQ', flights: [] });
    await callTool('get_airspace', { country_code: 'Iraq' });
    const airspace = urls.find((u) => u.includes('/api/military/v1/'));
    assert.ok(airspace, `no downstream call: ${JSON.stringify(urls)}`);
    assert.ok(airspace.includes(IRAQ_BBOX), `expected Iraq's bbox, got: ${airspace}`);
    assert.ok(!airspace.includes(IRAN_BBOX), `queried Iran's airspace for an Iraq request: ${airspace}`);
  });

  it('get_maritime_activity echoes IQ and Iraq\'s box, not Iran\'s, for "Iraq"', async () => {
    // This tool deliberately sends no bbox downstream (WORLDMONITOR-T8), so the
    // outbound URL cannot witness the bug. It DOES echo the resolved code and
    // box in its own result, which can — pre-fix this returned IR + Iran's box.
    stubDownstream({ zones: [], disruptions: [] });
    const rpc = await callTool('get_maritime_activity', { country_code: 'Iraq' });
    const text = rpc.result?.content?.[0]?.text;
    assert.ok(text, `no tool result: ${JSON.stringify(rpc).slice(0, 400)}`);
    const payload = JSON.parse(text);
    assert.equal(payload.country_code, 'IQ', `echoed the wrong country: ${text.slice(0, 200)}`);
    assert.deepEqual(payload.bounding_box,
      { sw_lat: 29.1, sw_lon: 38.77, ne_lat: 37.37, ne_lon: 48.53 },
      'returned a bounding box that is not Iraq\'s');
  });

  it('get_country_brief resolves "Iraq" to IQ', async () => {
    // The fourth call site, and the most agent-facing of the set — its own
    // description invites an LLM to ask for country intelligence by name.
    const calls = stubDownstreamWithBodies({
      country_code: 'IQ', brief: 'x', framework: '', generatedAt: '2026-08-30T00:00:00.000Z',
      provider: 'p', model: 'm', sources: [], categories: { world: { items: [] } },
    });
    await callTool('get_country_brief', { country_code: 'Iraq' });
    // This tool POSTs the code in the request body, not the query string.
    const brief = calls.find((c) => c.url.includes('get-country-intel-brief'));
    assert.ok(brief, `no brief call: ${JSON.stringify(calls.map((c) => c.url))}`);
    const sent = JSON.parse(brief.body || '{}');
    assert.equal(sent.country_code ?? sent.countryCode, 'IQ',
      `sent the wrong country: ${brief.body.slice(0, 200)}`);
  });

  // Unresolvable input must fail loudly. The two tools that throw surface as
  // JSON-RPC -32602; the two that map to a bounding box return a result-level
  // {error}. Assert the actual shape, not just that some text mentions the value.
  for (const tool of ['get_country_risk', 'get_country_brief']) {
    it(`${tool} rejects an unresolvable country as -32602 with violations`, async () => {
      const urls = stubDownstream({ countryCode: 'XX' });
      const rpc = await callTool(tool, { country_code: 'Wakanda' });
      assert.equal(urls.length, 0, `must not call downstream: ${JSON.stringify(urls)}`);
      assert.equal(rpc.error?.code, -32602, `wrong error shape: ${JSON.stringify(rpc).slice(0, 400)}`);
      assert.equal(rpc.error?.message, 'Invalid params');
      const violations = rpc.error?.data?.violations;
      assert.ok(Array.isArray(violations) && violations.length > 0, 'expected violations[]');
      assert.equal(violations[0].field, 'country_code');
      assert.match(violations[0].description, /Wakanda/,
        'the violation must name the offending value so an agent can self-correct');
    });
  }

  it('rejects a non-string country_code as -32602 rather than crashing', async () => {
    // `{"toString":"x"}` is legal JSON. The error formatter used to run
    // `String(raw)`, which invokes the value's own toString — shadowed here by
    // a non-callable string — throwing `Cannot convert object to primitive
    // value` and turning a clean 400 into a 500. The guard crashed instead of
    // guarding.
    const urls = stubDownstream({});
    const rpc = await callTool('get_country_risk', { country_code: { toString: 'x' } });
    assert.equal(urls.length, 0, `must not call downstream: ${JSON.stringify(urls)}`);
    assert.equal(rpc.error?.code, -32602, `expected a validation error: ${JSON.stringify(rpc).slice(0, 400)}`);
    assert.equal(rpc.error?.data?.violations?.[0]?.field, 'country_code');
  });

  for (const tool of ['get_airspace', 'get_maritime_activity']) {
    it(`${tool} reports an unresolvable country without querying another`, async () => {
      const urls = stubDownstream({});
      const rpc = await callTool(tool, { country_code: 'Wakanda' });
      assert.equal(urls.length, 0, `must not call downstream: ${JSON.stringify(urls)}`);
      const payload = JSON.parse(rpc.result.content[0].text);
      assert.match(payload.error ?? '', /Wakanda/, `expected a named error: ${JSON.stringify(payload)}`);
    });

    it(`${tool} distinguishes "no coverage" from "unresolvable"`, async () => {
      // 92 of the 306 resolvable names have no COUNTRY_BBOXES entry, so this
      // branch is common, not a corner case — and this diff rewrote its message.
      const urls = stubDownstream({});
      const rpc = await callTool(tool, { country_code: 'Bahrain' });
      assert.equal(urls.length, 0, `must not call downstream: ${JSON.stringify(urls)}`);
      const payload = JSON.parse(rpc.result.content[0].text);
      assert.match(payload.error ?? '', /no bounding box/,
        `a resolvable country lacking coverage must not read as bad input: ${JSON.stringify(payload)}`);
      assert.match(payload.error ?? '', /BH/, 'the message should name the resolved code');
    });
  }
});
