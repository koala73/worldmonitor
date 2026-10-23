/**
 * IMD marine bulletins from the public mausam.imd.gov.in pages (#7005, #7730).
 *
 * Not district/nowcast (#7004) and not NDMA SACHET (#7002).
 * Products stay typed. They are not merged into weather:alerts:v1.
 *
 * The IMD API binds each key to one IPv4, which Railway egress cannot satisfy,
 * so cyclone track, wind radii and cone (API-only) stay disabled: GDACS
 * tropical cyclones in seed-natural-events cover the North Indian Ocean.
 * Disabled is not all-clear.
 */

import { CHROME_UA } from '../_seed-utils.mjs';

export const IMD_BULLETIN_HOST = 'mausam.imd.gov.in';
export const IMD_FORECAST_BASE = `https://${IMD_BULLETIN_HOST}/Forecast`;
export const IMD_API_REFERENCE_URL = 'https://api.imd.gov.in/public/api_reference.html';
export const IMD_RSMC_URL = 'https://rsmcnewdelhi.imd.gov.in/';
export const IMD_PORT_WARNING_PAGE = 'https://rsmcnewdelhi.imd.gov.in/port-warning.php';
export const IMD_SEA_BULLETIN_PAGE = 'https://mausam.imd.gov.in/responsive/marine_forecast.php';
export const IMD_COASTAL_BULLETIN_PAGE = 'https://mausam.imd.gov.in/responsive/coastal_forecast.php';
export const IMD_SOURCE_NAME = 'India Meteorological Department';
export const IMD_CANONICAL_KEY = 'weather:imd-cyclone-marine:v1';
export const IMD_SOURCE_VERSION = 'imd-public-bulletins-v1';
export const IMD_MAX_BYTES = 512 * 1024;
export const IMD_TIMEOUT_MS = 15_000;
export const IMD_PAGE_DELAY_MS = 1_000;
// Sea-area bulletins are issued twice a day and coastal bulletins daily.
export const IMD_MAX_CONTENT_AGE_MIN = 36 * 60;
export const IMD_COUNTRY = 'IN';

const MAX_FIELD_CHARS = 4_000;
const MAX_FUTURE_VALIDITY_MS = 12 * 60 * 60 * 1000;
const MAX_FUTURE_ISSUE_MS = 10 * 60 * 1000;

const SEA_AREA_FIELDS = Object.freeze(['wind', 'weather', 'visibility', 'seaCondition']);
const COASTAL_AREA_FIELDS = Object.freeze([...SEA_AREA_FIELDS, 'portSignal', 'stormSurgeWarning']);

/**
 * Bulletin page IDs were read from the index pages on 2026-10-16
 * (tests/fixtures/imd/*-index.html). Unlisted sea-area IDs return the Bay of
 * Bengal bulletin, and NAVTEX copies redirect to a login page.
 */
export const IMD_PRODUCTS = Object.freeze({
  cycloneTrack: Object.freeze({
    id: 'cycloneTrack',
    kind: 'cyclone-track',
    sourceUrl: IMD_RSMC_URL,
    disabledReason: 'API_ONLY_COVERED_BY_GDACS',
  }),
  cycloneWind: Object.freeze({
    id: 'cycloneWind',
    kind: 'cyclone-wind',
    sourceUrl: IMD_RSMC_URL,
    disabledReason: 'API_ONLY_COVERED_BY_GDACS',
  }),
  cycloneCou: Object.freeze({
    id: 'cycloneCou',
    kind: 'cyclone-cone',
    sourceUrl: IMD_RSMC_URL,
    disabledReason: 'API_ONLY_COVERED_BY_GDACS',
  }),
  portWarning: Object.freeze({
    id: 'portWarning',
    kind: 'port-warning',
    sourceUrl: IMD_PORT_WARNING_PAGE,
    disabledReason: 'PDF_ONLY_PORT_SIGNALS_IN_COASTAL_BULLETINS',
  }),
  seaBulletin: Object.freeze({
    id: 'seaBulletin',
    kind: 'sea-area-bulletin',
    sourceUrl: IMD_SEA_BULLETIN_PAGE,
    title: 'Sea Area Bulletin',
    requiresStormWarning: true,
    areaFields: SEA_AREA_FIELDS,
    pages: Object.freeze([
      Object.freeze({ key: 'bay-of-bengal', url: `${IMD_FORECAST_BASE}/seaarea_bulletin_new.php?id=1` }),
      Object.freeze({ key: 'arabian-sea', url: `${IMD_FORECAST_BASE}/seaarea_bulletin_new.php?id=4` }),
    ]),
  }),
  coastalBulletin: Object.freeze({
    id: 'coastalBulletin',
    kind: 'coastal-bulletin',
    sourceUrl: IMD_COASTAL_BULLETIN_PAGE,
    title: 'Coastal Weather Bulletin',
    requiresStormWarning: false,
    areaFields: COASTAL_AREA_FIELDS,
    pages: Object.freeze([
      Object.freeze({ key: 'west-bengal-andaman-nicobar', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php` }),
      Object.freeze({
        key: 'kerala-karnataka-lakshadweep',
        url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=2`,
        fallbackUrl: 'https://mausam.imd.gov.in/thiruvananthapuram/mcdata/coastal%20bulletin.pdf',
      }),
      Object.freeze({ key: 'gujarat', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=3` }),
      Object.freeze({ key: 'maharashtra-goa', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=4` }),
      Object.freeze({ key: 'odisha', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=5` }),
      Object.freeze({ key: 'tamil-nadu', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=6` }),
      Object.freeze({ key: 'andhra-pradesh', url: `${IMD_FORECAST_BASE}/coastal_bulletin_new.php?id=7` }),
    ]),
  }),
  fishermenWarning: Object.freeze({
    id: 'fishermenWarning',
    kind: 'fishermen-warning',
    sourceUrl: IMD_SEA_BULLETIN_PAGE,
    disabledReason: 'PDF_ONLY',
  }),
});

export const IMD_PRODUCT_IDS = Object.freeze(Object.keys(IMD_PRODUCTS));
export const IMD_BULLETIN_PRODUCT_IDS = Object.freeze(IMD_PRODUCT_IDS.filter((id) => IMD_PRODUCTS[id].pages));

// The RTI non-commercial terms cover the public bulletin pages as well as the API.
export const IMD_RIGHTS_DECISION = Object.freeze({
  status: 'reviewed',
  redistribution: 'validated',
  publicDisplay: 'validated',
  retention: 'validated',
  commercialUse: 'rti-non-commercial-only',
  attribution: 'Data source: India Meteorological Department. Link the official product page.',
  references: Object.freeze([
    IMD_API_REFERENCE_URL,
    'https://internal.imd.gov.in/section/rti/rticases/20260112_rti_211.pdf',
  ]),
});

/** Gazetteer precision only, keyed by the area captions IMD prints. Not official IMD polygons. */
export const IMD_AREA_CENTROIDS = Object.freeze({
  'north west bay': [87.0, 19.5],
  'north east bay': [90.5, 19.5],
  'west central bay': [84.5, 16.0],
  'east central bay': [89.0, 16.0],
  'south west bay': [83.0, 11.0],
  'south east bay': [88.5, 11.0],
  'north andaman sea': [95.5, 13.0],
  'south andaman sea': [96.0, 8.5],
  'north west arabian sea': [62.0, 20.0],
  'north east arabian sea': [67.5, 20.5],
  'west central arabian sea': [60.0, 15.0],
  'east central arabian sea': [68.0, 15.0],
  'south west arabian sea': [58.0, 8.5],
  'south east arabian sea': [70.0, 9.0],
  'lakshadweep area': [72.8, 10.5],
  'maldives area': [73.3, 3.5],
  'andaman area': [92.7, 11.7],
  'west bengal coast': [88.2, 21.7],
  'karnataka coast': [74.6, 13.8],
  'north kerala coast': [75.6, 11.5],
  'south kerala coast': [76.4, 9.3],
  'north gujrath coast': [69.5, 22.6],
  'south gujrath coast': [71.0, 20.9],
  'north maharashtra coast': [72.8, 19.0],
  'south maharashtra and goa coast': [73.6, 16.0],
  'north odisha coast': [86.9, 20.7],
  'south odisha coast': [85.0, 19.4],
  'north tamilnadu coast': [80.2, 12.5],
  'south tamilnadu coast': [78.8, 9.0],
  'north andhra coast': [83.3, 17.7],
  'south andhra coast': [80.5, 15.5],
});

const NIL_PHRASES = new Set([
  '', '-', 'nil', 'nil at all ports', 'nil at all port', 'n/a', 'na', 'none', 'no warning', 'no storm warning',
]);

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s.]+$/, '');
}

export function isNilText(value) {
  return NIL_PHRASES.has(normalizeLabel(value));
}

export function lookupAreaCentroid(name) {
  return IMD_AREA_CENTROIDS[normalizeLabel(name)] || null;
}

export function isAllowedImdUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === IMD_BULLETIN_HOST
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function slug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlText(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Comments and script/style blocks never carry bulletin text. They are cut
// with an index scan instead of a one-pass regex replace: each cut re-checks
// the seam, so nested input like `<scr<script></script>ipt>` cannot rebuild a
// block, and an unterminated block drops everything after it, as a browser would.
const NON_CONTENT_BLOCKS = Object.freeze([
  Object.freeze({ open: '<!--', close: '-->', tag: false }),
  Object.freeze({ open: '<script', close: '</script>', tag: true }),
  Object.freeze({ open: '<style', close: '</style>', tag: true }),
]);
const LONGEST_BLOCK_OPEN = Math.max(...NON_CONTENT_BLOCKS.map((block) => block.open.length));

// ASCII-only lowercasing keeps every index aligned with the original string.
function asciiLower(text) {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function firstNonContentBlock(lower, from) {
  let first = null;
  for (const block of NON_CONTENT_BLOCKS) {
    let at = lower.indexOf(block.open, from);
    while (at !== -1 && block.tag && /\w/.test(lower[at + block.open.length] ?? '')) {
      at = lower.indexOf(block.open, at + 1);
    }
    if (at !== -1 && (!first || at < first.at)) first = { at, block };
  }
  return first;
}

export function stripNonContentBlocks(html) {
  let text = String(html || '');
  let from = 0;
  for (;;) {
    const lower = asciiLower(text);
    const hit = firstNonContentBlock(lower, from);
    if (!hit) return text;
    const closeAt = lower.indexOf(hit.block.close, hit.at + hit.block.open.length);
    const end = closeAt === -1 ? text.length : closeAt + hit.block.close.length;
    text = text.slice(0, hit.at) + text.slice(end);
    // Only an opener that straddles the cut can be new; rescan from just before it.
    from = Math.max(0, hit.at - LONGEST_BLOCK_OPEN);
  }
}

class ImdBulletinParseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ImdBulletinParseError(code);
}

function boundedText(value) {
  if (value.length > MAX_FIELD_CHARS) fail('BULLETIN_FIELD_TOO_LONG');
  return value;
}

function utcHourOf(date, hour) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const h = Number(hour);
  if (!match || !Number.isInteger(h) || h < 0 || h > 23) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day, h);
  const check = new Date(ms);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? ms : null;
}

function parseValidity(headerText) {
  const match = headerText.match(
    /Valid\s+for\s+(\d{1,2})\s*hrs?\s+from\s+(\d{1,2})\s*UTC\s+of\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{1,2})\s*UTC\s+of\s+(\d{4}-\d{2}-\d{2})/i,
  );
  if (!match) fail('BULLETIN_VALIDITY_MISSING');
  const validityHours = Number(match[1]);
  const validFrom = utcHourOf(match[3], match[2]);
  const validUntil = utcHourOf(match[5], match[4]);
  if (validFrom == null || validUntil == null || validityHours < 1 || validityHours > 48
    || validUntil - validFrom !== validityHours * 60 * 60 * 1000) {
    fail('BULLETIN_VALIDITY_INCONSISTENT');
  }
  return { validFrom, validUntil, validityHours };
}

function parseIssueTime(value) {
  const match = value.match(/^(\d{1,2}):(\d{2})\s*IST\s+of\s+(\d{4})-(\d{2})-(\d{2})$/i);
  if (!match) fail('BULLETIN_ISSUE_TIME_MISSING');
  const ms = Date.parse(`${match[3]}-${match[4]}-${match[5]}T${match[1].padStart(2, '0')}:${match[2]}:00+05:30`);
  if (!Number.isFinite(ms)) fail('BULLETIN_ISSUE_TIME_MISSING');
  return ms;
}

const BULLETIN_LABELS = Object.freeze({
  'ttt warning': 'stormWarning',
  'synoptic situation': 'synopticSituation',
  'time of issue': 'timeOfIssue',
});

const AREA_LABELS = Object.freeze({
  wind: 'wind',
  weather: 'weather',
  visibility: 'visibility',
  'sea condition': 'seaCondition',
  'port signal': 'portSignal',
  'storm surge/tidal warning': 'stormSurgeWarning',
});

function tableRows(tableHtml) {
  const rows = [];
  for (const row of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => htmlText(cell[1]));
    if (cells.length >= 2) rows.push([normalizeLabel(cells[0]), boundedText(cells[1])]);
  }
  return rows;
}

/**
 * Parse one public IMD sea-area or coastal bulletin page. Throws an error whose
 * `code` names the first structural check that failed, so a changed layout
 * fails closed instead of publishing partial fields.
 */
export function parseImdBulletinHtml(html, productId) {
  const spec = IMD_PRODUCTS[productId];
  if (!spec?.pages) throw new Error(`UNKNOWN_IMD_BULLETIN_PRODUCT:${productId}`);
  const body = stripNonContentBlocks(html);
  const firstTable = body.search(/<table\b/i);
  if (firstTable === -1) fail('BULLETIN_AREAS_MISSING');
  const headerText = htmlText(body.slice(0, firstTable));
  if (!headerText.toLowerCase().includes(spec.title.toLowerCase())) fail('BULLETIN_TITLE_MISSING');
  const validity = parseValidity(headerText);
  const office = headerText.match(/\b(A?CWC(?:\s+[A-Z]+)+)\s*\//);

  const bulletin = {};
  const areas = [];
  for (const table of body.slice(firstTable).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (/<table\b/i.test(table[1])) fail('BULLETIN_NESTED_TABLE');
    const caption = table[1].match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    const rows = tableRows(table[1]);
    if (caption) {
      const area = { name: boundedText(htmlText(caption[1])) };
      for (const [label, value] of rows) {
        if (AREA_LABELS[label]) area[AREA_LABELS[label]] = value;
      }
      areas.push(area);
      continue;
    }
    for (const [label, value] of rows) {
      if (BULLETIN_LABELS[label]) bulletin[BULLETIN_LABELS[label]] = value;
    }
  }

  if (areas.length === 0) fail('BULLETIN_AREAS_MISSING');
  for (const area of areas) {
    if (!area.name || spec.areaFields.some((field) => !area[field])) fail('BULLETIN_AREA_INCOMPLETE');
  }
  if (spec.requiresStormWarning && !bulletin.stormWarning) fail('BULLETIN_STORM_WARNING_MISSING');
  if (!bulletin.synopticSituation) fail('BULLETIN_SYNOPTIC_MISSING');
  if (!office) fail('BULLETIN_OFFICE_MISSING');
  const issuedAt = parseIssueTime(bulletin.timeOfIssue || '');

  return {
    issuedBy: office[1],
    issuedAt,
    ...validity,
    stormWarning: bulletin.stormWarning || '',
    synopticSituation: bulletin.synopticSituation,
    areas,
  };
}

const KERALA_COASTAL_AREAS = Object.freeze([
  'Karnataka coast', 'North Kerala coast', 'South Kerala coast', 'Lakshadweep area',
]);

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseImdKeralaPdfText(text) {
  if (text.length > 64_000) fail('BULLETIN_RESPONSE_TOO_LARGE');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstArea = lines.indexOf(KERALA_COASTAL_AREAS[0]);
  if (firstArea < 0) fail('BULLETIN_AREAS_MISSING');
  const header = lines.slice(0, firstArea).join(' ');
  if (!/\bCWC THIRUVANANTHAPURAM\s*\//.test(header)) fail('BULLETIN_OFFICE_MISSING');
  const synoptic = header.match(/\bSynoptic Situation\s*(.*)$/i)?.[1] || '';
  const issueIndex = lines.findIndex((line, index) => index > firstArea && /^Time of Issue\b/i.test(line));
  if (issueIndex < 0) fail('BULLETIN_ISSUE_TIME_MISSING');
  const issue = lines.slice(issueIndex).join(' ').replace(/^Time of Issue\s*/i, '');
  const tables = [];
  let cursor = firstArea;
  for (const area of KERALA_COASTAL_AREAS) {
    if (lines[cursor] !== area) fail('BULLETIN_AREAS_MISSING');
    cursor++;
    const fields = new Map();
    let label;
    while (cursor < issueIndex && !KERALA_COASTAL_AREAS.includes(lines[cursor])) {
      const line = lines[cursor++];
      if (/^[A-Za-z -]+(?: coast| area)$/i.test(line)) fail('BULLETIN_AREAS_MISSING');
      const field = line.match(/^(Storm Surge\/Tidal Warning|Sea Condition|Port Signal|Visibility|Weather|Wind)(?:\s+|$)(.*)$/i);
      if (field) {
        label = normalizeLabel(field[1]);
        if (fields.has(label)) fail('BULLETIN_AREA_INCOMPLETE');
        fields.set(label, field[2]);
      } else {
        if (!label) fail('BULLETIN_AREA_INCOMPLETE');
        fields.set(label, `${fields.get(label)} ${line}`);
      }
    }
    tables.push(`<table><caption>${escapeHtml(area)}</caption>${[...fields].map(([key, value]) =>
      `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>`);
  }
  if (cursor !== issueIndex) fail('BULLETIN_AREAS_MISSING');
  const metadata = `<table><tr><td>Synoptic Situation</td><td>${escapeHtml(synoptic)}</td></tr>`
    + `<tr><td>Time of Issue</td><td>${escapeHtml(issue)}</td></tr></table>`;
  return parseImdBulletinHtml(`<div>${escapeHtml(header)}</div>${metadata}${tables.join('')}`, 'coastalBulletin');
}

async function parseImdKeralaPdf(bytes) {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') fail('BULLETIN_PDF_INVALID');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages !== 1) fail('BULLETIN_PDF_PAGE_COUNT');
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('');
    return parseImdKeralaPdfText(text);
  } finally {
    await task.destroy();
  }
}

function compactUtcHour(ms) {
  return new Date(ms).toISOString().slice(0, 13).replace(/\D/g, '');
}

export function bulletinRecords(bulletin, productId, page) {
  const spec = IMD_PRODUCTS[productId];
  const hasTttWarning = !isNilText(bulletin.stormWarning);
  return bulletin.areas.map((area) => {
    const centroid = lookupAreaCentroid(area.name);
    const portSignal = area.portSignal || null;
    const stormSurgeWarning = area.stormSurgeWarning || null;
    return {
      product: productId,
      kind: spec.kind,
      id: `imd-${productId}-${page.key}-${slug(area.name)}-${compactUtcHour(bulletin.validFrom)}`,
      page: page.key,
      area: area.name,
      issuedBy: bulletin.issuedBy,
      issuedAt: bulletin.issuedAt,
      validFrom: bulletin.validFrom,
      validityHours: bulletin.validityHours,
      expiresAt: bulletin.validUntil,
      tttWarning: bulletin.stormWarning,
      hasTttWarning,
      wind: area.wind,
      visibility: area.visibility,
      seaCondition: area.seaCondition,
      weather: area.weather,
      synopticSituation: bulletin.synopticSituation,
      portSignal,
      hasPortSignal: portSignal != null && !isNilText(portSignal),
      stormSurgeWarning,
      hasStormSurgeWarning: stormSurgeWarning != null && !isNilText(stormSurgeWarning),
      isForecastBulletin: true,
      centroid,
      lon: centroid ? centroid[0] : null,
      lat: centroid ? centroid[1] : null,
      countryCode: IMD_COUNTRY,
      sourceName: IMD_SOURCE_NAME,
      sourceUrl: page.url,
      source: `imd-${spec.kind}`,
    };
  });
}

export function dropExpiredRecords(records, nowMs = Date.now()) {
  const horizon = nowMs - IMD_MAX_CONTENT_AGE_MIN * 60 * 1000;
  return (records || []).filter((record) => Number.isFinite(record?.expiresAt)
    && record.expiresAt > nowMs
    && Number.isFinite(record.issuedAt)
    && record.issuedAt >= horizon);
}

function isWarningRecord(record) {
  return record.hasTttWarning || record.hasPortSignal || record.hasStormSurgeWarning;
}

function isFutureDated(bulletin, now) {
  return bulletin.validFrom > now + MAX_FUTURE_VALIDITY_MS || bulletin.issuedAt > now + MAX_FUTURE_ISSUE_MS;
}

/**
 * Classify one page at `now`. A bulletin whose window has ended is `expired`:
 * IMD replied and the page parsed, but nothing on it is current.
 */
function evaluatePage(productId, page, result, previousRecords, now) {
  const failure = result?.status !== 'parsed' ? result?.reason || 'FETCH_FAILED'
    : isFutureDated(result.bulletin, now) ? 'BULLETIN_FUTURE_DATED' : null;
  if (!failure) {
    const { bulletin } = result;
    const timing = { issuedAt: bulletin.issuedAt, validFrom: bulletin.validFrom, validUntil: bulletin.validUntil };
    const source = result.fallbackUsed
      ? { fallbackUsed: true, primaryFailure: result.primaryFailure, sourceUrl: result.sourceUrl } : {};
    if (bulletin.validUntil <= now) {
      return { health: { status: 'expired', reason: null, ...timing, ...source }, records: [], carried: false };
    }
    return {
      health: { status: 'ok', reason: null, ...timing, ...source },
      records: dropExpiredRecords(bulletinRecords(bulletin, productId, { ...page, url: result.sourceUrl || page.url }), now),
      carried: false,
    };
  }
  const carried = dropExpiredRecords(previousRecords.filter((record) => record?.page === page.key), now);
  return {
    health: { status: 'failed', reason: failure, ...(result?.fallbackFailure ? { fallbackFailure: result.fallbackFailure } : {}) },
    records: carried,
    carried: carried.length > 0,
  };
}

function productStatus(pageHealth) {
  const statuses = Object.values(pageHealth).map((page) => page.status);
  if (statuses.every((status) => status !== 'failed')) return 'ok';
  return statuses.some((status) => status !== 'failed') ? 'partial' : 'failed';
}

function disabledProductHealth(spec) {
  return {
    status: 'disabled',
    reason: spec.disabledReason,
    recordCount: 0,
    warningCount: 0,
    carried: false,
    requestCount: 0,
    emptyMeans: null,
  };
}

const PREVIOUS_LIST = Object.freeze({ seaBulletin: 'seaBulletins', coastalBulletin: 'coastalBulletins' });

/**
 * Build the cache envelope from per-page results:
 * `pageResults[productId][pageKey]` is `{ status: 'parsed', bulletin }` or
 * `{ status: 'failed', reason }`. A failed page carries its own last-good
 * records from `previous`; other pages are unaffected.
 */
export function assembleImdSnapshot({ pageResults = {}, previous = null, now = Date.now() } = {}) {
  const products = {};
  const failedProducts = [];
  const lists = { seaBulletins: [], coastalBulletins: [] };

  for (const id of IMD_PRODUCT_IDS) {
    const spec = IMD_PRODUCTS[id];
    if (!spec.pages) {
      products[id] = disabledProductHealth(spec);
      continue;
    }
    const previousRecords = Array.isArray(previous?.[PREVIOUS_LIST[id]]) ? previous[PREVIOUS_LIST[id]] : [];
    const pages = {};
    const records = [];
    let carried = false;
    let requestCount = spec.pages.length;
    for (const page of spec.pages) {
      const result = pageResults[id]?.[page.key];
      if (result?.fallbackUsed || result?.fallbackFailure) requestCount++;
      const evaluated = evaluatePage(id, page, result, previousRecords, now);
      pages[page.key] = evaluated.health;
      records.push(...evaluated.records);
      carried ||= evaluated.carried;
    }
    const status = productStatus(pages);
    if (status !== 'ok') failedProducts.push(id);
    lists[PREVIOUS_LIST[id]] = records;
    products[id] = {
      status,
      reason: status === 'ok' ? null : 'BULLETIN_PAGE_FAILED',
      recordCount: records.length,
      warningCount: records.filter(isWarningRecord).length,
      carried,
      requestCount,
      emptyMeans: status === 'ok' && records.length === 0 ? 'no-current-bulletin' : null,
      pages,
    };
  }

  const pageStatuses = IMD_BULLETIN_PRODUCT_IDS.flatMap((id) => Object.values(products[id].pages).map((page) => page.status));
  let coverageState = 'ok';
  if (pageStatuses.every((status) => status === 'failed')) coverageState = 'unavailable';
  else if (failedProducts.length > 0) coverageState = 'degraded';

  const snapshot = {
    coverageState,
    skipReason: coverageState === 'ok' ? null : failedProducts.join(','),
    rights: { ...IMD_RIGHTS_DECISION },
    generatedAt: now,
    products,
    cyclones: [],
    windRadii: [],
    cones: [],
    portWarnings: [],
    seaBulletins: lists.seaBulletins,
    coastalBulletins: lists.coastalBulletins,
    fishermenWarnings: [],
    records: [...lists.seaBulletins, ...lists.coastalBulletins],
    failedProducts,
    sourceName: IMD_SOURCE_NAME,
    sourceUrl: IMD_SEA_BULLETIN_PAGE,
    attribution: IMD_RIGHTS_DECISION.attribution,
  };
  return {
    ...snapshot,
    cycloneEvents: [],
    portAlerts: [],
    marineBulletins: marineBulletinsFromSnapshot(snapshot),
  };
}

async function readBoundedBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail('BULLETIN_RESPONSE_TOO_LARGE');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = typeof response.arrayBuffer === 'function'
      ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
    if (bytes.length > maxBytes) fail('BULLETIN_RESPONSE_TOO_LARGE');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      fail('BULLETIN_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function pageFailureReason(err) {
  if (err instanceof ImdBulletinParseError) return err.code;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'IMD_FETCH_TIMEOUT';
  if (/^HTTP \d{3}$/.test(String(err?.message || ''))) return err.message;
  return 'IMD_FETCH_FAILED';
}

export async function fetchImdBulletinPage(productId, page, {
  fetchFn = globalThis.fetch,
  userAgent = CHROME_UA,
  maxBytes = IMD_MAX_BYTES,
  timeoutMs = IMD_TIMEOUT_MS,
  delayMs = IMD_PAGE_DELAY_MS,
  sleep = defaultSleep,
} = {}) {
  if (!isAllowedImdUrl(page.url)) return { status: 'failed', reason: 'UNTRUSTED_SOURCE_HOST' };
  try {
    const response = await fetchFn(page.url, {
      headers: { Accept: 'text/html', 'User-Agent': userAgent },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = new TextDecoder('utf-8').decode(await readBoundedBytes(response, maxBytes));
    return { status: 'parsed', bulletin: parseImdBulletinHtml(html, productId) };
  } catch (err) {
    const primary = { status: 'failed', reason: pageFailureReason(err) };
    const registered = IMD_PRODUCTS[productId]?.pages?.find((entry) => entry.key === page.key && entry.url === page.url);
    if (!registered?.fallbackUrl || !isAllowedImdUrl(registered.fallbackUrl)) return primary;
    try {
      await sleep(delayMs);
      const response = await fetchFn(registered.fallbackUrl, {
        headers: { Accept: 'application/pdf', 'User-Agent': userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!/^application\/pdf(?:;|$)/i.test(response.headers?.get?.('content-type') || '')) fail('BULLETIN_PDF_INVALID');
      const bulletin = await parseImdKeralaPdf(await readBoundedBytes(response, maxBytes));
      return { status: 'parsed', bulletin, sourceUrl: registered.fallbackUrl, fallbackUsed: true, primaryFailure: primary.reason };
    } catch (fallbackError) {
      return { ...primary, fallbackFailure: pageFailureReason(fallbackError) };
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function fetchImdCycloneMarine({
  fetchFn = globalThis.fetch,
  previous = null,
  now = Date.now(),
  userAgent = CHROME_UA,
  delayMs = IMD_PAGE_DELAY_MS,
  sleep = defaultSleep,
} = {}) {
  const pageResults = {};
  let first = true;
  for (const id of IMD_BULLETIN_PRODUCT_IDS) {
    pageResults[id] = {};
    for (const page of IMD_PRODUCTS[id].pages) {
      if (!first) await sleep(delayMs);
      first = false;
      pageResults[id][page.key] = await fetchImdBulletinPage(id, page, { fetchFn, userAgent, delayMs, sleep });
    }
  }
  return assembleImdSnapshot({ pageResults, previous, now });
}

const WARNING_FIELDS = Object.freeze([
  Object.freeze({ flag: 'hasTttWarning', text: 'tttWarning', label: 'TTT' }),
  Object.freeze({ flag: 'hasPortSignal', text: 'portSignal', label: 'Port signal' }),
  Object.freeze({ flag: 'hasStormSurgeWarning', text: 'stormSurgeWarning', label: 'Storm surge/tidal' }),
]);

function activeWarnings(record) {
  return WARNING_FIELDS.filter((field) => record[field.flag]);
}

function marineSeverity(record) {
  if (record.hasTttWarning || record.hasPortSignal) return 'Severe';
  if (record.hasStormSurgeWarning) return 'Moderate';
  return 'Minor';
}

export function marineBulletinsFromSnapshot(snapshot) {
  return [...(snapshot?.seaBulletins || []), ...(snapshot?.coastalBulletins || [])].map((row) => {
    const warnings = activeWarnings(row);
    return {
      id: row.id,
      event: row.kind === 'coastal-bulletin' ? 'IMD Coastal Bulletin' : 'IMD Sea Area Bulletin',
      severity: marineSeverity(row),
      headline: `${row.area}: ${warnings.length > 0
        ? `${warnings[0].label}: ${row[warnings[0].text]}`
        : (row.weather || row.seaCondition || 'Marine bulletin')}`,
      description: [
        warnings.length > 1 && `Active: ${warnings.map((field) => field.label).join(', ')}`,
        ...warnings.map((field) => `${field.label}: ${row[field.text]}`),
        warnings.length > 0 && row.weather && `Weather: ${row.weather}`,
        row.wind && `Wind: ${row.wind}`,
        row.visibility && `Visibility: ${row.visibility}`,
        row.seaCondition && `Sea: ${row.seaCondition}`,
      ].filter(Boolean).join(' · '),
      areaDesc: row.area,
      onset: row.validFrom,
      expires: row.expiresAt,
      coordinates: row.centroid ? [row.centroid] : [],
      centroid: row.centroid || undefined,
      countryCode: IMD_COUNTRY,
      source: row.source,
      productKind: row.kind,
      issuedBy: row.issuedBy,
      wind: row.wind,
      visibility: row.visibility,
      seaState: row.seaCondition,
      sourceUrl: row.sourceUrl,
      geometryPrecision: row.centroid ? 'point' : undefined,
      isForecastBulletin: true,
    };
  });
}

function validBulletinRecord(row) {
  return row && typeof row === 'object'
    && typeof row.id === 'string' && row.id
    && typeof row.area === 'string' && row.area
    && Number.isFinite(row.validFrom) && Number.isFinite(row.expiresAt) && row.expiresAt > row.validFrom
    && Number.isFinite(row.issuedAt);
}

export function validateImdEnvelope(data) {
  if (!data || typeof data !== 'object') return false;
  for (const key of ['cyclones', 'windRadii', 'cones', 'portWarnings', 'seaBulletins', 'coastalBulletins',
    'cycloneEvents', 'portAlerts', 'marineBulletins']) {
    if (!Array.isArray(data[key])) return false;
  }
  if (!data.products || typeof data.products !== 'object') return false;
  for (const id of IMD_PRODUCT_IDS) {
    if (!data.products[id] || typeof data.products[id].status !== 'string') return false;
  }
  return [...data.seaBulletins, ...data.coastalBulletins].every(validBulletinRecord);
}

export function declareImdRecords(data) {
  if (!data || typeof data !== 'object') return 0;
  return (data.seaBulletins?.length || 0) + (data.coastalBulletins?.length || 0);
}

function parsedPages(data) {
  return IMD_BULLETIN_PRODUCT_IDS.flatMap((id) => Object.values(data?.products?.[id]?.pages || {}))
    .filter((page) => page.status === 'ok' || page.status === 'expired');
}

/**
 * Activation proves this deployment parsed at least one bulletin page from
 * IMD in this run. An expired page counts; carried last-good records do not.
 */
export function shouldActivateImdSnapshot(data) {
  return parsedPages(data).length > 0;
}

/** Content age is the age of IMD's newest parsed or served bulletin, by its time of issue. */
export function imdContentMeta(data, nowMs = Date.now()) {
  const stamps = [
    ...parsedPages(data).map((page) => page.issuedAt),
    ...(data?.seaBulletins || []).map((row) => row?.issuedAt),
    ...(data?.coastalBulletins || []).map((row) => row?.issuedAt),
  ].filter((value) => Number.isFinite(value) && value > 0 && value <= nowMs);
  if (stamps.length === 0) return null;
  return { newestItemAt: Math.max(...stamps), oldestItemAt: Math.min(...stamps) };
}

export function imdAfterPublish(data) {
  if (data?.coverageState === 'degraded' || data?.coverageState === 'unavailable') {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: data.coverageState === 'degraded' ? 'IMD_PRODUCT_PARTIAL' : 'IMD_PRODUCTS_UNAVAILABLE',
        failedProducts: data.failedProducts,
        coverageState: data.coverageState,
      },
    };
  }
  return { freshnessMetaPatch: { sourceState: 'ok', coverageState: 'ok' } };
}
