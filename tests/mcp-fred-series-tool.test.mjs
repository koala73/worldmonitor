/**
 * #5707 (item: on-demand FRED series) — the dashboard exposes curated
 * FRED-derived series, and the seeded universe is already servable through
 * the get-fred-series-batch RPC's allowlist, but agents had no way to pull
 * a common macro series (UNRATE, CPIAUCSL, FEDFUNDS…) on demand.
 *
 * get_fred_series is the bounded parameterized surface: the tool answers
 * through the canonical RPC (same allowlist, same seeded cache, zero new
 * seeders and zero external calls), and its description names the exact
 * allowlist so agents can discover what is servable — with a parity test
 * pinning that list to the server's own ALLOWED_SERIES set.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HMAC_SECRET,
  callBody,
  makeProDeps,
  PRO_USER_ID,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const FRED_RPC_PATH = '/api/economic/v1/get-fred-series-batch';

const canonicalResponse = {
  results: {
    UNRATE: {
      seriesId: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      observations: [
        { date: '2026-07-01', value: 4.2 },
        { date: '2026-08-01', value: 4.3 },
      ],
    },
  },
  fetched: 1,
  requested: 1,
};

describe('get_fred_series MCP tool (#5707)', () => {
  let mcpHandler;
  let requests;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    requests = [];
    globalThis.fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(canonicalResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const mod = await import(`../api/mcp.ts?fred-series=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('lists the tool and answers through the canonical FRED batch RPC', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_fred_series');
    assert.ok(tool, 'tool must be discoverable through tools/list');
    assert.deepEqual(tool.inputSchema.required, ['series_ids']);

    requests = [];
    const { deps } = makeProDeps();
    const response = await mcpHandler(
      proReq('POST', callBody('get_fred_series', { series_ids: ['unrate'] })),
      deps,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    const downstream = requests.find((entry) => {
      try { return new URL(entry.url).pathname === FRED_RPC_PATH; } catch { return false; }
    });
    assert.ok(downstream, 'tool must answer through the canonical RPC, not a second FRED implementation');
    const sent = JSON.parse(downstream.init.body);
    assert.deepEqual(sent.seriesIds, ['UNRATE'], 'ids are normalized to the allowlist casing');
    assert.match(downstream.init.headers['X-WM-MCP-Internal'] ?? '', /^\d+\.[A-Za-z0-9_-]+$/);
    assert.equal(downstream.init.headers['X-WM-MCP-User-Id'], PRO_USER_ID);

    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.fetched, 1);
    assert.equal(payload.results.UNRATE.observations.length, 2);
  });

  it('caps the observation window by default so a 20-series pull cannot blow the output budget', async () => {
    requests = [];
    const { deps } = makeProDeps();
    await mcpHandler(proReq('POST', callBody('get_fred_series', { series_ids: ['UNRATE'] })), deps);

    const downstream = requests.find((entry) => String(entry.url).includes(FRED_RPC_PATH));
    const sent = JSON.parse(downstream.init.body);
    assert.ok(
      Number.isFinite(sent.limit) && sent.limit > 0 && sent.limit <= 60,
      `the tool must send a bounded default observation limit, got ${sent.limit}`,
    );
  });

  it('forwards valid bounded limits and at most twenty normalized ids', async () => {
    const { deps } = makeProDeps();
    await mcpHandler(proReq('POST', callBody('get_fred_series', {
      series_ids: Array.from({ length: 25 }, (_, i) => i % 2 ? ' unrate ' : ' cpiAUCSL '),
      limit: 1000,
    })), deps);
    const downstream = requests.find((entry) => String(entry.url).includes(FRED_RPC_PATH));
    const sent = JSON.parse(downstream.init.body);
    assert.equal(sent.limit, 1000);
    assert.deepEqual(sent.seriesIds, ['CPIAUCSL', 'UNRATE']);
  });

  it('rejects empty arrays and blank ids before making a downstream request', async () => {
    for (const series_ids of [[], [''], [' \t '], ['UNRATE', ' ']]) {
      requests = [];
      const { deps } = makeProDeps();
      const response = await mcpHandler(proReq('POST', callBody('get_fred_series', { series_ids })), deps);
      const body = await response.json();
      assert.equal(body.error?.code, -32602, JSON.stringify({ series_ids, body }));
      assert.equal(requests.filter((entry) => String(entry.url).includes(FRED_RPC_PATH)).length, 0);
    }
  });

  it('filters unsupported ids and duplicates before the canonical sorted twenty-series cap', async () => {
    const { economicFredSeriesIds: allowed } = JSON.parse(readFileSync('shared/openapi-filter-param-contracts.json', 'utf8'));
    for (const series_ids of [
      [...Array(20).fill('UNKNOWN_ID'), 'unrate'],
      [...Array(20).fill('UNRATE'), ' cpiAUCSL '],
      [...allowed].reverse(),
    ]) {
      requests = [];
      const { deps } = makeProDeps();
      await mcpHandler(proReq('POST', callBody('get_fred_series', { series_ids })), deps);
      const downstream = requests.find((entry) => String(entry.url).includes(FRED_RPC_PATH));
      const sent = JSON.parse(downstream.init.body);
      const expected = [...new Set(series_ids.map((id) => id.trim().toUpperCase()).filter((id) => allowed.includes(id)))].sort().slice(0, 20);
      assert.deepEqual(sent.seriesIds, expected);
    }
  });

  it('returns the canonical empty result without downstream work when no ids are supported', async () => {
    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('get_fred_series', {
      series_ids: ['UNKNOWN_ID', 'not-a-seeded-series'],
    })), deps);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(body.result.content[0].text), { results: {}, fetched: 0, requested: 0 });
    assert.equal(requests.filter((entry) => String(entry.url).includes(FRED_RPC_PATH)).length, 0);
  });

  it('rejects fractional and out-of-range limits before making a downstream request', async () => {
    for (const limit of [1.5, 1001, 0, -1]) {
      requests = [];
      const { deps } = makeProDeps();
      const response = await mcpHandler(proReq('POST', callBody('get_fred_series', {
        series_ids: ['UNRATE'], limit,
      })), deps);
      const body = await response.json();
      assert.equal(body.error.code, -32602);
      assert.equal(requests.filter((entry) => String(entry.url).includes(FRED_RPC_PATH)).length, 0);
    }
  });

  it("the description advertises the canonical server series allowlist", async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_fred_series');

    const { economicFredSeriesIds: serverIds } = JSON.parse(
      readFileSync('shared/openapi-filter-param-contracts.json', 'utf8'),
    );
    assert.ok(serverIds.length > 10);

    for (const id of serverIds) {
      assert.ok(
        tool.inputSchema.properties.series_ids.description.includes(id),
        `series_ids description must advertise ${id} — the allowlist an agent cannot discover is a guessing game`,
      );
    }
  });
});
