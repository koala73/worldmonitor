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

  it('only known transport paths are served — an unknown resource path is not invented', async () => {
    const res = await get(prmHandler, 'worldmonitor.app', '/.well-known/oauth-protected-resource/not-a-resource');
    assert.equal(res.status, 404);
  });

  // Production rewrites suffixes to /api/oauth-protected-resource?resource=...,
  // which drops the well-known pathname. An unknown query must still 404 rather
  // than fall through to the origin-wide document.
  it('a rewritten unknown resource query is 404, not the origin-wide document', async () => {
    const res = await get(prmHandler, 'worldmonitor.app', '/api/oauth-protected-resource?resource=not-a-resource');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });

  it('a rewritten known resource query still serves that document', async () => {
    const json = await (await get(prmHandler, 'worldmonitor.app', '/api/oauth-protected-resource?resource=mcp')).json();
    assert.equal(json.resource, 'https://worldmonitor.app/mcp');
  });

  // The suffix rewrite forwards a multi-segment suffix, which arrives either
  // literally or percent-encoded depending on how the platform serializes it.
  for (const query of ['resource=api/mcp', 'resource=api%2Fmcp']) {
    it(`a rewritten ?${query} serves the /api/mcp document`, async () => {
      const json = await (await get(prmHandler, 'api.worldmonitor.app', `/api/oauth-protected-resource?${query}`)).json();
      assert.equal(json.resource, `https://${'api'}.worldmonitor.app/api/mcp`);
    });
  }

  // A client can put anything in the query of the origin-wide well-known URL.
  // That URL names the origin, whatever the query says.
  it('the origin-wide well-known URL ignores a client-supplied resource query', async () => {
    const res = await get(prmHandler, 'worldmonitor.app', '/.well-known/oauth-protected-resource?resource=mcp');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resource, 'https://worldmonitor.app');
  });

  it('the rewritten origin-wide path without a resource query still describes the origin', async () => {
    const json = await (await get(prmHandler, 'worldmonitor.app', '/api/oauth-protected-resource')).json();
    assert.equal(json.resource, 'https://worldmonitor.app');
  });

  // `/api/mcp` is the deployed route (api/mcp.ts) and the URL
  // docs/usage-quickstart.mdx publishes. The MCP SDK accepts a resource only
  // when the requested path starts with the advertised one, so a client on
  // `/api/mcp` cannot be handed the `/mcp` document.
  it('describes /api/mcp for the deployed route', async () => {
    const json = await (await get(prmHandler, 'api.worldmonitor.app', '/.well-known/oauth-protected-resource/api/mcp')).json();
    assert.equal(json.resource, `https://${'api'}.worldmonitor.app/api/mcp`);
    assert.deepEqual(json.authorization_servers, [`https://${'api'}.worldmonitor.app`]);
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

  const call = async (url, host) => {
    const { mcpHandler } = await import('../api/mcp/handler.ts');
    return mcpHandler(new Request(url, {
      method: 'POST',
      headers: { host, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_world_brief', arguments: {} } }),
    }), undefined, { skip: false });
  };

  it('an unauthenticated data call answers with the path-scoped pointer', async () => {
    const res = await call('https://worldmonitor.app/mcp', 'worldmonitor.app');
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/worldmonitor\.app\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  // The challenge must name a host we actually serve metadata from. The
  // metadata handlers validate Host and fall back to the apex, so a challenge
  // built from the raw header could send discovery somewhere else entirely.
  it('a spoofed Host is not reflected into the challenge', async () => {
    const res = await call('https://worldmonitor.app/mcp', 'evil.example');
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/worldmonitor\.app\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  it('a retired /api/mcp transport request gets the migration error before auth', async () => {
    const res = await call(`https://${'api'}.worldmonitor.app/api/mcp`, 'api.worldmonitor.app');
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'Use https://worldmonitor.app/mcp',
        data: {
          reason: 'canonical_endpoint_required',
          endpoint: 'https://worldmonitor.app/mcp',
        },
      },
    });
  });

  // The well-known aliases are the same transport under a different URL
  // (handler.ts WELL_KNOWN_MCP_PATHS). Neither `/mcp` nor `/api/mcp` is a
  // prefix of `/.well-known/mcp`, so a path-scoped pointer would advertise a
  // resource that does not cover the caller. The origin-wide document does.
  for (const alias of ['/.well-known/mcp', '/.well-known/mcp.json']) {
    it(`${alias} advertises the origin-wide document, which covers it`, async () => {
      const res = await call(`https://worldmonitor.app${alias}`, 'worldmonitor.app');
      assert.equal(res.status, 401);
      assert.equal(
        res.headers.get('www-authenticate'),
        'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"',
      );
    });
  }

  it('a query parameter cannot bypass the /api/mcp migration response', async () => {
    const res = await call(`https://${'api'}.worldmonitor.app/api/mcp?transport=mcp`, 'api.worldmonitor.app');
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error?.data?.reason, 'canonical_endpoint_required');
  });

  // The edge function observes the original path: production serves markdown at
  // /mcp and the JSON card at /.well-known/mcp, and both are rewritten to
  // /api/mcp — handler.ts picks between them by pathname. So the transport path
  // is read from the pathname alone, with no tag on the rewrite.
  it('the /mcp rewrite stays a plain path rewrite', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/mcp');
    assert.ok(rewrite, 'expected the /mcp rewrite');
    assert.equal(rewrite.destination, '/api/mcp');
  });
});

describe('routing', () => {
  // Every suffix reaches the handler, so an unsupported one gets the handler's
  // JSON 404 rather than the SPA's HTML 404 — an exact-match rewrite per
  // transport path would let unknown suffixes fall through to the filesystem.
  it('any protected-resource suffix reaches the handler, carrying the suffix', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source.startsWith('/.well-known/oauth-protected-resource/'));
    assert.ok(rewrite, 'expected a protected-resource suffix rewrite');
    assert.match(rewrite.source, /:\w+\*?$/, 'the rewrite must capture any suffix');
    assert.match(rewrite.destination, /^\/api\/oauth-protected-resource\?resource=:/);
  });

  for (const source of [
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/oauth-authorization-server/api/mcp',
  ]) {
    it(`${source} is rewritten to its handler ahead of the SPA catch-all`, () => {
      const index = vercelConfig.rewrites.findIndex((r) => r.source === source);
      assert.ok(index >= 0, `expected a rewrite for ${source}`);
      const catchAll = vercelConfig.rewrites.findIndex((r) => r.source === '/(.*)' || r.source === '/:path*');
      if (catchAll >= 0) assert.ok(index < catchAll, `${source} must precede the SPA catch-all`);
    });
  }
});
