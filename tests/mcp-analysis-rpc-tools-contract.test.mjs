import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const findTool = (name) => TOOL_REGISTRY.find((tool) => tool.name === name);
// ---------------------------------------------------------------------------
// Registry contract
// ---------------------------------------------------------------------------

describe('wave-2a analysis tools registry contract', () => {
  const expected = {
    get_signal_convergence: {
      budget: 65536,
      coverage: ['unrest:events:v1', 'military:flights:v1', 'seismology:earthquakes:v1', 'usni-fleet:sebuf:v1'],
    },
    get_focal_points: {
      budget: 65536,
      coverage: ['news:insights:v1', 'intelligence:cross-source-signals:v1', 'risk:scores:sebuf:v8'],
    },
    simulate_infrastructure_cascade: {
      budget: 131072,
      coverage: ['infrastructure:submarine-cables:v1'],
    },
    get_military_surge: {
      budget: 65536,
      coverage: ['military:flights:v1', 'theater-posture:sebuf:v1', 'military:surges:v1', 'risk:scores:sebuf:v8'],
    },
  };

  for (const [name, spec] of Object.entries(expected)) {
    it(`${name} declares the full hybrid tool contract`, () => {
      const tool = findTool(name);
      assert.ok(tool, `${name} must be registered in the tool registry`);
      assert.equal(tool._cacheKeys, undefined, `${name} is a hybrid _execute tool, not a cache tool`);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 200, 'descriptions are long-form; tools/list compresses them');
      assert.equal(tool._outputBudgetBytes, spec.budget);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      });
      assert.deepEqual(tool._apiPaths, []);
      assert.equal(typeof tool._execute, 'function');
      assert.deepEqual(tool.inputSchema.required, [], 'every wave-2a tool is callable with no arguments');
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.outputSchema, 'object');
      for (const key of spec.coverage) {
        assert.ok(tool._coverageKeys.includes(key), `${name} must declare coverage of ${key}`);
      }
    });
  }

  it('first sentences stay inside the tools/list compression budget', () => {
    // Same extraction compressDescription() uses (api/mcp/utils.ts) — asserting
    // on a hand-rolled split would let a description pass here and still be
    // byte-truncated mid-word on the wire.
    for (const name of Object.keys(expected)) {
      const tool = findTool(name);
      const match = tool.description.match(/^[\s\S]+?[.!?](?:\s|$)/);
      assert.ok(match, `${name}: description has no extractable first sentence`);
      const bytes = Buffer.byteLength(match[0].trim(), 'utf8');
      assert.ok(bytes <= 120, `${name}: first sentence is ${bytes} bytes (max 120)`);
    }
  });

  it('documents every parameter it reads', () => {
    const params = {
      get_signal_convergence: ['lat', 'lon', 'radius_km', 'min_domains'],
      get_focal_points: ['country_code', 'limit'],
      simulate_infrastructure_cascade: ['source_id', 'disruption_level'],
      get_military_surge: ['theater'],
    };
    for (const [name, keys] of Object.entries(params)) {
      const tool = findTool(name);
      assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [...keys].sort());
      for (const key of keys) {
        assert.equal(typeof tool.inputSchema.properties[key].description, 'string', `${name}.${key} needs a description`);
      }
    }
  });

  it('advertises convergence bounds that the runtime can honor', () => {
    const schema = findTool('get_signal_convergence').inputSchema.properties;
    assert.equal(schema.min_domains.maximum, 5);
    assert.equal(schema.lat.minimum, -90);
    assert.equal(schema.lat.maximum, 90);
    assert.equal(schema.lon.minimum, -180);
    assert.equal(schema.lon.maximum, 180);
    assert.equal(schema.radius_km.exclusiveMinimum, 0);
  });

  it('documents the focal-point response field with its actual wire name', () => {
    const english = readFileSync(new URL('../docs/mcp-tools-reference.mdx', import.meta.url), 'utf8');
    const chinese = readFileSync(new URL('../docs/zh/mcp-tools-reference.mdx', import.meta.url), 'utf8');
    for (const docs of [english, chinese]) {
      const section = docs.match(/### `get_focal_points`[\s\S]*?(?=\n### `)/)?.[0] ?? '';
      assert.match(section, /`ai_context`/);
      assert.doesNotMatch(section, /`aiContext`/);
    }
  });

  it('publishes a valid cascade source id in the English example', () => {
    const english = readFileSync(new URL('../docs/mcp-tools-reference.mdx', import.meta.url), 'utf8');
    const section = english.match(/### `simulate_infrastructure_cascade`[\s\S]*?(?=\n### `)/)?.[0] ?? '';
    assert.match(section, /"source_id":"chokepoint:hormuz_strait"/);
    assert.doesNotMatch(section, /"source_id":"hormuz"/);
  });
});

// ---------------------------------------------------------------------------
// Error-path envelope conformance
//
// The hybrid tools return whatever `_execute` produces — dispatch injects no
// envelope — so a result-level `{error}` return must STILL carry the keys the
// tool's own outputSchema marks required. tests/mcp-tool-output-contracts.test.mjs
// cannot catch this: it monkey-patches `_execute` for RPC tools, so no error
// path is ever validated against the schema.
// ---------------------------------------------------------------------------

describe('wave-2 analysis tools: user-input error returns honour the declared envelope', () => {
  // Each entry drives a tool down its user-input fault branch WITHOUT any cache
  // read (every guard short-circuits before Upstash), so these run offline.
  const errorCases = [
    ['get_signal_convergence', { lat: 32 }],                       // partial lat/lon/radius triple
    ['get_population_exposure', { mode: 'point' }],                // point mode without coordinates
    ['get_hotspot_escalation', { hotspot_id: 'does-not-exist' }],  // unknown curated id
  ];

  for (const [name, args] of errorCases) {
    it(`${name} returns cached_at/stale/data alongside error`, async () => {
      const tool = findTool(name);
      const result = await tool._execute(args, '', {}, {});
      assert.equal(typeof result.error, 'string', 'error message present');
      assert.ok(result.error.length > 0);
      for (const key of tool.outputSchema.required) {
        assert.ok(key in result, `${name} error return must include required key "${key}"`);
      }
      assert.equal(typeof result.stale, 'boolean');
      assert.equal(typeof result.data, 'object');
      assert.notEqual(result.data, null);
    });
  }

  it('every analysis tool that can return an error declares it in outputSchema', () => {
    for (const name of ['get_signal_convergence', 'simulate_infrastructure_cascade', 'get_population_exposure', 'get_hotspot_escalation']) {
      const tool = findTool(name);
      assert.ok(
        tool.outputSchema.properties.error,
        `${name} returns {error} on user-input faults, so outputSchema must declare it`,
      );
    }
  });
});

describe('wave-2 analysis tools: user-input bounds', () => {
  it('rejects invalid convergence coordinates and radii before reading caches', async () => {
    const tool = findTool('get_signal_convergence');
    for (const args of [
      { lat: 91, lon: 0, radius_km: 10 },
      { lat: 0, lon: 181, radius_km: 10 },
      { lat: 0, lon: 0, radius_km: -1 },
      { lat: 0, lon: 0, radius_km: 20001 },
    ]) {
      const result = await tool._execute(args, '', {}, {});
      assert.match(result.error, /lat.*lon.*radius_km/i);
      assert.deepEqual(result.data.alerts, []);
    }
  });

  it('get_population_exposure rejects out-of-range coordinates instead of guessing a country', () => {
    // Euclidean nearest-centroid has no notion of a valid globe, so lat 999
    // previously resolved to Mali and returned a real-looking estimate.
    const tool = findTool('get_population_exposure');
    return tool._execute({ mode: 'point', lat: 999, lon: -999 }, '', {}, {}).then((result) => {
      assert.match(result.error, /lat must be within/);
      for (const key of tool.outputSchema.required) {
        assert.ok(key in result, `error return must include required key "${key}"`);
      }
    });
  });

  it('accepts coordinates exactly on the range boundary', async () => {
    const tool = findTool('get_population_exposure');
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
      const result = await tool._execute({ mode: 'point', lat, lon, radius_km: 10 }, '', {}, {});
      assert.equal(result.error, undefined, `lat=${lat} lon=${lon} must be accepted`);
      assert.equal(typeof result.data.exposure.exposedPopulation, 'number');
    }
  });

  it('clamps a runaway radius and reports the radius actually used', async () => {
    const tool = findTool('get_population_exposure');
    const result = await tool._execute({ mode: 'point', lat: 31, lon: 34.8, radius_km: 20000 }, '', {}, {});
    assert.equal(result.data.exposure.exposureRadiusKm, 1000);
    assert.ok(result.data.exposure.exposedPopulation < 8.1e10);
  });
});
