import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function extractGetRoutes() {
  const generatedDir = join(root, 'src', 'generated', 'server', 'worldmonitor');
  const routes = [];

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === 'service_server.ts') {
        const src = readFileSync(full, 'utf-8');
        // Match both object literal { method: "GET", path: "/..." }
        // and factory call makeHandler(..., "/...") which is hardcoded as GET
        const re = /method:\s*"GET",[\s\S]*?path:\s*"([^"]+)"/g;
        const re2 = /makeHandler\s*\(\s*"[^"]+",\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          routes.push(m[1]);
        }
        while ((m = re2.exec(src)) !== null) {
          routes.push(m[1]);
        }
      }
    }
  }

  walk(generatedDir);
  return routes.sort();
}

function extractCacheTierKeys() {
  const gatewayPath = join(root, 'server', 'gateway.ts');
  const src = readFileSync(gatewayPath, 'utf-8');
  const re = /'\/(api\/[^']+)':\s*'(fast|medium|slow|slow-browser|live-browser|static|daily|no-store|live)'/g;
  const entries = {};
  let m;
  while ((m = re.exec(src)) !== null) {
    entries['/' + m[1]] = m[2];
  }
  return entries;
}

describe('RPC_CACHE_TIER route parity', () => {
  const getRoutes = extractGetRoutes();
  const tierMap = extractCacheTierKeys();
  const tierKeys = Object.keys(tierMap);

  it('finds a non-empty GET route universe in generated server files', () => {
    assert.ok(getRoutes.length > 0, 'generated GET route extraction must not be empty');
  });

  it('every generated GET route has an explicit cache tier entry', () => {
    const missing = getRoutes.filter((r) => !(r in tierMap));
    assert.deepStrictEqual(
      missing,
      [],
      `Missing RPC_CACHE_TIER entries for:\n  ${missing.join('\n  ')}\n\nAdd explicit tier entries in server/gateway.ts`,
    );
  });

  it('every cache tier key maps to a real generated route', () => {
    const stale = tierKeys.filter((k) => !getRoutes.includes(k));
    assert.deepStrictEqual(
      stale,
      [],
      `Stale RPC_CACHE_TIER entries (no matching generated route):\n  ${stale.join('\n  ')}`,
    );
  });

  it('no route uses the implicit default tier', () => {
    const gatewaySrc = readFileSync(join(root, 'server', 'gateway.ts'), 'utf-8');
    // The declared per-route tier (RPC_CACHE_TIER + env override, captured as
    // `declaredTier`) still falls back to 'medium' — the tripwire that keeps
    // every route's tier explicit. `declaredTier` also gates the no-store floor.
    assert.match(
      gatewaySrc,
      /declaredTier\s*\?\?\s*'medium'/,
      'Gateway still has medium default fallback — ensure all routes are explicit',
    );
    assert.match(
      gatewaySrc,
      /RPC_CACHE_TIER\[pathname\]/,
      'Gateway still consults RPC_CACHE_TIER for the declared per-route tier',
    );
  });

  it('keeps Pro-fresh market routes on the ordinary shared default', () => {
    for (const path of [
      '/api/market/v1/list-market-quotes',
      '/api/market/v1/list-crypto-quotes',
      '/api/market/v1/list-commodity-quotes',
      '/api/market/v1/list-stablecoin-markets',
      '/api/market/v1/list-gulf-quotes',
    ]) {
      assert.equal(
        tierMap[path],
        'medium',
        `${path} must stay medium by default; only verified paid callers get live-browser`,
      );
    }
  });

  it('shared tiers include public s-maxage while private browser tiers do not', () => {
    const gatewaySrc = readFileSync(join(root, 'server', 'gateway.ts'), 'utf-8');
    const slowLine = gatewaySrc.match(/^\s+slow: '.*'/m)?.[0] ?? '';
    assert.ok(slowLine.includes('public'), 'slow tier must include public for CF caching');
    assert.ok(slowLine.includes('s-maxage'), 'slow tier must include s-maxage for CF edge TTL');
    const slowBrowserLine = gatewaySrc.match(/^\s+'slow-browser': '.*'/m)?.[0] ?? '';
    assert.ok(!slowBrowserLine.includes('public'), 'slow-browser tier must NOT include public');
    assert.ok(!slowBrowserLine.includes('s-maxage'), 'slow-browser tier must NOT include s-maxage');
    const liveBrowserLine = gatewaySrc.match(/^\s+'live-browser': '.*'/m)?.[0] ?? '';
    assert.ok(!liveBrowserLine.includes('public'), 'live-browser tier must NOT include public');
    assert.ok(!liveBrowserLine.includes('s-maxage'), 'live-browser tier must NOT include s-maxage');
  });
});
