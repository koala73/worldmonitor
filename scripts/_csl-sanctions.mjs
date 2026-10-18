// US Consolidated Screening List (International Trade Administration): parse
// and fetch. Only the six non-Treasury lists are kept; OFAC's own XML already
// supplies the Treasury rows. CSL rows feed screening and the change feed, never
// pressure scores or country counts: export controls are not sanctions pressure.
// Tests import this module, not the seeder (which runs runSeed on load).

import { createRequire } from 'node:module';
import { CHROME_UA } from './_seed-utils.mjs';
import { normalizeName, readResponseLimited } from './_sema-sanctions.mjs';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('./shared/country-name-to-iso2.cjs');

export const CSL_HOST = 'data.trade.gov';
export const CSL_URL = 'https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json';
// The live file is about 34 MB; about 5,000 rows survive the filter.
export const CSL_MAX_BYTES = 64 * 1024 * 1024;
export const CSL_TIMEOUT_MS = 90_000;
// Below this, a download of ~34 MB would only time out; skip it and retain the lists.
const CSL_MIN_BUDGET_MS = 10_000;
const NOTICE_MAX = 200;
const ALIAS_MAX = 10;

// CSL `source` label -> seeder source key. One key per list, so each list gets
// its own health, retention, coverage gap and 5% removal guard.
const CSL_LISTS = {
  'Entity List (EL) - Bureau of Industry and Security': 'CSL-EL',
  'Denied Persons List (DPL) - Bureau of Industry and Security': 'CSL-DPL',
  'Unverified List (UVL) - Bureau of Industry and Security': 'CSL-UVL',
  'Military End User (MEU) List - Bureau of Industry and Security': 'CSL-MEU',
  'ITAR Debarred (DTC) - State Department': 'CSL-DTC',
  'Nonproliferation Sanctions (ACN) - State Department': 'CSL-ACN',
};
export const CSL_SOURCES = Object.values(CSL_LISTS);
export const CSL_ROW_ID = /^[0-9a-f]{32,64}$/;

// A few rows carry the Windows-1252 apostrophe as the C1 control U+0092.
const clean = value => value.replace(/\u0092/g, '’').trim();
const strings = value => (Array.isArray(value) ? value : []).filter(v => typeof v === 'string' && v.trim()).map(clean);
const dayMs = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const iso = us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : text;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
// Spellings in the live file that the shared resolver does not know.
const CSL_COUNTRY_ALIASES = {
  prc: 'CN',
  dprk: 'KP',
  "people's republic of china (prc)": 'CN',
  'crimea (occupied)': 'UA',
};
const countryCode = value => {
  if (typeof value !== 'string') return null;
  const text = clean(value).replace(/’/g, "'");
  if (/^[A-Z]{2}$/.test(text)) return text;
  return CSL_COUNTRY_ALIASES[text.toLowerCase()] ?? countryNameToIso2(text);
};

function cslRecord(row, source) {
  const name = typeof row.name === 'string' ? clean(row.name) : '';
  // EL, DPL, UVL and ACN ids are 56 hex characters; DTC and MEU ids are 32.
  if (!name || typeof row.id !== 'string' || !CSL_ROW_ID.test(row.id)) return null;
  const countryCodes = [...new Set([row.country, ...(Array.isArray(row.addresses) ? row.addresses : []).map(a => a?.country)]
    .map(countryCode).filter(Boolean))];
  const own = normalizeName(name);
  const aliases = [];
  for (const alias of strings(row.alt_names)) {
    const normalized = normalizeName(alias);
    if (normalized && normalized !== own && !aliases.some(a => normalizeName(a) === normalized)) aliases.push(alias);
    if (aliases.length === ALIAS_MAX) break;
  }
  const notice = typeof row.federal_register_notice === 'string' ? clean(row.federal_register_notice) : '';
  return {
    id: `${source}:${row.id}`,
    name,
    entityType: 'SANCTIONS_ENTITY_TYPE_UNSPECIFIED',
    countryCodes,
    countryNames: [],
    programs: strings(row.programs),
    sourceLists: [source],
    effectiveAt: String(dayMs(row.start_date) ?? 0),
    _aliases: aliases,
    _identifiers: [],
    ...(notice ? { _notice: notice.slice(0, NOTICE_MAX) } : {}),
    ...(typeof row.source_list_url === 'string' && row.source_list_url.startsWith('https://') ? { _url: row.source_list_url } : {}),
  };
}

/**
 * Split the bulk download into one record set per kept list. A list absent from
 * a good download reports CSL_LIST_MISSING so it is retained, not emptied.
 * Rows whose end_date has passed (mostly expired Denied Persons orders) are dropped.
 */
export function parseCslPayload(payload, nowMs) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return { lists: {}, error: 'CSL_INVALID_PAYLOAD' };
  }
  const updated = new Map((Array.isArray(payload.sources_used) ? payload.sources_used : [])
    .map(s => [s?.source, Date.parse(s?.source_last_updated)]));
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const records = Object.fromEntries(CSL_SOURCES.map(source => [source, new Map()]));
  for (const row of payload.results) {
    const source = CSL_LISTS[row?.source];
    if (!source) continue;
    const endAt = dayMs(row.end_date);
    if (endAt !== null && endAt < today) continue;
    const record = cslRecord(row, source);
    if (record && !records[source].has(record.id)) records[source].set(record.id, record);
  }
  const lists = {};
  for (const [label, source] of Object.entries(CSL_LISTS)) {
    const rows = [...records[source].values()];
    const publishedAt = updated.get(label);
    lists[source] = rows.length
      ? { records: rows, publishedAt: Number.isSafeInteger(publishedAt) && publishedAt <= nowMs ? publishedAt : 0, error: null }
      : { records: [], publishedAt: 0, error: 'CSL_LIST_MISSING' };
  }
  return { lists, error: null };
}

/** Milliseconds the download may take before `deadlineAt`, or 0 when too little is left. */
export function cslFetchBudget(deadlineAt, nowMs, timeoutMs = CSL_TIMEOUT_MS) {
  const budget = Math.min(timeoutMs, deadlineAt - nowMs);
  return budget >= CSL_MIN_BUDGET_MS ? budget : 0;
}

/**
 * Fetch and parse without throwing; a failed download is an error for every list.
 * `deadlineAt` is the caller's wall-clock limit, so a slow download cannot outlive it.
 */
export async function ingestCslEntries({
  fetchFn = globalThis.fetch,
  now = Date.now(),
  maxBytes = CSL_MAX_BYTES,
  timeoutMs = CSL_TIMEOUT_MS,
  deadlineAt = Infinity,
} = {}) {
  const budget = cslFetchBudget(deadlineAt, Date.now(), timeoutMs);
  if (!budget) return { lists: {}, error: 'CSL_FETCH_DEADLINE' };
  try {
    const response = await fetchFn(CSL_URL, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      redirect: 'error',
      signal: AbortSignal.timeout(budget),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { text } = await readResponseLimited(response, maxBytes);
    return parseCslPayload(JSON.parse(text), now);
  } catch (err) {
    return { lists: {}, error: String(err?.message || err || 'CSL_FETCH_FAILED') };
  }
}
