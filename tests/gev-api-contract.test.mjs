/**
 * Guards the contract between God's Eye View's client and its extracted API.
 *
 * Two halves have to agree, and nothing else enforces it:
 *   - the server mounts upstream's routes under /api/gev/* (server/gev/)
 *   - the vendored client fetches /api/gev/* (rewritten by
 *     scripts/vendor-gev-api-base.mjs)
 *
 * A re-vendor that adds an upstream route, or a hand-edit that reintroduces a
 * bare /api/ literal, breaks that quietly: the layer just returns 404 and
 * renders empty. This test makes it loud.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GEV_API_PREFIX,
  GEV_ENV_ALIASES,
  applyGevEnvAliases,
  isGevProxyPlugin,
  remountUnderGev,
} from '../server/gev/gev-api-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

describe("God's Eye View API contract", () => {
  it('remounts upstream /api/* paths under /api/gev, idempotently', () => {
    assert.equal(remountUnderGev('/api/radio'), '/api/gev/radio');
    assert.equal(remountUnderGev('/api/adsblol/trace'), '/api/gev/adsblol/trace');
    // Already-namespaced input must not double up — the server calls this on
    // every registration and a re-run would otherwise produce /api/gev/gev/*.
    assert.equal(remountUnderGev('/api/gev/radio'), '/api/gev/radio');
    assert.equal(remountUnderGev(GEV_API_PREFIX), GEV_API_PREFIX);
    // Anything outside /api/ is passed through rather than swallowed.
    assert.equal(remountUnderGev('/healthz'), '/healthz');
  });

  it('identifies exactly the proxy plugins upstream names', () => {
    assert.ok(isGevProxyPlugin({ name: 'opensky-proxy' }));
    assert.ok(isGevProxyPlugin({ name: 'track-backfill-proxies' }));
    // vite-plugin-cesium must NOT be replayed — it is a build plugin and
    // would fail against the Connect shim.
    assert.ok(!isGevProxyPlugin({ name: 'vite-plugin-cesium' }));
    assert.ok(!isGevProxyPlugin({}));
    assert.ok(!isGevProxyPlugin(null));
  });

  it('maps this fork\'s env names onto the ones upstream reads', () => {
    const env = { GEV_GOOGLE_API_KEY: 'g', GEV_TOMTOM_API_KEY: 't', NASA_FIRMS_API_KEY: 'f' };
    applyGevEnvAliases(env);
    assert.equal(env.GOOGLE_MAPS_API_KEY, 'g');
    assert.equal(env.TOMTOM_API_KEY, 't');
    assert.equal(env.FIRMS_MAP_KEY, 'f');
  });

  it('never overwrites an explicitly-set target name', () => {
    const env = { GEV_TOMTOM_API_KEY: 'from-alias', TOMTOM_API_KEY: 'explicit' };
    applyGevEnvAliases(env);
    assert.equal(env.TOMTOM_API_KEY, 'explicit');
  });

  it('ignores blank aliases rather than defining an empty key', () => {
    const env = { GEV_GOOGLE_API_KEY: '   ' };
    applyGevEnvAliases(env);
    assert.equal(env.GOOGLE_MAPS_API_KEY, undefined);
    // Every alias target is distinct from its source, or the mapping would
    // be a no-op that looks like it works.
    for (const [from, to] of Object.entries(GEV_ENV_ALIASES)) {
      assert.notEqual(from, to);
    }
  });

  it('has no un-namespaced client API literals left in src/gev', () => {
    // The rewrite script doubles as its own checker. It derives the route
    // list from the server, so this asserts both halves at once.
    try {
      execFileSync(
        process.execPath,
        [resolve(ROOT, 'scripts/vendor-gev-api-base.mjs'), '--check'],
        { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' },
      );
    } catch (err) {
      assert.fail(
        'Un-namespaced God\'s Eye View API literals found in src/gev.\n'
        + 'Run: node scripts/vendor-gev-api-base.mjs\n\n'
        + String(err.stdout ?? '') + String(err.stderr ?? ''),
      );
    }
  });

  it('mounts every upstream route, all under the prefix', async () => {
    const { createGevApiApp } = await import('../server/gev/gev-api-server.mjs');
    const { routes } = await createGevApiApp({ mode: 'production' });

    // Upstream ships 24 proxy routes. A drop means a plugin stopped
    // registering; a rise means a re-vendor brought new ones in and the
    // client rewrite needs re-running (the --check above would also fail).
    assert.equal(routes.length, 24, `expected 24 routes, got ${routes.length}`);

    for (const route of routes) {
      assert.ok(
        route.startsWith(`${GEV_API_PREFIX}/`),
        `${route} escaped the ${GEV_API_PREFIX} namespace`,
      );
    }

    // The route that motivated the namespace in the first place.
    assert.ok(routes.includes('/api/gev/opensky'));
  });
});
