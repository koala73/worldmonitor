import Papa from 'papaparse';

import {
  CHROME_UA,
  loadSharedConfig,
} from './_seed-utils.mjs';

export const HAPI_PAGE_LIMIT = 10_000;
export const HAPI_MAX_PAGES = 3;
export const HAPI_HDX_PACKAGE_URL = 'https://data.humdata.org/api/3/action/package_show?id=hdx-hapi-conflict-event';
const HAPI_HDX_METADATA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const HAPI_HDX_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const HAPI_HDX_METADATA_TIMEOUT_MS = 60_000;
// The official annual CSV is currently about 18.7 MB and has taken longer
// than 60 seconds to transfer. Keep the stream bounded by bytes, but allow
// enough time for a legitimate snapshot to finish.
export const HAPI_HDX_SNAPSHOT_TIMEOUT_MS = 120_000;

const ISO2_TO_ISO3 = loadSharedConfig('iso2-to-iso3.json');
const ISO3_TO_ISO2 = new Map(
  Object.entries(ISO2_TO_ISO3).map(([iso2, iso3]) => [String(iso3).toUpperCase(), iso2]),
);
const HAPI_COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

function previousMonthStart(nowMs) {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
}

export function hapiCountryCodeForIso3(value) {
  return ISO3_TO_ISO2.get(String(value || '').toUpperCase());
}

export function buildHapiConflictEventsUrl({
  nowMs = Date.now(),
  offset = 0,
  countryCode,
  adminLevel = '0',
} = {}) {
  const url = new URL('https://hapi.humdata.org/api/v2/coordination-context/conflict-events');
  url.searchParams.set('output_format', 'json');
  if (adminLevel != null) url.searchParams.set('admin_level', String(adminLevel));
  url.searchParams.set('start_date', previousMonthStart(nowMs));
  url.searchParams.set('limit', String(HAPI_PAGE_LIMIT));
  url.searchParams.set('offset', String(offset));
  if (countryCode) {
    const iso3 = ISO2_TO_ISO3[countryCode];
    if (!iso3) throw new Error(`No ISO3 mapping for HAPI country ${countryCode}`);
    url.searchParams.set('location_code', iso3);
  }
  return url.toString();
}

function hapiHdxError(message, {
  status,
  reasonCode = 'HDX_FETCH_FAILED',
} = {}) {
  return Object.assign(new Error(message), {
    ...(status != null ? { status } : {}),
    reasonCode,
  });
}

function hapiHdxResourceUrl(resource) {
  let url;
  try {
    url = new URL(String(resource?.url || ''));
  } catch {
    throw hapiHdxError('HAPI HDX snapshot resource has an invalid URL', {
      reasonCode: 'HDX_RESOURCE_INVALID',
    });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'data.humdata.org') {
    throw hapiHdxError(`HAPI HDX snapshot resource uses an unexpected origin: ${url.origin}`, {
      reasonCode: 'HDX_RESOURCE_INVALID',
    });
  }
  return url.toString();
}

export function selectHapiHdxCsvResources(resources, { nowMs = Date.now() } = {}) {
  const startYear = Number(previousMonthStart(nowMs).slice(0, 4));
  const currentYear = new Date(nowMs).getUTCFullYear();
  const selected = [];

  for (let year = startYear; year <= currentYear; year += 1) {
    const yearPattern = new RegExp(`(?:^|[_-])${year}\\.csv$`, 'i');
    const candidates = (Array.isArray(resources) ? resources : [])
      .filter((resource) => {
        if (String(resource?.format || '').toUpperCase() !== 'CSV') return false;
        const name = String(resource?.name || '');
        let pathname = '';
        try {
          pathname = new URL(String(resource?.url || '')).pathname;
        } catch {
          // The selected resource is validated below; malformed non-matches can
          // be ignored while looking for the requested annual snapshot.
        }
        return yearPattern.test(name) || yearPattern.test(pathname);
      })
      .sort((left, right) => String(right?.last_modified || '').localeCompare(
        String(left?.last_modified || ''),
      ));

    if (candidates.length === 0 && year === startYear) {
      throw hapiHdxError(`HAPI HDX snapshot has no CSV resource for ${year}`, {
        reasonCode: 'HDX_RESOURCE_NOT_FOUND',
      });
    }
    // At the start of January, HDX can legitimately still expose only the
    // prior-year file. It contains the previous month requested by the API
    // contract, so use it until the new annual resource appears.
    if (candidates.length === 0) continue;
    selected.push({
      year,
      url: hapiHdxResourceUrl(candidates[0]),
    });
  }
  return selected;
}

export async function readBoundedHapiHdxText(response, maxResponseBytes) {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength != null
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > maxResponseBytes
  ) {
    throw hapiHdxError(
      `HAPI HDX response exceeds ${maxResponseBytes} bytes`,
      { status: response.status, reasonCode: 'RESPONSE_TOO_LARGE' },
    );
  }

  if (!response.body?.getReader) {
    const body = await response.arrayBuffer();
    if (body.byteLength > maxResponseBytes) {
      throw hapiHdxError(
        `HAPI HDX response exceeds ${maxResponseBytes} bytes`,
        { status: response.status, reasonCode: 'RESPONSE_TOO_LARGE' },
      );
    }
    return new TextDecoder().decode(body);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw hapiHdxError(
          `HAPI HDX response exceeds ${maxResponseBytes} bytes`,
          { status: response.status, reasonCode: 'RESPONSE_TOO_LARGE' },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function parseHapiHdxConflictCsv(
  csvText,
  { nowMs = Date.now(), countryCodes = Object.keys(ISO2_TO_ISO3) } = {},
) {
  const earliestPeriod = previousMonthStart(nowMs);
  const targetIso3 = new Set(
    countryCodes
      .map((countryCode) => ISO2_TO_ISO3[countryCode])
      .filter(Boolean)
      .map((countryCode) => String(countryCode).toUpperCase()),
  );
  const rows = [];
  const parseErrors = [];
  const parsed = Papa.parse(String(csvText || ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.replace(/^\ufeff/, '').trim(),
    step: (result) => {
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        parseErrors.push(...result.errors.slice(0, 5 - parseErrors.length));
      }
      const row = result.data;
      const locationCode = String(row?.location_code || '').toUpperCase();
      if (!targetIso3.has(locationCode)) return;
      if (String(row?.reference_period_start || '') < earliestPeriod) return;
      rows.push(row);
    },
  });

  const requiredFields = [
    'location_code',
    'admin_level',
    'event_type',
    'events',
    'fatalities',
    'reference_period_start',
  ];
  const fields = new Set(parsed.meta?.fields || []);
  const missingFields = requiredFields.filter((field) => !fields.has(field));
  if (missingFields.length > 0 || parseErrors.length > 0) {
    const details = missingFields.length > 0
      ? `missing fields: ${missingFields.join(', ')}`
      : parseErrors[0].message;
    throw hapiHdxError(`HAPI HDX CSV is invalid (${details})`, {
      reasonCode: 'HDX_CSV_INVALID',
    });
  }
  return rows;
}

export async function fetchHapiHdxSnapshotRows({
  fetchFn = (...args) => globalThis.fetch(...args),
  nowMs = Date.now(),
  countryCodes = Object.keys(ISO2_TO_ISO3),
  createTimeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
} = {}) {
  const requestOptions = (accept, timeoutMs) => ({
    headers: {
      Accept: accept,
      'User-Agent': CHROME_UA,
    },
    signal: createTimeoutSignal(timeoutMs),
  });
  const metadataResponse = await fetchFn(
    HAPI_HDX_PACKAGE_URL,
    requestOptions('application/json', HAPI_HDX_METADATA_TIMEOUT_MS),
  );
  if (!metadataResponse.ok) {
    throw hapiHdxError(`HAPI HDX metadata request failed: HTTP ${metadataResponse.status}`, {
      status: metadataResponse.status,
      reasonCode: `HDX_HTTP_${metadataResponse.status}`,
    });
  }

  const metadataText = await readBoundedHapiHdxText(
    metadataResponse,
    HAPI_HDX_METADATA_MAX_RESPONSE_BYTES,
  );
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw hapiHdxError('HAPI HDX metadata response is not valid JSON', {
      reasonCode: 'HDX_METADATA_INVALID',
    });
  }
  if (metadata?.success !== true || !Array.isArray(metadata?.result?.resources)) {
    throw hapiHdxError('HAPI HDX metadata response is missing resources', {
      reasonCode: 'HDX_METADATA_INVALID',
    });
  }

  const resources = selectHapiHdxCsvResources(metadata.result.resources, { nowMs });
  const rows = [];
  for (const resource of resources) {
    const response = await fetchFn(
      resource.url,
      requestOptions('text/csv', HAPI_HDX_SNAPSHOT_TIMEOUT_MS),
    );
    if (!response.ok) {
      throw hapiHdxError(
        `HAPI HDX ${resource.year} snapshot request failed: HTTP ${response.status}`,
        {
          status: response.status,
          reasonCode: `HDX_HTTP_${response.status}`,
        },
      );
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw hapiHdxError(`HAPI HDX ${resource.year} snapshot returned HTML`, {
        status: response.status,
        reasonCode: 'HDX_CSV_INVALID',
      });
    }
    const csvText = await readBoundedHapiHdxText(response, HAPI_HDX_MAX_RESPONSE_BYTES);
    rows.push(...parseHapiHdxConflictCsv(csvText, { nowMs, countryCodes }));
  }
  return rows;
}

export function hapiHdxFailureReason(error) {
  const seen = new Set();
  let reasonCode;
  let sawTimeout = false;
  let sawDns = false;
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    reasonCode ||= current.reasonCode;
    sawTimeout ||= (
      current.name === 'TimeoutError'
      || current.name === 'AbortError'
      || current.code === 'ETIMEDOUT'
      || current.code === 'UND_ERR_CONNECT_TIMEOUT'
      || current.code === 'UND_ERR_HEADERS_TIMEOUT'
      || current.code === 'UND_ERR_BODY_TIMEOUT'
    );
    sawDns ||= current.code === 'ENOTFOUND' || current.code === 'EAI_AGAIN';
    current = current.cause;
  }

  if (reasonCode) return reasonCode;
  if (sawTimeout) return 'HDX_TIMEOUT';
  if (sawDns) return 'HDX_DNS_ERROR';
  return 'HDX_FETCH_FAILED';
}

function finiteCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function aggregateHapiConflictEvents(
  records,
  { nowMs = Date.now(), countryCodes = Object.keys(ISO2_TO_ISO3) } = {},
) {
  const targetCountries = new Set(countryCodes);
  const aggregates = new Map();

  for (const row of Array.isArray(records) ? records : []) {
    const countryCode = hapiCountryCodeForIso3(row?.location_code);
    if (!countryCode || !targetCountries.has(countryCode)) continue;

    const referencePeriod = String(row?.reference_period_start || '');
    if (!referencePeriod) continue;
    const parsedAdminLevel = Number(row?.admin_level ?? 0);
    const adminLevel = Number.isFinite(parsedAdminLevel) ? parsedAdminLevel : 0;

    let aggregate = aggregates.get(countryCode);
    if (
      !aggregate
      || referencePeriod > aggregate.referencePeriod
      || (referencePeriod === aggregate.referencePeriod && adminLevel > aggregate.adminLevel)
    ) {
      aggregate = {
        referencePeriod,
        adminLevel,
        countryName: String(
          row?.location_name
          || HAPI_COUNTRY_NAMES.of(countryCode)
          || countryCode,
        ),
        eventsTotal: 0,
        eventsPV: 0,
        eventsCT: 0,
        eventsDem: 0,
        fatalitiesPV: 0,
        fatalitiesCT: 0,
      };
      aggregates.set(countryCode, aggregate);
    }
    if (
      referencePeriod !== aggregate.referencePeriod
      || adminLevel !== aggregate.adminLevel
    ) continue;

    const eventType = String(row?.event_type || '').toLowerCase();
    const events = finiteCount(row?.events);
    const fatalities = finiteCount(row?.fatalities);
    aggregate.eventsTotal += events;
    if (eventType === 'political_violence') {
      aggregate.eventsPV += events;
      aggregate.fatalitiesPV += fatalities;
    } else if (eventType === 'civilian_targeting') {
      aggregate.eventsCT += events;
      aggregate.fatalitiesCT += fatalities;
    } else if (eventType === 'demonstration') {
      aggregate.eventsDem += events;
    }
  }

  const results = {};
  for (const [countryCode, aggregate] of aggregates) {
    results[countryCode] = {
      summary: {
        countryCode,
        countryName: aggregate.countryName,
        conflictEventsTotal: aggregate.eventsTotal,
        conflictPoliticalViolenceEvents: aggregate.eventsPV + aggregate.eventsCT,
        conflictFatalities: aggregate.fatalitiesPV + aggregate.fatalitiesCT,
        referencePeriod: aggregate.referencePeriod,
        conflictDemonstrations: aggregate.eventsDem,
        updatedAt: nowMs,
      },
    };
  }
  return results;
}
