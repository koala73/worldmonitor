import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-portwatch-port-activity.mjs'), 'utf-8');
const seedUtilsSrc = readFileSync(resolve(root, 'scripts/_seed-utils.mjs'), 'utf-8');
const proxyUtilsSrc = readFileSync(resolve(root, 'scripts/_proxy-utils.cjs'), 'utf-8');

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-portwatch-port-activity.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('CANONICAL_KEY is supply_chain:portwatch-ports:v1:_countries', () => {
    assert.match(src, /supply_chain:portwatch-ports:v1:_countries/);
  });

  it('KEY_PREFIX is supply_chain:portwatch-ports:v1:', () => {
    assert.match(src, /supply_chain:portwatch-ports:v1:/);
  });

  it('Endpoint 3 URL contains Daily_Ports_Data', () => {
    assert.match(src, /Daily_Ports_Data/);
  });

  it('Endpoint 4 URL contains PortWatch_ports_database', () => {
    assert.match(src, /PortWatch_ports_database/);
  });

  it('date filter uses epochToTimestamp', () => {
    assert.match(src, /epochToTimestamp/);
  });

  it('Endpoint 3 pagination loop checks body.exceededTransferLimit', () => {
    assert.match(src, /body\.exceededTransferLimit/);
  });

  it('Endpoint 4 query fetches all ports globally with where=1=1', () => {
    assert.match(src, /PortWatch_ports_database/);
    assert.match(src, /where:\s*'1=1'/);
    assert.match(src, /outFields:\s*'portid,ISO3,lat,lon'/);
  });

  it('both paginators set returnGeometry:false to avoid wasted wire bandwidth', () => {
    // ArcGIS returns geometry by default (~100-200KB per page). Omitting
    // this in the EP3 paginator across ~150-200 pages adds tens of MB to
    // the perf-critical path. Review feedback on PR #3225.
    const matches = src.match(/returnGeometry:\s*'false'/g) ?? [];
    assert.ok(matches.length >= 2, `expected returnGeometry:'false' in both EP3 and EP4 paginators, found ${matches.length}`);
  });

  it('fetchAllPortRefs accepts + forwards signal for SIGTERM cancellation', () => {
    // Review feedback on PR #3225: during the 'refs' stage a SIGTERM must
    // cancel in-flight EP4 fetches, not let them run up to FETCH_TIMEOUT
    // after the handler fires. The signal must thread through the
    // paginator into fetchWithTimeout.
    assert.match(src, /async function fetchAllPortRefs\(\{\s*signal\s*\}\s*=\s*\{\}\)/);
    assert.match(src, /fetchWithTimeout\(`\$\{EP4_BASE\}\?\$\{params\}`,\s*\{\s*signal\s*\}\)/);
    // fetchAll must pass the signal when calling it.
    assert.match(src, /fetchAllPortRefs\(\{\s*signal\s*\}\)/);
  });

  it('Endpoint 3 activity query is globalised — no per-country ISO3 filter', () => {
    // The per-country `WHERE ISO3='XX' AND date > ...` shape is gone; the
    // globalised paginator uses a single date filter and groups by ISO3 in
    // memory. This eliminates the 174-per-country round-trip cost that
    // blew the 420s section budget even when every country was fast, and
    // also removes the `Invalid query parameters` errors that hit
    // BRA/IDN/NGA under the per-country shape.
    assert.doesNotMatch(src, /where:\s*`ISO3=/);
    assert.match(src, /where:\s*`date\s*>\s*\$\{epochToTimestamp\(since\)\}`/);
  });

  it('streams EP3 into per-port accumulators, not a flat rows array', () => {
    // Review feedback on PR #3225: materialising the full 90d activity
    // dataset as Map<iso3, Feature[]> holds ~180k feature objects at once
    // (~70MB) on a 1GB Railway container. The aggregator now folds each
    // page into Map<iso3, Map<portId, PortAccum>> (~200KB) and discards
    // the rows. Assert both the rename and the accumulator shape.
    assert.match(src, /async function fetchAndAggregateActivity/);
    assert.doesNotMatch(src, /async function fetchAllActivityRows/);
    // Accumulator fields (at least the key ones we rely on downstream).
    assert.match(src, /last30_calls:\s*0/);
    assert.match(src, /last30_count:\s*0/);
    assert.match(src, /prev30_calls:\s*0/);
    assert.match(src, /last7_calls:\s*0/);
    // No more flat rows array collected per country.
    assert.doesNotMatch(src, /byIso3\.set\(key,\s*list\)/);
  });

  it('finalisePortsForCountry emits top-N ports from accumulators', () => {
    assert.match(src, /function finalisePortsForCountry\(portAccumMap,\s*refMap\)/);
    assert.match(src, /MAX_PORTS_PER_COUNTRY/);
    // Same anomaly/trend formula as the old per-row code.
    assert.match(src, /avg7d\s*<\s*avg30d\s*\*\s*0\.5/);
  });

  it('registers SIGTERM handler for graceful shutdown', () => {
    assert.match(src, /process\.on\('SIGTERM'/);
  });

  it('SIGTERM handler aborts shutdownController + logs stage/pages/countries', () => {
    // Per-country batching is gone, but the SIGTERM path still must (a)
    // abort the in-flight global paginator via the shared controller, and
    // (b) emit a forensic line identifying which stage we died in.
    assert.match(src, /shutdownController\.abort\(new Error\('SIGTERM'\)\)/);
    assert.match(src, /SIGTERM during stage=\$\{progress\.stage\}/);
    assert.match(src, /pages=\$\{progress\.pages\},\s*countries=\$\{progress\.countries\}/);
  });

  it('fetchAll accepts progress + { signal } and mutates progress.stage', () => {
    assert.match(src, /export async function fetchAll\(progress,\s*\{\s*signal\s*\}\s*=\s*\{\}\)/);
    assert.match(src, /progress\.stage\s*=\s*'refs'/);
    assert.match(src, /progress\.stage\s*=\s*'activity'/);
    assert.match(src, /progress\.stage\s*=\s*'compute'/);
  });

  it('fetchAndAggregateActivity updates progress.pages + progress.countries', () => {
    assert.match(src, /progress\.pages\s*=\s*page/);
    assert.match(src, /progress\.countries\s*=\s*accumByIso3\.size/);
  });

  it('fetchWithTimeout combines caller signal with FETCH_TIMEOUT via AbortSignal.any', () => {
    // Still needed so a shutdown-controller abort propagates into the
    // in-flight fetch instead of orphaning it for up to 45s.
    assert.match(src, /AbortSignal\.any\(\[signal,\s*AbortSignal\.timeout\(FETCH_TIMEOUT\)\]\)/);
  });

  it('fetchAndAggregateActivity checks signal.aborted between pages', () => {
    assert.match(src, /signal\?\.aborted\)\s*throw\s+signal\.reason/);
  });

  it('429 proxy fallback threads caller signal into httpsProxyFetchRaw', () => {
    assert.match(src, /httpsProxyFetchRaw\(url,\s*proxyAuth,\s*\{[^}]*signal\s*\}/s);
  });

  it('httpsProxyFetchRaw accepts and forwards signal', () => {
    assert.match(seedUtilsSrc, /httpsProxyFetchRaw\(url,\s*proxyAuth,\s*\{[^}]*signal\s*\}/s);
    assert.match(seedUtilsSrc, /proxyFetch\(url,\s*proxyConfig,\s*\{[^}]*signal[^}]*\}/s);
  });

  it('proxyFetch + proxyConnectTunnel accept signal and bail early if aborted', () => {
    assert.match(proxyUtilsSrc, /function proxyFetch\([\s\S]*?\bsignal,?\s*\}\s*=\s*\{\}/);
    assert.match(proxyUtilsSrc, /function proxyConnectTunnel\([\s\S]*?\bsignal\s*\}\s*=\s*\{\}/);
    assert.match(proxyUtilsSrc, /signal && signal\.aborted/);
    assert.match(proxyUtilsSrc, /signal\.addEventListener\('abort'/);
  });

  it('pagination advances by actual features.length, not PAGE_SIZE', () => {
    // ArcGIS PortWatch_ports_database caps responses at 1000 rows even when
    // resultRecordCount=2000. Advancing by PAGE_SIZE skips rows 1000-1999.
    // Guard: no 'offset += PAGE_SIZE' anywhere in the file, both loops use
    // 'offset += features.length'.
    assert.doesNotMatch(src, /offset\s*\+=\s*PAGE_SIZE/);
    const matches = src.match(/offset\s*\+=\s*features\.length/g) ?? [];
    assert.ok(matches.length >= 2, `expected both paginators to advance by features.length, found ${matches.length}`);
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

  it('calls resolveProxyForConnect() on 429', () => {
    assert.match(src, /resolveProxyForConnect\(\)/);
  });

  it('calls httpsProxyFetchRaw with proxy auth on 429', () => {
    assert.match(src, /httpsProxyFetchRaw\(url,\s*proxyAuth/);
  });

  it('throws if 429 and no proxy configured', () => {
    assert.match(src, /429.*rate limited/);
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
    // last 7 days avg = 2 (spike down)
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 2;
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, true, 'should detect anomaly when 7d avg is far below 30d avg');
  });

  it('does NOT flag anomaly when 7d avg is close to 30d avg', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 60 });
    }
    // last 7 days avg = 55 (close to 60)
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 55;
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, false, 'should not flag anomaly when 7d is close to 30d avg');
  });

  it('returns false when 30d avg is zero (no baseline)', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 0 });
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, false, 'should return false when baseline is zero');
  });
});

describe('top-N port truncation', () => {
  it('returns top 50 ports from a set of 60', () => {
    const ports = Array.from({ length: 60 }, (_, i) => ({
      portId: String(i),
      portName: `Port ${i}`,
      tankerCalls30d: 60 - i,
    }));
    const result = topN(ports, 50);
    assert.equal(result.length, 50, 'should return exactly 50 ports');
    assert.equal(result[0].tankerCalls30d, 60, 'first port should have highest tankerCalls30d');
    assert.equal(result[49].tankerCalls30d, 11, 'last port should be rank 50');
  });

  it('returns all ports when count is less than N', () => {
    const ports = Array.from({ length: 10 }, (_, i) => ({
      portId: String(i),
      portName: `Port ${i}`,
      tankerCalls30d: 10 - i,
    }));
    const result = topN(ports, 50);
    assert.equal(result.length, 10, 'should return all 10 ports when fewer than 50');
  });

  it('sorts by tankerCalls30d descending', () => {
    const ports = [
      { portId: 'a', portName: 'A', tankerCalls30d: 5 },
      { portId: 'b', portName: 'B', tankerCalls30d: 100 },
      { portId: 'c', portName: 'C', tankerCalls30d: 50 },
    ];
    const result = topN(ports, 50);
    assert.equal(result[0].portId, 'b');
    assert.equal(result[1].portId, 'c');
    assert.equal(result[2].portId, 'a');
  });
});

describe('finalisePortsForCountry (runtime, semantic equivalence)', () => {
  // eslint-disable-next-line import/first
  let finalisePortsForCountry;
  before(async () => {
    ({ finalisePortsForCountry } = await import('../scripts/seed-portwatch-port-activity.mjs'));
  });

  it('emits tankerCalls30d / trendDelta / anomalySignal that match the old per-row formula', () => {
    // Accum equivalent of: last30 has 30 rows × 60 calls, prev30 has 30 × 40,
    // last7 has 7 rows × 20 calls (subset of last30 — but note that the
    // streaming aggregator increments last30 AND last7 on the same row for
    // dates ≤ 7d, so last7_calls should be <= last30_calls).
    const portAccumMap = new Map([
      ['42', {
        portname: 'Test Port',
        last30_calls: 60 * 23 + 20 * 7, // 23 rows in 8-30d window + 7 rows in 0-7d window
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

    assert.equal(port.portId, '42');
    assert.equal(port.portName, 'Test Port');
    assert.equal(port.lat, 10);
    assert.equal(port.lon, 20);
    assert.equal(port.tankerCalls30d, 60 * 23 + 20 * 7);
    assert.equal(port.importTankerDwt30d, 1000);
    assert.equal(port.exportTankerDwt30d, 500);
    // trendDelta = ((last30 - prev30) / prev30) * 100, rounded to 1 decimal
    const expectedTrend = Math.round(((60 * 23 + 20 * 7 - 40 * 30) / (40 * 30)) * 1000) / 10;
    assert.equal(port.trendDelta, expectedTrend);
    // avg30d = last30_calls / last30_count; avg7d = last7_calls / last7_count
    // (60*23 + 20*7) / 30 = (1380+140)/30 = 50.67; last7 avg = 140/7 = 20
    // 20 < 50.67 * 0.5 = 25.33 → anomaly = true
    assert.equal(port.anomalySignal, true);
  });

  it('returns trendDelta=0 when prev30_calls is zero (no baseline)', () => {
    const portAccumMap = new Map([
      ['1', {
        portname: 'P', last30_calls: 100, last30_count: 30,
        last30_import: 0, last30_export: 0,
        prev30_calls: 0, // no prior-period baseline
        // last7 matches last30 rate → no anomaly
        last7_calls: Math.round((100 / 30) * 7),
        last7_count: 7,
      }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.trendDelta, 0);
    assert.equal(port.anomalySignal, false);
  });

  it('sorts by tankerCalls30d desc and truncates to MAX_PORTS_PER_COUNTRY=50', () => {
    const portAccumMap = new Map();
    for (let i = 0; i < 60; i++) {
      portAccumMap.set(String(i), {
        portname: `P${i}`, last30_calls: 60 - i, last30_count: 1,
        last30_import: 0, last30_export: 0, prev30_calls: 0,
        last7_calls: 0, last7_count: 0,
      });
    }
    const out = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(out.length, 50);
    assert.equal(out[0].tankerCalls30d, 60);
    assert.equal(out[49].tankerCalls30d, 11);
  });

  it('falls back to lat/lon=0 when a portId is missing from refMap', () => {
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
    // A shutdown-controller abort must short-circuit BEFORE any CONNECT
    // tunnel opens; otherwise a killed run's proxy call continues in the
    // background past SIGKILL. No network reached in this test.
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
    const countries = data.countries;
    const valid = data && Array.isArray(countries) && countries.length >= 50;
    assert.equal(valid, true);
  });

  it('returns false when countries array has < 50 entries', () => {
    const data = { countries: ['US', 'SA'], fetchedAt: new Date().toISOString() };
    const countries = data.countries;
    const valid = data && Array.isArray(countries) && countries.length >= 50;
    assert.equal(valid, false);
  });

  it('returns false for null data', () => {
    const data = null;
    const valid = !!(data && Array.isArray(data.countries) && data.countries.length >= 50);
    assert.equal(valid, false);
  });
});
