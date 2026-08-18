// Global Affairs Canada SEMA consolidated sanctions: parse, identity, fetch.
// Tests import this module, not the seeder (which runs runSeed on load).

import { createRequire } from 'node:module';
import { CHROME_UA } from './_seed-utils.mjs';
import { decodeHtmlEntities } from './_html-entities.mjs';
import { DAY_MIN, periodTokenToMs } from './_content-age-helpers.mjs';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('./shared/country-name-to-iso2.cjs');

export const SEMA_SOURCE = 'sema-ca';
export const SEMA_HOST = 'www.international.gc.ca';
export const SEMA_XML_URL = 'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml';
export const SEMA_CACHE_KEY = SEMA_XML_URL;
// Live list is ~1.7 MB. Raise the ceiling deliberately (4–8 MB).
export const SEMA_MAX_BYTES = 8 * 1024 * 1024;
export const SEMA_TIMEOUT_MS = 45_000;
export const SEMA_PROGRAM = 'SEMA';
export const SANCTIONS_SOURCE_VERSION = 'ofac-sls-advanced-xml+sema-ca-v3';
// List publication can sit days-to-weeks between designation batches.
export const SANCTIONS_MAX_CONTENT_AGE_MIN = 30 * DAY_MIN;

const CLOCK_SKEW_MS = 60 * 60 * 1000;

function xmlText(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return decodeHtmlEntities(match[1])
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export function englishCountryLabel(raw) {
  return String(raw || '').split(/\s*\/\s*/)[0].trim();
}

export function countryFromSemaLabel(raw) {
  const english = englishCountryLabel(raw);
  if (!english) return { code: '', name: '' };
  const code = countryNameToIso2(english) || '';
  return { code, name: english };
}

/** SEMA <Country> is the regulating schedule, not a person's nationality. */
export function regimeLabel(raw) {
  const english = englishCountryLabel(raw);
  if (/jvcfor|jvcfoa|justice for victims/i.test(english)) return 'JVCFOR';
  if (/^hamas/i.test(english)) return 'Hamas';
  if (/settler/i.test(english)) return 'Settler';
  return english;
}

/** Map the SEMA Country field onto a program code. JVCFOR/Hamas/Settler are not SEMA. */
export function programFromSemaCountry(raw) {
  const english = englishCountryLabel(raw);
  const token = normalizeName(english);
  if (!token) return SEMA_PROGRAM;
  if (token.includes('jvcfor') || token.includes('jvcfoa') || token.includes('justice for victims')) {
    return 'JVCFOR';
  }
  if (token.startsWith('hamas')) return 'HAMAS';
  if (token.includes('settler')) return 'SETTLER';
  return SEMA_PROGRAM;
}

/** Initials and leftover Latin-i crumbs from Cyrillic aliases are not identity. */
export function isWeakNameToken(token) {
  const normalized = String(token || '');
  return normalized.length <= 2 || /^i( i)*$/i.test(normalized);
}

/**
 * A single word is not enough evidence to fuse two designations from DIFFERENT
 * source lists. `splitAliases` splits on commas, so "Smith, John" yields the bare
 * tokens "Smith" and "John" — matching those against ~20k OFAC rows produced
 * false merges, and a false merge DELETES a row from a legal list. Requiring two
 * or more words keeps the real signal ("Acme Ltd", "AI Alliance Russia") and
 * drops the noise.
 */
export function isCorroboratingNameToken(token) {
  const normalized = String(token || '').trim();
  return normalized.includes(' ');
}

export function splitAliases(raw) {
  return uniqueSorted(
    String(raw || '')
      .split(/\s*(?:;|\||(?:\s+or\s+))\s*/i)
      .flatMap((part) => part.split(/\s*,\s*/))
      .map((part) => part.replace(/^(?:Belarusian|Belarussian|Russian|Ukrainian|French|Arabic)\s*:\s*/i, '').trim())
      .filter((part) => part.length > 1 && !isWeakNameToken(normalizeName(part))),
  );
}

export function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/["'«»`]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeIdentifier(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

export function slugToken(value, fallback = 'unspecified') {
  return normalizeName(value).replace(/\s+/g, '-') || fallback;
}

/** Schedule restarts Item per part, so the id must include Schedule. */
export function semaRecordId(regimeRaw, scheduleRaw, itemRaw) {
  const regime = slugToken(englishCountryLabel(regimeRaw) || 'unspecified', 'xx');
  const schedule = slugToken(scheduleRaw, 'unspecified');
  const item = String(itemRaw || '0').trim() || '0';
  return `${SEMA_SOURCE}:${regime}:${schedule}:${item}`;
}

/** Map an OFAC IDRegDocument / Feature registration onto the shared identifier space. */
export function ofacRegistrationToIdentifier(typeName, rawNumber) {
  const type = String(typeName || '');
  const raw = String(rawNumber || '').trim();
  if (!raw) return '';
  if (/imo|vessel registration/i.test(type) || /^IMO\b/i.test(raw)) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 8) return `imo:${digits}`;
  }
  return '';
}

export function identityOf(entry) {
  const names = new Set();
  const ids = new Set();
  const legal = normalizeName(entry?.name);
  if (legal && !isWeakNameToken(legal)) names.add(legal);
  for (const alias of entry?._aliases || []) {
    const token = normalizeName(alias);
    if (token && !isWeakNameToken(token)) names.add(token);
  }
  for (const id of entry?._identifiers || []) {
    const token = normalizeIdentifier(id);
    if (token) ids.add(token);
  }
  return { legal, names, ids };
}

/**
 * Identity is legal name + aliases + identifiers.
 * Unique-name equality is not sufficient when identifiers conflict,
 * and is not required when an alias or identifier overlaps.
 */
export function sameSanctionIdentity(left, right) {
  const a = identityOf(left);
  const b = identityOf(right);
  for (const id of a.ids) {
    if (b.ids.has(id)) return true;
  }
  if (a.ids.size > 0 && b.ids.size > 0) return false;
  for (const name of a.names) {
    if (b.names.has(name)) return true;
  }
  return false;
}

function listingEpoch(dateText) {
  const ms = periodTokenToMs(dateText);
  return ms && ms > 0 ? ms : 0;
}

function compactNote(value) {
  const note = String(value || '').replace(/\s+/g, ' ').trim();
  if (!note) return '';
  return note.length > 240 ? `${note.slice(0, 237)}...` : note;
}

export function recordToCanonical(block) {
  const countryRaw = xmlText(block, 'Country');
  const regime = regimeLabel(countryRaw);
  const program = programFromSemaCountry(countryRaw);
  const lastName = xmlText(block, 'LastName');
  const givenName = xmlText(block, 'GivenName');
  const entityOrShip = xmlText(block, 'EntityOrShip');
  const imo = xmlText(block, 'ShipIMONumber').replace(/\D/g, '');
  const aliases = splitAliases(xmlText(block, 'Aliases'));
  const item = xmlText(block, 'Item') || '0';
  const listed = xmlText(block, 'DateOfListing');
  const schedule = xmlText(block, 'Schedule');
  const title = xmlText(block, 'TitleOrShip');

  const legalName = entityOrShip || [givenName, lastName].filter(Boolean).join(' ').trim();
  if (!legalName) return null;

  let entityType = 'SANCTIONS_ENTITY_TYPE_ENTITY';
  if (imo) entityType = 'SANCTIONS_ENTITY_TYPE_VESSEL';
  else if (lastName || givenName) entityType = 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL';

  const identifiers = [];
  if (imo) identifiers.push(`imo:${imo}`);

  const id = semaRecordId(countryRaw, schedule, item);

  return {
    id,
    name: legalName,
    entityType,
    countryCodes: [],
    countryNames: [],
    programs: [program],
    sourceLists: [SEMA_SOURCE],
    effectiveAt: String(listingEpoch(listed)),
    isNew: false,
    note: compactNote([regime, schedule && `Schedule ${schedule}`, title].filter(Boolean).join(' · ')),
    _regime: regime,
    _aliases: aliases.filter((alias) => normalizeName(alias) !== normalizeName(legalName)),
    _identifiers: identifiers,
    _publishedAt: listed,
  };
}

export function parseSemaXml(xml) {
  const records = [];
  const blocks = String(xml || '').match(/<record\b[\s\S]*?<\/record>/gi) || [];
  let newest = 0;
  let oldest = Infinity;
  for (const block of blocks) {
    const entry = recordToCanonical(block);
    if (!entry) continue;
    records.push(entry);
    const listed = listingEpoch(entry._publishedAt);
    if (listed > 0) {
      if (listed > newest) newest = listed;
      if (listed < oldest) oldest = listed;
    }
  }
  return {
    records,
    publishedAtMs: newest > 0 ? newest : 0,
    oldestItemAt: newest > 0 && oldest !== Infinity ? oldest : 0,
  };
}

export function mergeSanctionEntries(parts = {}) {
  const ofac = Array.isArray(parts.ofac) ? parts.ofac : [];
  const sema = Array.isArray(parts.sema) ? parts.sema : [];
  const eu = Array.isArray(parts.eu) ? parts.eu : [];
  const uk = Array.isArray(parts.uk) ? parts.uk : [];
  const merged = [];
  const idIndex = new Map();
  const nameIndex = new Map();

  function cloneEntry(entry) {
    return {
      ...entry,
      sourceLists: uniqueSorted(entry.sourceLists || []),
      programs: uniqueSorted(entry.programs || []),
      _aliases: uniqueSorted(entry._aliases || []),
      _identifiers: uniqueSorted(entry._identifiers || []),
    };
  }

  function indexEntry(entry) {
    const ident = identityOf(entry);
    for (const id of ident.ids) idIndex.set(id, entry);
    for (const name of ident.names) {
      const list = nameIndex.get(name) || [];
      if (!list.includes(entry)) list.push(entry);
      nameIndex.set(name, list);
    }
  }

  function sharesIncomingSource(hit, entry) {
    const incoming = new Set(entry.sourceLists || []);
    return (hit.sourceLists || []).some((source) => incoming.has(source));
  }

  function findHit(entry, { skipSelfMerge = false } = {}) {
    const ident = identityOf(entry);
    const skip = (hit) => skipSelfMerge && sharesIncomingSource(hit, entry);
    for (const id of ident.ids) {
      const hit = idIndex.get(id);
      if (hit && !skip(hit)) return hit;
    }
    for (const name of ident.names) {
      // A shared identifier above is strong evidence on its own. A shared NAME
      // is not: it needs corroboration, or a common surname fuses two unrelated
      // designations and one of them stops existing.
      if (!isCorroboratingNameToken(name)) continue;
      for (const hit of nameIndex.get(name) || []) {
        if (skip(hit)) continue;
        const hitIdent = identityOf(hit);
        if (ident.ids.size > 0 && hitIdent.ids.size > 0) continue;
        if ((hit.entityType || '') !== (entry.entityType || '')) continue;
        return hit;
      }
    }
    return null;
  }

  function mergeInto(hit, entry) {
    hit.sourceLists = uniqueSorted([...(hit.sourceLists || []), ...(entry.sourceLists || [])]);
    hit.programs = uniqueSorted([...(hit.programs || []), ...(entry.programs || [])]);
    // Nothing may vanish from a legal list. Carry the absorbed row's own name
    // and id forward so it stays findable and traceable to its schedule item.
    hit._aliases = uniqueSorted([
      ...(hit._aliases || []),
      ...(entry._aliases || []),
      ...(entry.name && normalizeName(entry.name) !== normalizeName(hit.name) ? [entry.name] : []),
    ]);
    if (entry.id && entry.id !== hit.id) {
      hit.mergedIds = uniqueSorted([...(hit.mergedIds || []), entry.id]);
    }
    hit._identifiers = uniqueSorted([...(hit._identifiers || []), ...(entry._identifiers || [])]);
    if (entry.note && !hit.note) hit.note = entry.note;
    if ((!hit.countryCodes || hit.countryCodes.length === 0) && entry.countryCodes?.length) {
      hit.countryCodes = [...entry.countryCodes];
      hit.countryNames = [...(entry.countryNames || [])];
    }
    indexEntry(hit);
  }

  function ingest(entry, { identityMerge, skipSelfMerge = false }) {
    if (!entry?.name) return;
    if (identityMerge) {
      const hit = findHit(entry, { skipSelfMerge });
      if (hit) {
        mergeInto(hit, entry);
        return;
      }
    }
    const cloned = cloneEntry(entry);
    merged.push(cloned);
    indexEntry(cloned);
  }

  // OFAC concat is the seed. Do not identity-collapse SDN ↔ CONS.
  // SEMA concat mirrors OFAC: do not identity-collapse SEMA ↔ SEMA.
  // SEMA may attach onto OFAC/EU/UK only.
  for (const entry of ofac) ingest(entry, { identityMerge: false });
  for (const entry of eu) ingest(entry, { identityMerge: true });
  for (const entry of uk) ingest(entry, { identityMerge: true });
  for (const entry of sema) ingest(entry, { identityMerge: true, skipSelfMerge: true });
  return merged;
}

/**
 * Content-age from list publication dates in the payload, never fetchedAt.
 * `nowMs` is only a clock-skew filter.
 */
export function sanctionsListContentMeta(data, nowMs = 0) {
  const ts = Number(data?.datasetDate);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (nowMs > 0 && ts > nowMs + CLOCK_SKEW_MS) return null;
  return { newestItemAt: ts, oldestItemAt: ts };
}

async function readResponseLimited(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* still reject */ }
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return { text, lastModified: response.headers?.get?.('last-modified') || '' };
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return { text, lastModified: response.headers?.get?.('last-modified') || '' };
}

/**
 * Host-policy fetch: allowlist www.international.gc.ca, reject redirects,
 * timeout, byte ceiling, CHROME_UA. Do not bind fetch to globalThis. Cache key is the XML URL.
 */
export async function fetchSemaXml(url = SEMA_CACHE_KEY, {
  fetchFn = globalThis.fetch,
  maxBytes = SEMA_MAX_BYTES,
  timeoutMs = SEMA_TIMEOUT_MS,
  userAgent = CHROME_UA,
} = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== SEMA_HOST) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const response = await fetchFn(parsed.toString(), {
    headers: { Accept: 'application/xml, text/xml, */*', 'User-Agent': userAgent },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readResponseLimited(response, maxBytes);
}

export async function fetchSemaEntries(options = {}) {
  const { text } = await fetchSemaXml(SEMA_CACHE_KEY, options);
  return parseSemaXml(text);
}

export const SEMA_EMPTY_ERROR = 'SEMA_EMPTY';
export const SEMA_INGEST_ERROR_CODE = 'SEMA_INGEST_FAILED';

/**
 * Fetch+parse SEMA without throwing. Empty XML, HTTP errors, and transport
 * failures all become `{ error }` so a successful OFAC snapshot cannot hide them.
 */
export async function ingestSemaEntries(options = {}) {
  try {
    const parsed = await fetchSemaEntries(options);
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    if (records.length === 0) {
      return { records: [], publishedAtMs: 0, oldestItemAt: 0, error: SEMA_EMPTY_ERROR };
    }
    return {
      records,
      publishedAtMs: parsed.publishedAtMs || 0,
      oldestItemAt: parsed.oldestItemAt || 0,
      error: null,
    };
  } catch (err) {
    return {
      records: [],
      publishedAtMs: 0,
      oldestItemAt: 0,
      error: String(err?.message || err || 'SEMA_FETCH_FAILED'),
    };
  }
}

/** Seed-meta patch that keeps health off green when SEMA ingest failed. */
export function sanctionsSemaHealthMeta(semaError) {
  if (!semaError) return null;
  return {
    sourceState: 'error',
    errorCode: SEMA_INGEST_ERROR_CODE,
  };
}

/**
 * Merge lists and keep a SEMA failure visible on the snapshot.
 * OFAC-only data still publishes; sourceState/semaError stay set.
 */
export function buildSanctionsMergeSnapshot({ ofac = [], eu = [], uk = [], sema = [], semaError = null } = {}) {
  const ofacEntries = Array.isArray(ofac) ? ofac : [];
  const euEntries = Array.isArray(eu) ? eu : [];
  const ukEntries = Array.isArray(uk) ? uk : [];
  const semaEntries = Array.isArray(sema) ? sema : [];
  if (ofacEntries.length === 0 && euEntries.length === 0 && ukEntries.length === 0 && semaEntries.length === 0) {
    throw new Error('all sanctions lists failed');
  }
  const entries = mergeSanctionEntries({
    ofac: ofacEntries,
    eu: euEntries,
    uk: ukEntries,
    sema: semaEntries,
  });
  const health = sanctionsSemaHealthMeta(semaError);
  return {
    totalCount: entries.length,
    semaCount: semaEntries.length,
    semaError: semaError || null,
    sourceState: health?.sourceState || 'ok',
    errorCode: health?.errorCode || null,
    entries,
  };
}
