/**
 * MCP evaluation case (#9722): an enterprise agent-platform customer asked
 * "Compare the resilience of the UAE vs. Saudi Arabia to subsea cable
 * disruption." This file pins the tool chain that answers it and runs the
 * cable step offline against the seeded TeleGeography cable table shape
 * (src/config/geo-map.ts mirrors what scripts/seed-submarine-cables.mjs
 * writes) plus a cable-health snapshot.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable.ts';
import { submarineCablesToCableInputs } from '../shared/analysis-mcp-adapters.ts';
import { UNDERSEA_CABLES } from '../src/config/geo-map.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const findTool = (name) => TOOL_REGISTRY.find((tool) => tool.name === name);

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_URL;
  if (ORIGINAL_REDIS_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_TOKEN;
});

/** The evaluation case: the question, the chain an agent should run, and the facts the answer must carry. */
const EVAL_CASE = {
  id: 'subsea-cable-resilience-uae-vs-saudi',
  question: 'Compare the resilience of the UAE vs. Saudi Arabia to subsea cable disruption.',
  chain: [
    {
      tool: 'simulate_infrastructure_cascade',
      args: { countries: ['United Arab Emirates', 'Saudi Arabia'] },
      purpose: 'Per-country cable count, landing stations, chokepoint exposure and active cable faults.',
    },
    {
      tool: 'simulate_infrastructure_cascade',
      args: { cut_cables_through: 'chokepoint:hormuz_strait' },
      purpose: 'Stress test: estimated per-country impact if every cable through Hormuz is cut.',
    },
    {
      tool: 'simulate_infrastructure_cascade',
      args: { cut_cables_through: 'chokepoint:bab_el_mandeb' },
      purpose: 'Stress test: the Red Sea route that Saudi west-coast cables depend on.',
    },
    {
      tool: 'get_infrastructure_status',
      args: { country: 'AE', dataset: ['outages', 'traffic'] },
      purpose: 'Current national Internet outages and traffic anomalies (repeat for SA).',
    },
    {
      tool: 'get_resilience_indicators',
      args: { country_code: 'AE' },
      purpose: 'cyberDigital and infrastructure dimensions of the resilience score (repeat for SA).',
    },
  ],
};

const NOW = Date.now();
const CABLE_HEALTH = {
  generatedAt: NOW - 10 * 60_000,
  cables: {
    seamewe_6: {
      status: 'CABLE_HEALTH_STATUS_FAULT',
      score: 0.92,
      confidence: 0.85,
      lastUpdated: NOW - 2 * 3_600_000,
      evidence: [{ source: 'NGA', summary: 'SEA-ME-WE 6 cable fault reported; repair ship on station.', ts: NOW - 2 * 3_600_000 }],
    },
    falcon: { status: 'CABLE_HEALTH_STATUS_DEGRADED', score: 0.6, confidence: 0.5, lastUpdated: NOW - 3_600_000, evidence: [] },
    marea: { status: 'CABLE_HEALTH_STATUS_FAULT', score: 0.9, confidence: 0.9, lastUpdated: NOW - 3_600_000, evidence: [] },
    imewe: { status: 'CABLE_HEALTH_STATUS_OK', score: 0.1, confidence: 0.2, lastUpdated: NOW - 3_600_000, evidence: [] },
  },
};

function install({ misses = [] } = {}) {
  const fixtures = {
    'infrastructure:submarine-cables:v1': { cables: structuredClone(UNDERSEA_CABLES), fetchedAt: NOW },
    'seed-meta:infrastructure:submarine-cables': { fetchedAt: NOW, recordCount: UNDERSEA_CABLES.length },
    'cable-health-v1': CABLE_HEALTH,
    'seed-meta:cable-health': { fetchedAt: NOW, recordCount: Object.keys(CABLE_HEALTH.cables).length },
  };
  for (const key of misses) delete fixtures[key];
  installRedis(fixtures, { keepVercelEnv: true });
}

const landsIn = (code) => UNDERSEA_CABLES.filter((cable) => (cable.landingPoints ?? []).some((lp) => lp.country === code));

describe(`MCP eval: ${EVAL_CASE.id}`, () => {
  it('every chain step names a registered tool with arguments its inputSchema accepts', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const step of EVAL_CASE.chain) {
      const tool = findTool(step.tool);
      assert.ok(tool, `${step.tool} must be registered`);
      const validate = ajv.compile(tool.inputSchema);
      assert.ok(validate(step.args), `${step.tool} rejects ${JSON.stringify(step.args)}: ${ajv.errorsText(validate.errors)}`);
      for (const arg of Object.keys(step.args)) {
        assert.ok(tool.inputSchema.properties[arg], `${step.tool} must declare ${arg}`);
      }
    }
  });

  it('an agent reading tool descriptions can find the per-country cable exposure view', () => {
    const matches = TOOL_REGISTRY.filter((tool) =>
      /submarine-cable|subsea cable/i.test(tool.description)
      && /landing station/i.test(tool.description)
      && /countries/.test(tool.description));
    assert.deepEqual(matches.map((tool) => tool.name), ['simulate_infrastructure_cascade']);
    const countries = findTool('simulate_infrastructure_cascade').inputSchema.properties.countries;
    assert.equal(countries.type, 'array');
    assert.ok(countries.maxItems >= 2);
    assert.match(countries.description, /landing/i);
  });

  it('the seeded-cable adapter keeps route geometry so Red Sea crossings are detected', () => {
    const [mapped] = submarineCablesToCableInputs({ cables: [UNDERSEA_CABLES.find((cable) => cable.id === 'seamewe_6')] });
    assert.ok(Array.isArray(mapped.points) && mapped.points.length > 2, 'route points must survive the adapter');
    assert.deepEqual(mapped.points[0], UNDERSEA_CABLES.find((cable) => cable.id === 'seamewe_6').points[0]);
  });

  it('answers the cable step with landing stations, redundancy, chokepoint exposure and active faults', async () => {
    install();
    const result = await findTool('simulate_infrastructure_cascade')._execute(EVAL_CASE.chain[0].args, '', {}, {});
    assert.equal(result.stale, false);
    assert.deepEqual(result.unavailable_inputs, []);
    assert.equal(result.data.catalog, null);
    assert.equal(result.data.cascade, null);
    assert.equal(result.data.health_available, true);

    const exposure = result.data.exposure;
    assert.deepEqual(exposure.map((entry) => entry.country), ['AE', 'SA']);
    const [ae, sa] = exposure;

    // Cable count and landing stations come straight from the seeded table.
    assert.equal(ae.cableCount, landsIn('AE').length);
    assert.equal(sa.cableCount, landsIn('SA').length);
    assert.ok(ae.cableCount >= 10 && sa.cableCount >= 10);
    for (const city of ['Fujairah', 'Kalba', 'Dubai', 'Abu Dhabi']) {
      assert.ok(ae.landingStations.some((station) => station.city === city), `AE lands at ${city}`);
    }
    for (const city of ['Jeddah', 'Yanbu', 'Al Khobar', 'Duba']) {
      assert.ok(sa.landingStations.some((station) => station.city === city), `SA lands at ${city}`);
    }
    assert.equal(ae.landingStationCount, ae.landingStations.length);
    const fujairah = ae.landingStations.find((station) => station.city === 'Fujairah');
    assert.ok(fujairah.cables >= 5, 'Fujairah is the UAE concentration point');

    // Chokepoint exposure: the UAE's Gulf of Oman landings bypass Hormuz; Saudi
    // Arabia has a Gulf coast (Hormuz) and a Red Sea coast (Bab el-Mandeb / Suez).
    const share = (entry, id) => entry.chokepointExposure.find((row) => row.chokepoint === id)?.share ?? 0;
    assert.ok(share(ae, 'chokepoint:hormuz_strait') > 0 && share(ae, 'chokepoint:hormuz_strait') < 1);
    assert.ok(share(sa, 'chokepoint:hormuz_strait') > 0);
    assert.ok(
      share(sa, 'chokepoint:bab_el_mandeb') > 0 || share(sa, 'chokepoint:suez') > 0,
      'Saudi Red Sea cables must register a Red Sea chokepoint',
    );
    for (const entry of exposure) {
      const max = Math.max(...entry.chokepointExposure.map((row) => row.share));
      assert.equal(entry.largestSingleChokepointShare, max);
      assert.equal(
        entry.cablesAvoidingChokepoints,
        entry.cables.filter((cable) => cable.chokepoints.length === 0).length,
      );
      assert.ok(entry.chokepointExposure.every((row, i, rows) => i === 0 || rows[i - 1].cables >= row.cables));
    }

    // Active incidents: SEA-ME-WE 6 (FAULT) and FALCON (DEGRADED) land in both
    // countries; MAREA (transatlantic) and an OK record never appear.
    for (const entry of exposure) {
      const incidents = Object.fromEntries(entry.activeIncidents.map((row) => [row.cableId, row.status]));
      assert.deepEqual(incidents, { seamewe_6: 'FAULT', falcon: 'DEGRADED' });
      assert.equal(entry.cables.find((cable) => cable.id === 'seamewe_6').health.status, 'FAULT');
      assert.equal(entry.cables.find((cable) => cable.id === 'imewe')?.health ?? null, null);
    }
    const fault = ae.activeIncidents.find((row) => row.cableId === 'seamewe_6');
    assert.match(fault.evidence[0].summary, /SEA-ME-WE 6/);
    assert.equal(result.data.exposure_note.length > 0, true);
  });

  it('runs the Red Sea stress-test step with route geometry intact', async () => {
    install();
    const result = await findTool('simulate_infrastructure_cascade')._execute(EVAL_CASE.chain[2].args, '', {}, {});
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.data.cascade.sources.length > 0);
  });

  it('keeps the exposure topology when the cable-health snapshot is missing, and says so', async () => {
    install({ misses: ['cable-health-v1'] });
    const result = await findTool('simulate_infrastructure_cascade')._execute({ countries: ['AE'] }, '', {}, {});
    assert.equal(result.data.health_available, false);
    assert.ok(result.unavailable_inputs.includes('cable-health-v1'));
    assert.equal(result.stale, true);
    assert.equal(result.data.exposure[0].cableCount, landsIn('AE').length);
    assert.deepEqual(result.data.exposure[0].activeIncidents, []);
  });

  it('refuses to answer exposure without the cable table', async () => {
    install({ misses: ['infrastructure:submarine-cables:v1'] });
    await assert.rejects(
      () => findTool('simulate_infrastructure_cascade')._execute({ countries: ['SA'] }, '', {}, {}),
      (error) => error instanceof McpSourceUnavailableError
        && error.unavailableInputs.includes('infrastructure:submarine-cables:v1'),
    );
  });

  it('rejects an unresolvable country before reading caches', async () => {
    globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
    await assert.rejects(
      () => findTool('simulate_infrastructure_cascade')._execute({ countries: ['AE', 'Atlantis'] }, '', {}, {}),
      (error) => error.name === 'RpcValidationError' && error.violations[0].field === 'countries',
    );
  });

  it('rejects bad countries in _validateArgs, before dispatch reserves quota', () => {
    const tool = findTool('simulate_infrastructure_cascade');
    assert.equal(typeof tool._validateArgs, 'function');
    for (const countries of [['Atlantis'], ['ZZ'], ['AE', 'XX']]) {
      assert.throws(
        () => tool._validateArgs({ countries }),
        (error) => error.name === 'RpcValidationError' && error.violations[0].field === 'countries',
        `${JSON.stringify(countries)} must be rejected`,
      );
    }
    tool._validateArgs({ countries: ['AE', 'Saudi Arabia', 'SAU'] });
    tool._validateArgs({});
  });

  it('reports a resolvable country with no seeded cable landing as zero exposure', async () => {
    install();
    const result = await findTool('simulate_infrastructure_cascade')._execute({ countries: ['Switzerland'] }, '', {}, {});
    assert.equal(result.data.exposure[0].country, 'CH');
    assert.equal(result.data.exposure[0].cableCount, 0);
    assert.equal(result.data.exposure[0].largestSingleChokepointShare, 0);
  });
});
