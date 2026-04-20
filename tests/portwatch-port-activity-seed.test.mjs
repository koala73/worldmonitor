import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-portwatch-port-activity.mjs'), 'utf-8');
const bundleSrc = readFileSync(resolve(root, 'scripts/seed-bundle-portwatch-port-activity.mjs'), 'utf-8');
const mainBundleSrc = readFileSync(resolve(root, 'scripts/seed-bundle-portwatch.mjs'), 'utf-8');
const dockerfileSrc = readFileSync(resolve(root, 'Dockerfile.seed-bundle-portwatch-port-activity'), 'utf-8');

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-portwatch-port-activity.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('exports withPerCountryTimeout', () => {
    assert.match(src, /export\s+function\s+withPerCountryTimeout/);
  });

  it('exports finalisePortsForCountry', () => {
    assert.match(src, /export\s+function\s+finalisePortsForCountry/);
  });

  it('CANONICAL_KEY is supply_chain:portwatch-ports:v1:_countries', () => {
    assert.match(src, /supply_chain:portwatch-ports:v1:_countries/);
  });

  it('Endpoint 3 URL contains Daily_Ports_Data', () => {
    assert.match(src, /Daily_Ports_Data/);
  });

  it('Endpoint 4 URL contains PortWatch_ports_database', () => {
    assert.match(src, /PortWatch_ports_database/);
  });

  it('EP3 per-country WHERE uses ISO3 index + date filter', () => {
    // After the PR #3225 globalisation failed in prod, we restored the
    // per-country shape because ArcGIS has an ISO3 index but NO date
    // index — the per-country filter is what keeps queries fast.
    assert.match(src, /where:\s*`ISO3='\$\{iso3\}'\s+AND\s+date\s*>/);
    // Global where=date>X shape must NOT be present any more.
    assert.doesNotMatch(src, /where:\s*`date\s*>\s*\$\{epochToTimestamp\(since\)\}`/);
  });

  it('EP4 refs query fetches all ports globally with where=1=1', () => {
    assert.match(src, /where:\s*'1=1'/);
    assert.match(src, /outFields:\s*'portid,ISO3,lat,lon'/);
  });

  it('both paginators set returnGeometry:false', () => {
    const matches = src.match(/returnGeometry:\s*'false'/g) ?? [];
    assert.ok(matches.length >= 2, `expected returnGeometry:'false' in both paginators, found ${matches.length}`);
  });

  it('fetchWithTimeout combines caller signal with FETCH_TIMEOUT via AbortSignal.any', () => {
    assert.match(src, /AbortSignal\.any\(\[signal,\s*AbortSignal\.timeout\(FETCH_TIMEOUT\)\]\)/);
  });

  it('paginators check signal.aborted between pages', () => {
    // Both refs + activity paginators must exit fast on abort.
    const matches = src.match(/signal\?\.aborted\)\s*throw\s+signal\.reason/g) ?? [];
    assert.ok(matches.length >= 2, `expected signal.aborted checks in both paginators, found ${matches.length}`);
  });

  it('defines fetchWithRetryOnInvalidParams — single retry on transient ArcGIS error', () => {
    // Prod log 2026-04-20 showed ArcGIS returning "Cannot perform query.
    // Invalid query parameters." for otherwise-valid queries (BRA/IDN/NGA
    // on per-country; also the global WHERE). One retry clears it.
    assert.match(src, /async function fetchWithRetryOnInvalidParams/);
    assert.match(src, /Invalid query parameters/);
    // Must NOT retry other error classes.
    assert.match(src, /if\s*\(!\/Invalid query parameters\/i\.test\(msg\)\)\s*throw\s+err/);
  });

  it('both EP3 + EP4 paginators route through fetchWithRetryOnInvalidParams', () => {
    const matches = src.match(/fetchWithRetryOnInvalidParams\(/g) ?? [];
    // Called in: fetchAllPortRefs (EP4), fetchCountryAccum (EP3). 2+ usages.
    assert.ok(matches.length >= 2, `expected retry wrapper used by both paginators, found ${matches.length}`);
  });

  it('CONCURRENCY is 12 and PER_COUNTRY_TIMEOUT_MS is 90s', () => {
    assert.match(src, /CONCURRENCY\s*=\s*12/);
    assert.match(src, /PER_COUNTRY_TIMEOUT_MS\s*=\s*90_000/);
  });

  it('batch loop wires eager .catch for mid-batch SIGTERM diagnostics', () => {
    assert.match(src, /p\.catch\(err\s*=>\s*errors\.push/);
  });

  it('withPerCountryTimeout aborts the controller when timer fires', () => {
    // Abort propagation must be real — not just a Promise.race that lets
    // the inner work keep running (PR #3222 review P1).
    assert.match(src, /controller\.abort\(err\)/);
  });

  it('fetchCountryAccum returns per-port accumulators, not raw rows', () => {
    assert.match(src, /async function fetchCountryAccum/);
    assert.match(src, /last30_calls:\s*0/);
    assert.match(src, /prev30_calls:\s*0/);
    assert.match(src, /last7_calls:\s*0/);
  });

  it('registers SIGTERM + SIGINT + aborts shutdownController', () => {
    assert.match(src, /process\.on\('SIGTERM'/);
    assert.match(src, /process\.on\('SIGINT'/);
    assert.match(src, /shutdownController\.abort\(new Error\('SIGTERM'\)\)/);
  });

  it('SIGTERM handler logs batch + stage + seeded + first errors', () => {
    assert.match(src, /SIGTERM at batch \$\{progress\.batchIdx\}\/\$\{progress\.totalBatches\}/);
    assert.match(src, /progress\.errors\.slice\(0,\s*10\)/);
  });

  it('pagination advances by actual features.length, not PAGE_SIZE', () => {
    assert.doesNotMatch(src, /offset\s*\+=\s*PAGE_SIZE/);
    const matches = src.match(/offset\s*\+=\s*features\.length/g) ?? [];
    assert.ok(matches.length >= 2, `expected both paginators to advance by features.length, found ${matches.length}`);
  });

  it('LOCK_TTL_MS is 60 min', () => {
    // Bumped from 30 → 60 min when this moved to its own Railway cron with
    // a bigger wall-time budget.
    assert.match(src, /LOCK_TTL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('anomalySignal computation is present', () => {
    assert.match(src, /anomalySignal/);
  });

  it('MAX_PORTS_PER_COUNTRY is 50', () => {
    assert.match(src, /MAX_PORTS_PER_COUNTRY\s*=\s*50/);
  });

  it('TTL is 259200 (3 days)', () => {
    assert.match(src, /259[_\s]*200/);
  });

  it('wraps main() in isMain guard', () => {
    assert.match(src, /isMain.*=.*process\.argv/s);
    assert.match(src, /if\s*\(isMain\)/);
  });
});

describe('ArcGIS 429 proxy fallback', () => {
  it('imports resolveProxyForConnect and httpsProxyFetchRaw', () => {
    assert.match(src, /resolveProxyForConnect/);
    assert.match(src, /httpsProxyFetchRaw/);
  });

  it('fetchWithTimeout checks resp.status === 429', () => {
    assert.match(src, /resp\.status\s*===\s*429/);
  });

  it('429 proxy fallback threads caller signal', () => {
    assert.match(src, /httpsProxyFetchRaw\(url,\s*proxyAuth,\s*\{[^}]*signal\s*\}/s);
  });
});

// ── standalone bundle + Dockerfile assertions ────────────────────────────────

describe('standalone Railway cron split', () => {
  it('main portwatch bundle NO LONGER contains PW-Port-Activity', () => {
    assert.doesNotMatch(mainBundleSrc, /label:\s*'PW-Port-Activity'/);
    assert.doesNotMatch(mainBundleSrc, /seed-portwatch-port-activity\.mjs/);
  });

  it('new dedicated bundle script exists and references the seeder', () => {
    assert.match(bundleSrc, /seed-portwatch-port-activity\.mjs/);
    assert.match(bundleSrc, /runBundle\('portwatch-port-activity'/);
    assert.match(bundleSrc, /label:\s*'PW-Port-Activity'/);
  });

  it('new bundle gives the section a 540s timeout', () => {
    assert.match(bundleSrc, /timeoutMs:\s*540_000/);
  });

  it('Dockerfile copies scripts/ + shared/ (needed at runtime)', () => {
    assert.match(dockerfileSrc, /COPY\s+scripts\/\s+\.\/scripts\//);
    assert.match(dockerfileSrc, /COPY\s+shared\/\s+\.\/shared\//);
  });

  it('Dockerfile CMD runs the new bundle script', () => {
    assert.match(dockerfileSrc, /CMD\s*\["node",\s*"scripts\/seed-bundle-portwatch-port-activity\.mjs"\]/);
  });

  it('Dockerfile sets dns-result-order=ipv4first (matches other seed services)', () => {
    assert.match(dockerfileSrc, /dns-result-order=ipv4first/);
  });
});

describe('SKIPPED log message', () => {
  it('includes lock domain in SKIPPED message', () => {
    assert.match(src, /SKIPPED.*seed-lock.*LOCK_DOMAIN/s);
  });

  it('includes TTL duration in SKIPPED message', () => {
    assert.match(src, /LOCK_TTL_MS\s*\/\s*60000/);
  });

  it('mentions next cron trigger in SKIPPED message', () => {
    assert.match(src, /next cron trigger/);
  });
});

// ── unit tests ────────────────────────────────────────────────────────────────

function computeAnomalySignal(rows, cutoff30, cutoff7) {
  const last30 = rows.filter(r => r.date >= cutoff30);
  const last7 = rows.filter(r => r.date >= cutoff7);
  const avg30d = last30.reduce((s, r) => s + r.portcalls_tanker, 0) / 30;
  const avg7d = last7.reduce((s, r) => s + r.portcalls_tanker, 0) / Math.max(last7.length, 1);
  return avg30d > 0 && avg7d < avg30d * 0.5;
}

function topN(ports, n) {
  return [...ports].sort((a, b) => b.tankerCalls30d - a.tankerCalls30d).slice(0, n);
}

describe('anomalySignal computation', () => {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  it('detects anomaly when 7d avg is < 50% of 30d avg', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 60 });
    }
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 2;
    }
    assert.equal(computeAnomalySignal(rows, cutoff30, cutoff7), true);
  });

  it('does NOT flag anomaly when 7d avg is close to 30d avg', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 60 });
    }
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 55;
    }
    assert.equal(computeAnomalySignal(rows, cutoff30, cutoff7), false);
  });

  it('returns false when 30d avg is zero', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: now - (29 - i) * 86400000, portcalls_tanker: 0 }));
    assert.equal(computeAnomalySignal(rows, cutoff30, cutoff7), false);
  });
});

describe('top-N port truncation', () => {
  it('returns top 50 ports from a set of 60', () => {
    const ports = Array.from({ length: 60 }, (_, i) => ({ portId: String(i), portName: `P${i}`, tankerCalls30d: 60 - i }));
    const result = topN(ports, 50);
    assert.equal(result.length, 50);
    assert.equal(result[0].tankerCalls30d, 60);
    assert.equal(result[49].tankerCalls30d, 11);
  });

  it('returns all ports when count is less than N', () => {
    const ports = Array.from({ length: 10 }, (_, i) => ({ portId: String(i), portName: `P${i}`, tankerCalls30d: 10 - i }));
    assert.equal(topN(ports, 50).length, 10);
  });
});

// ── runtime tests ────────────────────────────────────────────────────────────

describe('withPerCountryTimeout (runtime)', () => {
  let withPerCountryTimeout;
  before(async () => {
    ({ withPerCountryTimeout } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('aborts the per-country signal when the timer fires', async () => {
    let observedSignal;
    const p = withPerCountryTimeout(
      (signal) => {
        observedSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      'TST',
      40,
    );
    await assert.rejects(p, /per-country timeout after 0\.04s \(TST\)/);
    assert.equal(observedSignal.aborted, true);
  });

  it('resolves with the work result when work completes before the timer', async () => {
    const result = await withPerCountryTimeout((_s) => Promise.resolve({ ok: true }), 'TST', 500);
    assert.deepEqual(result, { ok: true });
  });

  it('surfaces the real error when work rejects first (not timeout message)', async () => {
    await assert.rejects(
      withPerCountryTimeout((_s) => Promise.reject(new Error('ArcGIS HTTP 500')), 'TST', 1_000),
      /ArcGIS HTTP 500/,
    );
  });
});

describe('finalisePortsForCountry (runtime, semantic equivalence)', () => {
  let finalisePortsForCountry;
  before(async () => {
    ({ finalisePortsForCountry } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('emits tankerCalls30d / trendDelta / anomalySignal that match the old per-row formula', () => {
    const portAccumMap = new Map([
      ['42', {
        portname: 'Test Port',
        last30_calls: 60 * 23 + 20 * 7,
        last30_count: 30,
        last30_import: 1000,
        last30_export: 500,
        prev30_calls: 40 * 30,
        last7_calls: 20 * 7,
        last7_count: 7,
      }],
    ]);
    const refMap = new Map([['42', { lat: 10, lon: 20 }]]);
    const [port] = finalisePortsForCountry(portAccumMap, refMap);
    assert.equal(port.tankerCalls30d, 60 * 23 + 20 * 7);
    assert.equal(port.importTankerDwt30d, 1000);
    assert.equal(port.exportTankerDwt30d, 500);
    const expectedTrend = Math.round(((60 * 23 + 20 * 7 - 40 * 30) / (40 * 30)) * 1000) / 10;
    assert.equal(port.trendDelta, expectedTrend);
    assert.equal(port.anomalySignal, true);
  });

  it('trendDelta=0 when prev30_calls=0', () => {
    const portAccumMap = new Map([
      ['1', { portname: 'P', last30_calls: 100, last30_count: 30, last30_import: 0, last30_export: 0, prev30_calls: 0, last7_calls: Math.round((100 / 30) * 7), last7_count: 7 }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.trendDelta, 0);
    assert.equal(port.anomalySignal, false);
  });

  it('sorts desc + truncates to MAX_PORTS_PER_COUNTRY=50', () => {
    const portAccumMap = new Map();
    for (let i = 0; i < 60; i++) {
      portAccumMap.set(String(i), { portname: `P${i}`, last30_calls: 60 - i, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0, last7_calls: 0, last7_count: 0 });
    }
    const out = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(out.length, 50);
    assert.equal(out[0].tankerCalls30d, 60);
    assert.equal(out[49].tankerCalls30d, 11);
  });

  it('falls back to lat/lon=0 when refMap lacks the portId', () => {
    const portAccumMap = new Map([
      ['999', { portname: 'Orphan', last30_calls: 1, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0, last7_calls: 0, last7_count: 0 }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.lat, 0);
    assert.equal(port.lon, 0);
  });
});

describe('proxyFetch signal propagation (runtime)', () => {
  const require_ = createRequire(import.meta.url);
  const { proxyFetch } = require_('../scripts/_proxy-utils.cjs');

  it('rejects synchronously when called with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('test-cancel'));
    await assert.rejects(
      proxyFetch('https://example.invalid/x', { host: 'nope', port: 1, auth: 'a:b', tls: true }, {
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
      /test-cancel|aborted/,
    );
  });
});

describe('validateFn', () => {
  it('returns true when countries array has >= 50 entries', () => {
    const data = { countries: Array.from({ length: 80 }, (_, i) => `C${i}`), fetchedAt: new Date().toISOString() };
    const valid = data && Array.isArray(data.countries) && data.countries.length >= 50;
    assert.equal(valid, true);
  });

  it('returns false when countries array has < 50 entries', () => {
    const data = { countries: ['US', 'SA'], fetchedAt: new Date().toISOString() };
    const valid = data && Array.isArray(data.countries) && data.countries.length >= 50;
    assert.equal(valid, false);
  });

  it('returns false for null data', () => {
    const data = null;
    const valid = !!(data && Array.isArray(data.countries) && data.countries.length >= 50);
    assert.equal(valid, false);
  });
});
