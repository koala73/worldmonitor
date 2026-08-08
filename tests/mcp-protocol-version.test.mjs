// Protocol-version-floor + negotiation contract:
//
//   - By DEFAULT (env unset, or =on) the server supports both
//     [2025-03-26, 2025-06-18] and negotiates 2025-06-18 — kept in lock-step
//     with the static server card, which advertises 2025-06-18.
//   - With MCP_PROTOCOL_FLOOR_2025_06_18=off the server pins back to the
//     legacy [2025-03-26]-only floor (the explicit rollback kill-switch).
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

  it('env unset (default) + client requests 2025-06-18 → server returns 2025-06-18 (default-on)', async () => {
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}_default`);
    const res = await mod.default(makeInitReq('2025-06-18'));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Hardcoded: locks in the DEFAULT-ON contract — an accidental revert to
    // default-off shows up here. This is the version the static server card
    // advertises, so the handshake stays in lock-step with the card (what
    // lets a strict scanner's protocol-version validation pass).
    assert.equal(body.result?.protocolVersion, '2025-06-18');
  });

  it('env off (kill-switch) + client requests 2025-06-18 → server returns 2025-03-26 (legacy floor)', async () => {
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'off';
    try {
      const mod = await import(`../api/mcp.ts?t=${Date.now()}_killswitch`);
      const res = await mod.default(makeInitReq('2025-06-18'));
      assert.equal(res.status, 200);
      const body = await res.json();
      // The =off rollback pins the server to the legacy floor, so a client
      // requesting the bumped version negotiates down to the legacy default.
      assert.equal(body.result?.protocolVersion, '2025-03-26');
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
  });

  it('MCP_SUPPORTED_PROTOCOL_VERSIONS defaults to both versions; =off pins to the legacy floor', async () => {
    // Default (env unset): both versions supported, latest = 2025-06-18.
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    const modDefault = await import(`../api/mcp.ts?t=${Date.now()}_supported_default`);
    assert.deepEqual([...modDefault.MCP_SUPPORTED_PROTOCOL_VERSIONS], ['2025-03-26', '2025-06-18']);
    // Latest-supported convention: MCP_PROTOCOL_VERSION is the last entry.
    assert.equal(
      modDefault.MCP_PROTOCOL_VERSION,
      modDefault.MCP_SUPPORTED_PROTOCOL_VERSIONS[modDefault.MCP_SUPPORTED_PROTOCOL_VERSIONS.length - 1],
    );
    // Kill-switch (=off): legacy floor only.
    process.env.MCP_PROTOCOL_FLOOR_2025_06_18 = 'off';
    try {
      const modOff = await import(`../api/mcp.ts?t=${Date.now()}_supported_off`);
      assert.deepEqual([...modOff.MCP_SUPPORTED_PROTOCOL_VERSIONS], ['2025-03-26']);
      assert.equal(modOff.MCP_PROTOCOL_VERSION, '2025-03-26');
    } finally {
      delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
    }
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
