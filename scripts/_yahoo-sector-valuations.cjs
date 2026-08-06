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
const BATCH_BUDGET_MS = 15_000;
const CURL_PROCESS_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  { userAgent, resolveProxyString, sleepFn = sleep, client, deadlineAt = null, now = Date.now } = {},
) {
  const freshVals = {};
  const diagnostics = [];
  const valuationSources = new Set();
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
  const batchSymbols = symbols.filter((symbol) => !freshVals[symbol]);
  if (
    batchSymbols.length > 0
    && client?.fetchV7BatchDetailed
    // Require a real slice of budget, not merely "not yet expired": this route
    // runs BEFORE the quoteSummary tier, so an uncapped slow batch would eat
    // the remainder and starve the alternative source entirely.
    && (deadlineAt == null || deadlineAt - now() >= BATCH_MIN_BUDGET_MS)
  ) {
    let batchResult = null;
    let batchError = null;
    try {
      batchResult = await client.fetchV7BatchDetailed(batchSymbols, {
        deadlineAt: deadlineAt == null ? null : Math.min(deadlineAt, now() + BATCH_BUDGET_MS),
      });
    } catch (error) {
      batchResult = null;
      batchError = boundedFailure(error?.message || error?.name);
      console.warn('[Sector] v7 batch fallback threw', { failure: batchError });
    }
    const batchValues = batchResult?.value?.valuations;
    const batchOutcomes = batchResult?.value?.outcomes;
    const transportDiagnostic = batchResult?.diagnostics?.[batchResult.diagnostics.length - 1]
      || batchResult?.diagnostic;
    for (const symbol of batchSymbols) {
      const outcome = batchOutcomes?.[symbol];
      const failure = outcome?.failure || transportDiagnostic?.failure || batchError;
      const diagnostic = {
        // Labelled distinctly from the per-symbol 'v7Quote' route so an
        // operator can tell whether the batch fallback ran and whether it
        // helped. Cooldown state is still SHARED with 'v7Quote' -- see the
        // healthKey passed by fetchV7BatchDetailed.
        route: 'v7QuoteBatch',
        ...(transportDiagnostic?.transport ? { transport: transportDiagnostic.transport } : {}),
        ...(transportDiagnostic?.attempts != null ? { attempts: transportDiagnostic.attempts } : {}),
        ...(transportDiagnostic?.status != null ? { status: transportDiagnostic.status } : {}),
        responseClass: batchError
          ? 'batch_error'
          : outcome?.kind || transportDiagnostic?.responseClass || batchResult?.kind || 'failed',
        ...(outcome?.missingFields?.length ? { missingFields: outcome.missingFields } : {}),
        ...(failure ? { failure: boundedFailure(failure) } : {}),
      };
      const entry = diagnostics.find((item) => item.symbol === symbol);
      if (entry) entry.outcomes.push(diagnostic);
      else diagnostics.push({ symbol, outcomes: [diagnostic] });

      const value = batchValues?.[symbol];
      if (value) {
        freshVals[symbol] = {
          ...value,
          ...(batchResult.value.source ? { source: batchResult.value.source } : {}),
        };
        if (batchResult.value.source) valuationSources.add(batchResult.value.source);
      }
    }
  }
  return { valuations: freshVals, diagnostics, valuationSources: [...valuationSources] };
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
    this.directRequest = directRequest;
    this.proxyRequest = proxyRequest;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.sessionTtlMs = sessionTtlMs;
    this.requestSpacingMs = requestSpacingMs;
    this.sleep = sleepFn;
    this.logger = logger;
    // Transport-level session only (cookie+crumb). Route cooldowns live in routeStates.
    this.states = {
      direct: { session: null, sessionPromise: null },
      proxy: { session: null, sessionPromise: null },
    };
    this.routeStates = new Map();
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
    const state = this.states[transport];
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

  _getRouteState(route, transport) {
    const key = `${route}:${transport}`;
    let state = this.routeStates.get(key);
    if (!state) {
      state = { cooldownUntil: 0 };
      this.routeStates.set(key, state);
    }
    return state;
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
    const routeState = this._getRouteState(healthKey || route, transport);
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
      this.states[transport].session = null;
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

  async _fetchRoute(route, symbol, { buildUrl, parseResponse, source, deadlineAt = null, healthKey = null }) {
    const diagnostics = [];
    const direct = await this._fetchVia(
      route,
      'direct',
      symbol,
      '',
      { buildUrl, parseResponse, source: `${source}_direct`, deadlineAt, healthKey },
    );
    diagnostics.push(direct.diagnostic);
    if (direct.kind === 'success') return { ...direct, diagnostics };

    const proxy = this.resolveProxyString();
    if (!proxy) return { ...direct, diagnostics };
    const proxied = await this._fetchVia(
      route,
      'proxy',
      symbol,
      proxy,
      { buildUrl, parseResponse, source: `${source}_proxy`, deadlineAt, healthKey },
    );
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
        return {
          kind: 'success',
          value: {
            valuations,
            outcomes: { ...(direct.value?.outcomes || {}), ...(proxied.value?.outcomes || {}) },
            source: proxiedValuations ? proxied.value?.source : direct.value?.source,
          },
          diagnostic: proxied.diagnostic,
          diagnostics,
        };
      }
    }
    if (proxied.kind === 'success') return { ...proxied, diagnostics };
    return { ...proxied, diagnostics };
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

  // Tier 1: v7/finance/quote for P/E and beta
  const v7Result = v7UserAgent ? await collectV7Valuations(symbols, {
    userAgent: v7UserAgent,
    resolveProxyString: v7ResolveProxyString,
    sleepFn,
    client: v7Client,
    deadlineAt,
    now,
  }) : {};
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
