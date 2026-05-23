// Protocol-version-floor contract: the live initialize handler advertises
// 2025-03-26 by default and 2025-06-18 when MCP_PROTOCOL_FLOOR_2025_06_18=on,
// while the published server-card advertises the bumped floor unconditionally
// (the card is a static capability declaration; the env var gates only the
// runtime negotiation). The client-version matrix is a structural sanity
// check so a future floor bump can't silently drop a tracked client.
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const VALID_KEY = 'wm_test_key_123';
const BASE_URL = 'https://worldmonitor.app/mcp';

const originalEnv = { ...process.env };

function makeInitReq(protocolVersion) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    }),
  });
}

describe('api/mcp.ts — protocol-version floor', () => {
  before(() => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_TELEMETRY = 'false';
  });

  after(() => {
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('with MCP_PROTOCOL_FLOOR_2025_06_18=on, initialize advertises the live MCP_PROTOCOL_VERSION constant', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'on';
    try {
      const mod = await import(`../api/mcp.ts?t=${Date.now()}_on`);
      const res = await mod.default(makeInitReq('2025-06-18'));
      assert.equal(res.status, 200);
      const body = await res.json();
      // Assert against the live exported constant so this test can't drift
      // if the bumped-floor string ever changes in a future spec revision.
      assert.equal(body.result?.protocolVersion, mod.MCP_PROTOCOL_VERSION);
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
  });

  it('with MCP_PROTOCOL_FLOOR_2025_06_18 unset, initialize advertises 2025-03-26 (safe default)', async () => {
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}_off`);
    const res = await mod.default(makeInitReq('2025-06-18'));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Hardcoded value is deliberate: this test locks in the OFF-default
    // contract so an accidental flip to default-on shows up here.
    assert.equal(body.result?.protocolVersion, '2025-03-26');
  });

  it('server-card.json advertises protocolVersion 2025-06-18 unconditionally', () => {
    const card = JSON.parse(
      readFileSync(
        new URL('../public/.well-known/mcp/server-card.json', import.meta.url),
        'utf8',
      ),
    );
    assert.equal(card.protocolVersion, '2025-06-18');
  });

  it('MCP_SUPPORTED_CLIENT_MATRIX lists each canonical client with a non-empty minimum', async () => {
    const mod = await import(`../api/mcp.ts?t=${Date.now()}_matrix`);
    const matrix = mod.MCP_SUPPORTED_CLIENT_MATRIX;
    assert.ok(matrix && typeof matrix === 'object', 'MCP_SUPPORTED_CLIENT_MATRIX must be exported');
    for (const client of ['Claude Desktop', 'Claude Code', 'MCP Inspector', 'Cursor']) {
      const value = matrix[client];
      assert.equal(typeof value, 'string', `matrix entry for ${client} must be a string`);
      assert.ok(value.length > 0, `matrix entry for ${client} must be non-empty`);
    }
  });
});
