import Papa from 'papaparse';
import { fredFetchJson, readCanonicalValue, resolveProxyForConnect } from '../_seed-utils.mjs';

export const OECD_MAX_REQUESTS_PER_RUN = 2;
export const OECD_CPI_URL = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_G20_PRICES@DF_G20_PRICES,1.0/CHN.M...PA...?startPeriod=2024-01&dimensionAtObservation=AllDimensions&format=csvfile';
export const OECD_CLI_URL = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/CHN.M.LI...AA...H?startPeriod=2024-01&dimensionAtObservation=AllDimensions&format=csvfile';
export const HKMA_CNY_URL = 'https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily?pagesize=2&fields=end_of_day,cny&sortby=end_of_day&sortorder=desc';
export const FRED_DEXCHUS_URL = 'https://api.stlouisfed.org/fred/series/observations?series_id=DEXCHUS&file_type=json&sort_order=desc&limit=2';

const REQUIRED_CATEGORIES = ['price', 'activity', 'policy', 'fx'];

export function observationDateMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  const parsed = month
    ? Date.UTC(Number(month[1]), Number(month[2]), 0, 23, 59, 59)
    : Date.parse(`${value}${/^\d{4}-\d{2}-\d{2}$/.test(value) ? 'T23:59:59Z' : ''}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStale(observationDate, maxAgeDays, now) {
  const observedAt = observationDateMs(observationDate);
  return observedAt == null || now - observedAt > maxAgeDays * 86_400_000;
}

function unavailableIndicator({ id, label, category, unit, source, sourceUrl, reason, contextOnly = false }) {
  return {
    id, label, category, value: null, priorValue: null, unit,
    observationDate: '', source, sourceUrl, stale: false,
    unavailableReason: reason || 'SOURCE_UNAVAILABLE', contextOnly,
  };
}

function completeIndicator(def, value, priorValue, observationDate, now, contextOnly = false) {
  const stale = isStale(observationDate, def.maxAgeDays, now);
  return {
    id: def.id,
    label: def.label,
    category: def.category,
    value,
    priorValue,
    unit: def.unit,
    observationDate,
    source: def.source,
    sourceUrl: def.sourceUrl || '',
    stale,
    unavailableReason: stale ? 'STALE_OBSERVATION' : '',
    contextOnly,
  };
}

export function parseOecdCsvIndicator(csv, def, now = Date.now()) {
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return unavailableIndicator({ ...def, reason: 'MALFORMED_RESPONSE' });
  }
  const rows = parsed.data
    .filter((row) => String(row.REF_AREA || row.ReferenceArea || '').toUpperCase() === 'CHN')
    .map((row) => ({
      date: String(row.TIME_PERIOD || row.TimePeriod || ''),
      value: Number(row.OBS_VALUE ?? row.ObservationValue),
    }))
    .filter((row) => row.date && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows.at(-1);
  if (!latest) return unavailableIndicator({ ...def, reason: 'NO_CHINA_OBSERVATIONS' });
  return completeIndicator(def, latest.value, rows.at(-2)?.value ?? null, latest.date, now);
}

export function parseBisPolicy(data, now = Date.now()) {
  const def = {
    id: 'policy_rate', label: 'Policy Rate', category: 'policy', unit: '%',
    source: 'BIS (mainland China policy rate)',
    sourceUrl: 'https://stats.bis.org/api/v1/data/WS_CBPOL', maxAgeDays: 75,
  };
  const rows = Array.isArray(data?.rates) ? data.rates : [];
  const matches = rows
    .filter((row) => row?.countryCode === 'CN' && Number.isFinite(Number(row.rate)) && row.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = matches.at(-1);
  if (!latest) return unavailableIndicator({ ...def, reason: 'NO_CHINA_POLICY_RATE' });
  const prior = matches.length > 1 ? Number(matches.at(-2).rate) : Number(latest.previousRate);
  return completeIndicator(def, Number(latest.rate), Number.isFinite(prior) ? prior : null, String(latest.date), now);
}

export function parseFredUsdCny(data, now = Date.now()) {
  const def = {
    id: 'usd_cny', label: 'USD/CNY', category: 'fx', unit: 'CNY per USD',
    source: 'FRED DEXCHUS (Federal Reserve H.10)',
    sourceUrl: 'https://fred.stlouisfed.org/series/DEXCHUS', maxAgeDays: 10,
  };
  const rows = (Array.isArray(data?.observations) ? data.observations : [])
    .map((row) => ({ date: String(row?.date || ''), value: Number(row?.value) }))
    .filter((row) => row.date && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows.at(-1);
  if (!latest) return unavailableIndicator({ ...def, reason: 'NO_CURRENT_DEXCHUS' });
  return completeIndicator(def, latest.value, rows.at(-2)?.value ?? null, latest.date, now);
}

export function parseHkmaCnyContext(data, now = Date.now()) {
  const def = {
    id: 'cnh_context', label: 'CNY/HKD Context', category: 'context', unit: 'HKD per CNY',
    source: 'HKMA (Hong Kong/CNH context)',
    sourceUrl: 'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily/',
    maxAgeDays: 10,
  };
  const rows = (Array.isArray(data?.result?.records) ? data.result.records : [])
    .map((row) => ({ date: String(row?.end_of_day || ''), value: Number(row?.cny) }))
    .filter((row) => row.date && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows.at(-1);
  if (!latest) return unavailableIndicator({ ...def, reason: 'NO_HKMA_CNY_CONTEXT', contextOnly: true });
  return completeIndicator(def, latest.value, rows.at(-2)?.value ?? null, latest.date, now, true);
}

function requiredIndicator(indicators, category) {
  return indicators.find((indicator) => indicator.category === category && !indicator.contextOnly);
}

export function buildChinaMacroSnapshot({ indicators, sourceDecisions, generatedAt = new Date().toISOString() }) {
  const launchReady = REQUIRED_CATEGORIES.every((category) => {
    const indicator = requiredIndicator(indicators, category);
    return indicator && Number.isFinite(indicator.value) && !indicator.stale && !indicator.unavailableReason;
  });
  const requiredDates = REQUIRED_CATEGORIES
    .map((category) => requiredIndicator(indicators, category)?.observationDate)
    .filter(Boolean)
    .sort();
  return {
    countryCode: 'CN',
    generatedAt,
    status: launchReady ? 'ready' : (indicators.some((indicator) => Number.isFinite(indicator.value)) ? 'degraded' : 'unavailable'),
    launchReady,
    // The oldest required observation anchors content health. A fresh FX tick
    // must never make stale CPI/activity content look fresh.
    contentObservationDate: launchReady && requiredDates.length === REQUIRED_CATEGORIES.length ? requiredDates[0] : '',
    latestObservationDate: requiredDates.at(-1) || '',
    indicators,
    sourceDecisions,
  };
}

function decision({ source, host, status, reason, checkedAt, optional = false, requestCount = 1 }) {
  return { source, host, status, reason, checkedAt, optional, requestCount };
}

async function fetchText(fetchFn, url, headers = {}) {
  const response = await fetchFn(url, {
    // OECD's CLI flow currently returns `500 languageTag1` to Node clients
    // without an explicit language, even though the same URL works in curl.
    headers: { Accept: 'text/csv, text/plain;q=0.9, */*;q=0.1', 'Accept-Language': 'en', 'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)' , ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  return response.text();
}

async function fetchJson(fetchFn, url) {
  const response = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/2.10 (+https://worldmonitor.app)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  return response.json();
}

function reasonFor(error) {
  if (Number.isInteger(error?.status)) return `HTTP_${error.status}`;
  if (error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message))) return 'TIMEOUT';
  return 'FETCH_FAILED';
}

export async function fetchChinaMacroSnapshot({
  now = Date.now(),
  fetchFn = globalThis.fetch,
  readCachedFn = readCanonicalValue,
  fredFetchFn,
  fredFetchJsonFn = fredFetchJson,
  fredProxyFn = resolveProxyForConnect,
  onDecision = (entry) => console.log(JSON.stringify({ event: 'china_macro_source_preflight', ...entry })),
} = {}) {
  const checkedAt = new Date(now).toISOString();
  const sourceDecisions = [];
  const record = (entry) => { sourceDecisions.push(entry); onDecision(entry); };

  let cpiCsv;
  let cliCsv;
  let oecdRequestCount = 0;
  try {
    // OECD explicitly asks API consumers to consolidate and stay below
    // 60 downloads/hour. Keep this to two sequential dataset requests: the
    // public endpoint intermittently returns 500 when these land together.
    oecdRequestCount += 1;
    cpiCsv = await fetchText(fetchFn, OECD_CPI_URL);
    oecdRequestCount += 1;
    cliCsv = await fetchText(fetchFn, OECD_CLI_URL);
    record(decision({ source: 'OECD Data Explorer', host: 'sdmx.oecd.org', status: 'accepted', reason: 'OK', checkedAt, requestCount: oecdRequestCount }));
  } catch (error) {
    const reason = reasonFor(error);
    record(decision({ source: 'OECD Data Explorer', host: 'sdmx.oecd.org', status: 'blocked', reason, checkedAt, requestCount: oecdRequestCount }));
    const requiredError = new Error(`OECD_REQUIRED_SOURCE_UNAVAILABLE:${reason}`);
    // runSeed wraps fetchers in its own four-attempt retry loop. OECD asks
    // clients to bound downloads, so preserve last-good immediately instead
    // of replaying the full two-request dataflow after a timeout/rate limit.
    requiredError.nonRetryable = true;
    throw requiredError;
  }

  const indicators = [
    parseOecdCsvIndicator(cpiCsv, {
      id: 'cpi_yoy', label: 'CPI (YoY)', category: 'price', unit: '%', source: 'OECD Data Explorer', sourceUrl: OECD_CPI_URL, maxAgeDays: 120,
    }, now),
    parseOecdCsvIndicator(cliCsv, {
      id: 'activity_cli', label: 'Composite Leading Indicator', category: 'activity', unit: 'index', source: 'OECD Data Explorer', sourceUrl: OECD_CLI_URL, maxAgeDays: 120,
    }, now),
  ];

  try {
    const bis = await readCachedFn('economic:bis:policy:v1');
    indicators.push(parseBisPolicy(bis, now));
    record(decision({ source: 'BIS seed cache', host: 'redis', status: indicators.at(-1).value == null ? 'blocked' : 'accepted', reason: indicators.at(-1).unavailableReason || 'OK', checkedAt }));
  } catch {
    indicators.push(unavailableIndicator({ id: 'policy_rate', label: 'Policy Rate', category: 'policy', unit: '%', source: 'BIS (mainland China policy rate)', sourceUrl: 'https://stats.bis.org/api/v1/data/WS_CBPOL', reason: 'CACHE_UNAVAILABLE' }));
    record(decision({ source: 'BIS seed cache', host: 'redis', status: 'blocked', reason: 'CACHE_UNAVAILABLE', checkedAt }));
  }

  try {
    if (!fredFetchFn && !process.env.FRED_API_KEY) throw new Error('MISSING_FRED_API_KEY');
    const fredUrl = fredFetchFn ? FRED_DEXCHUS_URL : `${FRED_DEXCHUS_URL}&api_key=${encodeURIComponent(process.env.FRED_API_KEY)}`;
    const fred = fredFetchFn
      ? await fredFetchFn(fredUrl)
      : await fredFetchJsonFn(fredUrl, fredProxyFn());
    indicators.push(parseFredUsdCny(fred, now));
    record(decision({ source: 'FRED DEXCHUS', host: 'api.stlouisfed.org', status: indicators.at(-1).value == null ? 'blocked' : 'accepted', reason: indicators.at(-1).unavailableReason || 'OK', checkedAt }));
  } catch (error) {
    indicators.push(unavailableIndicator({ id: 'usd_cny', label: 'USD/CNY', category: 'fx', unit: 'CNY per USD', source: 'FRED DEXCHUS (Federal Reserve H.10)', sourceUrl: 'https://fred.stlouisfed.org/series/DEXCHUS', reason: error?.message === 'MISSING_FRED_API_KEY' ? 'MISSING_FRED_API_KEY' : reasonFor(error) }));
    record(decision({ source: 'FRED DEXCHUS', host: 'api.stlouisfed.org', status: 'blocked', reason: indicators.at(-1).unavailableReason, checkedAt }));
  }

  try {
    const hkma = await fetchJson(fetchFn, HKMA_CNY_URL);
    indicators.push(parseHkmaCnyContext(hkma, now));
    record(decision({ source: 'HKMA CNY context', host: 'api.hkma.gov.hk', status: indicators.at(-1).value == null ? 'blocked' : 'accepted', reason: indicators.at(-1).unavailableReason || 'OK', checkedAt, optional: true }));
  } catch (error) {
    indicators.push(unavailableIndicator({ id: 'cnh_context', label: 'CNY/HKD Context', category: 'context', unit: 'HKD per CNY', source: 'HKMA (Hong Kong/CNH context)', sourceUrl: 'https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily/', reason: reasonFor(error), contextOnly: true }));
    record(decision({ source: 'HKMA CNY context', host: 'api.hkma.gov.hk', status: 'blocked', reason: reasonFor(error), checkedAt, optional: true }));
  }

  return buildChinaMacroSnapshot({ indicators, sourceDecisions, generatedAt: checkedAt });
}
