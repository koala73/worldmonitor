import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from '../api/http-message-signatures-directory.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelConfig = JSON.parse(readFileSync(resolve(__dirname, '../vercel.json'), 'utf-8'));

const WELL_KNOWN_PATH = '/.well-known/http-message-signatures-directory';
const call = (init) => handler(new Request('https://worldmonitor.app' + WELL_KNOWN_PATH, init));

// RFC 8037 App. A.3 JWK thumbprint, computed independently of the handler.
const expectedThumbprint = (x) =>
  createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');

const isBase64UrlNoPad = (s) => /^[A-Za-z0-9_-]+$/.test(s);

describe('Web Bot Auth key directory (/.well-known/http-message-signatures-directory)', () => {
  it('serves the spec-mandated content-type', async () => {
    const res = await call({ method: 'GET' });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('content-type'),
      'application/http-message-signatures-directory+json',
    );
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('publishes a JWK Set with a single Ed25519 signing key', async () => {
    const res = await call({ method: 'GET' });
    const body = await res.json();
    assert.ok(Array.isArray(body.keys), 'body.keys must be an array');
    assert.equal(body.keys.length, 1);

    const jwk = body.keys[0];
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');
    assert.equal(jwk.use, 'sig');

    // x: base64url, no padding, 43 chars == a 32-byte Ed25519 public key.
    assert.ok(isBase64UrlNoPad(jwk.x), 'x must be base64url without padding');
    assert.equal(jwk.x.length, 43, 'Ed25519 public key is 32 bytes -> 43 base64url chars');
  });

  it('derives kid as the RFC 8037 JWK thumbprint of the published key', async () => {
    const res = await call({ method: 'GET' });
    const jwk = (await res.json()).keys[0];
    assert.ok(isBase64UrlNoPad(jwk.kid), 'kid must be base64url without padding');
    assert.equal(
      jwk.kid,
      expectedThumbprint(jwk.x),
      'kid must be the SHA-256 JWK thumbprint of {crv,kty,x} — never drift from x',
    );
  });

  it('advertises a forward-looking validity window of at most ~24h', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const jwk = (await (await call({ method: 'GET' })).json()).keys[0];
    assert.equal(typeof jwk.nbf, 'number');
    assert.equal(typeof jwk.exp, 'number');
    assert.ok(jwk.nbf <= nowSeconds, 'nbf must not be in the future (allow clock-skew backdate)');
    assert.ok(jwk.exp > nowSeconds, 'exp must be in the future — the key must not read as expired');
    assert.ok(
      jwk.exp - jwk.nbf <= 24 * 3600,
      `validity window must stay within the spec-recommended <=24h (got ${jwk.exp - jwk.nbf}s)`,
    );
  });

  it('rejects non-GET methods (read-only directory) and answers CORS preflight', async () => {
    const post = await call({ method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');

    const preflight = await call({ method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  });

  it('is wired in vercel.json ahead of the SPA catch-all', () => {
    const rewrite = vercelConfig.rewrites.find((r) => r.source === WELL_KNOWN_PATH);
    assert.ok(rewrite, 'expected a rewrite for the directory path');
    assert.equal(rewrite.destination, '/api/http-message-signatures-directory');

    const catchAllIndex = vercelConfig.rewrites.findIndex(
      (r) => r.destination === '/dashboard.html' && r.source.startsWith('/((?!'),
    );
    assert.ok(
      vercelConfig.rewrites.indexOf(rewrite) < catchAllIndex,
      'directory rewrite must precede the SPA catch-all',
    );
    // The SPA catch-all already excludes every /.well-known/* path.
    assert.ok(
      vercelConfig.rewrites[catchAllIndex].source.includes('\\.well-known'),
      'SPA catch-all must keep excluding /.well-known/*',
    );
  });
});
