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

  it('EP3 per-country query does NOT orderBy on the date field — DateOnly sort cliff', () => {
    // WM 2026-05-06 trap: ArcGIS migrated Daily_Ports_Data's `date` column
    // to esriFieldTypeDateOnly. Server-side sort on DateOnly is 10-15× slower
    // than no-sort. With CONCURRENCY=12 and a 90s per-country cap, every
    // per-country fetch was timing out (BRA 60d page = 46.6s with
    // `portid ASC,date ASC` vs 4.0s with no orderBy → ~140s/country vs ~12s).
    //
    // The aggregation in paginateWindowInto is order-INdependent (sums into
    // Map<portId, accum>), so dropping orderBy is safe AND fast. ArcGIS
    // still returns rows in default ObjectId order across pages, so
    // resultOffset pagination remains correct.
    //
    // If a future refactor genuinely needs ordered output, sort
    // CLIENT-side after pagination — never re-add orderByFields with the
    // ${df} (date) field on EP3, even with `${df} ASC` or `${df} DESC`.
    assert.doesNotMatch(src, /orderByFields:\s*[`'][^`']*\$\{df\}/);
    // Also forbid hardcoded date-field literals in the orderBy template.
    assert.doesNotMatch(src, /orderByFields:\s*[`'][^`']*\b(date|date_)\s+(ASC|DESC)\b/i);
  });

  it('EP4 refs query fetches all ports globally with where=1=1', () => {
    assert.match(src, /where:\s*'1=1'/);
    assert.match(src, /outFields:\s*'portid,ISO3,lat,lon'/);
  });

  it('EP4 refs query MAY orderBy portid (string field, not DateOnly)', () => {
    // EP4 = PortWatch_ports_database (static port-reference table), no date
    // column. Sorting by portid (string) is fine — the DateOnly cliff is
    // specific to EP3. This test exists so a future "remove all orderBy
    // everywhere" sweep doesn't blanket-remove this one.
    assert.match(src, /orderByFields:\s*'portid ASC'/);
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

  it('CONCURRENCY is 6 and PER_COUNTRY_TIMEOUT_MS is 90s', () => {
    // Halved from 12 → 6 on 2026-05-14 (PR #3694) to ease pressure on both
    // ArcGIS-direct AND Decodo-proxy rate-limits during the ongoing
    // ArcGIS degradation. Math at concurrency 6 + cold-fetch cap 30:
    //   5 batches × ~60s realistic (90s worst case) + 4×5s backoff
    //   ≈ 320s realistic, 470s worst case — still fits the 570s
    //   bundle budget.
    assert.match(src, /const CONCURRENCY\s*=\s*6/);
    assert.match(src, /PER_COUNTRY_TIMEOUT_MS\s*=\s*90_000/);
  });

  it('BATCH_BACKOFF_MS spaces out per-batch bursts + signal-aborts break the loop', () => {
    // Inter-batch sleep prevents back-to-back rate-limit hits on Decodo +
    // ArcGIS. Post-#3681 run #2 showed Decodo throttling us after run #1
    // hammered it (24/30 → 5/30 success degradation). 5s × 4 = 20s total
    // added; negligible against the 570s bundle budget.
    assert.match(src, /const BATCH_BACKOFF_MS\s*=\s*5_000/);
    // The sleep itself is gated on not-last-batch. Pre-Greptile P2 it was
    // also gated on !signal.aborted but the loop kept iterating after the
    // skipped sleep — defeating the SIGTERM-responsiveness intent. Now an
    // aborted signal `break`s the loop entirely (Greptile PR #3694 P2).
    assert.match(src, /if\s*\(\s*signal\?\.aborted\s*\)\s*break/);
    assert.match(src, /if\s*\(\s*batchIdx\s*<\s*batches\s*\)/);
    assert.match(src, /setTimeout\(r,\s*BATCH_BACKOFF_MS\)/);
  });

  it('MIN_VALID_COUNTRIES is temporarily lowered to 25 (ArcGIS degraded)', () => {
    // Pre-2026-05-14 value: 50. Lowered to 25 to let seed-meta refresh
    // during the ArcGIS rate-limit degradation. The comment must call
    // out the temporary nature + review date so this doesn't get
    // forgotten as the new permanent floor.
    assert.match(src, /const MIN_VALID_COUNTRIES\s*=\s*25/);
    // Require the comment to flag temporariness (so a future reviewer
    // doesn't normalise the lower value silently).
    assert.match(src, /TEMPORARILY lowered from 50/);
    assert.match(src, /Revert to 50/);
  });

  // Greptile PR #3694 round 3 P1: with the temp gate lowered to 25 but the
  // 80% degradation guard unchanged, a cap-mode partial-success run that
  // CLEARS the coverage gate (countryData.size ≥ 25) would STILL fail the
  // degradation guard (countryData.size < prevCount × 0.8 ≈ 139). The fix
  // is to bypass the degradation guard when capTriggered.
  it('degradation guard is bypassed when capTriggered (cap-mode partial publish)', () => {
    // fetchAll must surface capTriggered + counter fields to main()
    assert.match(src, /capTriggered,\s*\n\s*servedStaleCount,/);
    assert.match(src, /droppedTooOldCount,/);
    assert.match(src, /droppedNoCacheCount,/);
    // main() must read those fields off the fetchAll result
    assert.match(src, /capTriggered,\s*\n\s*servedStaleCount,\s*\n\s*droppedTooOldCount,\s*\n\s*droppedNoCacheCount,\s*\n\s*\}\s*=\s*await fetchAll/);
    // The guard branch must be wrapped in `if (capTriggered) {} else if (...)`
    // so cap-mode runs SKIP the guard entirely (not just log a warning and
    // then still fall through to the guard).
    assert.match(src, /if\s*\(\s*capTriggered\s*\)\s*\{[\s\S]+?PARTIAL PUBLISH \(cap-mode\)[\s\S]+?\}\s*else if\s*\(\s*prevCount\s*>\s*0\s*&&\s*countryData\.size\s*<\s*prevCount\s*\*\s*0\.8\s*\)/);
  });

  it('cap-mode partial publish logs operator-visible bucket counts', () => {
    // Without this log, operators see seed-meta advance but have no signal
    // that the publish was partial. The log must include servedStale,
    // droppedTooOld, droppedNoCache counts so /api/health WARNING ↔ HEALTHY
    // transitions are explainable from the seed log alone.
    assert.match(src, /PARTIAL PUBLISH \(cap-mode\)/);
    assert.match(src, /\$\{servedStaleCount\}\s*stale-served/);
    assert.match(src, /\$\{droppedTooOldCount\}\s*dropped/);
    assert.match(src, /\$\{droppedNoCacheCount\}\s*dropped/);
    assert.match(src, /Degradation guard bypassed/);
  });

  it('non-cap-mode runs still enforce the 80% degradation guard (silent-loss protection)', () => {
    // The bypass MUST only fire when capTriggered. A run where
    // needsFetch.length ≤ MAX_COLD_FETCH_PER_RUN (normal happy path) must
    // still apply the 80% guard so an ArcGIS schema regression that
    // silently drops 100 → 50 countries can't sneak through as a publish.
    //
    // Assert by structure: the else-if branch contains the prevCount × 0.8
    // comparison and a DEGRADATION GUARD error+return, AND the comparison
    // is INSIDE the else-if condition (not in a separate unconditional
    // check before it that would bypass the else-if scoping).
    assert.match(src, /else if\s*\([\s\S]{0,200}prevCount\s*\*\s*0\.8[\s\S]{0,200}\)\s*\{[\s\S]{0,400}DEGRADATION GUARD/);
    // Ensure the 0.8 threshold appears exactly twice (once in the
    // condition, once in the error message's `Math.ceil(prevCount * 0.8)`
    // suggestion) — both inside the else-if scope. A third occurrence
    // would suggest a duplicated check leaked outside the bypass.
    const matches = src.match(/prevCount\s*\*\s*0\.8/g) ?? [];
    assert.equal(
      matches.length,
      2,
      `expected exactly 2 prevCount × 0.8 references (condition + error-msg suggestion), found ${matches.length}`,
    );
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

  // WM 2026-05-13 incident: ArcGIS silently stalled instead of returning
  // 429, so all 30 cold-fetches timed out at 45s without ever entering
  // the 429 retry branch. Fix: also fall through to proxy on timeout /
  // transient network errors.
  it('proxy fallback also fires on timeout (not just HTTP 429)', () => {
    // The fetchWithTimeout body must wrap `await fetch(...)` in try/catch
    // so a thrown AbortError (timeout) can be inspected and re-dispatched
    // to the proxy path. Pre-fix the fetch was bare-awaited, so any
    // throw exited the function before the 429 branch.
    assert.match(src, /try\s*\{[\s\S]*?resp\s*=\s*await fetch\(url/);
    // The catch block must detect timeout-class errors before deciding to
    // re-throw vs retry-via-proxy.
    assert.match(src, /errName\s*===\s*'TimeoutError'/);
    assert.match(src, /isTimeoutLike/);
  });

  it('proxy retry helper is shared between 429 and timeout paths', () => {
    // Centralized in arcgisProxyRetry so both branches behave identically
    // (same Decodo creds resolution, same proxy-side timeout budget, same
    // error message format). Pre-fix the 429 branch had inline proxy
    // logic; the timeout path would have duplicated it. Refactored to
    // share the helper.
    assert.match(src, /async function arcgisProxyRetry/);
    // Both branches must dispatch through the helper:
    const callSites = src.match(/arcgisProxyRetry\(url,/g) ?? [];
    assert.ok(
      callSites.length >= 2,
      `arcgisProxyRetry must be called from both 429 and timeout paths, found ${callSites.length}`,
    );
  });

  it('caller signal-abort propagates without proxy retry (real cancellation)', () => {
    // If the OUTER signal aborts (SIGTERM, per-country 90s timeout), we
    // must NOT silently retry via proxy — the caller is asking us to
    // stop. The check is `if (signal?.aborted) throw err`. Without this,
    // a SIGTERM-triggered abort would still fire a proxy attempt and
    // potentially miss the shutdown window.
    assert.match(src, /if\s*\(\s*signal\?\.aborted\s*\)\s*throw err/);
  });

  it('proxy fallback distinguishes timeout error sources for operator visibility', () => {
    // Pre-fix the 429 warn log said only "429 rate-limited — retrying via
    // proxy". Post-fix the same helper is reused with a reason string,
    // so operator logs distinguish "HTTP 429 rate-limited" from "direct
    // TimeoutError" from "direct AbortError". Critical for diagnosing
    // whether ArcGIS is explicitly rate-limiting (429) or silently
    // stalling (timeout) — different mitigation paths.
    assert.match(src, /direct \$\{errName \|\| 'timeout'\}/);
    assert.match(src, /'HTTP 429 rate-limited'/);
  });

  // Greptile PR #3681 review round 2 P2: combined direct + proxy budget must
  // stay under PER_COUNTRY_TIMEOUT_MS with slack for proxy setup overhead.
  it('proxy timeout is tighter than direct timeout to leave PER_COUNTRY budget slack', () => {
    // FETCH_TIMEOUT (45s) + PROXY_FETCH_TIMEOUT (35s) = 80s, under
    // PER_COUNTRY_TIMEOUT_MS (90s) with 10s slack for Decodo TCP handshake
    // + CONNECT setup. Pre-fix used FETCH_TIMEOUT on both sides (90s exact,
    // racey with the per-country signal abort).
    assert.match(src, /const PROXY_FETCH_TIMEOUT\s*=\s*35_000/);
    // The proxy retry MUST pass PROXY_FETCH_TIMEOUT, not FETCH_TIMEOUT:
    assert.match(src, /timeoutMs:\s*PROXY_FETCH_TIMEOUT/);
    // And the budget invariant: direct + proxy < per-country.
    const fetchTimeout = src.match(/const FETCH_TIMEOUT\s*=\s*(\d+_?\d*)/)?.[1];
    const proxyTimeout = src.match(/const PROXY_FETCH_TIMEOUT\s*=\s*(\d+_?\d*)/)?.[1];
    const perCountry = src.match(/const PER_COUNTRY_TIMEOUT_MS\s*=\s*(\d+_?\d*)/)?.[1];
    const parseMs = (s) => parseInt((s ?? '0').replace(/_/g, ''), 10);
    const total = parseMs(fetchTimeout) + parseMs(proxyTimeout);
    const perCountryMs = parseMs(perCountry);
    assert.ok(
      total < perCountryMs,
      `direct(${fetchTimeout}) + proxy(${proxyTimeout}) = ${total}ms must be < PER_COUNTRY_TIMEOUT_MS(${perCountryMs}); ` +
      `pre-fix 45+45=90 exactly equalled per-country, no slack for proxy setup.`,
    );
    // Specifically require ≥5s slack for the TCP handshake and CONNECT setup
    // to Decodo, which can run ~3-5s on cold connections.
    assert.ok(
      perCountryMs - total >= 5000,
      `proxy setup needs ≥5s slack; got ${perCountryMs - total}ms`,
    );
  });

  // Greptile PR #3681 review round 2 P2: ArcGIS can return error objects
  // without a `message` field (observed `{"error":{"code":400}}`). The thrown
  // message must stay informative on unexpected shapes.
  it('proxy error message falls back through message → code → JSON.stringify', () => {
    assert.match(
      src,
      /proxied\.error\.message\s*\?\?\s*proxied\.error\.code\s*\?\?\s*JSON\.stringify\(proxied\.error\)/,
      'proxy error path must fall back through message → code → JSON.stringify so `undefined` never reaches the thrown message',
    );
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

// WM 2026-05-13 incident: when upstream advanced ArcGIS data after two days of
// "frozen" runs, every cached country's `asof` mismatched, producing a
// 174-country cold-fetch. The 570s bundle budget couldn't cover it (preflight
// alone took 360s; batch 1 of 15 hit 12 errors at 45s before SIGTERM).
// Result: 37 hours of stale data + UptimeRobot WARNING.
//
// Fix: cap cold-fetches per run; serve the deferred countries from prior
// (slightly-stale) cache rather than dropping them. Full rotation across
// ~ceil(N / cap) runs.
describe('cold-fetch cap prevents 174-country cliff (WM 2026-05-13)', () => {
  it('MAX_COLD_FETCH_PER_RUN constant is declared with a sane value', () => {
    // The cap value must allow the cold-fetch loop to fit comfortably inside
    // the 570s bundle budget at the observed ~3-5s/country with concurrency
    // 12. 30 × 5s / 12 ≈ 13s — well under budget, with plenty of room for
    // preflight + write phases.
    assert.match(src, /const MAX_COLD_FETCH_PER_RUN\s*=\s*30/);
  });

  it('cap triggers when needsFetch exceeds the cap (not a no-op)', () => {
    // The guard must be a > comparison so a needsFetch of EXACTLY the cap
    // doesn't trigger the partition path (which would create an unnecessary
    // shuffle/log line for the happy case where everything fits).
    assert.match(src, /if\s*\(\s*needsFetch\.length\s*>\s*MAX_COLD_FETCH_PER_RUN\s*\)/);
  });

  it('deferred countries are served from prior payload with staleAsof=true', () => {
    // Without this fallback, a deferred country DROPS from the canonical
    // output — that's the same as a hard-fail for the consumer. Marking
    // staleAsof preserves the country's data shape but signals "one window
    // behind" so downstream can render or warn accordingly.
    assert.match(src, /\.\.\.prev,\s*staleAsof:\s*true/);
  });

  it('deferred-stale path respects MAX_CACHE_AGE_MS hard-drop (Greptile P1)', () => {
    // The cacheFresh check enforces a 7-day age gate via `(now - cacheWrittenAt)
    // < MAX_CACHE_AGE_MS`. The deferred-stale fallback MUST enforce the same
    // gate, otherwise a country repeatedly deferred across enough runs while
    // upstream was frozen >4 days could publish data older than the intended
    // hard-drop threshold (window-drift). Greptile review P1 on PR #3676.
    //
    // Assert the age comparison appears inside the cap block (between the
    // shuffle and the needsFetch reassignment) — using a multi-line regex
    // that requires shuffle → cacheWrittenAt → MAX_CACHE_AGE_MS in order.
    const capBlock = src.match(
      /needsFetch\.length\s*>\s*MAX_COLD_FETCH_PER_RUN[\s\S]+?needsFetch\s*=\s*shuffled\.slice/,
    );
    assert.ok(capBlock, 'cap block found');
    assert.match(
      capBlock[0],
      /cacheWrittenAt[\s\S]{0,200}MAX_CACHE_AGE_MS/,
      'deferred-stale path must compare prev.cacheWrittenAt against MAX_CACHE_AGE_MS',
    );
    // And the failure-bucket counter exists so operators can see how many
    // countries dropped via the age gate (vs no-cache).
    assert.match(src, /droppedTooOld/);
  });

  it('partition path captures prevPayload alongside iso3/iso2/upstreamMaxDate', () => {
    // The needsFetch entries gained a 4th field (prevPayload) so the cap
    // logic can fall back to cached data per-country. Pre-fix the entries
    // were {iso3, iso2, upstreamMaxDate} — adding prevPayload is the
    // critical contract change for the deferred-serving path.
    assert.match(src, /needsFetch\.push\(\{\s*iso3,\s*iso2,\s*upstreamMaxDate,\s*prevPayload:\s*prev\s*\}\)/);
  });

  it('cap logs refresh count + defer count for operator visibility', () => {
    // When the cap fires, an operator hitting `/api/health?history=1` and
    // pulling the Railway log needs to see "X refreshing, Y deferred on
    // stale cache, Z dropped (cache too old), W dropped (no prior payload)"
    // — without per-bucket counts, "everything looked fine" (174 records
    // published) would mask that some are a window behind and some are
    // beyond the hard-drop threshold.
    assert.match(src, /Cold-fetch capped/);
    assert.match(src, /refreshing/);
    assert.match(src, /\$\{servedStale\}/);
    assert.match(src, /\$\{droppedTooOld\}/);
    assert.match(src, /\$\{droppedNoCache\}/);
  });

  it('rotation arithmetic uses MAX_COLD_FETCH_PER_RUN directly, not needsFetch.length (Greptile P2)', () => {
    // After `needsFetch = shuffled.slice(0, MAX_COLD_FETCH_PER_RUN)`,
    // `needsFetch.length` numerically equals MAX_COLD_FETCH_PER_RUN — so the
    // pre-fix arithmetic was coincidentally correct. But if the log block
    // is ever reordered above the reassignment (or the cap value changes
    // dynamically), `needsFetch.length` would silently break. Using the
    // constant directly makes the intent unambiguous. Greptile review P2
    // on PR #3676.
    const capBlock = src.match(
      /needsFetch\.length\s*>\s*MAX_COLD_FETCH_PER_RUN[\s\S]+?Rotation:/,
    );
    assert.ok(capBlock, 'cap block found');
    // The rotation expression must reference MAX_COLD_FETCH_PER_RUN, not
    // needsFetch.length, in its numerator/denominator.
    assert.match(
      capBlock[0],
      /originalMisses\s*=\s*MAX_COLD_FETCH_PER_RUN/,
      'rotation total must be expressed as cap + stale + dropped, using the constant',
    );
  });

  it('needsFetch is declared with let (mutable) — cap path reassigns it', () => {
    // The cap path slices needsFetch to keep only the refresh-now subset.
    // Pre-fix needsFetch was const. This regression-guards a future cleanup
    // that switches it back without realizing the cap path mutates it.
    assert.match(src, /let needsFetch\s*=\s*\[\]/);
    // And the reassignment in the cap path:
    assert.match(src, /needsFetch\s*=\s*shuffled\.slice\(0,\s*MAX_COLD_FETCH_PER_RUN\)/);
  });

  it('full rotation is computable: ~ceil(174 / 30) = 6 runs ≈ 3 days at 12h cadence', () => {
    // Documentation-grade test: encodes the rotation math so a future
    // bump to the cap (or a different country count) surfaces the
    // implication via failure rather than silent drift.
    const cap = 30;
    const countries = 174;
    const cronIntervalHours = 12;
    const runs = Math.ceil(countries / cap);
    const fullRotationHours = runs * cronIntervalHours;
    assert.equal(runs, 6);
    assert.equal(fullRotationHours, 72, 'full rotation must stay under MAX_CACHE_AGE_MS (7d = 168h)');
    assert.ok(fullRotationHours < 168, 'rotation must complete before MAX_CACHE_AGE_MS forces hard drops');
  });
});
