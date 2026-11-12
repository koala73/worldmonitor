/**
 * `_meta.ui.domain` is host-defined. ChatGPT's app submission wants the site
 * origin there. Claude reads the field as its own sandbox host
 * (`<hash>.claudemcpcontent.com`) and refuses to render a view whose value
 * does not match, so with the site origin every World Monitor view failed in
 * Claude with "There was a problem displaying content". Only ChatGPT gets the
 * field; every other host gets views without it.
 *
 * Manufact Cloud's compatibility check and the manufact.com leaderboard review
 * (`mcp-use-probe`) are the other recipients. They check ChatGPT submission
 * metadata but reach the server with a browser or Bun user agent, so the only
 * stable marker is the clientInfo name every request carries in params._meta.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp/handler.ts';
import { UI_RESOURCE_LIST_RESPONSE } from '../api/mcp/ui/registry.ts';
import { HMAC_SECRET, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const CHATGPT_UA = 'openai-mcp/1.0.0 (ChatGPT)';
const CLAUDE_UA = 'Claude-User';
const SHELL_VIEW = UI_RESOURCE_LIST_RESPONSE.find((r) => r.uri.startsWith('ui://') && r.uri.includes('country-risk'));

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function rpc(method, params, { userAgent, signedIn = true } = {}) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const headers = { Accept: 'application/json', ...(userAgent ? { 'User-Agent': userAgent } : {}) };
  const req = signedIn
    ? proReq('POST', body, headers)
    : new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const response = await mcpHandler(req, makeProDeps().deps);
  assert.equal(response.status, 200, `${method} status`);
  return (await response.json()).result;
}

const viewDomains = (entries) => entries.filter((e) => String(e.uri).startsWith('ui://')).map((e) => e._meta?.ui?.domain);

describe('view domain per host', () => {
  it('the fixture view exists', () => assert.ok(SHELL_VIEW, 'country-risk view'));

  for (const signedIn of [true, false]) {
    const who = signedIn ? 'signed in' : 'anonymous';

    it(`ChatGPT keeps the site origin on every view (${who})`, async () => {
      const list = await rpc('resources/list', {}, { userAgent: CHATGPT_UA, signedIn });
      const domains = viewDomains(list.resources);
      assert.ok(domains.length >= 12);
      assert.deepEqual([...new Set(domains)], ['https://www.worldmonitor.app']);
      const read = await rpc('resources/read', { uri: SHELL_VIEW.uri }, { userAgent: CHATGPT_UA, signedIn });
      assert.equal(read.contents[0]._meta.ui.domain, 'https://www.worldmonitor.app');
    });

    for (const userAgent of [CLAUDE_UA, 'claude-code/2.1.0 (cli)', undefined]) {
      it(`${userAgent ?? 'no user agent'} gets views without ui.domain (${who})`, async () => {
        const list = await rpc('resources/list', {}, { userAgent, signedIn });
        const views = list.resources.filter((r) => r.uri.startsWith('ui://'));
        assert.ok(views.length >= 12);
        for (const view of views) {
          assert.equal('domain' in (view._meta?.ui ?? {}), false, view.uri);
          assert.ok(view._meta.ui.csp, `${view.uri} keeps its CSP`);
        }
        const read = await rpc('resources/read', { uri: SHELL_VIEW.uri }, { userAgent, signedIn });
        assert.equal('domain' in read.contents[0]._meta.ui, false);
        assert.ok(read.contents[0].text.length > 0, 'view HTML still served');
      });
    }
  }

  describe('Manufact Cloud compatibility check', () => {
    const meta = (name) => ({ _meta: { 'io.modelcontextprotocol/clientInfo': { name, version: '2' } } });
    const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

    // The manufact.com leaderboard review is a separate scanner from the Cloud
    // check. On 2026-11-12 it initialized as `mcp-use-probe` with a Bun user agent.
    for (const clientName of ['Manufact Cloud', 'mcp-use-probe']) {
      for (const signedIn of [true, false]) {
        const who = signedIn ? 'signed in' : 'anonymous';
        for (const userAgent of [BROWSER_UA, 'Bun/1.4.4']) {
          it(`${clientName} gets the site origin on every view (${who}, ${userAgent.slice(0, 7)})`, async () => {
            const list = await rpc('resources/list', meta(clientName), { userAgent, signedIn });
            const domains = viewDomains(list.resources);
            assert.ok(domains.length >= 12);
            assert.deepEqual([...new Set(domains)], ['https://www.worldmonitor.app']);
            const read = await rpc('resources/read', { uri: SHELL_VIEW.uri, ...meta(clientName) }, { userAgent, signedIn });
            assert.equal(read.contents[0]._meta.ui.domain, 'https://www.worldmonitor.app');
          });
        }
      }
    }

    // The leaderboard review speaks the 2025 session protocol: its clientInfo
    // name arrives only on `initialize`, and later requests carry just the
    // Mcp-Session-Id the server minted (seen 2026-11-12 14:53 UTC: initialize,
    // notifications/initialized, two POSTs, DELETE, all Bun/1.4.4).
    async function initialize(clientName) {
      const body = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1' } },
      };
      const req = proReq('POST', body, { Accept: 'application/json', 'User-Agent': 'Bun/1.4.4' });
      const response = await mcpHandler(req, makeProDeps().deps);
      assert.equal(response.status, 200);
      const sessionId = response.headers.get('Mcp-Session-Id');
      assert.ok(sessionId, 'initialize mints a session id');
      return sessionId;
    }
    async function sessionRpc(method, params, sessionId) {
      const body = { jsonrpc: '2.0', id: 2, method, params };
      const headers = { Accept: 'application/json', 'User-Agent': 'Bun/1.4.4', 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' };
      const req = proReq('POST', body, headers);
      const response = await mcpHandler(req, makeProDeps().deps);
      assert.equal(response.status, 200, `${method} status`);
      return (await response.json()).result;
    }

    // Session initialize requires sign-in (anonymous initialize is 401), and the
    // leaderboard review signs in, so only the signed-in path is exercised.
    for (const clientName of ['Manufact Cloud', 'mcp-use-probe']) {
      it(`${clientName} named only at initialize keeps the domain for its session`, async () => {
        const sessionId = await initialize(clientName);
        const list = await sessionRpc('resources/list', {}, sessionId);
        const domains = viewDomains(list.resources);
        assert.ok(domains.length >= 12);
        assert.deepEqual([...new Set(domains)], ['https://www.worldmonitor.app']);
        const read = await sessionRpc('resources/read', { uri: SHELL_VIEW.uri }, sessionId);
        assert.equal(read.contents[0]._meta.ui.domain, 'https://www.worldmonitor.app');
      });
    }

    for (const clientName of ['claude-ai', 'Claude Code', 'Cursor', undefined]) {
      it(`a session started by ${clientName ?? 'a nameless client'} gets views without ui.domain`, async () => {
        const sessionId = await initialize(clientName);
        const list = await sessionRpc('resources/list', {}, sessionId);
        const views = list.resources.filter((r) => r.uri.startsWith('ui://'));
        assert.ok(views.length >= 12);
        for (const view of views) assert.equal('domain' in (view._meta?.ui ?? {}), false, view.uri);
      });
    }

    it('a browser with another client name still gets views without ui.domain', async () => {
      const list = await rpc('resources/list', meta('Claude'), { userAgent: BROWSER_UA });
      for (const view of list.resources.filter((r) => r.uri.startsWith('ui://'))) {
        assert.equal('domain' in (view._meta?.ui ?? {}), false, view.uri);
      }
    });

    it('a non-string client name is ignored', async () => {
      const list = await rpc('resources/list', meta({ toString: () => 'Manufact Cloud' }), { userAgent: BROWSER_UA });
      for (const view of list.resources.filter((r) => r.uri.startsWith('ui://'))) {
        assert.equal('domain' in (view._meta?.ui ?? {}), false, view.uri);
      }
    });
  });

  it('does not mutate the shared registry metadata', async () => {
    await rpc('resources/list', {}, { userAgent: CLAUDE_UA });
    assert.equal(SHELL_VIEW._meta.ui.domain, 'https://www.worldmonitor.app');
  });
});
