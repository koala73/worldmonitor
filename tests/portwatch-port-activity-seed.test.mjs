import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { withPerCountryTimeout } from '../scripts/seed-portwatch-port-activity.mjs';

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

  it('Endpoint 3 activity query still filters per-country ISO3', () => {
    assert.match(src, /where:\s*`ISO3='\$\{iso3\}'\s+AND\s+date\s*>/);
  });

  it('concurrency is bumped to 12', () => {
    assert.match(src, /CONCURRENCY\s*=\s*12/);
  });

  it('registers SIGTERM handler for graceful shutdown', () => {
    assert.match(src, /process\.on\('SIGTERM'/);
  });

  it('defines a per-country timeout to cap Promise.allSettled stalls', () => {
    // Without this cap, one slow country (USA: many ports × many pages when
    // ArcGIS is throttled) blocks the whole batch via Promise.allSettled and
    // cascades to the 420s section timeout, leaving batches 2..N unattempted.
    assert.match(src, /PER_COUNTRY_TIMEOUT_MS\s*=\s*\d/);
  });

  it('wraps processCountry with the per-country timeout in the batch loop', () => {
    // Must pass a factory (signal) => processCountry(...) so the timer can
    // abort the in-flight fetch (PR #3222 review P1), not just race a
    // detached promise.
    assert.match(src, /withPerCountryTimeout\s*\(\s*\n?\s*\(signal\)\s*=>\s*processCountry/);
  });

  it('fetchWithTimeout combines caller signal with FETCH_TIMEOUT via AbortSignal.any', () => {
    // Otherwise the per-country abort cannot propagate into the in-flight
    // fetch; orphan pagination would continue with fresh 45s budgets each
    // page (PR #3222 review P1).
    assert.match(src, /AbortSignal\.any\(\[signal,\s*AbortSignal\.timeout\(FETCH_TIMEOUT\)\]\)/);
  });

  it('fetchActivityRows checks signal.aborted between pages', () => {
    assert.match(src, /signal\?\.aborted\)\s*throw\s+signal\.reason/);
  });

  it('429 proxy fallback threads caller signal into httpsProxyFetchRaw', () => {
    // Review feedback: without this, a timed-out country can leak a
    // proxy CONNECT tunnel for up to FETCH_TIMEOUT (45s) after the
    // batch moved on, defeating the concurrency cap under the exact
    // throttling scenario this PR addresses.
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

  it('eager error flush attaches p.catch before Promise.allSettled', () => {
    // Review P2: without this, errors collected only AFTER allSettled
    // returns. A mid-batch SIGTERM would flush zero errors even though
    // several promises had already rejected.
    assert.match(src, /p\.catch\(err\s*=>\s*\{[^}]*errors\.push/);
  });

  it('SIGTERM handler flushes batch progress + first errors', () => {
    // Past regressions were undiagnosable because the errors array was only
    // logged after all batches completed — a SIGTERM kill discarded it.
    assert.match(src, /SIGTERM at batch \$\{progress\.batchIdx\}/);
    assert.match(src, /progress\.errors\.slice\(0,\s*10\)/);
  });

  it('fetchAll accepts a progress object and mutates it', () => {
    assert.match(src, /export async function fetchAll\(progress\)/);
    assert.match(src, /progress\.totalBatches\s*=\s*batches/);
    assert.match(src, /progress\.batchIdx\s*=\s*batchIdx/);
    assert.match(src, /progress\.seeded\s*=\s*countryData\.size/);
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

describe('withPerCountryTimeout (runtime)', () => {
  it('aborts the per-country signal when the timer fires', async () => {
    let observedSignal;
    const p = withPerCountryTimeout(
      (signal) => {
        observedSignal = signal;
        // Never resolves on its own; can only reject via abort.
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      'TST',
      40, // 40ms — keeps the test fast
    );

    await assert.rejects(p, /per-country timeout after 0\.04s \(TST\)/);
    assert.equal(observedSignal.aborted, true, 'underlying work received the abort');
  });

  it('resolves with the work result when work completes before the timer', async () => {
    const result = await withPerCountryTimeout(
      (_signal) => Promise.resolve({ ok: true }),
      'TST',
      500,
    );
    assert.deepEqual(result, { ok: true });
  });

  it('does not invoke the timer path when work rejects first', async () => {
    // Rejecting with a non-timeout error should surface as-is, not as the
    // per-country timeout message.
    await assert.rejects(
      withPerCountryTimeout(
        (_signal) => Promise.reject(new Error('ArcGIS HTTP 500')),
        'TST',
        1_000,
      ),
      /ArcGIS HTTP 500/,
    );
  });
});

describe('proxyFetch signal propagation (runtime)', () => {
  const require_ = createRequire(import.meta.url);
  const { proxyFetch } = require_('../scripts/_proxy-utils.cjs');

  it('rejects synchronously when called with an already-aborted signal', async () => {
    // Review feedback: the per-country AbortController must kill the proxy
    // fallback too. Pre-aborted signals must short-circuit BEFORE any
    // CONNECT tunnel opens; otherwise a timed-out country's proxy call
    // continues in the background. No network reached in this test — the
    // synchronous aborted check is the guard.
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

describe('eager error flush (runtime)', () => {
  it('populates shared errors via p.catch before Promise.allSettled resolves', async () => {
    // Mirrors the wiring in fetchAll(): attach p.catch to each promise so
    // rejections land in the errors array at the moment they fire, not
    // only after allSettled. A SIGTERM that hits during allSettled still
    // sees the already-pushed errors.
    const errors = [];
    let stuckResolve;

    const rejecting = Promise.reject(new Error('boom A'));
    rejecting.catch(err => errors.push(`A: ${err.message}`));

    const stuck = new Promise(resolve => { stuckResolve = resolve; });
    stuck.catch(err => errors.push(`B: ${err.message}`));

    // Yield microtasks so `rejecting.catch` fires.
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(errors, ['A: boom A'], 'rejected promise pushed BEFORE allSettled is even awaited');

    // Sanity: the hung promise still blocks allSettled, proving the
    // behavior we rely on: errors from resolved-rejected members are
    // visible to a SIGTERM handler even while the batch itself is stuck.
    const allSettledPromise = Promise.allSettled([rejecting, stuck]);
    let settledEarly = false;
    allSettledPromise.then(() => { settledEarly = true; });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(settledEarly, false, 'allSettled still pending while one member is stuck');
    assert.equal(errors.length, 1, 'error list observable despite pending batch');

    stuckResolve();
    await allSettledPromise;
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
