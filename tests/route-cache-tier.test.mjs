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
  const re = /'\/(api\/[^']+)':\s*'(fast|medium|slow|slow-browser|static|daily|no-store)'/g;
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

  it('finds at least 50 GET routes in generated server files', () => {
    assert.ok(getRoutes.length >= 50, `Expected ≥50 GET routes, found ${getRoutes.length}`);
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
    assert.match(
      gatewaySrc,
      /RPC_CACHE_TIER\[pathname\]\s*\?\?\s*'medium'/,
      'Gateway still has medium default fallback — ensure all routes are explicit',
    );
  });

  it('slow tier includes public s-maxage for CF edge caching, slow-browser does not', () => {
    const gatewaySrc = readFileSync(join(root, 'server', 'gateway.ts'), 'utf-8');
    const slowLine = gatewaySrc.match(/^\s+slow: '.*'/m)?.[0] ?? '';
    assert.ok(slowLine.includes('public'), 'slow tier must include public for CF caching');
    assert.ok(slowLine.includes('s-maxage'), 'slow tier must include s-maxage for CF edge TTL');
    const slowBrowserLine = gatewaySrc.match(/^\s+'slow-browser': '.*'/m)?.[0] ?? '';
    assert.ok(!slowBrowserLine.includes('public'), 'slow-browser tier must NOT include public');
    assert.ok(!slowBrowserLine.includes('s-maxage'), 'slow-browser tier must NOT include s-maxage');
  });
});
