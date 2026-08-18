import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from '../api/agent-auth.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));

const call = (host, init) =>
  handler(new Request('https://' + host + '/agent/auth', { headers: { host }, ...init }));

describe('agent-auth WWW-Authenticate challenge (/agent/auth)', () => {
  it('answers a plain GET with 401 + RFC 9728 WWW-Authenticate pointing at the PRM', async () => {
    const res = await call('worldmonitor.app', { method: 'GET' });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"',
    );
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('returns a machine-readable body with the auth discovery pointers', async () => {
    const body = await (await call('worldmonitor.app', { method: 'GET' })).json();
    assert.equal(body.error, 'unauthorized');
    assert.equal(
      body.resource_metadata,
      'https://worldmonitor.app/.well-known/oauth-protected-resource',
    );
    assert.equal(
      body.authorization_server,
      'https://worldmonitor.app/.well-known/oauth-authorization-server',
    );
    assert.equal(body.skill, 'https://worldmonitor.app/auth.md');
  });

  it('derives resource_metadata from the request Host (www stays self-consistent)', async () => {
    const res = await call('www.worldmonitor.app', { method: 'GET' });
    assert.equal(
      res.headers.get('www-authenticate'),
      'Bearer realm="worldmonitor", resource_metadata="https://www.worldmonitor.app/.well-known/oauth-protected-resource"',
    );
  });

  it('never reflects a spoofed Host — falls back to the apex origin', async () => {
    const res = await call('evil.example', { method: 'GET' });
    assert.match(
      res.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/worldmonitor\.app\/\.well-known\/oauth-protected-resource"/,
    );
  });

  it('answers CORS preflight', async () => {
    const res = await call('worldmonitor.app', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, OPTIONS');
  });

  it('is wired in vercel.json ahead of the SPA catch-all', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === '/agent/auth');
    assert.ok(rewrite, 'expected a rewrite for /agent/auth');
    assert.equal(rewrite.destination, '/api/agent-auth');

    // #6575: the dashboard catch-all rewrite is gone — unknown paths 404.
    // /agent/auth keeps its explicit endpoint rewrite, which cannot be shadowed.
    const catchAll = vercelConfig.rewrites.find(
      (r) => r.destination === '/dashboard.html' && r.source.startsWith('/((?!'),
    );
    assert.equal(catchAll, undefined, 'dashboard catch-all rewrite must stay removed (#6575)');
    const dashboardShadow = vercelConfig.rewrites.find(
      (r) => r.destination === '/dashboard.html' && r.source === '/agent/auth',
    );
    assert.equal(dashboardShadow, undefined, '/agent/auth must not be rewritten to the dashboard');
  });
});
