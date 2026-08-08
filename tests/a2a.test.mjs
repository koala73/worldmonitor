import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const CARD_PATH = join(ROOT, 'public/.well-known/agent-card.json');
const SERVER_CARD_PATH = join(ROOT, 'public/.well-known/mcp/server-card.json');
const VERCEL_JSON_PATH = join(ROOT, 'vercel.json');

const card = JSON.parse(readFileSync(CARD_PATH, 'utf-8'));
const serverCard = JSON.parse(readFileSync(SERVER_CARD_PATH, 'utf-8'));
const vercelConfig = JSON.parse(readFileSync(VERCEL_JSON_PATH, 'utf-8'));

// Guards for the A2A surface (orank Identity `a2a-agent-card`): the card at
// /.well-known/agent-card.json and the JSON-RPC endpoint at /a2a must stay
// deployable as a pair — a card pointing at a dead endpoint is exactly the
// phantom-endpoint failure mode the 2026-07 MCP-discovery saga was about.
describe('a2a: agent card contract', () => {
  it('carries the required A2A v0.3.0 fields', () => {
    assert.equal(card.protocolVersion, '0.3.0');
    assert.ok(card.name && typeof card.name === 'string');
    assert.ok(card.description && card.description.length > 50, 'description must be substantive');
    assert.equal(card.url, 'https://www.worldmonitor.app/a2a');
    assert.equal(card.preferredTransport, 'JSONRPC');
    assert.ok(card.version && typeof card.version === 'string');
    assert.ok(Array.isArray(card.defaultInputModes) && card.defaultInputModes.length > 0);
    assert.ok(Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.length > 0);
  });

  it('declares capabilities honestly: no streaming, no push notifications, no tasks', () => {
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.capabilities.stateTransitionHistory, false);
    assert.equal(card.supportsAuthenticatedExtendedCard, false);
  });

  it('every skill has id, name, description, and tags', () => {
    assert.ok(Array.isArray(card.skills) && card.skills.length >= 2);
    for (const skill of card.skills) {
      assert.ok(skill.id, 'skill missing id');
      assert.ok(skill.name, `${skill.id} missing name`);
      assert.ok(skill.description && skill.description.length > 0, `${skill.id} missing description`);
      assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0, `${skill.id} missing tags`);
    }
  });

  it('shares branding with the MCP server card (same icon)', () => {
    assert.equal(card.iconUrl, serverCard.icon);
  });

  it('vercel.json routes /a2a to the endpoint and shields it from the SPA catch-all', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/a2a');
    assert.ok(rewrite, 'missing /a2a rewrite');
    assert.equal(rewrite.destination, '/api/a2a');

    const catchAll = vercelConfig.rewrites.find((r) => r.destination === '/dashboard.html' && r.source.startsWith('/((?!'));
    assert.ok(catchAll, 'dashboard catch-all rewrite missing');
    assert.ok(catchAll.source.includes('a2a'), 'a2a must be excluded from the dashboard catch-all');

    const corsBlock = vercelConfig.headers.find((h) => h.source === '/a2a');
    assert.ok(corsBlock, 'missing /a2a headers block');
    const acao = corsBlock.headers.find((h) => h.key === 'Access-Control-Allow-Origin');
    assert.equal(acao?.value, '*');
  });
});

describe('a2a: JSON-RPC endpoint', () => {
  let handler;
  let suggestTools;

  before(async () => {
    const mod = await import(`../api/a2a.ts?t=${Date.now()}`);
    handler = mod.default;
    suggestTools = mod.suggestTools;
  });

  function post(body) {
    return handler(
      new Request('https://worldmonitor.app/a2a', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  }

  function rpc(method, params, id = 1) {
    return post({ jsonrpc: '2.0', id, method, params });
  }

  it('message/send routes a chokepoint query to get_chokepoint_status', async () => {
    const res = await rpc('message/send', {
      message: {
        role: 'user',
        messageId: 'm-1',
        parts: [{ kind: 'text', text: 'Which tool gives live shipping chokepoint status?' }],
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.ok(body.result, `expected result, got ${JSON.stringify(body.error)}`);
    assert.equal(body.result.kind, 'message');
    assert.equal(body.result.role, 'agent');
    assert.ok(body.result.messageId, 'response message must carry a messageId');
    const textPart = body.result.parts.find((p) => p.kind === 'text');
    const dataPart = body.result.parts.find((p) => p.kind === 'data');
    assert.ok(textPart?.text.length > 0, 'must include a text part');
    assert.ok(dataPart, 'must include a data part');
    const names = dataPart.data.suggestedTools.map((t) => t.name);
    assert.ok(names.includes('get_chokepoint_status'), `expected get_chokepoint_status in ${names}`);
    assert.ok(dataPart.data.howToCall.mcp.endpoint.endsWith('/mcp'));
  });

  it('message/send accepts the pre-0.3 part dialect ({type: "text"})', async () => {
    const res = await rpc('message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: 'country risk scores' }] },
    });
    const body = await res.json();
    assert.ok(body.result, `expected result, got ${JSON.stringify(body.error)}`);
    assert.ok(body.result.parts.some((p) => p.kind === 'data'));
  });

  it('message/send answers freshness queries with the public freshness envelope', async () => {
    const res = await rpc('message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'Is the market data fresh right now?' }] },
    });
    const body = await res.json();
    assert.ok(body.result, `expected result, got ${JSON.stringify(body.error)}`);
    const dataPart = body.result.parts.find((p) => p.kind === 'data');
    assert.ok(dataPart.data.freshness, 'freshness envelope must be attached');
    assert.ok('stale' in dataPart.data.freshness, 'freshness envelope must carry stale');
  });

  it('message/send echoes a provided contextId', async () => {
    const res = await rpc('message/send', {
      message: { role: 'user', contextId: 'ctx-42', parts: [{ kind: 'text', text: 'sanctions data' }] },
    });
    const body = await res.json();
    assert.equal(body.result.contextId, 'ctx-42');
  });

  it('message/send without a text part → -32602', async () => {
    const res = await rpc('message/send', { message: { role: 'user', parts: [{ kind: 'file' }] } });
    const body = await res.json();
    assert.equal(body.error.code, -32602);
  });

  it('unsupported optional methods → -32004; tasks → -32001; extended card → -32007; unknown → -32601', async () => {
    for (const [method, code] of [
      ['message/stream', -32004],
      ['tasks/resubscribe', -32004],
      ['tasks/pushNotificationConfig/set', -32004],
      ['tasks/get', -32001],
      ['tasks/cancel', -32001],
      ['agent/getAuthenticatedExtendedCard', -32007],
      ['bogus/method', -32601],
    ]) {
      const res = await rpc(method, {});
      const body = await res.json();
      assert.equal(body.error?.code, code, `${method} must answer ${code}`);
    }
  });

  it('malformed JSON → -32700; non-2.0 envelope → -32600', async () => {
    const bad = await post('{not json');
    assert.equal((await bad.json()).error.code, -32700);
    const wrong = await post({ id: 1, method: 'message/send' });
    assert.equal((await wrong.json()).error.code, -32600);
  });

  it('GET → 405 with Allow header; OPTIONS → 204 with CORS', async () => {
    const get = await handler(new Request('https://worldmonitor.app/a2a', { method: 'GET' }));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('Allow'), 'POST, OPTIONS');
    const options = await handler(new Request('https://worldmonitor.app/a2a', { method: 'OPTIONS' }));
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('responses are JSON, uncacheable, and CORS-open', async () => {
    const res = await rpc('bogus/method', {});
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('suggestTools: empty/stopword-only queries return no suggestions', () => {
    assert.deepEqual(suggestTools(''), []);
    assert.deepEqual(suggestTools('what can you give'), []);
  });

  it('card skill ids match the behaviours the endpoint implements', () => {
    const ids = card.skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['check-data-freshness', 'route-to-tool']);
  });
});
