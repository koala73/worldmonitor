/**
 * RFC 9728 path-scoped metadata for the MCP resource.
 *
 * A protected resource whose identifier carries a path publishes its metadata
 * at the well-known URI with that path appended:
 * `/.well-known/oauth-protected-resource/mcp` describes `https://<host>/mcp`.
 * Clients that build that URL themselves — rather than following our
 * `WWW-Authenticate` pointer — got the SPA 404 and had nowhere to go, which is
 * a sign-in button that does nothing. Every hosted MCP server whose sign-in
 * works in those clients (Linear, Sentry, Notion) serves the path-scoped
 * document, and names the full `/mcp` URL as its `resource`.
 *
 * The root documents stay exactly as they were: clients that discovered them
 * before this change keep working.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prmHandler from '../api/oauth-protected-resource.ts';
import asHandler from '../api/oauth-authorization-server.ts';

const vercelConfig = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../vercel.json'), 'utf-8'),
);

const HOSTS = ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'];
const get = (handler, host, path) => handler(new Request(`https://${host}${path}`, { headers: { host } }));

describe('protected-resource metadata — path-scoped /mcp document', () => {
  for (const host of HOSTS) {
    it(`${host} describes the /mcp resource, not the origin`, async () => {
      const res = await get(prmHandler, host, '/.well-known/oauth-protected-resource/mcp');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('vary'), 'Host');
      const json = await res.json();
      assert.equal(json.resource, `https://${host}/mcp`);
      assert.deepEqual(json.authorization_servers, [`https://${host}`]);
      assert.deepEqual(json.bearer_methods_supported, ['header']);
    });
  }

  it('the root document still describes the origin', async () => {
    const json = await (await get(prmHandler, 'worldmonitor.app', '/.well-known/oauth-protected-resource')).json();
    assert.equal(json.resource, 'https://worldmonitor.app');
  });

  it('a spoofed Host is not reflected into the path-scoped resource', async () => {
    const res = await prmHandler(new Request('https://worldmonitor.app/.well-known/oauth-protected-resource/mcp', {
      headers: { host: 'evil.example' },
    }));
    assert.equal((await res.json()).resource, 'https://worldmonitor.app/mcp');
  });

  it('only the /mcp suffix is served — an unknown resource path is not invented', async () => {
    const res = await get(prmHandler, 'worldmonitor.app', '/.well-known/oauth-protected-resource/not-a-resource');
    assert.equal(res.status, 404);
  });
});

describe('authorization-server metadata — path-scoped probe', () => {
  for (const host of HOSTS) {
    it(`${host} serves the same issuer document under /mcp`, async () => {
      const res = await get(asHandler, host, '/.well-known/oauth-authorization-server/mcp');
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.issuer, `https://${host}`);
      assert.equal(json.authorization_endpoint, `https://${host}/oauth/authorize`);
      assert.equal(json.authorization_response_iss_parameter_supported, true);
    });
  }
});

describe('the MCP 401 challenge points at the path-scoped document', () => {
  it('wwwAuthHeader carries the /mcp resource metadata URL', async () => {
    const { wwwAuthHeader } = await import('../api/mcp/auth.ts');
    assert.equal(
      wwwAuthHeader('https://worldmonitor.app/.well-known/oauth-protected-resource/mcp'),
      'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('an unauthenticated data call answers with the path-scoped pointer', async () => {
    const { mcpHandler } = await import('../api/mcp/handler.ts');
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { host: 'worldmonitor.app', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_world_brief', arguments: {} } }),
    }), undefined, { skip: false });
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/worldmonitor\.app\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });
});

describe('routing', () => {
  for (const source of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server/mcp',
  ]) {
    it(`${source} is rewritten to its handler ahead of the SPA catch-all`, () => {
      const index = vercelConfig.rewrites.findIndex((r) => r.source === source);
      assert.ok(index >= 0, `expected a rewrite for ${source}`);
      const catchAll = vercelConfig.rewrites.findIndex((r) => r.source === '/(.*)' || r.source === '/:path*');
      if (catchAll >= 0) assert.ok(index < catchAll, `${source} must precede the SPA catch-all`);
    });
  }
});
