// US Consolidated Screening List (International Trade Administration): parse
// and fetch. Only the six non-Treasury lists are kept; OFAC's own XML already
// supplies the Treasury rows. CSL rows feed screening and the change feed, never
// pressure scores or country counts: export controls are not sanctions pressure.
// Tests import this module, not the seeder (which runs runSeed on load).

import { createRequire } from 'node:module';
import { withSourceRequestDiagnostics } from './lib/source-request-diagnostics.mjs';
import { CHROME_UA } from './_seed-utils.mjs';
import { normalizeName } from './_sema-sanctions.mjs';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('./shared/country-name-to-iso2.cjs');

export const CSL_HOST = 'data.trade.gov';
export const CSL_URL = 'https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.json';
// The live file is about 34 MB once empty address objects are dropped; about
// 5,000 rows survive the filter. The cap applies to that text. The transport cap
// bounds the download itself: since 2026-11-24 one nameless Entity List row has
// carried about a million empty addresses, 79 MB of a 113 MB file.
export const CSL_MAX_BYTES = 64 * 1024 * 1024;
export const CSL_TRANSPORT_MAX_BYTES = 256 * 1024 * 1024;
// An address with every field empty carries nothing. Each one becomes `null`,
// which keeps the JSON valid wherever it sits in the array.
const EMPTY_ADDRESS = /\{"address": ?"", ?"city": ?"", ?"state": ?"", ?"postal_code": ?"", ?"country": ?""\}/g;
// Longer than any match, so a match split across two chunks is still found.
const EMPTY_ADDRESS_CARRY = 96;
export const CSL_TIMEOUT_MS = 90_000;
// Below this, the download (113 MB since 2026-11-24) would only time out; skip it and retain the lists.
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

/**
 * Read the body, dropping empty addresses as it streams. `maxBytes` bounds the
 * text that is kept and parsed; `transportMaxBytes` bounds what is downloaded.
 */
async function readCslText(response, maxBytes, transportMaxBytes) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > transportMaxBytes) {
    try { await response.body?.cancel?.(); } catch { /* still reject */ }
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('CSL_INVALID_PAYLOAD');
  const decoder = new TextDecoder();
  const parts = [];
  let pending = '';
  let downloaded = 0;
  let kept = 0;
  const keep = text => {
    kept += Buffer.byteLength(text, 'utf8');
    if (kept > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    parts.push(text);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > transportMaxBytes) throw new Error('RESPONSE_TOO_LARGE');
      pending = (pending + decoder.decode(value, { stream: true })).replace(EMPTY_ADDRESS, 'null');
      if (pending.length > EMPTY_ADDRESS_CARRY) {
        keep(pending.slice(0, -EMPTY_ADDRESS_CARRY));
        pending = pending.slice(-EMPTY_ADDRESS_CARRY);
      }
    }
    keep((pending + decoder.decode()).replace(EMPTY_ADDRESS, 'null'));
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock?.();
  }
  return parts.join('');
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
  transportMaxBytes = CSL_TRANSPORT_MAX_BYTES,
  timeoutMs = CSL_TIMEOUT_MS,
  deadlineAt = Infinity,
} = {}) {
  const budget = cslFetchBudget(deadlineAt, Date.now(), timeoutMs);
  if (!budget) return { lists: {}, error: 'CSL_FETCH_DEADLINE' };
  try {
    return await withSourceRequestDiagnostics({ source: 'csl' }, async observe => {
      const response = await fetchFn(CSL_URL, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        redirect: 'error',
        signal: AbortSignal.timeout(budget),
      });
      observe(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseCslPayload(JSON.parse(await readCslText(response, maxBytes, transportMaxBytes)), now);
    });
  } catch (err) {
    const code = err?.cause?.code;
    const cause = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (cause: ${code})` : '';
    const error = String(err?.message || err || 'CSL_FETCH_FAILED')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 512 - cause.length) + cause;
    return { lists: {}, error };
  }
}
