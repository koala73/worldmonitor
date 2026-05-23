// Protocol-version-floor + negotiation contract:
//
//   - With MCP_PROTOCOL_FLOOR_2025_06_18 unset, the server supports only
//     [2025-03-26] — the safe default.
//   - With MCP_PROTOCOL_FLOOR_2025_06_18=on, the server supports both
//     [2025-03-26, 2025-06-18] so old + new clients are both served
//     correctly during the rollout window.
//   - On `initialize`, the server returns the client's requested version
//     verbatim if it is in the supported set; otherwise the server returns
//     the latest supported version (its own preferred). This matches the
//     MCP lifecycle spec's "respond with what you support" rule.
//   - The published server-card advertises the bumped floor unconditionally
//     (the card is a static capability declaration; negotiation happens at
//     the live initialize handler).
//   - The client-version matrix is a structural sanity check so a future
//     floor bump can't silently drop a tracked client.
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

  it('env on + client requests 2025-06-18 → server returns 2025-06-18 (latest supported)', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'on';
    try {
      const mod = await import(`../api/mcp.ts?t=${Date.now()}_on_new`);
      const res = await mod.default(makeInitReq('2025-06-18'));
      assert.equal(res.status, 200);
      const body = await res.json();
      // Assert against the live exported constant so this test can't drift
      // if the latest-supported string ever changes in a future spec revision.
      assert.equal(body.result?.protocolVersion, mod.MCP_PROTOCOL_VERSION);
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
  });

  it('env on + client requests 2025-03-26 → server negotiates down to 2025-03-26 (the rollout-safety guarantee)', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'on';
    try {
      const mod = await import(`../api/mcp.ts?t=${Date.now()}_on_down`);
      const res = await mod.default(makeInitReq('2025-03-26'));
      assert.equal(res.status, 200);
      const body = await res.json();
      // Hardcoded: this is the load-bearing assertion for the env-var flip.
      // If the server stops returning 2025-03-26 to clients pinned there,
      // the rollout safety net is gone and pre-floor clients will disconnect.
      assert.equal(body.result?.protocolVersion, '2025-03-26');
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
  });

  it('env on + client requests an unsupported version → server returns the latest supported (fallback)', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'on';
    try {
      const mod = await import(`../api/mcp.ts?t=${Date.now()}_on_unknown`);
      const res = await mod.default(makeInitReq('1999-01-01'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result?.protocolVersion, mod.MCP_PROTOCOL_VERSION);
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
  });

  it('env unset + client requests 2025-06-18 → server returns 2025-03-26 (safe default; unsupported request)', async () => {
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}_off`);
    const res = await mod.default(makeInitReq('2025-06-18'));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Hardcoded: locks in the OFF-default contract — an accidental flip to
    // default-on shows up here.
    assert.equal(body.result?.protocolVersion, '2025-03-26');
  });

  it('MCP_SUPPORTED_PROTOCOL_VERSIONS is gated by the env var', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'on';
    try {
      const modOn = await import(`../api/mcp.ts?t=${Date.now()}_supported_on`);
      assert.deepEqual([...modOn.MCP_SUPPORTED_PROTOCOL_VERSIONS], ['2025-03-26', '2025-06-18']);
      // Latest-supported convention: MCP_PROTOCOL_VERSION is the last entry.
      assert.equal(
        modOn.MCP_PROTOCOL_VERSION,
        modOn.MCP_SUPPORTED_PROTOCOL_VERSIONS[modOn.MCP_SUPPORTED_PROTOCOL_VERSIONS.length - 1],
      );
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
    const modOff = await import(`../api/mcp.ts?t=${Date.now()}_supported_off`);
    assert.deepEqual([...modOff.MCP_SUPPORTED_PROTOCOL_VERSIONS], ['2025-03-26']);
    assert.equal(modOff.MCP_PROTOCOL_VERSION, '2025-03-26');
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
