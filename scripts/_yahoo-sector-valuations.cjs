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
    { buildUrl, parseResponse, source, deadlineAt = null },
  ) {
    if (deadlineAt != null && this.now() >= deadlineAt) {
      return this._deadlineExceeded(route, transport);
    }
    const routeState = this._getRouteState(route, transport);
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
          return { ...parsed, diagnostic };
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

  async _fetchRoute(route, symbol, { buildUrl, parseResponse, source, deadlineAt = null }) {
    const diagnostics = [];
    const direct = await this._fetchVia(
      route,
      'direct',
      symbol,
      '',
      { buildUrl, parseResponse, source: `${source}_direct`, deadlineAt },
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
      { buildUrl, parseResponse, source: `${source}_proxy`, deadlineAt },
    );
    diagnostics.push(proxied.diagnostic);
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
}) {
  const count = Number.isFinite(valuationCount) ? Math.max(0, valuationCount) : 0;
  const expected = Number.isFinite(expectedCount) ? Math.max(0, expectedCount) : 0;
  const orderedSources = [...new Set((sources || []).filter(Boolean))].sort();
  const source = orderedSources.length > 0
    ? orderedSources.join('+')
    : 'yahoo_quote_summary_authenticated';
  const unavailable = [...new Set(unavailableSymbols.filter(Boolean))].sort();
  const diagnostics = valuationDiagnostics.filter(Boolean);
  const lastGood = lastGoodFetchedAt && lastGoodMetricsUsed.length > 0
    ? {
      fetchedAt: lastGoodFetchedAt,
      stale: true,
      symbols: [...new Set(lastGoodMetricsUsed)].sort(),
    }
    : null;

  const extras = {
    ...(unavailable.length > 0 ? { unavailableSymbols: unavailable } : {}),
    ...(diagnostics.length > 0 ? { valuationDiagnostics: diagnostics } : {}),
    ...(lastGood ? { lastGood } : {}),
  };

  if (count <= 0) {
    return {
      valuationCount: 0,
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
  if (count < expected) {
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
  let lastGoodMetricsUsed = [];

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

  if (Object.keys(v7Vals).length > 0 && typeof upstashGet === 'function') {
    try {
      const raw = await upstashGet(LAST_GOOD_KEY);
      if (raw && typeof raw === 'object' && raw.valuations) {
        lastGood = raw.valuations;
        lastGoodFetchedAt = Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : null;
      }
    } catch {}
  }
  if (lastGood) lastGoodMetricsUsed = mergeReturnMetrics(v7Vals, lastGood);

  const valuations = {};
  const unavailableSymbols = [];
  for (const symbol of symbols) {
    if (!v7Vals[symbol]) {
      unavailableSymbols.push(symbol);
      continue;
    }
    const { source: _source, ...valuation } = v7Vals[symbol];
    valuations[symbol] = valuation;
  }
  const valuationCount = Object.keys(valuations).length;
  if (valuationCount > 0 && valuationSources.size === 0) valuationSources.add('yahoo_v7_quote');

  const hasCompleteReturnMetrics = valuationCount === symbols.length
    && symbols.length > 0
    && symbols.every((symbol) => {
      const valuation = valuations[symbol];
      return valuation
        && valuation.ytdReturn != null
        && valuation.threeYearReturn != null
        && valuation.fiveYearReturn != null;
    });

  // Persist last-good only when the current snapshot is complete at the
  // field level. A v7-only run intentionally leaves return metrics null, and
  // a partial quoteSummary fallback must never replace an older complete
  // snapshot with that incomplete shape.
  // A partial run may borrow return metrics from the previous snapshot. Do not
  // rewrite that snapshot with a new fetchedAt: doing so would make borrowed
  // metrics appear fresh forever across repeated partial cycles. Also retain a
  // full last-good snapshot until a full current run replaces it; otherwise a
  // partial outage would discard the symbols that were healthy previously.
  if (
    hasCompleteReturnMetrics
    && lastGoodMetricsUsed.length === 0
    && typeof upstashSet === 'function'
  ) {
    try {
      const ok = await upstashSet(LAST_GOOD_KEY, { valuations, fetchedAt: now() }, LAST_GOOD_TTL);
      // upstashSet resolves false on disable/timeout/non-OK without throwing.
      if (!ok) {
        console.warn('[Sector] last-good valuation snapshot write failed');
      }
    } catch {
      console.warn('[Sector] last-good valuation snapshot write failed');
    }
  }

  return {
    valuations,
    valuationSources: [...valuationSources],
    valuationCount,
    ...(unavailableSymbols.length > 0 ? { unavailableSymbols } : {}),
    ...(valuationDiagnostics.length > 0 ? { valuationDiagnostics } : {}),
    ...(lastGoodFetchedAt && lastGoodMetricsUsed.length > 0
      ? { lastGoodFetchedAt, lastGoodMetricsUsed }
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
      sourceVersion: 'market-sectors',
      ...(valuationCoverage.unavailableSymbols?.length > 0
        ? { valuationUnavailableSymbols: valuationCoverage.unavailableSymbols }
        : {}),
      ...(valuationCoverage.valuationDiagnostics?.length > 0
        ? { valuationDiagnostics: valuationCoverage.valuationDiagnostics }
        : {}),
      ...(valuationCoverage.lastGood ? { valuationLastGood: valuationCoverage.lastGood } : {}),
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
  parseQuoteSummary,
  requestHttpsText,
  requestCurlText,
  LAST_GOOD_KEY,
  LAST_GOOD_TTL,
};
