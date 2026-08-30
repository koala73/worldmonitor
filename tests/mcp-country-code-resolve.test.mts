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
import { readFileSync } from 'node:fs';
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

  it('strips a trailing historical parenthetical', () => {
    assert.equal(resolveCountryCode('Russia (Soviet Union)'), 'RU');
    assert.equal(resolveCountryCode('Myanmar (Burma)'), 'MM');
  });

  it('returns null rather than guessing', () => {
    for (const bad of ['', '   ', 'Foo', 'ZZZ', 'not a country', '12', null, undefined, 42, {}]) {
      assert.equal(resolveCountryCode(bad as unknown), null, `expected null for ${JSON.stringify(bad)}`);
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
  const { countryNameToIso2 } = require('../shared/country-name-to-iso2.cjs');

  it('resolves every name-map key identically', () => {
    const disagreements = Object.keys(COUNTRY_NAMES)
      .map((key) => ({ key, ours: resolveCountryCode(key), theirs: countryNameToIso2(key) }))
      .filter((row) => row.ours !== row.theirs);
    assert.deepEqual(disagreements, []);
  });

  it('normalizes tokens identically', () => {
    const probes = ["Côte d'Ivoire", 'Côte d’Ivoire', 'Bosnia & Herzegovina', 'Timor-Leste',
      'Korea, Republic of', '  Spaced   Out  ', 'St. Kitts and Nevis'];
    const theirs = require('../shared/country-name-to-iso2.cjs');
    for (const probe of probes) {
      // The .cjs does not export its normalizer, so compare through lookups:
      // identical normalization means identical resolution for every probe.
      assert.equal(resolveCountryCode(probe), theirs.countryNameToIso2(probe), probe);
    }
    // And the exported normalizer must be idempotent + already-normalized-stable.
    for (const probe of probes) {
      assert.equal(normalizeCountryToken(normalizeCountryToken(probe)), normalizeCountryToken(probe), probe);
    }
  });

  it('is a strict superset — it adds alpha-3, which the .cjs lacks', () => {
    assert.equal(countryNameToIso2('IRQ'), null, 'guard: the .cjs still has no alpha-3 step');
    assert.equal(resolveCountryCode('IRQ'), 'IQ');
  });
});

// The regression guard that makes the fix stick: no MCP tool executor may
// coerce a country argument by truncation again.
describe('no MCP executor truncates a country code', () => {
  it('rpc-tools.ts contains no slice(0, 2) country coercion', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../api/mcp/registry/rpc-tools.ts', import.meta.url)), 'utf8');
    const offenders = source.split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /country_?[Cc]ode/.test(line) && /\.slice\(\s*0\s*,\s*2\s*\)/.test(line));
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

  it('reports an unresolvable country instead of silently querying another', async () => {
    const urls = stubDownstream({ countryCode: 'XX' });
    const rpc = await callTool('get_country_risk', { country_code: 'Wakanda' });
    assert.equal(urls.length, 0, `must not call downstream: ${JSON.stringify(urls)}`);
    const text = JSON.stringify(rpc);
    assert.match(text, /Wakanda/, `the error must name the offending value: ${text.slice(0, 400)}`);
  });
});
