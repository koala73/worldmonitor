/**
 * Dynamic Client Registration redirect_uri allowlist (#8303).
 *
 * DCR is open to anyone, and the registered redirect_uri is where the
 * authorization code is delivered, so the allowlist is exact-match against
 * vendor-published MCP client callbacks plus http loopback. Each accepted URI
 * below is the verbatim value the client sends; each rejection guards a
 * matching mistake (prefix, lookalike host, scheme, trailing slash, query).
 *
 * Clients register every callback they might use in one request and one
 * disallowed entry rejects the whole registration, so the multi-URI cases
 * (Grok Bot, VS Code) are tested as the exact arrays those clients send.
 */

import { strict as assert } from 'node:assert';
import { afterEach, before, after, describe, it } from 'node:test';

const REDIS_URL = 'https://redis.test';
const originalFetch = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const { default: registerHandler } = await import('../api/oauth/register.js');
const { isAllowedRedirectUri } = await import('../api/oauth/_redirect-uri.js');

const HOSTED_CLIENT_CALLBACKS = {
  'Claude (claude.ai)': 'https://claude.ai/api/mcp/auth_callback',
  'Claude (claude.com)': 'https://claude.com/api/mcp/auth_callback',
  'Cursor Agents / web, Grok Bot': 'https://www.cursor.com/agents/mcp/oauth/callback',
  'Cursor legacy deeplink, Grok Bot': 'cursor://anysphere.cursor-mcp/oauth/callback',
  'ChatGPT (stable, RFC 9207)': 'https://chatgpt.com/connector_platform_oauth_redirect',
  'Grok (grok.com)': 'https://grok.com/connectors-oauth-exchange-code/',
  'Grok (console.x.ai)': 'https://console.x.ai/connectors-oauth-exchange-code/',
  'VS Code for the Web': 'https://vscode.dev/redirect',
  'VS Code Insiders for the Web': 'https://insiders.vscode.dev/redirect',
  'Perplexity': 'https://www.perplexity.ai/rest/connections/oauth_callback',
  'Perplexity Enterprise': 'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
  'Mistral Le Chat': 'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
  'Devin': 'https://api.devin.ai/mcp/oauth/callback',
  'Google Antigravity': 'https://antigravity.google/oauth-callback',
  'Vercel Connect': 'https://connect.vercel.com/callback',
  'Cursor Bot, Grok Bot': 'https://www.cursor.com/bot/mcp/oauth/callback',
  'Make.com MCP Client': 'https://www.make.com/oauth/cb/mcp',
  'Notion (notion.so)': 'https://www.notion.so/workflows/mcp/oauth/callback',
  'Notion (app.notion.com)': 'https://app.notion.com/workflows/mcp/oauth/callback',
  'Linear': 'https://linear.app/connect/mcp/callback',
  'Lovable': 'https://api.lovable.dev/workspaces/connectors/mcp/oauth/callback',
  'Microsoft 365 Copilot': 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect',
  'Factory': 'https://app.factory.ai/mcp/oauth/callback',
  'Factory EU': 'https://app.eu.factory.ai/mcp/oauth/callback',
  'Conductor': 'https://api.conductor.build/oauth/callback',
  'Skydive': 'https://www.skydive.com/api/v1/external-oauth/callback',
  'MCPJam': 'https://app.mcpjam.com/oauth/callback',
  'MCPJam score': 'https://score.mcpjam.com/oauth/callback',
  'Glama connectors': 'https://glama.ai/api/app/mcp/oauth/callback',
  'Glama Inspector': 'https://glama.ai/mcp/inspector/oauth/callback',
  'Meta Muse': 'https://agent.meta.ai/api/hatch/oauth/callback',
};

const LOOPBACK = [
  'http://localhost:8787/callback', // Cursor desktop, Grok Bot
  'http://127.0.0.1/', // VS Code desktop
  'http://127.0.0.1:33418/', // VS Code desktop, fixed-port fallback
  'http://localhost:6274/oauth/callback', // MCP Inspector
  'http://[::1]/oauth_callback', // goose, IPv6 loopback
  'http://[::1]:33418/callback',
];

const REJECTED = {
  'arbitrary https host': 'https://evil.example/callback',
  'cursor.com without www': 'https://cursor.com/agents/mcp/oauth/callback',
  'lookalike host (dot is not a wildcard)': 'https://wwwxcursor.com/agents/mcp/oauth/callback',
  'suffix host': 'https://www.cursor.com.evil.example/agents/mcp/oauth/callback',
  'userinfo host smuggling': 'https://www.cursor.com@evil.example/agents/mcp/oauth/callback',
  'trailing slash': 'https://chatgpt.com/connector_platform_oauth_redirect/',
  'Grok callback without the trailing slash Grok sends': 'https://grok.com/connectors-oauth-exchange-code',
  'www.grok.com (Grok never sends it)': 'https://www.grok.com/connectors-oauth-exchange-code/',
  'the unverified grok.com/connectors/oauth/callback': 'https://grok.com/connectors/oauth/callback',
  'Gemini per-user callback (dynamic, not exact-matchable)':
    'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123-api_worldmonitor_app',
  'muse.ai (Muse never sends the redirect target)': 'https://muse.ai/api/hatch/oauth/callback',
  'extra query': 'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
  'fragment': 'https://claude.ai/api/mcp/auth_callback#x',
  'sibling path under an allowed callback': 'https://claude.ai/api/mcp/auth_callback/../evil',
  'http downgrade of a hosted callback': 'http://chatgpt.com/connector_platform_oauth_redirect',
  'uppercase host variant': 'https://ChatGPT.com/connector_platform_oauth_redirect',
  'other cursor:// path': 'cursor://anysphere.cursor-mcp/evil',
  'https loopback': 'https://localhost:8787/callback',
  'loopback lookalike host': 'http://localhost.evil.example/callback',
  'loopback userinfo smuggling': 'http://localhost@evil.example/callback',
  'Vercel Connect callback with a trailing slash': 'https://connect.vercel.com/callback/',
  'other path on connect.vercel.com': 'https://connect.vercel.com/evil',
  'vercel.com without the connect subdomain': 'https://vercel.com/callback',
  'Factory staging host': 'https://staging.app.factory.ai/mcp/oauth/callback',
  'Factory dev host': 'https://dev.app.factory.ai/mcp/oauth/callback',
  'Factory preprod EU host': 'https://preprod.app.eu.factory.ai/mcp/oauth/callback',
  'MCPJam staging host': 'https://staging.mcpjam.com/oauth/callback',
  'MCPJam www.score host': 'https://www.score.mcpjam.com/oauth/callback',
  'MCPJam debug callback': 'https://app.mcpjam.com/oauth/callback/debug',
  'Glama callback on www': 'https://www.glama.ai/api/app/mcp/oauth/callback',
  'Glama app callback with a trailing slash': 'https://glama.ai/api/app/mcp/oauth/callback/',
  'other path on glama.ai': 'https://glama.ai/callback',
  'LobeHub cloud (derived from source, not vendor-published)': 'https://app.lobehub.com/oauth/connector/callback',
  'Teams callback with a lowercased path': 'https://teams.microsoft.com/api/platform/v1.0/oauthredirect',
  'https IPv6 loopback': 'https://[::1]/oauth_callback',
  'non-loopback IPv6 literal': 'http://[::2]/oauth_callback',
  'IPv4-mapped IPv6 loopback': 'http://[::ffff:7f00:1]/oauth_callback',
  'javascript scheme': 'javascript:alert(1)',
  'not a URL': 'not a url',
};

describe('isAllowedRedirectUri', () => {
  for (const [client, uri] of Object.entries(HOSTED_CLIENT_CALLBACKS)) {
    it(`accepts ${client}: ${uri}`, () => assert.equal(isAllowedRedirectUri(uri), true));
  }
  for (const uri of LOOPBACK) {
    it(`accepts http loopback ${uri}`, () => assert.equal(isAllowedRedirectUri(uri), true));
  }
  for (const [why, uri] of Object.entries(REJECTED)) {
    it(`rejects ${why}: ${uri}`, () => assert.equal(isAllowedRedirectUri(uri), false));
  }
});

describe('POST /oauth/register', () => {
  let stored;

  before(() => {
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function stubRedis() {
    stored = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).startsWith(`${REDIS_URL}/`), `unexpected fetch ${input}`);
      const body = JSON.parse(init.body);
      const pipeline = Array.isArray(body[0]);
      const results = (pipeline ? body : [body]).map((command) => {
        if (['eval', 'evalsha'].includes(command[0].toLowerCase())) return { result: [4, 5] };
        stored.push(command);
        return { result: 'OK' };
      });
      return Response.json(pipeline ? results : results[0]);
    };
  }

  const register = (body) => registerHandler(new Request('https://api.worldmonitor.app/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  it('registers Grok Bot, which sends all three Cursor callbacks in one request', async () => {
    stubRedis();
    const redirect_uris = [
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'http://localhost:8787/callback',
    ];
    const res = await register({ client_name: 'Grok Bot', redirect_uris });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.deepEqual(json.redirect_uris, redirect_uris);
    assert.equal(stored.length, 1);
    assert.deepEqual(JSON.parse(stored[0][2]).redirect_uris, redirect_uris);
  });

  it('registers VS Code, which sends four redirect_uris in one request', async () => {
    stubRedis();
    // Verbatim from microsoft/vscode src/vs/base/common/oauth.ts fetchDynamicRegistration.
    const redirect_uris = [
      'https://insiders.vscode.dev/redirect',
      'https://vscode.dev/redirect',
      'http://127.0.0.1/',
      'http://127.0.0.1:33418/',
    ];
    const res = await register({ client_name: 'Visual Studio Code', redirect_uris });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).redirect_uris, redirect_uris);
  });

  it('registers Cursor, which sends every callback in its published client metadata', async () => {
    stubRedis();
    // Verbatim from https://cursor.com/oauth/mcp-client.json (fetched 2026-10-17).
    const redirect_uris = [
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'https://www.cursor.com/bot/mcp/oauth/callback',
      'https://grok.com/connectors-oauth-exchange-code/',
      'http://localhost:8787/callback',
      'http://127.0.0.1:8787/callback',
    ];
    const res = await register({ client_name: 'Cursor', redirect_uris });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).redirect_uris, redirect_uris);
  });

  it('registers goose, which sends IPv4 and IPv6 loopback', async () => {
    stubRedis();
    // Verbatim from https://goose-docs.ai/oauth/client-metadata.json (fetched 2026-10-17).
    const redirect_uris = ['http://127.0.0.1/oauth_callback', 'http://[::1]/oauth_callback'];
    const res = await register({ client_name: 'goose', redirect_uris });
    assert.equal(res.status, 201);
    assert.deepEqual((await res.json()).redirect_uris, redirect_uris);
  });

  it('registers Vercel Connect with the metadata it sends', async () => {
    stubRedis();
    // https://vercel.com/docs/connect/providers: exact callback, public client, PKCE.
    const redirect_uris = ['https://connect.vercel.com/callback'];
    const res = await register({
      client_name: 'Vercel Connect',
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.deepEqual(json.redirect_uris, redirect_uris);
    assert.equal(json.token_endpoint_auth_method, 'none');
    assert.deepEqual(json.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(stored.length, 1);
  });

  it('still caps redirect_uris per registration', async () => {
    stubRedis();
    const redirect_uris = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${3000 + i}/callback`);
    const res = await register({ client_name: 'Too many', redirect_uris });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_request');
    assert.equal(stored.length, 0);
  });

  it('rejects the whole registration when any one redirect_uri is not allowed, and stores nothing', async () => {
    stubRedis();
    const res = await register({
      client_name: 'Mixed',
      redirect_uris: ['https://www.cursor.com/agents/mcp/oauth/callback', 'https://evil.example/cb'],
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'invalid_redirect_uri');
    assert.match(json.error_description, /https:\/\/evil\.example\/cb/);
    assert.match(json.error_description, /https:\/\/www\.worldmonitor\.app\/docs\/mcp-overview#redirect-uri-allowlist/);
    assert.equal(stored.length, 0);
  });
});
