'use strict';

const https = require('node:https');
const { spawn } = require('node:child_process');

const YAHOO_COOKIE_URL = 'https://fc.yahoo.com';
const YAHOO_CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const YAHOO_SUMMARY_BASE_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const YAHOO_SUMMARY_MODULES = 'summaryDetail,defaultKeyStatistics';
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_SPACING_MS = 150;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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
  if (value && typeof value === 'object') return value.raw ?? value.fmt ?? null;
  return typeof value === 'number' ? value : null;
}

function parseQuoteSummary(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'invalid_json', value: null };
  }
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return { kind: 'no_data', value: null };
  const summaryDetail = result.summaryDetail || {};
  const keyStatistics = result.defaultKeyStatistics || {};
  return {
    kind: 'success',
    value: {
      trailingPE: rawYahooValue(summaryDetail.trailingPE),
      forwardPE: rawYahooValue(summaryDetail.forwardPE),
      beta: rawYahooValue(summaryDetail.beta) ?? rawYahooValue(keyStatistics.beta3Year),
      ytdReturn: rawYahooValue(keyStatistics.ytdReturn),
      threeYearReturn: rawYahooValue(keyStatistics.threeYearAverageReturn),
      fiveYearReturn: rawYahooValue(keyStatistics.fiveYearAverageReturn),
    },
  };
}

function responseFailure(response) {
  if (!response) return 'no_response';
  try {
    const parsed = JSON.parse(response.body);
    const description = parsed?.finance?.error?.description
      || parsed?.quoteSummary?.error?.description;
    if (description) return `HTTP ${response.status} ${description}`;
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
  return error?.message || error?.name || 'request failed';
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
    this.states = {
      direct: { session: null, sessionPromise: null, cooldownUntil: 0 },
      proxy: { session: null, sessionPromise: null, cooldownUntil: 0 },
    };
  }

  async _request(transport, url, headers, proxy) {
    const request = transport === 'direct' ? this.directRequest : this.proxyRequest;
    if (this.requestSpacingMs > 0) await this.sleep(this.requestSpacingMs);
    return request(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        ...headers,
      },
      timeoutMs: transport === 'direct' ? 12_000 : 15_000,
      proxy,
    });
  }

  async _bootstrapSession(transport, proxy) {
    const cookieResponse = await this._request(transport, YAHOO_COOKIE_URL, {}, proxy);
    const cookie = cookieHeaderFromResponse(cookieResponse);
    if (!cookie) throw new Error(`cookie bootstrap HTTP ${cookieResponse?.status || 0}`);

    const crumbResponse = await this._request(
      transport,
      YAHOO_CRUMB_URL,
      { Cookie: cookie, Accept: 'text/plain,*/*' },
      proxy,
    );
    const crumb = crumbResponse?.status === 200 ? validCrumb(crumbResponse.body) : null;
    if (!crumb) throw new Error(`crumb bootstrap HTTP ${crumbResponse?.status || 0}`);

    return { cookie, crumb, fetchedAt: this.now() };
  }

  async _getSession(transport, proxy, forceRefresh = false) {
    const state = this.states[transport];
    if (forceRefresh) state.session = null;
    if (
      state.session
      && this.now() - state.session.fetchedAt < this.sessionTtlMs
    ) return state.session;
    if (state.sessionPromise) return state.sessionPromise;

    state.sessionPromise = this._bootstrapSession(transport, proxy);
    try {
      state.session = await state.sessionPromise;
      return state.session;
    } finally {
      state.sessionPromise = null;
    }
  }

  async _fetchVia(transport, symbol, proxy = '') {
    const state = this.states[transport];
    if (this.now() < state.cooldownUntil) return { kind: 'cooldown', value: null };

    let lastFailure = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const session = await this._getSession(transport, proxy, attempt > 0);
        const query = new URLSearchParams({
          modules: YAHOO_SUMMARY_MODULES,
          crumb: session.crumb,
        });
        const response = await this._request(
          transport,
          `${YAHOO_SUMMARY_BASE_URL}/${encodeURIComponent(symbol)}?${query}`,
          { Cookie: session.cookie },
          proxy,
        );
        if (response.status === 401 && attempt === 0) {
          lastFailure = responseFailure(response);
          continue;
        }
        if (response.status !== 200) {
          lastFailure = responseFailure(response);
          break;
        }

        const parsed = parseQuoteSummary(response.body);
        if (parsed.kind === 'success') {
          state.cooldownUntil = 0;
          return {
            kind: 'success',
            value: {
              ...parsed.value,
              source: `yahoo_quote_summary_authenticated_${transport}`,
            },
          };
        }
        if (parsed.kind === 'no_data') return parsed;
        lastFailure = parsed.kind;
        break;
      } catch (error) {
        lastFailure = transportFailure(error, transport);
        break;
      }
    }

    state.session = null;
    state.cooldownUntil = this.now() + this.cooldownMs;
    this.logger.warn(
      `[Sector] Yahoo authenticated ${transport} route unavailable (${lastFailure}); cooldown ${Math.round(this.cooldownMs / 60_000)}min`,
      { transport, failure: lastFailure },
    );
    return { kind: 'failed', value: null };
  }

  async fetch(symbol) {
    const direct = await this._fetchVia('direct', symbol);
    if (direct.kind === 'success' || direct.kind === 'no_data') return direct.value;

    const proxy = this.resolveProxyString();
    if (!proxy) return null;
    const proxied = await this._fetchVia('proxy', symbol, proxy);
    return proxied.kind === 'success' ? proxied.value : null;
  }
}

function buildSectorValuationCoverage({
  valuationCount,
  expectedCount,
  fetchedAt,
  sources,
}) {
  const count = Number.isFinite(valuationCount) ? Math.max(0, valuationCount) : 0;
  const expected = Number.isFinite(expectedCount) ? Math.max(0, expectedCount) : 0;
  const orderedSources = [...new Set((sources || []).filter(Boolean))].sort();
  const source = orderedSources.length > 0
    ? orderedSources.join('+')
    : 'yahoo_quote_summary_authenticated';

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
  };
}

async function collectSectorValuations({
  symbols,
  fetchValue,
  parseValue,
  sleepFn = sleep,
}) {
  const valuations = {};
  const valuationSources = new Set();
  let valuationCount = 0;
  for (const symbol of symbols) {
    const raw = await fetchValue(symbol);
    const parsed = parseValue(raw);
    if (parsed) {
      valuations[symbol] = parsed;
      if (raw?.source) valuationSources.add(raw.source);
      valuationCount++;
    }
    await sleepFn(DEFAULT_REQUEST_SPACING_MS);
  }
  return {
    valuations,
    valuationSources: [...valuationSources],
    valuationCount,
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
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

module.exports = {
  YahooQuoteSummaryClient,
  buildCurlConfig,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  collectSectorValuations,
  parseCurlResponse,
  parseQuoteSummary,
  requestHttpsText,
  requestCurlText,
};
