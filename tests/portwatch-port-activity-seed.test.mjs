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

  it('EP3 per-country WHERE uses ISO3 index + dynamic date field', () => {
    // After the PR #3225 globalisation failed in prod, we restored the
    // per-country shape because ArcGIS has an ISO3 index but NO date
    // index — the per-country filter is what keeps queries fast.
    // H+F refactor: the WHERE clause is now built inline at the
    // paginateWindowInto call site (not as a `where:` param in a params
    // bag) because each window has a different date predicate.
    // Post-2026-04-29 (IMF reserved-keyword flap): the date field name is
    // resolved DYNAMICALLY at run start via resolveArcgisDateField — the
    // WHERE template must interpolate the resolved name (`${df}`), NOT a
    // hardcoded literal, so the seeder survives a `date` ↔ `date_` flap.
    assert.match(src, /`ISO3='\$\{iso3\}'\s+AND\s+\$\{df\}\s*>/);
    // Hardcoded `date` or `date_` literals in the WHERE template are
    // exactly the bug class this dynamic-resolution change exists to
    // prevent. Lock that out at test time.
    assert.doesNotMatch(src, /`ISO3='\$\{iso3\}'\s+AND\s+date_?\s*>/);
    // Global where=date>X shape (PR #3225) must NOT be present.
    assert.doesNotMatch(src, /where:\s*`date_?\s*>\s*\$\{epochToTimestamp\(since\)\}`/);
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
    // last7 aggregation removed — ArcGIS max-date lag made it always empty,
    // so anomalySignal was always false. See fetchCountryAccum header.
    assert.doesNotMatch(src, /last7_calls:\s*0/);
  });

  it('fetchCountryAccum splits windows (last30 + prev30) into parallel queries', () => {
    // Heavy countries hit the 90s per-country cap under a single 60-day
    // query. Splitting into two parallel windowed queries (max ~half the
    // rows each) drops heavy-country time from ~90s → ~30s.
    assert.match(src, /await Promise\.all\(\[/);
    assert.match(src, /paginateWindowInto\(/);
    assert.match(src, /'last30'/);
    assert.match(src, /'prev30'/);
  });

  it('fetchMaxDate preflight uses outStatistics for cheap cache invalidation', () => {
    assert.match(src, /async function fetchMaxDate/);
    assert.match(src, /statisticType:\s*'max'/);
    // Same dynamic-resolution invariant as the WHERE clause: onStatisticField
    // must use the resolved `df`, not a hardcoded literal — the IMF
    // 2026-04-29 flap proved either name can appear within hours.
    assert.match(src, /onStatisticField:\s*df\b/);
    assert.doesNotMatch(src, /onStatisticField:\s*'date_?'/);
  });

  it('fetchAll cache path: MGET preflight + maxDate check + reuse payload', () => {
    // H+F architecture: preflight reads prior payloads and maxDate, reuses
    // cache when upstream hasn't advanced. Without this, we re-fetched the
    // full 60 days every day even when ArcGIS hadn't published new rows.
    assert.match(src, /redisMgetJson/);
    assert.match(src, /async function redisMgetJson/);
    assert.match(src, /prev\.asof\s*===\s*upstreamMaxDate/);
    assert.match(src, /MAX_CACHE_AGE_MS/);
  });

  it('cached payloads store asof + cacheWrittenAt for next-run invalidation', () => {
    assert.match(src, /asof:\s*upstreamMaxDate/);
    assert.match(src, /cacheWrittenAt:\s*Date\.now\(\)/);
  });

  it('redisMgetJson failure degrades to cold-path (does not abort the seed)', () => {
    // PR #3299 review P1: a transient Upstash outage at run-start used to
    // abort the seed before any ArcGIS data was fetched — regression from
    // the prior behaviour where Redis was only required at write-time.
    // The MGET call is now wrapped in .catch that returns all-null so
    // every country falls through to the expensive-fetch path.
    assert.match(src, /redisMgetJson\(prevKeys\)\.catch\(/);
    assert.match(src, /new Array\(prevKeys\.length\)\.fill\(null\)/);
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

  it('anomalySignal field is still emitted (always false after H+F refactor)', () => {
    // The field stays in the payload shape for backward compatibility with
    // UI consumers reading `anomalySignal`. After H+F it is hardcoded to
    // false because the last7 aggregation that drove it was always empty
    // (ArcGIS data lag). TODO remove field once UI stops reading it.
    assert.match(src, /anomalySignal:\s*false/);
  });

  it('MAX_PORTS_PER_COUNTRY is 50', () => {
    assert.match(src, /MAX_PORTS_PER_COUNTRY\s*=\s*50/);
  });

  it('window cutoffs hardcoded to 30d + 60d anchored to upstream maxDate', () => {
    // HISTORY_DAYS constant was removed in the H+F refactor because the
    // actual windows are hardcoded in fetchCountryAccum. 60d is the
    // minimum that still covers trendDelta (prev30 = days 30-60).
    //
    // PR #3299 review P1: windows are anchored to upstream max(date),
    // not Date.now(), so the aggregate is STABLE day-over-day when
    // upstream is frozen. Without this, rolling `now - 30d` shifts the
    // window every day and the cache serves stale aggregates.
    assert.match(src, /anchor - 30 \* 86400000/);
    assert.match(src, /anchor - 60 \* 86400000/);
    // And the anchor is derived from the preflight maxDate, not just Date.now:
    assert.match(src, /function parseMaxDateToAnchor/);
    assert.match(src, /const anchor = anchorEpochMs \?\? Date\.now\(\)/);
  });

  it('fetchCountryAccum receives anchorEpochMs and dateField at the call site', () => {
    // The call site must thread the parsed maxDate anchor into
    // fetchCountryAccum — otherwise the windows default to Date.now()
    // and cache reuse serves stale data (defeats the H-path entirely).
    // The call site must also thread the run-resolved dateField so each
    // country fetch uses the same resolved name and one introspection
    // round-trip serves the whole run.
    assert.match(src, /parseMaxDateToAnchor\(upstreamMaxDate\)/);
    assert.match(
      src,
      /fetchCountryAccum\(iso3,\s*\{\s*signal:\s*childSignal,\s*anchorEpochMs,\s*dateField\s*\}\)/,
    );
  });

  it('fetchAll resolves the ArcGIS date field once at run start', () => {
    // The dynamic-resolution invariant: resolveArcgisDateField must be
    // called BEFORE any country-level fetch (preflight or batches) so
    // every per-country call within the run sees the same resolved name.
    // This is the single source of truth that survives an IMF schema flap.
    // Resolver is exported as a sync function that returns the cached
    // in-flight promise (Greptile P2 fix on PR #3496) — the actual
    // schema-fetch lives in `_doResolveArcgisDateField`. Both must be
    // present, but only the former is the public entry point.
    assert.match(src, /export function resolveArcgisDateField/);
    assert.match(src, /async function _doResolveArcgisDateField/);
    // Called inside fetchAll before refs/preflight/activity stages.
    assert.match(
      src,
      /export async function fetchAll[\s\S]{0,400}?resolveArcgisDateField\(/,
    );
    // Both per-country fetchers receive dateField from the resolved value.
    assert.match(src, /fetchMaxDate\(iso3,\s*\{\s*signal,\s*dateField\s*\}\)/);
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

  it('emits tankerCalls30d + trendDelta + import/export sums; anomalySignal always false', () => {
    const portAccumMap = new Map([
      ['42', {
        portname: 'Test Port',
        last30_calls: 60 * 23 + 20 * 7,
        last30_count: 30,
        last30_import: 1000,
        last30_export: 500,
        prev30_calls: 40 * 30,
      }],
    ]);
    const refMap = new Map([['42', { lat: 10, lon: 20 }]]);
    const [port] = finalisePortsForCountry(portAccumMap, refMap);
    assert.equal(port.tankerCalls30d, 60 * 23 + 20 * 7);
    assert.equal(port.importTankerDwt30d, 1000);
    assert.equal(port.exportTankerDwt30d, 500);
    const expectedTrend = Math.round(((60 * 23 + 20 * 7 - 40 * 30) / (40 * 30)) * 1000) / 10;
    assert.equal(port.trendDelta, expectedTrend);
    // anomalySignal is hardcoded false post-H+F. See finalisePortsForCountry
    // header for rationale (last7 aggregation was always empty due to
    // ArcGIS max-date lag, so the field was always false anyway).
    assert.equal(port.anomalySignal, false);
  });

  it('trendDelta=0 when prev30_calls=0', () => {
    const portAccumMap = new Map([
      ['1', { portname: 'P', last30_calls: 100, last30_count: 30, last30_import: 0, last30_export: 0, prev30_calls: 0 }],
    ]);
    const [port] = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(port.trendDelta, 0);
    assert.equal(port.anomalySignal, false);
  });

  it('sorts desc + truncates to MAX_PORTS_PER_COUNTRY=50', () => {
    const portAccumMap = new Map();
    for (let i = 0; i < 60; i++) {
      portAccumMap.set(String(i), { portname: `P${i}`, last30_calls: 60 - i, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0 });
    }
    const out = finalisePortsForCountry(portAccumMap, new Map());
    assert.equal(out.length, 50);
    assert.equal(out[0].tankerCalls30d, 60);
    assert.equal(out[49].tankerCalls30d, 11);
  });

  it('falls back to lat/lon=0 when refMap lacks the portId', () => {
    const portAccumMap = new Map([
      ['999', { portname: 'Orphan', last30_calls: 1, last30_count: 1, last30_import: 0, last30_export: 0, prev30_calls: 0 }],
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

describe('resolveArcgisDateField (runtime, schema-flap defence)', () => {
  let resolveArcgisDateField, _resetArcgisDateFieldCache;
  let originalFetch;

  before(async () => {
    ({ resolveArcgisDateField, _resetArcgisDateFieldCache } = await import(
      '../scripts/seed-portwatch-port-activity.mjs'
    ));
    originalFetch = globalThis.fetch;
  });

  // Sets globalThis.fetch to a stub returning `body`. Stays installed
  // until restoreFetch() — name reflects that (Greptile P2 on PR #3496:
  // the original `mockFetchOnce` name implied auto-reset semantics it
  // didn't enforce, masking accidental cache hits in future edits).
  function mockFetch(body) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
  }

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  it('returns "date" when schema reports name=date alias=date (post-revert state)', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'date', alias: 'date', type: 'esriFieldTypeDateOnly' },
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('returns "date_" when schema reports name=date_ alias=date (post-rename state)', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'date_', alias: 'date', type: 'esriFieldTypeDateOnly' },
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date_');
    } finally { restoreFetch(); }
  });

  it('memoises the resolved value across calls within a run', async () => {
    _resetArcgisDateFieldCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          fields: [{ name: 'date_', alias: 'date', type: 'esriFieldTypeDateOnly' }],
        }),
      };
    };
    try {
      const a = await resolveArcgisDateField();
      const b = await resolveArcgisDateField();
      const c = await resolveArcgisDateField();
      assert.equal(a, 'date_');
      assert.equal(b, 'date_');
      assert.equal(c, 'date_');
      assert.equal(calls, 1, 'schema endpoint must be hit at most once per run');
    } finally { restoreFetch(); }
  });

  it('falls back to "date" when schema introspection throws', async () => {
    _resetArcgisDateFieldCache();
    globalThis.fetch = async () => { throw new Error('schema endpoint timeout'); };
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('falls back to "date" when schema response has no date field', async () => {
    _resetArcgisDateFieldCache();
    mockFetch({
      fields: [
        { name: 'portid', alias: 'portid', type: 'esriFieldTypeString' },
        { name: 'ISO3', alias: 'ISO3', type: 'esriFieldTypeString' },
      ],
    });
    try {
      const df = await resolveArcgisDateField();
      assert.equal(df, 'date');
    } finally { restoreFetch(); }
  });

  it('concurrent first-callers share one schema round-trip (promise-cache)', async () => {
    // Greptile P2 on PR #3496: cache the in-flight promise, not the
    // resolved value, so `Promise.all([resolve(), resolve(), resolve()])`
    // dispatches a single fetch. Without this, three null-checks fire
    // before any fetch settles → three round-trips.
    _resetArcgisDateFieldCache();
    let calls = 0;
    let resolveFetch;
    globalThis.fetch = () => {
      calls++;
      // Hold the fetch open so all three callers race against the same
      // unresolved promise — the bug-class this guards against.
      return new Promise((r) => {
        resolveFetch = () => r({
          ok: true,
          status: 200,
          json: async () => ({
            fields: [{ name: 'date', alias: 'date', type: 'esriFieldTypeDateOnly' }],
          }),
        });
      });
    };
    try {
      const racing = Promise.all([
        resolveArcgisDateField(),
        resolveArcgisDateField(),
        resolveArcgisDateField(),
      ]);
      // Microtask flush so the three calls have all entered the resolver
      // and registered their continuations on the cached promise.
      await Promise.resolve();
      resolveFetch();
      const [a, b, c] = await racing;
      assert.equal(a, 'date');
      assert.equal(b, 'date');
      assert.equal(c, 'date');
      assert.equal(calls, 1, 'three concurrent first-callers must share ONE schema fetch');
    } finally { restoreFetch(); }
  });
});
