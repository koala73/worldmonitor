'use strict';

const https = require('node:https');
const { spawn } = require('node:child_process');

const YAHOO_COOKIE_URL = 'https://fc.yahoo.com';
const YAHOO_CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const YAHOO_SUMMARY_BASE_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const YAHOO_V7_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
// `price.symbol` is the identity-bearing field for ETF quoteSummary payloads;
// the valuation modules alone return valid fields without any symbol identity.
const YAHOO_SUMMARY_MODULES = 'price,summaryDetail,defaultKeyStatistics';
const LAST_GOOD_KEY = 'market:sectors:valuations:last-good';
const LAST_GOOD_TTL = 7 * 24 * 3600;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_SPACING_MS = 150;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SECTOR_VALUATION_BUDGET_MS = 60_000;
// The batch fallback runs before the quoteSummary tier, so it gets a bounded
// slice rather than the whole remainder: BATCH_MIN_BUDGET_MS is the floor below
// which issuing it is pointless, BATCH_BUDGET_MS the ceiling it may consume.
const BATCH_MIN_BUDGET_MS = 2_000;
// Sized against the MEASURED cost of one exit through a residential proxy:
// cookie + crumb + quote runs ~7s, so the previous 15s ceiling admitted only two
// exits and DEFAULT_MAX_EXIT_ATTEMPTS was unreachable in production -- the cap
// that actually bound rotation was this budget, not the attempt count. 30s fits
// four and still leaves half the 60s valuation budget for the quoteSummary tier,
// which only runs for symbols the batch failed to cover.
const BATCH_BUDGET_MS = 30_000;
// Yahoo's quote fundamentals cache is populated PER RESIDENTIAL EXIT IP: across
// 10 rotated Decodo exits, 7 answered HTTP 200 while omitting trailingPE for a
// stable subset of sector ETFs and 3 served it.
//
// Note this is NOT an independent 1-(0.7)^4 draw per cycle: the window is
// deterministic (start..start+3 from the remembered exit), so a window whose
// exits are all bad stays bad on repeat. That is why an exhausted window
// advances the remembered start rather than re-probing itself -- the exploration
// across cycles, not the width of any single window, is what finds a good exit.
// Raising this widens one cycle's search at the cost of proxy bandwidth, which
// is metered and whose exhaustion has taken the seeder fleet down before.
const DEFAULT_MAX_EXIT_ATTEMPTS = 4;
// Where the BATCH TIER should start next: either the exit with the best full-set
// coverage or the first exit after a fully exhausted search window. This does
// not change the per-symbol tier above it, which still uses the configured exit.
const PREFERRED_EXIT_KEY = 'market:sectors:valuations:proxy-exit';
const PREFERRED_EXIT_TTL = 24 * 3600;
// Redis carries the preference across processes and restarts. This process-local
// copy keeps a live relay moving when an optional Redis write times out or is
// temporarily unavailable; it is keyed by the long-lived client so tests and
// independent collectors cannot leak state into one another.
const LOCAL_PREFERRED_EXITS = new WeakMap();
const CURL_PROCESS_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Session and cooldown state is keyed by exit, and the relay is a long-running
// process whose preferred exit walks forward over days, so these maps would grow
// without bound. Evicting the oldest insertion is safe: a dropped entry costs one
// cookie+crumb bootstrap or one forgotten cooldown, never correctness.
const MAX_TRACKED_EXIT_STATES = 64;

function boundedMapGet(map, key, create) {
  const existing = map.get(key);
  if (existing) return existing;
  if (map.size >= MAX_TRACKED_EXIT_STATES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  const value = create();
  map.set(key, value);
  return value;
}

function requestHttpsText(
  url,
  {
    headers = {},
    timeoutMs = 12_000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    httpsGet = https.get,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    req = httpsGet(url, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      let bodyBytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (settled) return;
        bodyBytes += Buffer.byteLength(chunk, 'utf8');
        if (bodyBytes > maxResponseBytes) {
          settled = true;
          const error = new Error(
            `Yahoo response exceeded ${maxResponseBytes} byte limit`,
          );
          error.code = 'RESPONSE_TOO_LARGE';
          response.destroy();
          req?.destroy(error);
          reject(error);
          return;
        }
        body += chunk;
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body,
        });
      });
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Yahoo request timed out after ${timeoutMs}ms`));
    });
  });
}

function parseCurlResponse(stdout) {
  const marker = '\n__WM_HTTP_STATUS__:';
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) throw new Error('Yahoo proxy response omitted HTTP status');

  const responseText = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + marker.length).trim());
  let cursor = 0;
  let headers = null;
  while (responseText.startsWith('HTTP/', cursor)) {
    const crlfHeaderEnd = responseText.indexOf('\r\n\r\n', cursor);
    const lfHeaderEnd = responseText.indexOf('\n\n', cursor);
    const useCrlf = crlfHeaderEnd >= 0
      && (lfHeaderEnd < 0 || crlfHeaderEnd <= lfHeaderEnd);
    const headerEnd = useCrlf ? crlfHeaderEnd : lfHeaderEnd;
    const separatorLength = useCrlf ? 4 : 2;
    if (headerEnd < 0) throw new Error('Yahoo proxy response omitted HTTP headers');

    const headerLines = responseText.slice(cursor, headerEnd).split(/\r?\n/).slice(1);
    headers = {};
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'set-cookie') {
        if (!Array.isArray(headers[name])) headers[name] = [];
        headers[name].push(value);
      } else {
        headers[name] = value;
      }
    }
    cursor = headerEnd + separatorLength;
  }
  if (!headers) throw new Error('Yahoo proxy response omitted HTTP headers');

  return {
    status,
    headers,
    body: responseText.slice(cursor),
  };
}

function curlConfigValue(value) {
  const text = String(value);
  if (/\r|\n/.test(text)) throw new Error('Yahoo proxy config value contains a newline');
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildCurlConfig(url, { headers = {}, proxy } = {}) {
  const lines = [`proxy = ${curlConfigValue(`http://${proxy}`)}`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
  }
  lines.push(`url = ${curlConfigValue(url)}`);
  return `${lines.join('\n')}\n`;
}

async function requestCurlText(
  url,
  {
    headers = {},
    timeoutMs = 15_000,
    proxy,
    spawnFn = spawn,
  } = {},
) {
  if (!proxy) throw new Error('Yahoo proxy route is not configured');
  const args = [
    '-sS',
    '--compressed',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-D',
    '-',
    '-w',
    '\n__WM_HTTP_STATUS__:%{http_code}',
    '--config',
    '-',
  ];
  const config = buildCurlConfig(url, { headers, proxy });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    const chunks = [];
    let child;
    let timer;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    try {
      child = spawnFn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      fail(error);
      return;
    }

    timer = setTimeout(() => {
      const error = new Error(`Yahoo proxy request timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      try { child.kill('SIGKILL'); } catch {}
      fail(error);
    }, timeoutMs + CURL_PROCESS_GRACE_MS);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > DEFAULT_MAX_RESPONSE_BYTES) {
        const error = new Error(`Yahoo proxy response exceeded ${DEFAULT_MAX_RESPONSE_BYTES} byte limit`);
        error.code = 'RESPONSE_TOO_LARGE';
        try { child.kill('SIGKILL'); } catch {}
        fail(error);
        return;
      }
      chunks.push(buffer);
    });
    child.stderr.on('data', () => {});
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`Yahoo proxy curl exited with ${signal || `code ${code}`}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        resolve(parseCurlResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on('error', fail);
    child.stdin.end(config);
  });
}

function headerValues(headers, name) {
  if (!headers) return [];
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function cookieHeaderFromResponse(response) {
  return headerValues(response?.headers, 'set-cookie')
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter((value) => value && value.includes('='))
    .join('; ');
}

function validCrumb(body) {
  const crumb = String(body || '').trim();
  if (!crumb || crumb.length > 256 || crumb.startsWith('<')) return null;
  return crumb;
}

function rawYahooValue(value) {
  const candidate = value && typeof value === 'object'
    ? value.raw ?? value.fmt
    : value;
  if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    const numeric = Number(candidate);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

// Yahoo v7/finance/quote — different API surface from v10/quoteSummary,
// shares the query1 host with v8/chart (which works from Railway).
// Returns trailingPE, forwardPE, beta but NOT return metrics (ytd, 3Y, 5Y).
function parseV7Quote(body, expectedSymbol = null) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'invalid_json', value: null };
  }
  const quoteResponse = data?.quoteResponse;
  if (quoteResponse?.error) {
    return { kind: 'upstream_error', value: null, failure: 'quote_response_error' };
  }
  const results = quoteResponse?.result;
  if (!Array.isArray(results) || results.length === 0) return { kind: 'no_data', value: null };
  if (results.length !== 1) return { kind: 'ambiguous_result', value: null, failure: 'multiple_quote_results' };
  const result = results[0];
  if (expectedSymbol) {
    const returnedSymbol = typeof result?.symbol === 'string' ? result.symbol : '';
    if (!returnedSymbol) {
      return { kind: 'identity_mismatch', value: null, failure: 'quote_symbol_missing' };
    }
    if (returnedSymbol.toUpperCase() !== String(expectedSymbol).toUpperCase()) {
      return { kind: 'identity_mismatch', value: null, failure: 'quote_symbol_mismatch' };
    }
  }
  const raw = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const value = {
    trailingPE: raw(result.trailingPE),
    forwardPE: raw(result.forwardPE),
    beta: raw(result.beta),
    ytdReturn: null,
    threeYearReturn: null,
    fiveYearReturn: null,
  };
  const missingFields = ['trailingPE', 'forwardPE'].filter((field) => value[field] === null);
  if (missingFields.length === 2) {
    return { kind: 'missing_fields', value, missingFields };
  }
  return {
    kind: 'success',
    value,
    ...(missingFields.length > 0 ? { missingFields } : {}),
  };
}

function parseV7QuoteBatch(body, expectedSymbols = []) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'invalid_json', value: null };
  }
  const quoteResponse = data?.quoteResponse;
  if (quoteResponse?.error) {
    return { kind: 'upstream_error', value: null, failure: 'quote_response_error' };
  }
  const results = quoteResponse?.result;
  if (!Array.isArray(results) || results.length === 0) {
    return { kind: 'no_data', value: null };
  }

  const resultBySymbol = new Map(
    results
      .filter((result) => typeof result?.symbol === 'string')
      .map((result) => [result.symbol.toUpperCase(), result]),
  );
  const valuations = {};
  const outcomes = {};
  for (const symbol of [...new Set(expectedSymbols)]) {
    const result = resultBySymbol.get(String(symbol).toUpperCase());
    if (!result) {
      outcomes[symbol] = { kind: 'no_data', value: null };
      continue;
    }
    const parsed = parseV7Quote(
      JSON.stringify({ quoteResponse: { result: [result] } }),
      symbol,
    );
    outcomes[symbol] = parsed;
    if (parsed.kind === 'success') valuations[symbol] = parsed.value;
  }

  // Only a batch that covered every requested symbol is a healthy route result.
  // A partial batch must NOT short-circuit _fetchRoute's direct -> proxy
  // escalation: the symbols it failed to cover still deserve the proxy leg,
  // which is the whole point of having one. 'partial' carries the recovered
  // rows forward so nothing parsed is thrown away.
  const covered = Object.keys(valuations).length;
  if (covered > 0 && covered === new Set(expectedSymbols).size) {
    return { kind: 'success', value: { valuations, outcomes } };
  }
  if (covered > 0) {
    return { kind: 'partial', value: { valuations, outcomes } };
  }
  const firstOutcome = Object.values(outcomes)[0];
  return {
    kind: firstOutcome?.kind || 'no_data',
    value: { valuations, outcomes },
    ...(firstOutcome?.missingFields ? { missingFields: firstOutcome.missingFields } : {}),
    ...(firstOutcome?.failure ? { failure: firstOutcome.failure } : {}),
  };
}

async function fetchYahooV7QuoteDirect(symbol, { userAgent, timeoutMs = 10_000 } = {}) {
  const url = `${YAHOO_V7_QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`;
  try {
    const response = await requestHttpsText(url, {
      headers: { 'User-Agent': userAgent || 'Mozilla/5.0' },
      timeoutMs,
    });
    if (response.status !== 200) return { kind: 'failed', value: null };
    return parseV7Quote(response.body, symbol);
  } catch {
    return { kind: 'failed', value: null };
  }
}

async function fetchYahooV7QuoteProxy(symbol, { userAgent, proxy, timeoutMs = 15_000 } = {}) {
  if (!proxy) return { kind: 'failed', value: null };
  const url = `${YAHOO_V7_QUOTE_URL}?symbols=${encodeURIComponent(symbol)}`;
  try {
    const response = await requestCurlText(url, {
      headers: { 'User-Agent': userAgent || 'Mozilla/5.0', Accept: 'application/json' },
      timeoutMs,
      proxy,
    });
    if (response.status !== 200) return { kind: 'failed', value: null };
    return parseV7Quote(response.body, symbol);
  } catch {
    return { kind: 'failed', value: null };
  }
}

async function collectV7Valuations(
  symbols,
  {
    userAgent,
    resolveProxyString,
    sleepFn = sleep,
    client,
    deadlineAt = null,
    now = Date.now,
    preferredExitAttempt = 0,
  } = {},
) {
  const freshVals = {};
  const diagnostics = [];
  const valuationSources = new Set();
  let winningExitAttempt = null;
  for (const s of symbols) {
    let result;
    if (deadlineAt != null && now() >= deadlineAt) {
      result = {
        kind: 'deadline_exceeded',
        value: null,
        diagnostics: [{ route: 'v7Quote', attempts: 0, responseClass: 'deadline_exceeded', failure: 'valuation_budget_exceeded' }],
      };
    } else if (client?.fetchV7Detailed) {
      result = await client.fetchV7Detailed(s, { deadlineAt });
    } else {
      const direct = await fetchYahooV7QuoteDirect(s, { userAgent });
      const routeDiagnostics = [{
        route: 'v7Quote',
        transport: 'direct',
        attempts: 1,
        responseClass: direct.kind,
      }];
      if (direct.kind === 'success') {
        result = { ...direct, diagnostics: routeDiagnostics };
      } else {
        const proxy = typeof resolveProxyString === 'function' ? resolveProxyString() : '';
        const proxied = await fetchYahooV7QuoteProxy(s, { userAgent, proxy });
        routeDiagnostics.push({
          route: 'v7Quote',
          transport: 'proxy',
          attempts: 1,
          responseClass: proxied.kind,
        });
        result = { ...proxied, diagnostics: routeDiagnostics };
      }
    }
    diagnostics.push({ symbol: s, outcomes: result?.diagnostics || [] });
    if (result?.kind === 'success') {
      freshVals[s] = result.value;
      if (result.value?.source) valuationSources.add(result.value.source);
    }
    const remainingMs = deadlineAt == null ? DEFAULT_REQUEST_SPACING_MS : Math.max(0, deadlineAt - now());
    if (remainingMs > 0) await sleepFn(Math.min(DEFAULT_REQUEST_SPACING_MS, remainingMs));
  }

  // Yahoo's individual v7 responses can lose valuation fields for a stable
  // subset of ETFs even while the same authenticated endpoint returns them in
  // one bounded batch. Use the batch shape only for symbols still uncovered;
  // the normal per-symbol route remains the primary path and its diagnostics
  // stay intact.
  // Prefer the exit-rotating batch: the omission it recovers from is a property
  // of the exit IP, so a single-exit batch can only ever re-read the same
  // partial cache.
  //
  // The fetchV7BatchDetailed branch is NOT reachable from the production client
  // -- YahooQuoteSummaryClient always defines fetchV7BatchAcrossExits, which
  // degrades to a single attempt on its own when no rotator is wired. It exists
  // for callers that inject a narrower client object (today: test doubles), so
  // that supplying only the older method still works.
  // KNOWN GAP: the per-symbol loop above still reaches the proxy on the
  // CONFIGURED exit, not the remembered one, so on a cycle whose pinned exit is
  // truncating it spends a handful of proxy requests that cannot recover those
  // symbols before this batch runs. Routing that leg through the remembered exit
  // (or dropping it and letting everything uncovered fall to this batch) would
  // remove the waste, but it would also stop the batch running on healthy
  // cycles -- and the batch is what refreshes the remembered exit. That is a
  // design change with its own failure modes, deliberately not bundled here.
  const batchSymbols = symbols.filter((symbol) => !freshVals[symbol]);
  const rotatingBatch = typeof client?.fetchV7BatchAcrossExits === 'function';
  if (
    batchSymbols.length > 0
    && (rotatingBatch || client?.fetchV7BatchDetailed)
    // Require a real slice of budget, not merely "not yet expired": this route
    // runs BEFORE the quoteSummary tier, so an uncapped slow batch would eat
    // the remainder and starve the alternative source entirely.
    && (deadlineAt == null || deadlineAt - now() >= BATCH_MIN_BUDGET_MS)
  ) {
    let batchResult = null;
    let batchError = null;
    try {
      const batchOptions = {
        deadlineAt: deadlineAt == null ? null : Math.min(deadlineAt, now() + BATCH_BUDGET_MS),
      };
      batchResult = rotatingBatch
        ? await client.fetchV7BatchAcrossExits(batchSymbols, {
          ...batchOptions,
          startExitAttempt: preferredExitAttempt,
        })
        : await client.fetchV7BatchDetailed(batchSymbols, batchOptions);
      // A completed cycle may nominate the exit with the best full-set
      // coverage. An exhausted deterministic window must move past every exit
      // it disproved, even when one of them contributed a partial row. Provider
      // failures, deadline exhaustion, and unrotatable routes say nothing about
      // an untested exit and therefore do not move the preference.
      if (
        batchResult?.stopReason === 'complete'
        && Number.isInteger(batchResult?.bestExitAttempt)
      ) {
        winningExitAttempt = batchResult.bestExitAttempt;
      } else if (batchResult?.stopReason === 'attempt_cap_exhausted') {
        if (Number.isInteger(batchResult?.lastExitAttempt)) {
          winningExitAttempt = batchResult.lastExitAttempt + 1;
        } else if (batchResult?.exitsTried > 0) {
          winningExitAttempt = preferredExitAttempt + batchResult.exitsTried;
        }
      }
    } catch (error) {
      batchResult = null;
      batchError = boundedFailure(error?.message || error?.name);
      console.warn('[Sector] v7 batch fallback threw', { failure: batchError });
    }
    const batchValues = batchResult?.value?.valuations;
    const batchOutcomes = batchResult?.value?.outcomes;
    const batchTransportBySymbol = batchResult?.value?.transportBySymbol;
    const transportDiagnostic = batchResult?.diagnostics?.[batchResult.diagnostics.length - 1]
      || batchResult?.diagnostic;
    for (const symbol of batchSymbols) {
      const outcome = batchOutcomes?.[symbol];
      const failure = outcome?.failure || transportDiagnostic?.failure || batchError;
      const symbolTransport = batchTransportBySymbol?.[symbol]
        || transportDiagnostic?.transport;
      const value = batchValues?.[symbol];
      const diagnostic = {
        // Labelled distinctly from the per-symbol 'v7Quote' route so an
        // operator can tell whether the batch fallback ran and whether it
        // helped. Cooldown state is still SHARED with 'v7Quote' -- see the
        // healthKey passed by fetchV7BatchDetailed.
        route: 'v7QuoteBatch',
        ...(symbolTransport ? { transport: symbolTransport } : {}),
        ...(transportDiagnostic?.attempts != null ? { attempts: transportDiagnostic.attempts } : {}),
        ...(transportDiagnostic?.status != null ? { status: transportDiagnostic.status } : {}),
        responseClass: batchError
          ? 'batch_error'
          : outcome?.kind || transportDiagnostic?.responseClass || batchResult?.kind || 'failed',
        ...(outcome?.missingFields?.length ? { missingFields: outcome.missingFields } : {}),
        // For a recovered symbol, the exit that actually served IT -- not the
        // batch's last attempt, which belongs to whichever symbol rotated
        // longest. For one still missing, how many exits were tried, so an
        // operator can tell "Yahoo has no such field" from "we ran out of
        // exits": the whole distinction this route exists to make.
        ...(Number.isInteger(batchResult?.exitBySymbol?.[symbol])
          ? { exitAttempt: batchResult.exitBySymbol[symbol] }
          : !value && Number.isInteger(batchResult?.exitsTried)
            ? { exitAttemptsTried: batchResult.exitsTried }
            : {}),
        ...(failure ? { failure: boundedFailure(failure) } : {}),
      };
      const entry = diagnostics.find((item) => item.symbol === symbol);
      if (entry) entry.outcomes.push(diagnostic);
      else diagnostics.push({ symbol, outcomes: [diagnostic] });

      if (value) {
        const symbolSource = batchResult.value.sourceBySymbol?.[symbol]
          || value.source
          || batchResult.value.source;
        freshVals[symbol] = {
          ...value,
          ...(symbolSource ? { source: symbolSource } : {}),
        };
        if (symbolSource) valuationSources.add(symbolSource);
      }
    }
  }
  return {
    valuations: freshVals,
    diagnostics,
    valuationSources: [...valuationSources],
    ...(winningExitAttempt != null ? { winningExitAttempt } : {}),
  };
}

function mergeReturnMetrics(freshVals, lastGoodValuations) {
  if (!lastGoodValuations || typeof lastGoodValuations !== 'object') return [];
  const usedSymbols = [];
  for (const s of Object.keys(freshVals)) {
    const lg = lastGoodValuations[s];
    if (!lg) continue;
    const fv = freshVals[s];
    let used = false;
    if (fv.ytdReturn == null && lg.ytdReturn != null) {
      fv.ytdReturn = lg.ytdReturn;
      used = true;
    }
    if (fv.threeYearReturn == null && lg.threeYearReturn != null) {
      fv.threeYearReturn = lg.threeYearReturn;
      used = true;
    }
    if (fv.fiveYearReturn == null && lg.fiveYearReturn != null) {
      fv.fiveYearReturn = lg.fiveYearReturn;
      used = true;
    }
    if (used) usedSymbols.push(s);
  }
  return usedSymbols;
}

// The shape every published valuation must have. Consumers (MarketPanel's
// `SectorValuation`) type these as `number | null` and guard with `=== null`,
// so a MISSING key is not equivalent to a null one: it slips past the guard
// and reaches `undefined.toFixed()`. Any record replayed from the last-good
// snapshot is normalized against this before publication.
const EMPTY_VALUATION = {
  trailingPE: null,
  forwardPE: null,
  beta: null,
  ytdReturn: null,
  threeYearReturn: null,
  fiveYearReturn: null,
};

/** Restore the canonical six-key shape on a record read back from Redis. */
function normalizeValuation(value) {
  const record = { ...EMPTY_VALUATION };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return record;
  for (const key of Object.keys(EMPTY_VALUATION)) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) record[key] = candidate;
  }
  return record;
}

function hasCoreValuation(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value.trailingPE != null || value.forwardPE != null),
  );
}

function mergeLastGoodValuations(freshVals, lastGoodValuations, symbols) {
  if (!lastGoodValuations || typeof lastGoodValuations !== 'object') return [];
  const usedSymbols = [];
  for (const symbol of symbols) {
    if (freshVals[symbol]) continue;
    const lastGood = lastGoodValuations[symbol];
    if (!hasCoreValuation(lastGood)) continue;
    // Normalize on read, not just on write: snapshots already resident in
    // Redis were persisted with null keys stripped, and republishing that
    // sparse shape verbatim throws in the dashboard renderer.
    freshVals[symbol] = normalizeValuation(lastGood);
    usedSymbols.push(symbol);
  }
  return usedSymbols;
}

function parseQuoteSummary(body, expectedSymbol = null) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'invalid_json', value: null };
  }
  const results = data?.quoteSummary?.result;
  if (!Array.isArray(results) || results.length === 0) return { kind: 'no_data', value: null };
  if (results.length !== 1) {
    return { kind: 'ambiguous_result', value: null, failure: 'multiple_quote_summary_results' };
  }
  const result = results[0];
  if (expectedSymbol) {
    const returnedSymbol = typeof result?.symbol === 'string'
      ? result.symbol
      : (typeof result?.price?.symbol === 'string' ? result.price.symbol : '');
    if (!returnedSymbol) {
      return { kind: 'identity_mismatch', value: null, failure: 'quote_symbol_missing' };
    }
    if (returnedSymbol.toUpperCase() !== String(expectedSymbol).toUpperCase()) {
      return { kind: 'identity_mismatch', value: null, failure: 'quote_symbol_mismatch' };
    }
  }
  const summaryDetail = result.summaryDetail || {};
  const keyStatistics = result.defaultKeyStatistics || {};
  const value = {
    trailingPE: rawYahooValue(summaryDetail.trailingPE),
    forwardPE: rawYahooValue(summaryDetail.forwardPE),
    beta: rawYahooValue(summaryDetail.beta) ?? rawYahooValue(keyStatistics.beta3Year),
    ytdReturn: rawYahooValue(keyStatistics.ytdReturn),
    threeYearReturn: rawYahooValue(keyStatistics.threeYearAverageReturn),
    fiveYearReturn: rawYahooValue(keyStatistics.fiveYearAverageReturn),
  };
  const missingFields = ['trailingPE', 'forwardPE'].filter((field) => value[field] === null);
  if (missingFields.length === 2) return { kind: 'missing_fields', value, missingFields };
  return {
    kind: 'success',
    value,
    ...(missingFields.length > 0 ? { missingFields } : {}),
  };
}

// How many exits in a row may fail durably before rotation gives up for this
// cycle. One retry survives a single flaky exit; more than that is a provider
// problem no amount of rotation fixes.
const MAX_CONSECUTIVE_EXIT_FAILURES = 2;

/**
 * Route-level failures that are evidence about the transport or the provider
 * rather than about one exit's cached payload.
 */
function isDurableRouteFailure(kind) {
  return kind === 'failed' || kind === 'cooldown' || kind === 'deadline_exceeded';
}

function withBatchProvenance(result, transport) {
  const valuations = result?.value?.valuations;
  if (!valuations || typeof valuations !== 'object') return result;
  const source = result.value?.source;
  const transportBySymbol = {};
  const sourceBySymbol = {};
  for (const symbol of Object.keys(valuations)) {
    transportBySymbol[symbol] = transport;
    if (source) sourceBySymbol[symbol] = source;
  }
  return {
    ...result,
    value: {
      ...result.value,
      transportBySymbol,
      sourceBySymbol,
    },
  };
}

/** Parse kinds that are symbol-local (not evidence the route/session is dead). */
function isNonDurableParseKind(kind) {
  return kind === 'no_data'
    || kind === 'partial'
    || kind === 'missing_fields'
    || kind === 'identity_mismatch'
    || kind === 'ambiguous_result'
    || kind === 'invalid_json'
    || kind === 'upstream_error';
}

function boundedFailure(value, fallback = 'request failed') {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return fallback;
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function responseFailure(response) {
  if (!response) return 'no_response';
  try {
    const parsed = JSON.parse(response.body);
    const description = parsed?.finance?.error?.description
      || parsed?.quoteSummary?.error?.description
      || parsed?.quoteResponse?.error?.description;
    if (description) return `HTTP ${response.status} ${boundedFailure(description)}`;
  } catch {}
  return `HTTP ${response.status || 0}`;
}

function transportFailure(error, transport) {
  if (transport === 'proxy') {
    const code = typeof error?.code === 'string'
      && /^[A-Z0-9_]{1,32}$/i.test(error.code)
      ? error.code
      : null;
    return code ? `proxy request failed (${code})` : 'proxy request failed';
  }
  return boundedFailure(error?.message || error?.name);
}

class YahooQuoteSummaryClient {
  constructor({
    userAgent = 'Mozilla/5.0',
    resolveProxyString = () => '',
    // Optional. When supplied, a batch whose 200 response omits the fundamentals
    // block can be retried on a DIFFERENT residential exit -- see
    // fetchV7BatchAcrossExits. Absent, the client keeps its single-exit behaviour.
    resolveProxyStringForAttempt = null,
    maxExitAttempts = DEFAULT_MAX_EXIT_ATTEMPTS,
    directRequest = requestHttpsText,
    proxyRequest = requestCurlText,
    now = Date.now,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    requestSpacingMs = DEFAULT_REQUEST_SPACING_MS,
    sleepFn = sleep,
    logger = console,
  } = {}) {
    this.userAgent = userAgent;
    this.resolveProxyString = resolveProxyString;
    this.resolveProxyStringForAttempt = resolveProxyStringForAttempt;
    this.maxExitAttempts = Number.isInteger(maxExitAttempts) && maxExitAttempts > 0
      ? maxExitAttempts
      : DEFAULT_MAX_EXIT_ATTEMPTS;
    this.directRequest = directRequest;
    this.proxyRequest = proxyRequest;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.sessionTtlMs = sessionTtlMs;
    this.requestSpacingMs = requestSpacingMs;
    this.sleep = sleepFn;
    this.logger = logger;
    // Transport-level session only (cookie+crumb). Route cooldowns live in routeStates.
    // Keyed by transport AND exit: a Yahoo crumb is bound to the cookie that
    // minted it and both are tied to the originating IP, so a session minted on
    // one residential exit does not authenticate on another. Sharing one 'proxy'
    // slot across rotated exits would send exit A's crumb from exit B.
    this.sessionStates = new Map();
    this.routeStates = new Map();
  }

  _getSessionState(transport, proxy) {
    return boundedMapGet(
      this.sessionStates,
      `${transport}:${proxy || ''}`,
      () => ({ session: null, sessionPromise: null }),
    );
  }

  async _request(transport, url, headers, proxy, { timeoutMs, deadlineAt = null } = {}) {
    const request = transport === 'direct' ? this.directRequest : this.proxyRequest;
    let remainingMs = null;
    if (deadlineAt != null) {
      remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) {
        const err = new Error('valuation_budget_exceeded');
        err.code = 'DEADLINE_EXCEEDED';
        throw err;
      }
    }
    if (this.requestSpacingMs > 0) {
      const sleepMs = remainingMs == null
        ? this.requestSpacingMs
        : Math.min(this.requestSpacingMs, remainingMs);
      if (sleepMs > 0) await this.sleep(sleepMs);
      if (deadlineAt != null) {
        remainingMs = deadlineAt - this.now();
        if (remainingMs <= 0) {
          const err = new Error('valuation_budget_exceeded');
          err.code = 'DEADLINE_EXCEEDED';
          throw err;
        }
        timeoutMs = Number.isFinite(timeoutMs)
          ? Math.min(timeoutMs, remainingMs)
          : remainingMs;
      }
    }
    const defaultTimeoutMs = transport === 'direct' ? 12_000 : 15_000;
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(defaultTimeoutMs, timeoutMs))
      : defaultTimeoutMs;
    return request(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        ...headers,
      },
      timeoutMs: boundedTimeoutMs,
      proxy,
    });
  }

  async _bootstrapSession(transport, proxy, { deadlineAt = null } = {}) {
    const timeoutMs = deadlineAt == null ? undefined : Math.max(1, deadlineAt - this.now());
    const cookieResponse = await this._request(
      transport,
      YAHOO_COOKIE_URL,
      {},
      proxy,
      { timeoutMs, deadlineAt },
    );
    const cookie = cookieHeaderFromResponse(cookieResponse);
    if (!cookie) throw new Error(`cookie bootstrap HTTP ${cookieResponse?.status || 0}`);

    const crumbResponse = await this._request(
      transport,
      YAHOO_CRUMB_URL,
      { Cookie: cookie, Accept: 'text/plain,*/*' },
      proxy,
      {
        timeoutMs: deadlineAt == null ? undefined : Math.max(1, deadlineAt - this.now()),
        deadlineAt,
      },
    );
    const crumb = crumbResponse?.status === 200 ? validCrumb(crumbResponse.body) : null;
    if (!crumb) throw new Error(`crumb bootstrap HTTP ${crumbResponse?.status || 0}`);

    return { cookie, crumb, fetchedAt: this.now() };
  }

  async _getSession(transport, proxy, forceRefresh = false, { deadlineAt = null } = {}) {
    const state = this._getSessionState(transport, proxy);
    if (forceRefresh) state.session = null;
    if (
      state.session
      && this.now() - state.session.fetchedAt < this.sessionTtlMs
    ) return state.session;
    if (state.sessionPromise) return state.sessionPromise;

    state.sessionPromise = this._bootstrapSession(transport, proxy, { deadlineAt });
    try {
      state.session = await state.sessionPromise;
      return state.session;
    } finally {
      state.sessionPromise = null;
    }
  }

  /**
   * Cooldowns are per (route, transport, EXIT). A durable failure on one
   * residential exit is not evidence the endpoint is dead everywhere, and a
   * shared cooldown would let one bad exit suppress the very rotation that
   * recovers from it. With a single pinned exit this is identical to the old
   * per-(route, transport) key.
   */
  _getRouteState(route, transport, proxy = '') {
    return boundedMapGet(
      this.routeStates,
      `${route}:${transport}:${proxy || ''}`,
      () => ({ cooldownUntil: 0 }),
    );
  }

  async _fetchVia(
    route,
    transport,
    symbol,
    proxy,
    { buildUrl, parseResponse, source, deadlineAt = null, healthKey = null },
  ) {
    if (deadlineAt != null && this.now() >= deadlineAt) {
      return this._deadlineExceeded(route, transport);
    }
    // `healthKey` lets a route report itself distinctly in diagnostics while
    // SHARING cooldown state with the endpoint it actually calls. The batch
    // route hits the same v7 URL/session as the per-symbol route, so a durable
    // failure there must suppress it too.
    const routeState = this._getRouteState(healthKey || route, transport, proxy);
    if (this.now() < routeState.cooldownUntil) {
      return {
        kind: 'cooldown',
        value: null,
        diagnostic: {
          route,
          transport,
          attempts: 0,
          responseClass: 'cooldown',
        },
      };
    }

    let lastFailure = 'unknown';
    let lastDiagnostic = {
      route,
      transport,
      attempts: 0,
      responseClass: 'unknown',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const session = await this._getSession(transport, proxy, attempt > 0, { deadlineAt });
        if (deadlineAt != null && this.now() >= deadlineAt) {
          return this._deadlineExceeded(route, transport);
        }
        const response = await this._request(
          transport,
          buildUrl(symbol, session.crumb),
          { Cookie: session.cookie },
          proxy,
          {
            timeoutMs: deadlineAt == null ? undefined : deadlineAt - this.now(),
            deadlineAt,
          },
        );
        const diagnostic = {
          route,
          transport,
          attempts: attempt + 1,
          status: response.status,
          responseClass: response.status === 200 ? 'http_200' : `http_${response.status || 0}`,
        };
        if (response.status === 401 && attempt === 0) {
          lastFailure = responseFailure(response);
          lastDiagnostic = diagnostic;
          continue;
        }
        if (response.status !== 200) {
          lastFailure = responseFailure(response);
          lastDiagnostic = diagnostic;
          break;
        }

        const parsed = parseResponse(response.body, symbol);
        diagnostic.responseClass = parsed.kind;
        if (parsed.missingFields?.length) diagnostic.missingFields = parsed.missingFields;
        if (parsed.failure) diagnostic.failure = boundedFailure(parsed.failure);
        if (parsed.kind === 'success') {
          routeState.cooldownUntil = 0;
          return {
            kind: 'success',
            value: {
              ...parsed.value,
              source,
            },
            diagnostic,
          };
        }
        // Symbol-local / parse-local outcomes must not cool the route or wipe the
        // shared cookie session — a bad payload for one ticker is not route death.
        if (isNonDurableParseKind(parsed.kind)) {
          // Carry the transport's source label on any rows this attempt did
          // parse (batch 'partial'), so a caller merging attempts keeps
          // truthful provenance for the rows it keeps.
          return {
            ...parsed,
            ...(parsed.value ? { value: { ...parsed.value, source } } : {}),
            diagnostic,
          };
        }
        lastFailure = parsed.failure || parsed.kind;
        lastDiagnostic = diagnostic;
        break;
      } catch (error) {
        if (
          error?.code === 'DEADLINE_EXCEEDED'
          || (deadlineAt != null && this.now() >= deadlineAt)
        ) {
          return this._deadlineExceeded(route, transport);
        }
        lastFailure = transportFailure(error, transport);
        lastDiagnostic = {
          route,
          transport,
          attempts: attempt + 1,
          responseClass: 'transport_error',
        };
        break;
      }
    }

    // Budget already spent: report deadline, do not arm a multi-minute cooldown.
    if (deadlineAt != null && this.now() >= deadlineAt) {
      return this._deadlineExceeded(route, transport);
    }

    const authInvalidating = lastDiagnostic.status === 401;
    // Shared transport session (cookie+crumb) is only invalidated on auth failure.
    // Parse/5xx/timeout leave the session reusable by sibling routes under budget.
    if (authInvalidating) {
      this._getSessionState(transport, proxy).session = null;
    }

    // Durable route health failure: cool this route:transport only.
    routeState.cooldownUntil = this.now() + this.cooldownMs;
    this.logger.warn(
      `[Sector] Yahoo authenticated ${transport} ${route} route unavailable (${lastFailure}); cooldown ${Math.round(this.cooldownMs / 60_000)}min`,
      { transport, route, failure: lastFailure },
    );
    return {
      kind: 'failed',
      value: null,
      diagnostic: {
        ...lastDiagnostic,
        responseClass: lastDiagnostic.responseClass || 'failed',
        failure: lastFailure,
      },
    };
  }

  _deadlineExceeded(route, transport) {
    return {
      kind: 'deadline_exceeded',
      value: null,
      diagnostic: {
        route,
        transport,
        attempts: 0,
        responseClass: 'deadline_exceeded',
        failure: 'valuation_budget_exceeded',
      },
    };
  }

  async _fetchRoute(route, symbol, {
    buildUrl,
    parseResponse,
    source,
    deadlineAt = null,
    healthKey = null,
    // When set, use THIS exit for the proxy leg instead of the configured one.
    proxyOverride = null,
    // Rotation retries have already had their direct leg on the first attempt;
    // repeating it would re-read the same Railway IP that already came back
    // truncated, for no new information and one wasted request per exit.
    skipDirect = false,
  }) {
    const diagnostics = [];
    const direct = skipDirect
      ? { kind: 'skipped', value: null, diagnostic: null }
      : await this._fetchVia(
        route,
        'direct',
        symbol,
        '',
        { buildUrl, parseResponse, source: `${source}_direct`, deadlineAt, healthKey },
      );
    const attributedDirect = withBatchProvenance(direct, 'direct');
    if (!skipDirect) {
      diagnostics.push(direct.diagnostic);
      if (direct.kind === 'success') {
        return {
          ...attributedDirect,
          diagnostics,
          proxyAttempted: false,
          proxyKind: 'not_attempted',
        };
      }
    }

    const proxy = proxyOverride == null ? this.resolveProxyString() : proxyOverride;
    if (!proxy) {
      return {
        ...attributedDirect,
        diagnostics,
        proxyAttempted: false,
        proxyKind: 'no_route',
      };
    }
    const proxied = await this._fetchVia(
      route,
      'proxy',
      symbol,
      proxy,
      { buildUrl, parseResponse, source: `${source}_proxy`, deadlineAt, healthKey },
    );
    const attributedProxy = withBatchProvenance(proxied, 'proxy');
    diagnostics.push(proxied.diagnostic);

    // Multi-symbol (batch) routes can come back partially covered on one
    // transport. Union what each leg parsed so a partial direct result is not
    // discarded by a failing proxy leg, and vice versa. Single-symbol routes
    // never produce a `valuations` map, so this is inert for them.
    const directValuations = direct.value?.valuations;
    const proxiedValuations = proxied.value?.valuations;
    if (directValuations || proxiedValuations) {
      const valuations = { ...(directValuations || {}), ...(proxiedValuations || {}) };
      if (Object.keys(valuations).length > 0) {
        const proxySymbols = new Set(Object.keys(proxiedValuations || {}));
        const outcomes = { ...(direct.value?.outcomes || {}), ...(proxied.value?.outcomes || {}) };
        const transportBySymbol = {};
        const sourceBySymbol = {};
        const contributingSources = new Set();
        for (const symbol of Object.keys(valuations)) {
          const viaProxy = proxySymbols.has(symbol);
          const symbolSource = viaProxy ? proxied.value?.source : direct.value?.source;
          transportBySymbol[symbol] = viaProxy ? 'proxy' : 'direct';
          if (symbolSource) {
            sourceBySymbol[symbol] = symbolSource;
            contributingSources.add(symbolSource);
          }
          // A later proxy miss must not replace the successful direct outcome
          // for a row that only the direct leg actually supplied.
          if (!viaProxy && direct.value?.outcomes?.[symbol]) {
            outcomes[symbol] = direct.value.outcomes[symbol];
          }
        }
        const sources = [...contributingSources];
        return {
          kind: 'success',
          value: {
            valuations,
            outcomes,
            transportBySymbol,
            sourceBySymbol,
            ...(sources.length === 1 ? { source: sources[0] } : {}),
          },
          diagnostic: proxied.diagnostic,
          diagnostics,
          proxyAttempted: true,
          proxyKind: proxied.kind,
        };
      }
    }
    return {
      ...attributedProxy,
      diagnostics,
      proxyAttempted: true,
      proxyKind: proxied.kind,
    };
  }

  async fetchDetailed(symbol, { deadlineAt = null } = {}) {
    return this._fetchRoute('quoteSummary', symbol, {
      buildUrl: (ticker, crumb) => {
        const query = new URLSearchParams({
          modules: YAHOO_SUMMARY_MODULES,
          crumb,
        });
        return `${YAHOO_SUMMARY_BASE_URL}/${encodeURIComponent(ticker)}?${query}`;
      },
      parseResponse: parseQuoteSummary,
      source: 'yahoo_quote_summary_authenticated',
      deadlineAt,
    });
  }

  async fetch(symbol) {
    const result = await this.fetchDetailed(symbol);
    return result.kind === 'success' ? result.value : null;
  }

  async fetchV7Detailed(symbol, { deadlineAt = null } = {}) {
    return this._fetchRoute('v7Quote', symbol, {
      buildUrl: (ticker, crumb) => {
        const query = new URLSearchParams({ symbols: ticker, crumb });
        return `${YAHOO_V7_QUOTE_URL}?${query}`;
      },
      parseResponse: parseV7Quote,
      source: 'yahoo_v7_quote_authenticated',
      deadlineAt,
    });
  }

  async fetchV7BatchDetailed(symbols, { deadlineAt = null } = {}) {
    const requestedSymbols = [...new Set(symbols)].filter(Boolean);
    return this._fetchRoute('v7QuoteBatch', requestedSymbols.join(','), {
      buildUrl: (tickers, crumb) => {
        const query = new URLSearchParams({ symbols: tickers, crumb });
        return `${YAHOO_V7_QUOTE_URL}?${query}`;
      },
      parseResponse: (body) => parseV7QuoteBatch(body, requestedSymbols),
      source: 'yahoo_v7_quote_authenticated',
      deadlineAt,
      // Same URL, same cookie+crumb session as fetchV7Detailed -- so it must
      // share that route's cooldown rather than probing an endpoint the
      // per-symbol route has already found durably dead.
      healthKey: 'v7Quote',
    });
  }

  /**
   * Fetch the v7 batch, rotating residential exits until every requested symbol
   * carries fundamentals or the attempt/budget cap is hit.
   *
   * This exists because the failure it answers is invisible to ordinary retry
   * logic: Yahoo returns HTTP 200 with the fundamentals key-group simply absent
   * for a stable subset of ETFs, and which subset depends on the EXIT IP, not on
   * the request. Re-issuing against the same pinned exit reads the same partial
   * cache every time -- the seeder did exactly that for 46 of 61 cycles.
   *
   * Only the exits actually needed are used: coverage is re-checked before each
   * attempt, so a good first exit costs exactly one proxy request set. Each exit
   * is evaluated against the same original symbol set; otherwise a later exit
   * is ranked only on the marginal tail the earlier exits missed, not on how
   * useful it would be as the next cycle's starting point.
   *
   * @returns {{kind: string, value: {valuations: object, outcomes: object,
   *            source: string|null, transportBySymbol: object, sourceBySymbol: object},
   *            diagnostics: object[], lastExitAttempt: number|null,
   *            bestExitAttempt: number|null, exitBySymbol: object, exitsTried: number,
   *            stopReason: string}}
   *          `bestExitAttempt` is the exit worth remembering; `lastExitAttempt`
   *          is only the last one tried and must not be persisted as a winner.
   */
  async fetchV7BatchAcrossExits(symbols, { deadlineAt = null, startExitAttempt = 0 } = {}) {
    const requested = [...new Set(symbols)].filter(Boolean);
    if (requested.length === 0) {
      return {
        kind: 'no_data',
        value: { valuations: {}, outcomes: {}, transportBySymbol: {}, sourceBySymbol: {} },
        diagnostics: [],
        lastExitAttempt: null,
        bestExitAttempt: null,
        exitBySymbol: {},
        exitsTried: 0,
        stopReason: 'complete',
      };
    }
    const valuations = {};
    const outcomes = {};
    const diagnostics = [];
    // Which exit actually served each symbol. A single batch-wide value would be
    // a lie whenever rotation kept going for other symbols: a row recovered on
    // exit 1 would be reported against exit 3.
    const exitBySymbol = {};
    let source = null;
    // Named `last`, not `exit`, because the per-symbol diagnostic already uses
    // `exitAttempt` to mean "which exit served THIS symbol". Two different
    // scopes under one key is how a future reader persists the wrong one.
    let lastExitAttempt = null;
    const transportBySymbol = {};
    const sourceBySymbol = {};
    let exitsTried = 0;
    let lastKind = 'no_data';
    let stopReason = null;
    const coverageByExit = new Map();

    const canRotate = typeof this.resolveProxyStringForAttempt === 'function';
    const maxAttempts = canRotate ? this.maxExitAttempts : 1;
    const start = Number.isInteger(startExitAttempt) && startExitAttempt >= 0
      ? startExitAttempt
      : 0;

    let previousProxy = null;
    let consecutiveDurableFailures = 0;
    for (let i = 0; i < maxAttempts; i++) {
      if (Object.keys(valuations).length === requested.length && requested.length > 0) {
        stopReason = 'complete';
        break;
      }
      if (deadlineAt != null && this.now() >= deadlineAt) {
        stopReason = 'deadline';
        break;
      }

      const attempt = start + i;
      const proxyOverride = canRotate ? this.resolveProxyStringForAttempt(attempt) : null;
      // Nothing to rotate onto: either no proxy is configured, or the provider
      // returned the same route again (non-Decodo providers and Decodo's
      // rotating ports are not per-attempt addressable). Re-querying the exit
      // that just truncated cannot change the answer, and the request is billed
      // regardless.
      if (i > 0 && (!proxyOverride || proxyOverride === previousProxy)) {
        stopReason = proxyOverride ? 'repeated_route' : 'no_route';
        break;
      }
      previousProxy = proxyOverride;
      const result = await this._fetchRoute('v7QuoteBatch', requested.join(','), {
        buildUrl: (tickers, crumb) => {
          const query = new URLSearchParams({ symbols: tickers, crumb });
          return `${YAHOO_V7_QUOTE_URL}?${query}`;
        },
        parseResponse: (body) => parseV7QuoteBatch(body, requested),
        source: 'yahoo_v7_quote_authenticated',
        deadlineAt,
        // Same URL and session shape as the per-symbol route, so on a given exit
        // a durable failure there must suppress this too. Cooldown state is
        // per-exit, so this shares with the per-symbol route only on the exit
        // they have in common -- attempt 0, which resolves to the same string
        // resolveProxyString returns.
        healthKey: 'v7Quote',
        proxyOverride,
        skipDirect: i > 0,
      });

      for (const diagnostic of result?.diagnostics || []) {
        if (diagnostic) diagnostics.push(diagnostic);
      }
      lastKind = result?.kind || lastKind;

      const proxyAttempted = result?.proxyAttempted === true;
      const proxyKind = result?.proxyKind || (proxyAttempted ? result?.kind : 'not_attempted');
      if (proxyAttempted) {
        lastExitAttempt = attempt;
        exitsTried += 1;
      }

      const newlyCovered = new Set();
      const resultValuations = result?.value?.valuations || {};
      const attemptTransportBySymbol = result?.value?.transportBySymbol || {};
      const attemptSourceBySymbol = result?.value?.sourceBySymbol || {};
      let proxyCoverage = 0;
      for (const [symbol, value] of Object.entries(resultValuations)) {
        if (attemptTransportBySymbol[symbol] === 'proxy') proxyCoverage += 1;
        if (valuations[symbol]) continue;
        const symbolTransport = attemptTransportBySymbol[symbol];
        const symbolSource = attemptSourceBySymbol[symbol] || value?.source || result.value?.source;
        valuations[symbol] = {
          ...value,
          ...(symbolSource ? { source: symbolSource } : {}),
        };
        if (symbolTransport) transportBySymbol[symbol] = symbolTransport;
        if (symbolSource) sourceBySymbol[symbol] = symbolSource;
        newlyCovered.add(symbol);
        if (symbolTransport === 'proxy') exitBySymbol[symbol] = attempt;
      }
      if (proxyAttempted) coverageByExit.set(attempt, proxyCoverage);

      // Keep the outcome from the attempt that supplied a published row. Later
      // exits are still evaluated for ranking, but their misses must not erase
      // the successful outcome/provenance of an earlier contributor.
      for (const [symbol, outcome] of Object.entries(result?.value?.outcomes || {})) {
        if (newlyCovered.has(symbol) || !valuations[symbol]) outcomes[symbol] = outcome;
      }

      if (Object.keys(valuations).length === requested.length && requested.length > 0) {
        stopReason = 'complete';
        break;
      }

      if (proxyKind === 'deadline_exceeded') {
        stopReason = 'deadline';
        break;
      }

      // Rotation exists to escape a TRUNCATED 200 -- a payload defect that is a
      // property of the exit. A durable transport/auth failure is usually a
      // property of the PROVIDER (a Decodo quota 407 or credential expiry fails
      // identically on every exit), and per-exit cooldowns no longer suppress
      // that the way one shared key did. Allow a single retry so one flaky exit
      // is still survivable, then stop rather than probing the whole pool every
      // cycle against a provider that is down.
      if (isDurableRouteFailure(proxyKind)) {
        consecutiveDurableFailures += 1;
        if (consecutiveDurableFailures >= MAX_CONSECUTIVE_EXIT_FAILURES) {
          stopReason = 'durable_failures';
          break;
        }
      } else {
        consecutiveDurableFailures = 0;
      }

      if (!proxyAttempted) {
        stopReason = 'no_route';
        break;
      }
    }

    const covered = Object.keys(valuations).length;
    let kind = lastKind;
    if (covered === requested.length && covered > 0) kind = 'success';
    else if (covered > 0) kind = 'partial';

    if (!stopReason) {
      if (covered === requested.length && covered > 0) stopReason = 'complete';
      // Completing the last allowed exit before the clock reaches its boundary
      // still exhausts a deterministic search window. Classify that window as
      // capped so the caller advances past it; deadline stops set inside the
      // loop (before an attempt or reported by the proxy) remain deadlines.
      else if (canRotate && exitsTried >= maxAttempts) stopReason = 'attempt_cap_exhausted';
      else if (deadlineAt != null && this.now() >= deadlineAt) stopReason = 'deadline';
      else stopReason = canRotate ? 'attempt_cap_exhausted' : 'single_exit';
    }

    // The exit worth starting from next time is the one that covered the MOST
    // symbols -- not `lastExitAttempt`, which is merely the last one tried. When
    // coverage is assembled across exits, remembering the last one starts the
    // next cycle on an exit that serves only the tail of the set and rotates
    // fruitlessly for the rest. Ties go to the earliest exit so the choice is
    // deterministic.
    let bestExitAttempt = null;
    let bestCoverage = 0;
    for (const [attempt, count] of [...coverageByExit.entries()].sort((a, b) => a[0] - b[0])) {
      if (count > bestCoverage) {
        bestCoverage = count;
        bestExitAttempt = attempt;
      }
    }

    const sources = [...new Set(
      Object.values(valuations).map((value) => value?.source).filter(Boolean),
    )];
    if (sources.length === 1) source = sources[0];

    return {
      kind,
      value: {
        valuations,
        outcomes,
        transportBySymbol,
        sourceBySymbol,
        ...(source ? { source } : {}),
      },
      diagnostics,
      lastExitAttempt,
      bestExitAttempt,
      exitBySymbol,
      exitsTried,
      stopReason,
    };
  }

  async fetchV7(symbol) {
    const result = await this.fetchV7Detailed(symbol);
    return result.kind === 'success' ? result.value : null;
  }
}

function buildSectorValuationCoverage({
  valuationCount,
  expectedCount,
  fetchedAt,
  sources,
  unavailableSymbols = [],
  valuationDiagnostics = [],
  lastGoodFetchedAt = null,
  lastGoodMetricsUsed = [],
  currentValuationCount = null,
  lastGoodValuationSymbols = [],
}) {
  const count = Number.isFinite(valuationCount) ? Math.max(0, valuationCount) : 0;
  const expected = Number.isFinite(expectedCount) ? Math.max(0, expectedCount) : 0;
  const currentCount = Number.isFinite(currentValuationCount)
    ? Math.max(0, currentValuationCount)
    : null;
  const orderedSources = [...new Set((sources || []).filter(Boolean))].sort();
  const source = orderedSources.length > 0
    ? orderedSources.join('+')
    : 'yahoo_quote_summary_authenticated';
  const unavailable = [...new Set(unavailableSymbols.filter(Boolean))].sort();
  const diagnostics = valuationDiagnostics.filter(Boolean);
  const staleValuations = [...new Set(lastGoodValuationSymbols.filter(Boolean))].sort();
  const lastGoodSymbols = [...new Set([
    ...lastGoodMetricsUsed,
    ...staleValuations,
  ])].sort();
  const lastGood = lastGoodFetchedAt && lastGoodSymbols.length > 0
    ? {
      fetchedAt: lastGoodFetchedAt,
      stale: true,
      symbols: lastGoodSymbols,
    }
    : null;

  const extras = {
    ...(currentCount != null && currentCount !== count ? { currentValuationCount: currentCount } : {}),
    ...(staleValuations.length > 0 ? { staleValuationSymbols: staleValuations } : {}),
    ...(unavailable.length > 0 ? { unavailableSymbols: unavailable } : {}),
    ...(diagnostics.length > 0 ? { valuationDiagnostics: diagnostics } : {}),
    ...(lastGood ? { lastGood } : {}),
  };

  // Escalate on zero CURRENT records, not zero total records. Stale last-good
  // fills keep `count` non-zero, so without the currentCount arm a completely
  // dead upstream would report 'partial' for the whole 7-day snapshot TTL and
  // SECTOR_VALUATIONS_UNAVAILABLE would be unreachable.
  if (count <= 0 || (currentCount != null && currentCount <= 0)) {
    return {
      valuationCount: count,
      expectedValuationCount: expected,
      sourceStatus: 'degraded',
      source,
      fetchedAt,
      stale: false,
      seedSourceState: 'error',
      errorCode: 'SECTOR_VALUATIONS_UNAVAILABLE',
      ...extras,
    };
  }
  if (count < expected || staleValuations.length > 0 || (currentCount != null && currentCount < expected)) {
    return {
      valuationCount: count,
      expectedValuationCount: expected,
      sourceStatus: 'partial',
      source,
      fetchedAt,
      stale: false,
      seedSourceState: 'partial',
      errorCode: 'SECTOR_VALUATIONS_PARTIAL',
      ...extras,
    };
  }
  return {
    valuationCount: count,
    expectedValuationCount: expected,
    sourceStatus: 'ok',
    source,
    fetchedAt,
    stale: false,
    seedSourceState: 'ok',
    errorCode: null,
    ...extras,
  };
}

/**
 * Read the remembered next starting exit. Anything malformed degrades to exit
 * 0 (the configured route) rather than propagating a bad index into the
 * rotation: a fractional or negative attempt would resolve to a port outside
 * the provider's sticky range, i.e. no proxy at all.
 */
function normalizePreferredExit(raw) {
  const attempt = raw && typeof raw === 'object' ? raw.attempt : null;
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  const savedAt = Number.isFinite(raw.savedAt) ? raw.savedAt : null;
  const persistedAt = Number.isFinite(raw.persistedAt) ? raw.persistedAt : savedAt;
  return { attempt, savedAt, persistedAt };
}

async function readPreferredExit(upstashGet, localPreference = null) {
  const local = normalizePreferredExit(localPreference);
  if (typeof upstashGet !== 'function') {
    return local || { attempt: 0, savedAt: null, persistedAt: null };
  }
  try {
    const raw = await upstashGet(PREFERRED_EXIT_KEY);
    const remote = normalizePreferredExit(raw);
    if (
      remote
      && Number.isFinite(remote.savedAt)
      && (!local || !Number.isFinite(local.savedAt) || remote.savedAt > local.savedAt)
    ) return remote;
    return local || remote || { attempt: 0, savedAt: null, persistedAt: null };
  } catch (error) {
    // A cold preference costs one extra rotation, never the cycle.
    console.warn('[Sector] preferred proxy exit read failed', {
      failure: boundedFailure(error?.message || error?.name),
    });
    return local || { attempt: 0, savedAt: null, persistedAt: null };
  }
}

/**
 * Persist the next starting exit when it changed, or when a still-valid
 * preference is far enough into its TTL to be worth renewing.
 *
 * Writing only on change would let a working exit expire and be rediscovered
 * every TTL at the cost of extra rotations; writing every cycle would churn the
 * key 288 times a day for no new information. Renewing past the half-life gets
 * both.
 */
async function persistPreferredExit(upstashSet, next, previous, now) {
  if (typeof upstashSet !== 'function') return null;
  if (!Number.isInteger(next?.attempt)) return null;
  const changed = next.attempt !== previous.attempt;
  const dueForRenewal = !Number.isFinite(previous.persistedAt)
    || (now() - previous.persistedAt) > (PREFERRED_EXIT_TTL * 1000) / 2;
  if (!changed && !dueForRenewal) return null;
  try {
    const ok = await upstashSet(
      PREFERRED_EXIT_KEY,
      { attempt: next.attempt, savedAt: next.savedAt },
      PREFERRED_EXIT_TTL,
    );
    if (!ok) console.warn('[Sector] preferred proxy exit write failed');
    return ok ? next.savedAt : null;
  } catch {
    console.warn('[Sector] preferred proxy exit write failed');
    return null;
  }
}

async function collectSectorValuations({
  symbols,
  fetchValue,
  parseValue,
  sleepFn = sleep,
  v7UserAgent,
  v7ResolveProxyString,
  v7Client,
  upstashGet,
  upstashSet,
  fetchValueDetailed,
  maxDurationMs = DEFAULT_SECTOR_VALUATION_BUDGET_MS,
  now = Date.now,
}) {
  const valuationSources = new Set();
  const deadlineAt = Number.isFinite(maxDurationMs)
    ? now() + Math.max(1, maxDurationMs)
    : null;

  // The BATCH TIER's next starting exit may be either the best full-set coverage
  // winner or the continuation after an exhausted window. A coverage winner
  // collapses the ~3.3-exit blind search to 1; a continuation ensures the next
  // cycle explores new exits. This does not change the per-symbol tier below,
  // which still uses the configured exit -- see the follow-up noted on that
  // loop.
  //
  // Only read it when something can act on it: a client without exit rotation
  // would spend a Redis round-trip per cycle on a value it cannot use.
  const canRotateExits = Boolean(v7UserAgent)
    && typeof v7Client?.fetchV7BatchAcrossExits === 'function';
  const preferredExit = canRotateExits
    ? await readPreferredExit(upstashGet, LOCAL_PREFERRED_EXITS.get(v7Client))
    : { attempt: 0, savedAt: null, persistedAt: null };
  if (canRotateExits) {
    LOCAL_PREFERRED_EXITS.set(v7Client, {
      ...preferredExit,
      // A legacy Redis value without savedAt is still a valid cold-start
      // preference. Timestamp the local observation so a later stale/untimed
      // read cannot overwrite what this process learns.
      savedAt: Number.isFinite(preferredExit.savedAt) ? preferredExit.savedAt : now(),
    });
  }

  // Tier 1: v7/finance/quote for P/E and beta
  const v7Result = v7UserAgent ? await collectV7Valuations(symbols, {
    userAgent: v7UserAgent,
    resolveProxyString: v7ResolveProxyString,
    sleepFn,
    client: v7Client,
    deadlineAt,
    now,
    preferredExitAttempt: preferredExit.attempt,
  }) : {};
  let nextPreferredExit = null;
  if (canRotateExits && Number.isInteger(v7Result.winningExitAttempt)) {
    const learnedAt = now();
    const currentLocal = LOCAL_PREFERRED_EXITS.get(v7Client);
    const persistedAt = currentLocal?.attempt === v7Result.winningExitAttempt
      ? currentLocal.persistedAt
      : null;
    nextPreferredExit = {
      attempt: v7Result.winningExitAttempt,
      savedAt: learnedAt,
      persistedAt,
    };
    // Advance the live process before touching Redis. An optional SET failure
    // must not make the next five-minute cycle repeat the same deterministic
    // window.
    LOCAL_PREFERRED_EXITS.set(v7Client, nextPreferredExit);
  }
  const v7Vals = v7Result.valuations || {};
  const valuationDiagnostics = v7Result.diagnostics || [];
  for (const source of v7Result.valuationSources || []) valuationSources.add(source);

  // Tier 2: reserve the last-good read until every current valuation tier has
  // run. Otherwise a complete v7 failure followed by quoteSummary fallback
  // data can overwrite the previous snapshot before its return metrics are
  // available to merge.
  let lastGood = null;
  let lastGoodFetchedAt = null;
  let lastGoodMetricsFetchedAt = null;
  let lastGoodMetricsUsed = [];
  let lastGoodValuationSymbols = [];

  // Tier 3: v10/quoteSummary for symbols v7 didn't cover
  for (const symbol of symbols) {
    if (v7Vals[symbol]) continue;
    if (deadlineAt != null && now() >= deadlineAt) {
      valuationDiagnostics.push({
        symbol,
        outcomes: [{ route: 'quoteSummary', attempts: 0, responseClass: 'deadline_exceeded', failure: 'valuation_budget_exceeded' }],
      });
      continue;
    }
    const detailed = typeof fetchValueDetailed === 'function'
      ? await fetchValueDetailed(symbol, { deadlineAt })
      : null;
    const raw = detailed?.value ?? (detailed ? null : await fetchValue(symbol));
    const parsed = parseValue(raw);
    if (parsed) {
      v7Vals[symbol] = { ...parsed, ...(raw?.source ? { source: raw.source } : {}) };
      if (raw?.source) valuationSources.add(raw.source);
    }
    if (detailed?.diagnostics) {
      valuationDiagnostics.push({ symbol, outcomes: detailed.diagnostics });
    }
    const remainingMs = deadlineAt == null ? DEFAULT_REQUEST_SPACING_MS : Math.max(0, deadlineAt - now());
    if (remainingMs > 0) await sleepFn(Math.min(DEFAULT_REQUEST_SPACING_MS, remainingMs));
  }

  if (typeof upstashGet === 'function') {
    try {
      const raw = await upstashGet(LAST_GOOD_KEY);
      if (raw && typeof raw === 'object' && raw.valuations) {
        lastGood = raw.valuations;
        lastGoodFetchedAt = Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null;
        lastGoodMetricsFetchedAt = Number.isFinite(raw.metricsFetchedAt) ? raw.metricsFetchedAt : null;
      }
    } catch (error) {
      // The snapshot now drives valuationCount, sourceStatus and the stale
      // symbol list, so a silent read failure changes published health.
      console.warn('[Sector] last-good valuation snapshot read failed', {
        failure: boundedFailure(error?.message || error?.name),
      });
    }
  }

  const currentValuationCount = Object.keys(v7Vals).length;
  const currentValuations = {};
  for (const symbol of symbols) {
    if (!v7Vals[symbol]) continue;
    const { source: _source, ...valuation } = v7Vals[symbol];
    currentValuations[symbol] = valuation;
  }

  if (lastGood) {
    lastGoodValuationSymbols = mergeLastGoodValuations(v7Vals, lastGood, symbols);
    lastGoodMetricsUsed = mergeReturnMetrics(v7Vals, lastGood);
  }

  const valuations = {};
  // Computed AFTER the merges, so it keeps its established meaning: "no
  // valuation is published for this symbol at all". A symbol served from the
  // last-good snapshot is reported by staleValuationSymbols, not here -- a
  // symbol must never appear in unavailableSymbols while carrying a value.
  const unavailableSymbols = symbols.filter((symbol) => !v7Vals[symbol]);
  for (const symbol of symbols) {
    if (!v7Vals[symbol]) continue;
    const { source: _source, ...valuation } = v7Vals[symbol];
    valuations[symbol] = valuation;
  }
  const valuationCount = Object.keys(valuations).length;
  // Gate on CURRENT coverage: a run served entirely from Redis has no live
  // route to attribute, and labelling it 'yahoo_v7_quote' would claim a fetch
  // that never happened.
  if (currentValuationCount > 0 && valuationSources.size === 0) valuationSources.add('yahoo_v7_quote');

  const hasCompleteReturnMetrics = currentValuationCount === symbols.length
    && symbols.length > 0
    && symbols.every((symbol) => {
      const valuation = currentValuations[symbol];
      return valuation
        && valuation.ytdReturn != null
        && valuation.threeYearReturn != null
        && valuation.fiveYearReturn != null;
    });
  const hasCompleteCoreCoverage = currentValuationCount === symbols.length
    && symbols.length > 0
    && symbols.every((symbol) => hasCoreValuation(currentValuations[symbol]));
  // Persist a complete core snapshot even when a v7-only run leaves return
  // metrics null. The write below is MONOTONIC -- it merges fresh non-null
  // values over whatever the resident snapshot already held, so it can only
  // ever add information. That is why there is no "is the stored snapshot
  // better than this run?" clause here: an earlier version gated on
  // `lastGoodCoreCount < symbols.length`, which every snapshot this module
  // writes fails, so the snapshot froze until its 7-day TTL evicted it.
  //
  // Borrowed data must not be re-dated. `fetchedAt` tracks the core valuation
  // write; `metricsFetchedAt` separately tracks when ytd/3Y/5Y were last
  // actually fetched, and only advances on a run that fetched them live.
  const canPersistCoreSnapshot = hasCompleteCoreCoverage
    && !hasCompleteReturnMetrics
    // Borrowed nothing: the run stands entirely on its own data, so stamping a
    // new fetchedAt cannot make replayed values look fresh. This is what the
    // old `lastGoodCoreCount < symbols.length` clause was reaching for -- but
    // that clause tested the STORED snapshot's shape, which every snapshot this
    // module writes satisfies, so it froze the key until its TTL expired.
    && lastGoodMetricsUsed.length === 0
    && lastGoodValuationSymbols.length === 0;
  const shouldPersistLastGood = (
    hasCompleteReturnMetrics && lastGoodMetricsUsed.length === 0
  ) || canPersistCoreSnapshot;
  if (shouldPersistLastGood && typeof upstashSet === 'function') {
    try {
      const source = hasCompleteReturnMetrics ? valuations : currentValuations;
      const snapshotValuations = Object.fromEntries(
        Object.entries(source).map(([symbol, valuation]) => {
          const merged = normalizeValuation(lastGood?.[symbol]);
          for (const [key, value] of Object.entries(valuation)) {
            if (value != null) merged[key] = value;
          }
          return [symbol, merged];
        }),
      );
      const previousMetricsFetchedAt = Number.isFinite(lastGoodMetricsFetchedAt)
        ? lastGoodMetricsFetchedAt
        : lastGoodFetchedAt;
      const metricsFetchedAt = hasCompleteReturnMetrics ? now() : previousMetricsFetchedAt;
      const ok = await upstashSet(LAST_GOOD_KEY, {
        valuations: snapshotValuations,
        fetchedAt: now(),
        ...(Number.isFinite(metricsFetchedAt) ? { metricsFetchedAt } : {}),
      }, LAST_GOOD_TTL);
      // upstashSet resolves false on disable/timeout/non-OK without throwing.
      if (!ok) {
        console.warn('[Sector] last-good valuation snapshot write failed');
      }
    } catch {
      console.warn('[Sector] last-good valuation snapshot write failed');
    }
  }

  // Borrowed return metrics can be older than the snapshot's core write (the
  // core refreshes every healthy cycle; ytd/3Y/5Y only when quoteSummary runs).
  // Report the OLDER of the two so provenance never claims data is fresher
  // than it is.
  const borrowedMetricsFetchedAt = lastGoodMetricsUsed.length > 0 && Number.isFinite(lastGoodMetricsFetchedAt)
    ? lastGoodMetricsFetchedAt
    : null;
  const reportedLastGoodFetchedAt = borrowedMetricsFetchedAt != null && Number.isFinite(lastGoodFetchedAt)
    ? Math.min(lastGoodFetchedAt, borrowedMetricsFetchedAt)
    : (borrowedMetricsFetchedAt ?? lastGoodFetchedAt);

  // Preference durability is optional and must never spend the current-data
  // deadline. Start it only after v7, quoteSummary, last-good reads, and the
  // canonical snapshot write have finished; process-local state already keeps
  // the next cycle moving if this write fails.
  if (nextPreferredExit) {
    void persistPreferredExit(upstashSet, nextPreferredExit, preferredExit, now)
      .then((persistedAt) => {
        if (!Number.isFinite(persistedAt)) return;
        const current = LOCAL_PREFERRED_EXITS.get(v7Client);
        if (
          current?.attempt === nextPreferredExit.attempt
          && current.savedAt === nextPreferredExit.savedAt
        ) {
          LOCAL_PREFERRED_EXITS.set(v7Client, { ...current, persistedAt });
        }
      });
  }

  return {
    valuations,
    valuationSources: [...valuationSources],
    valuationCount,
    ...(currentValuationCount !== valuationCount ? { currentValuationCount } : {}),
    ...(unavailableSymbols.length > 0 ? { unavailableSymbols } : {}),
    ...(valuationDiagnostics.length > 0 ? { valuationDiagnostics } : {}),
    ...(reportedLastGoodFetchedAt && (lastGoodMetricsUsed.length > 0 || lastGoodValuationSymbols.length > 0)
      ? {
        lastGoodFetchedAt: reportedLastGoodFetchedAt,
        ...(lastGoodMetricsUsed.length > 0 ? { lastGoodMetricsUsed } : {}),
        ...(lastGoodValuationSymbols.length > 0 ? { lastGoodValuationSymbols } : {}),
      }
      : {}),
  };
}

function buildSectorValuationPublication({
  sectors,
  valuations,
  valuationCoverage,
}) {
  const {
    seedSourceState,
    errorCode,
    ...publishedValuationCoverage
  } = valuationCoverage;
  return {
    payload: {
      sectors,
      valuations,
      valuationCoverage: publishedValuationCoverage,
    },
    meta: {
      fetchedAt: valuationCoverage.fetchedAt,
      recordCount: sectors.length,
      sectorRecordCount: sectors.length,
      valuationRecordCount: valuationCoverage.valuationCount,
      expectedValuationRecordCount: valuationCoverage.expectedValuationCount,
      valuationSourceStatus: valuationCoverage.sourceStatus,
      valuationSource: valuationCoverage.source,
      sourceState: seedSourceState,
      ...(valuationCoverage.currentValuationCount != null
        ? { valuationCurrentRecordCount: valuationCoverage.currentValuationCount }
        : {}),
      sourceVersion: 'market-sectors',
      ...(valuationCoverage.unavailableSymbols?.length > 0
        ? { valuationUnavailableSymbols: valuationCoverage.unavailableSymbols }
        : {}),
      ...(valuationCoverage.valuationDiagnostics?.length > 0
        ? { valuationDiagnostics: valuationCoverage.valuationDiagnostics }
        : {}),
      ...(valuationCoverage.lastGood ? { valuationLastGood: valuationCoverage.lastGood } : {}),
      ...(valuationCoverage.staleValuationSymbols?.length > 0
        ? { valuationStaleSymbols: valuationCoverage.staleValuationSymbols }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

function buildSectorSeedMeta(sectorMeta, canonicalPayloadWritten) {
  if (canonicalPayloadWritten) return sectorMeta;
  const { fetchedAt: _fetchedAt, ...withoutFreshness } = sectorMeta;
  return {
    ...withoutFreshness,
    fetchedAt: null,
    sourceState: 'error',
    errorCode: 'SECTOR_DATA_WRITE_FAILED',
  };
}

module.exports = {
  YahooQuoteSummaryClient,
  buildCurlConfig,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  buildSectorSeedMeta,
  collectSectorValuations,
  collectV7Valuations,
  fetchYahooV7QuoteDirect,
  fetchYahooV7QuoteProxy,
  mergeReturnMetrics,
  parseCurlResponse,
  parseV7Quote,
  parseV7QuoteBatch,
  normalizeValuation,
  mergeLastGoodValuations,
  parseQuoteSummary,
  requestHttpsText,
  requestCurlText,
  LAST_GOOD_KEY,
  LAST_GOOD_TTL,
};
