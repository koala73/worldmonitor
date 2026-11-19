// US restricted-party lists that are not in the Consolidated Screening List:
// DoD Section 1260H Chinese military companies (with their named subsidiaries),
// FAR Section 889 covered telecom companies, the FCC Covered List and the DHS
// UFLPA Entity List. None of them is in the CSL, so most of their names returned
// no screening result.
//
// The rows come from the us-restricted-parties daily release
// (data CC BY 4.0, rebuilt daily from the Federal Register, the eCFR, the FCC
// Covered List page and the DHS UFLPA Entity List; each row keeps its source link).
// Every list file is checked against the sha256 and record count in the same
// release's manifest.json, so a file from a different release, a truncated
// download or an edited file is an ingest failure, not data.
//
// Like the CSL, these rows feed screening and the change feed only, never
// pressure scores or country counts. Tests import this module, not the seeder.

import { createHash } from 'node:crypto';
import { withSourceRequestDiagnostics } from './lib/source-request-diagnostics.mjs';
import { CHROME_UA } from './_seed-utils.mjs';
import { normalizeName, readResponseLimited } from './_sema-sanctions.mjs';

export const URP_RELEASE_URL = 'https://github.com/Mattbusel/us-restricted-parties/releases/latest/download/';
export const URP_MANIFEST_URL = `${URP_RELEASE_URL}manifest.json`;
// Each list file is under 200 KB today; the manifest is about 8 KB.
export const URP_MAX_BYTES = 4 * 1024 * 1024;
// Runs alongside SEMA (45s), so it adds nothing to the fetch phase.
export const URP_TIMEOUT_MS = 30_000;
const URP_MIN_BUDGET_MS = 5_000;
// Release downloads redirect from github.com to GitHub's asset host.
const URP_ASSET_ORIGIN = 'https://release-assets.githubusercontent.com';
const URP_HOSTS = new Set([
  new URL(URP_RELEASE_URL).hostname,
  new URL(URP_ASSET_ORIGIN).hostname,
  'objects.githubusercontent.com',
]);
const URP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const URP_MAX_REDIRECTS = 3;
const NOTICE_MAX = 200;
const ALIAS_MAX = 10;

// manifest list key -> seeder source key. One key per list, so each list gets
// its own health, retention, coverage gap and 5% removal guard. The release also
// carries an interim BIOSECURE file; it repeats 1260H rows, so it is not read.
const URP_LISTS = {
  us_dod_1260h: 'US-1260H',
  us_far_889: 'US-889',
  us_fcc_covered: 'US-FCC',
  us_dhs_uflpa: 'US-UFLPA',
};
export const URP_SOURCES = Object.values(URP_LISTS);
// RECORD_IDs are the list key plus a slug of the name, stable across builds.
export const URP_ROW_ID = /^[a-z0-9_]{1,32}-[a-z0-9-]{1,160}$/;

const text = value => (typeof value === 'string' ? value.trim() : '');
const dayMs = value => {
  const day = text(value);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function urpRecord(row, list, source) {
  const name = text(row?.NAME_ORG);
  const recordId = text(row?.RECORD_ID);
  if (!name || !URP_ROW_ID.test(recordId) || !recordId.startsWith(`${list}-`)) return null;
  const own = normalizeName(name);
  const aliases = [];
  for (const entry of Array.isArray(row.NAMES) ? row.NAMES : []) {
    const alias = entry?.NAME_TYPE === 'ALIAS' ? text(entry.NAME_ORG) : '';
    const normalized = normalizeName(alias);
    if (normalized && normalized !== own && !aliases.some(a => normalizeName(a) === normalized)) aliases.push(alias);
    if (aliases.length === ALIAS_MAX) break;
  }
  // A bare Federal Register document number reads as a citation with its prefix.
  const doc = text(row.SOURCE_DOC);
  const notice = /^\d{4}-\d{4,6}$/.test(doc) ? `FR Doc ${doc}` : doc;
  const url = text(row.SOURCE_URL);
  return {
    id: `${source}:${recordId}`,
    name,
    entityType: row.RECORD_TYPE === 'ORGANIZATION' ? 'SANCTIONS_ENTITY_TYPE_ENTITY' : 'SANCTIONS_ENTITY_TYPE_UNSPECIFIED',
    countryCodes: [],
    countryNames: [],
    programs: [],
    sourceLists: [source],
    effectiveAt: String(dayMs(row.LISTED_ON) ?? 0),
    _aliases: aliases,
    _identifiers: [],
    ...(notice ? { _notice: notice.slice(0, NOTICE_MAX) } : {}),
    ...(url.startsWith('https://') ? { _url: url } : {}),
  };
}

export const sha256Hex = body => createHash('sha256').update(body).digest('hex');

/**
 * Parse one list file against its manifest entry. A hash or count mismatch, or
 * a file with no usable rows, is an error for that list so it is retained.
 */
export function parseUrpList(list, body, entry, nowMs) {
  if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string') return { records: [], publishedAt: 0, error: 'URP_LIST_MISSING' };
  if (sha256Hex(body) !== entry.sha256.toLowerCase()) return { records: [], publishedAt: 0, error: 'URP_HASH_MISMATCH' };
  const source = URP_LISTS[list];
  const records = new Map();
  let lines = 0;
  for (const line of body.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    let row;
    try { row = JSON.parse(line); } catch { return { records: [], publishedAt: 0, error: 'URP_INVALID_ROW' }; }
    const record = urpRecord(row, list, source);
    if (record && !records.has(record.id)) records.set(record.id, record);
  }
  if (!Number.isSafeInteger(entry.records) || entry.records <= 0 || entry.records !== lines) {
    return { records: [], publishedAt: 0, error: 'URP_COUNT_MISMATCH' };
  }
  if (!records.size) return { records: [], publishedAt: 0, error: 'URP_LIST_MISSING' };
  // This timestamp comes from the published build. Unchanged bytes can
  // suppress a release, so its age does not tell us if a later fetch failed.
  const fetchedAt = Date.parse(text(entry.fetched_at));
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > nowMs) {
    return { records: [], publishedAt: 0, error: 'URP_FETCH_UNCONFIRMED' };
  }
  return { records: [...records.values()], publishedAt: fetchedAt, error: null };
}

/** Milliseconds the downloads may take before `deadlineAt`, or 0 when too little is left. */
export function urpFetchBudget(deadlineAt, nowMs, timeoutMs = URP_TIMEOUT_MS) {
  const budget = Math.min(timeoutMs, deadlineAt - nowMs);
  return budget >= URP_MIN_BUDGET_MS ? budget : 0;
}

async function download(fetchFn, url, { accept, signal, maxBytes, observe = () => {} }) {
  let target = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (target.protocol !== 'https:' || !URP_HOSTS.has(target.hostname)) throw new Error('URP_UNEXPECTED_HOST');
    const response = await fetchFn(target.href, { headers: { Accept: accept, 'User-Agent': CHROME_UA }, redirect: 'manual', signal });
    observe(response);
    if (response.ok) {
      const { text: body } = await readResponseLimited(response, maxBytes);
      return Buffer.from(body, 'utf8');
    }
    await response.body?.cancel();
    if (!URP_REDIRECT_STATUSES.has(response.status)) throw new Error(`HTTP ${response.status}`);
    const location = response.headers.get('Location');
    if (!location || hop === URP_MAX_REDIRECTS) throw new Error('URP_INVALID_REDIRECT');
    target = new URL(location, target);
  }
}

/**
 * Fetch the manifest and the four list files without throwing. A failed manifest
 * is an error for every list; a failed list file is an error for that list only.
 */
export async function ingestUsRestrictedEntries({
  fetchFn = globalThis.fetch,
  now = Date.now(),
  maxBytes = URP_MAX_BYTES,
  timeoutMs = URP_TIMEOUT_MS,
  deadlineAt = Infinity,
} = {}) {
  const budget = urpFetchBudget(deadlineAt, Date.now(), timeoutMs);
  if (!budget) return { lists: {}, error: 'URP_FETCH_DEADLINE' };
  try {
    return await withSourceRequestDiagnostics({ source: 'us-restricted-parties' }, async observe => {
      const signal = AbortSignal.timeout(budget);
      const manifest = JSON.parse((await download(fetchFn, URP_MANIFEST_URL,
        { accept: 'application/json', signal, maxBytes, observe })).toString('utf8'));
      if (!manifest || typeof manifest.lists !== 'object' || manifest.lists === null) return { lists: {}, error: 'URP_INVALID_MANIFEST' };
      const results = await Promise.all(Object.entries(URP_LISTS).map(async ([list, source]) => {
        if (Object.hasOwn(manifest.errors ?? {}, list)) {
          return [source, { records: [], publishedAt: 0, error: 'URP_UPSTREAM_FAILED' }];
        }
        const entry = manifest.lists[list];
        const file = typeof entry?.file === 'string' && /^[a-z0-9_]+\.jsonl$/.test(entry.file) ? entry.file : null;
        if (!file) {
          return [source, { records: [], publishedAt: 0, error: 'URP_LIST_MISSING' }];
        }
        try {
          const body = await download(fetchFn, `${URP_RELEASE_URL}${file}`, { accept: 'application/x-ndjson, */*', signal, maxBytes });
          return [source, parseUrpList(list, body, entry, now)];
        } catch {
          return [source, { records: [], publishedAt: 0, error: signal.aborted ? 'URP_FETCH_DEADLINE' : 'URP_FETCH_FAILED' }];
        }
      }));
      return { lists: Object.fromEntries(results), error: null };
    });
  } catch (err) {
    const code = err?.cause?.code;
    const cause = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (cause: ${code})` : '';
    const error = String(err?.message || err || 'URP_FETCH_FAILED')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 512 - cause.length) + cause;
    return { lists: {}, error };
  }
}
