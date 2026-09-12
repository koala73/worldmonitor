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

  it("the description's advertised allowlist is the server's ALLOWED_SERIES, verbatim", async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_fred_series');

    const serverSource = readFileSync('server/worldmonitor/economic/v1/get-fred-series-batch.ts', 'utf8');
    const setBlock = serverSource.match(/const ALLOWED_SERIES = new Set<string>\(\[([\s\S]*?)\]\);/);
    assert.ok(setBlock, 'server allowlist must stay a literal Set');
    const serverIds = [...setBlock[1].matchAll(/'([A-Z0-9]+)'/g)].map((m) => m[1]);
    assert.ok(serverIds.length > 10);

    for (const id of serverIds) {
      assert.ok(
        tool.inputSchema.properties.series_ids.description.includes(id),
        `series_ids description must advertise ${id} — the allowlist an agent cannot discover is a guessing game`,
      );
    }
  });
});
