// MCP capability-parity test — catches two structural drift modes at once:
//
//   1. Drift between public/.well-known/mcp/server-card.json::capabilities
//      (what external scanners read) and initialize.result.capabilities
//      (what the wire serves). A future PR that flips one but forgets the
//      other ships an advertised-but-unserved capability — discovery
//      scanners 404 on the flagged surface.
//
//   2. Advertised-but-empty — a capability flag is on but the matching
//      registry is empty at runtime. The list method returns
//      `{ <capability>: [] }`, which is spec-valid but useless to clients
//      and indistinguishable (to a casual reader) from "capability not
//      offered". Catches accidental truncation of PROMPT_REGISTRY,
//      RESOURCE_REGISTRY, or TOOL_REGISTRY.
//
// Normalization: server-card encodes capabilities as booleans (`tools: true`);
// initialize emits an object per capability (`tools: {}` for passive,
// `prompts: { listChanged: false }` for config). The value shapes are not
// commensurable — only the KEY presence is. Both sides project to
// Set<string> of advertised capability names; the value shape is per-spec
// opaque.
//
// `logging` is structurally registry-less — it's a passive-ACK capability
// (the handler returns `{}` for `logging/setLevel` but doesn't push
// `notifications/message`). The allowlist exempts it from the non-empty
// check. Adding a future passive-ACK capability requires editing this file
// deliberately — that is the discipline this test is buying.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { BASE_URL } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_capability_parity';

// Capabilities that are structurally registry-less — advertised, but with no
// `<cap>/list` method or backing registry to be non-empty.
//   - `logging`: a passive receive-side capability — the handler ACKs
//     `logging/setLevel` but the stateless edge transport can't push
//     `notifications/message` (same reason `listChanged: false` on
//     prompts/resources).
//   - `extensions`: the MCP-Apps negotiation key
//     (`extensions['io.modelcontextprotocol/ui']`, spec 2026-01-26). It is a
//     handshake declaration, not a listable collection — the extension's
//     CONTENT (ui:// app-shell resources, tool `_meta.ui.resourceUri`) is
//     enumerated via resources/list + tools/list under the existing
//     `resources`/`tools` capabilities, and is asserted directly in
//     tests/mcp-resources.test.mjs. Non-emptiness of `extensions` itself is
//     guarded below (the declared value must name the ui extension).
// Future passive/declaration-only additions require an explicit edit to this
// allowlist AND a positive assertion in the "structurally exempt" tests below.
const REGISTRYLESS_CAPABILITIES = new Set(['logging', 'extensions']);

// Mapping from advertised-capability name → (list-method, response-key,
// __testing__ registry name). Three entries; an abstraction would obscure
// the deliberate per-capability discipline this test is enforcing.
const CAPABILITY_WIRE = {
  tools: { method: 'tools/list', responseKey: 'tools', registryKey: 'TOOL_REGISTRY' },
  prompts: { method: 'prompts/list', responseKey: 'prompts', registryKey: 'PROMPT_REGISTRY' },
  resources: { method: 'resources/list', responseKey: 'resources', registryKey: 'RESOURCE_REGISTRY' },
};

function makeReq(body) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
    },
    body: JSON.stringify(body),
  });
}

function loadServerCardCapabilities() {
  const path = new URL('../public/.well-known/mcp/server-card.json', import.meta.url);
  const raw = readFileSync(path, 'utf8');
  const card = JSON.parse(raw);
  assert.ok(card.capabilities && typeof card.capabilities === 'object',
    'server-card.json must declare a capabilities object');
  return card.capabilities;
}

// Project server-card { tools: true, logging: true, ... } → Set<string>.
// Only `=== true` counts as advertised; a hypothetical `false` entry would
// be a deliberate disable that the parity test must respect.
function advertisedFromCard(capabilities) {
  return new Set(
    Object.entries(capabilities).filter(([, v]) => v === true).map(([k]) => k),
  );
}

// Project initialize { tools: {}, prompts: { listChanged: false }, ... } →
// Set<string>. Per spec, presence of a key in initialize.result.capabilities
// is the advertised signal — the value is per-spec opaque (config object).
function advertisedFromInitialize(capabilities) {
  return new Set(Object.keys(capabilities));
}

let handler;
let registries;
// Snapshot of server-card.json::capabilities, captured once per test in
// beforeEach. Hoisted out of the individual tests so all four assertions
// within a single run observe the exact same on-disk snapshot — and so
// the disk read isn't repeated three times per run.
let cardCaps;

describe('api/mcp.ts — capability parity (advertised AND non-empty)', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_TELEMETRY = 'false';

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-cap-parity`);
    handler = mod.default;
    registries = mod.__testing__;
    cardCaps = loadServerCardCapabilities();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('advertised-capability set parity between server-card.json and initialize', async () => {
    const cardSet = advertisedFromCard(cardCaps);

    const res = await handler(makeReq({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.capabilities && typeof body.result.capabilities === 'object',
      'initialize.result.capabilities must be an object');
    const initSet = advertisedFromInitialize(body.result.capabilities);

    const onlyOnCard = [...cardSet].filter((k) => !initSet.has(k)).sort();
    const onlyOnInit = [...initSet].filter((k) => !cardSet.has(k)).sort();
    assert.deepEqual(
      { onlyOnCard, onlyOnInit },
      { onlyOnCard: [], onlyOnInit: [] },
      `capability drift: server-card advertises [${[...cardSet].sort().join(', ')}]; ` +
      `initialize advertises [${[...initSet].sort().join(', ')}]; ` +
      `only on server-card: [${onlyOnCard.join(', ')}]; only on initialize: [${onlyOnInit.join(', ')}]`,
    );
  });

  it('every advertised capability has a non-empty wire response (defense at the contract layer)', async () => {
    const advertised = advertisedFromCard(cardCaps);

    for (const cap of advertised) {
      if (REGISTRYLESS_CAPABILITIES.has(cap)) continue;
      const wire = CAPABILITY_WIRE[cap];
      assert.ok(wire,
        `capability "${cap}" is advertised but has no CAPABILITY_WIRE mapping — ` +
        `add a {method, responseKey, registryKey} entry or extend LOGGING_HAS_NO_REGISTRY deliberately`,
      );

      const res = await handler(makeReq({ jsonrpc: '2.0', id: 2, method: wire.method, params: {} }));
      assert.equal(res.status, 200, `${wire.method} must return 200`);
      const body = await res.json();
      const list = body.result?.[wire.responseKey];
      assert.ok(Array.isArray(list),
        `${wire.method} result.${wire.responseKey} must be an array; got ${typeof list}`,
      );
      assert.ok(list.length >= 1,
        `'${cap}' is advertised but ${wire.method} returned 0 entries — advertised-but-empty`,
      );
    }
  });

  it('every advertised capability has a non-empty registry (defense at the source layer)', () => {
    const advertised = advertisedFromCard(cardCaps);

    for (const cap of advertised) {
      if (REGISTRYLESS_CAPABILITIES.has(cap)) continue;
      const wire = CAPABILITY_WIRE[cap];
      assert.ok(wire,
        `capability "${cap}" is advertised but has no CAPABILITY_WIRE mapping — see sibling test`,
      );
      const registry = registries[wire.registryKey];
      assert.ok(Array.isArray(registry),
        `__testing__.${wire.registryKey} must be an array; got ${typeof registry}`,
      );
      assert.ok(registry.length >= 1,
        `'${cap}' is advertised but __testing__.${wire.registryKey} is empty — advertised-but-empty`,
      );
    }
  });

  it('logging capability is advertised AND structurally exempt from the registry check', () => {
    const advertised = advertisedFromCard(cardCaps);
    assert.ok(advertised.has('logging'),
      `'logging' must remain advertised — removing it requires editing this test deliberately ` +
      `(advertised: [${[...advertised].sort().join(', ')}])`,
    );
    assert.ok(REGISTRYLESS_CAPABILITIES.has('logging'),
      `'logging' must remain in REGISTRYLESS_CAPABILITIES — removing it requires editing this test deliberately`,
    );
  });

  it('extensions capability (MCP Apps) is advertised, structurally exempt, AND names the ui extension on the wire', async () => {
    const advertised = advertisedFromCard(cardCaps);
    assert.ok(advertised.has('extensions'),
      `'extensions' must remain advertised on the server-card — the MCP-Apps ` +
      `negotiation key is how hosts/scanners classify an MCP-App surface ` +
      `(advertised: [${[...advertised].sort().join(', ')}])`,
    );
    assert.ok(REGISTRYLESS_CAPABILITIES.has('extensions'),
      `'extensions' must remain in REGISTRYLESS_CAPABILITIES — it is a handshake ` +
      `declaration, not a listable registry`,
    );

    // Advertised-but-empty guard, extensions edition: the initialize wire must
    // declare the ui extension key, not just an empty `extensions: {}` object.
    // An empty extensions map reads (to a scanner) as "no MCP Apps support",
    // the exact failure this capability exists to prevent.
    const res = await handler(makeReq({
      jsonrpc: '2.0', id: 3, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    }));
    const body = await res.json();
    const extensions = body.result?.capabilities?.extensions;
    assert.ok(extensions && typeof extensions === 'object',
      'initialize.result.capabilities.extensions must be an object');
    assert.ok(
      Object.prototype.hasOwnProperty.call(extensions, 'io.modelcontextprotocol/ui'),
      `initialize must declare the MCP Apps extension key 'io.modelcontextprotocol/ui'; ` +
      `got extensions=${JSON.stringify(extensions)}`,
    );
  });

  it('server-card daily-quota notes mirror metadata exemptions', () => {
    const card = JSON.parse(
      readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'),
    );
    assert.deepEqual(
      card.rateLimits?.dailyByPlan,
      {
        pro: 50,
        apiStarter: null,
        apiBusiness: null,
        enterprise: null,
      },
      'server-card must not advertise API-tier MCP daily caps that the handler does not enforce',
    );
    const notes = card.rateLimits?.notes;
    assert.equal(typeof notes, 'string', 'server-card rateLimits.notes must be a string');
    assert.match(notes, /Pro\/OAuth contexts only/i, 'notes must scope the hard daily reservation to Pro/OAuth contexts');
    assert.match(notes, /API-key .* do not use this MCP daily reservation path/i,
      'notes must disclose that env_key/API-key MCP callers do not use the daily reservation path');
    assert.doesNotMatch(notes, /1,000|1000|10,000|10000/,
      'notes must not publish API Starter/Business MCP daily caps that are not enforced');
    for (const method of [
      'initialize',
      'tools/list',
      'prompts/list',
      'prompts/get',
      'resources/list',
      'resources/templates/list',
      'logging/setLevel',
      'notifications/initialized',
      'ping',
      'describe_tool',
    ]) {
      assert.ok(notes.includes(method), `${method} must be named in daily-quota notes`);
    }
    assert.match(notes, /Per-minute .* counts ALL methods/i, 'notes must distinguish per-minute from daily exemptions');
  });

  // The card carries the identity fields BOTH top-level (for scanners that read
  // the flat shape, e.g. ora.ai's mcp-server-card check) AND nested under
  // serverInfo (the shape the handler + sibling tests read). Guard the two from
  // drifting on the next version bump.
  it('top-level server-card identity mirrors serverInfo (no drift)', () => {
    const card = JSON.parse(
      readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'),
    );
    assert.equal(card.name, card.serverInfo?.name, 'top-level name must mirror serverInfo.name');
    assert.equal(card.version, card.serverInfo?.version, 'top-level version must mirror serverInfo.version');
    assert.equal(card.description, card.serverInfo?.description, 'top-level description must mirror serverInfo.description');
    assert.equal(card.serverUrl, card.transport?.endpoint, 'top-level serverUrl must mirror transport.endpoint');
  });

});

describe('docs/mcp-server.mdx — API-key quota contract', () => {
  it('keeps API-key auth separate from the Pro/OAuth daily reservation path', () => {
    const docs = readFileSync(new URL('../docs/mcp-server.mdx', import.meta.url), 'utf8');
    assert.doesNotMatch(docs, /Both modes check the same PRO entitlement/i,
      'docs must not claim API-key requests use the OAuth/Pro entitlement pre-check path');
    assert.match(docs, /OAuth bearer requests re-check[\s\S]*active entitlement[\s\S]*before dispatch/i,
      'docs must describe the OAuth entitlement re-check path');
    assert.match(docs, /Direct `X-WorldMonitor-Key` requests[\s\S]*configured API key[\s\S]*per-key (?:rate )?limiter/i,
      'docs must describe API-key MCP auth and per-key minute limiting without implying Pro daily quota reservation');
    assert.match(docs, /REST\/API plan allowances[\s\S]*outside[\s\S]*Pro\/OAuth MCP daily reservation path/i,
      'docs must keep REST/API plan allowances separate from MCP daily reservation semantics');
    assert.match(docs, /`wm_…` MCP calls[\s\S]*no MCP daily reservation/i,
      'docs must state that wm_ API-key MCP calls have no MCP daily reservation');
  });
});
