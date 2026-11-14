#!/usr/bin/env node

// SAX streaming parser: response.body is piped chunk-by-chunk into the parser.
// The full XML string is never held in memory, which avoids the OOM crash that
// occurred when fast-xml-parser tried to build a ~300MB object tree from a
// 120MB XML download against Railway's 512MB container limit.
import sax from 'sax';
import { gzipSync, gunzipSync } from 'node:zlib';
import { projectCountrySanctions } from './shared/country-sanctions-signals.mjs';
import { aircraftRegistrationCountry } from './shared/aircraft-registration-country.mjs';
import { countryNameToIso2, COUNTRY_NAME_TO_ISO2, normalizeCountryToken } from './shared/country-name-to-iso2.cjs';

import { loadEnvFile, runSeed, verifySeedKey, readSeedSnapshot, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import { fetchOfacSourceResponse } from './_sanctions-source.mjs';
import { buildSanctionsChanges } from './_sanctions-changes.mjs';
import { CSL_ROW_ID, CSL_SOURCES, CSL_TIMEOUT_MS, ingestCslEntries } from './_csl-sanctions.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { SANCTIONS_MAX_CONTENT_AGE_MIN, SANCTIONS_SOURCE_VERSION, SEMA_SOURCE, SEMA_TIMEOUT_MS, ingestSemaEntries, mergeSanctionEntries, semaTargetCountry, ofacRegistrationToIdentifier, sanctionsListContentMeta } from './_sema-sanctions.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'sanctions:pressure:v1';
const STATE_KEY = 'sanctions:pressure:state:v1';
const ENTITY_INDEX_KEY = 'sanctions:entities:v1';
const ENTITY_INDEX_META_KEY = 'seed-meta:sanctions:entities';
// Full ISO2 -> count map consumed by CII/country-risk scoring; do not replace
// with the top-pressure display list written under CANONICAL_KEY.countries.
const COUNTRY_COUNTS_KEY = 'sanctions:country-counts:v1';
const COUNTRY_COUNTS_META_KEY = 'seed-meta:sanctions:country-counts';
const SOURCE_SNAPSHOTS_KEY = 'sanctions:source-snapshots:v1';
const SOURCE_SNAPSHOTS_META_KEY = 'seed-meta:sanctions:source-snapshots';
const CHANGES_KEY = 'sanctions:changes:v1';
const CHANGES_META_KEY = 'seed-meta:sanctions:changes';
const CHANGES_ACTIVATION_KEY = 'seed-activated:sanctions:changes';
const CHANGES_TTL = 100 * 86400;
// OFAC's lists change slowly, and a Railway container can lose egress to
// treasury.gov/S3 for several runs; 12h dropped ~20k OFAC entities on 2026-09-27.
const SOURCE_RETAIN_MS = 48 * 60 * 60 * 1000;
// Snapshots written before the 48h change carry fetchedAt + 12h; accept them and
// move the deadline to 48h from the same fetch so a deploy cannot drop a live cohort.
const LEGACY_SOURCE_RETAIN_MS = 12 * 60 * 60 * 1000;
const SOURCE_SNAPSHOTS_TTL = 54 * 60 * 60; // retention + one 6h cron
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
// The bounded direct/proxy/signed recovery ladder can spend about 7 minutes
// across both serial XML sources, plus the SEMA source. The CSL download goes
// last and gets only what is left, minus room to build and validate the result.
const FETCH_PHASE_TIMEOUT_MS = 540_000;
const CSL_DEADLINE_MARGIN_MS = 30_000;
const CACHE_TTL = 18 * 60 * 60; // 18h — 3× live 6h cron; remains queryable after the 12h freshness alarm
// Compact entity type codes for the lookup index (saves space vs full enum strings)
const ET_CODE = {
  SANCTIONS_ENTITY_TYPE_VESSEL: 'vessel',
  SANCTIONS_ENTITY_TYPE_AIRCRAFT: 'aircraft',
  SANCTIONS_ENTITY_TYPE_INDIVIDUAL: 'individual',
  SANCTIONS_ENTITY_TYPE_ENTITY: 'entity',
  // CSL rows carry no entity type; persons and companies share the lists.
  SANCTIONS_ENTITY_TYPE_UNSPECIFIED: 'unspecified',
};
const DEFAULT_RECENT_LIMIT = 60;
// Measure OFAC country/registry attribution separately from SEMA regime targets.
const OFAC_UNATTRIBUTED_MAX_SHARE = 0.10;
// Missing current tails are expected upstream. Alarm on a registry-resolution
// failure affecting 10 aircraft with current tails, independent of cohort size.
const OFAC_AIRCRAFT_REGISTRY_FAILURE_COUNT = 10;
const ATTRIBUTION_DEGRADED_ERROR_CODE = 'SANCTIONS_ATTRIBUTION_DEGRADED';
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const PROGRAM_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,24}$/;

function validPressureClock(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= 8640000000000000;
}

const OFAC_SOURCES = [
  { label: 'SDN', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml' },
  { label: 'CONSOLIDATED', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/cons_advanced.xml' },
];

// Pressure, country counts and the pressure source health come from OFAC and
// SEMA only; CSL export-control lists feed screening and the change feed.
const PRESSURE_SOURCES = [...OFAC_SOURCES.map(({ label }) => label), SEMA_SOURCE];

function validSourceId(source, id) {
  if (typeof id !== 'string') return false;
  if (source === SEMA_SOURCE) return /^sema-ca:(?!unspecified:|xx:)[^:]+:[^:]+:[1-9]\d*$/.test(id);
  if (CSL_SOURCES.includes(source)) return id.startsWith(`${source}:`) && CSL_ROW_ID.test(id.slice(source.length + 1));
  return new RegExp(`^${source}:\\d+$`).test(id);
}

function validSourceRecords(source, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  const ids = new Set();
  return records.every(entry => {
    const validId = validSourceId(source, entry?.id);
    if (!validId || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()
      || !Object.hasOwn(ET_CODE, entry.entityType)
      || !Array.isArray(entry.sourceLists) || entry.sourceLists.length !== 1 || entry.sourceLists[0] !== source
      || !['countryCodes', 'countryNames', 'programs'].every(field => Array.isArray(entry[field]) && entry[field].every(v => typeof v === 'string'))
      || !['_aliases', '_identifiers', 'parentCountryCodes', 'parentCountryNames'].every(field => entry[field] === undefined || (Array.isArray(entry[field]) && entry[field].every(v => typeof v === 'string')))
      || !(entry._aircraftHasCurrentTail === undefined || typeof entry._aircraftHasCurrentTail === 'boolean')
      || !['_notice', '_url', '_flagCode', '_flagName'].every(field => entry[field] === undefined || typeof entry[field] === 'string')
      || typeof entry.effectiveAt !== 'string' || !/^\d+$/.test(entry.effectiveAt)) return false;
    ids.add(entry.id);
    return true;
  });
}

function decodeSourceSnapshots(stored) {
  if (!stored) return {};
  try {
    if (stored.version !== 1 || stored.encoding !== 'gzip-base64' || typeof stored.data !== 'string'
      || stored.data.length > 5 * 1024 * 1024) throw new Error('invalid snapshot encoding');
    const decoded = JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: SNAPSHOT_MAX_BYTES }).toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid snapshot map');
    return decoded;
  } catch {
    console.warn('  SANCTIONS_SNAPSHOT_INVALID: ignoring unusable source snapshots');
    return {};
  }
}

function encodeSourceSnapshots(snapshots) {
  const json = JSON.stringify(snapshots);
  if (Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES) throw new Error('SANCTIONS_SNAPSHOT_TOO_LARGE');
  const data = gzipSync(json).toString('base64');
  if (data.length > 5 * 1024 * 1024 - 1024) throw new Error('SANCTIONS_SNAPSHOT_TOO_LARGE');
  return { version: 1, encoding: 'gzip-base64', data };
}

function selectSanctionsSourceSnapshot(source, result, previous, now) {
  const valid = !result.error && validSourceRecords(source, result.records)
    && Number.isSafeInteger(result.publishedAt) && result.publishedAt >= 0 && result.publishedAt <= now;
  const retained = previous?.version === 1
    && Number.isSafeInteger(previous.fetchedAt) && previous.fetchedAt > 0 && previous.fetchedAt <= now
    && (previous.retainedUntil === previous.fetchedAt + SOURCE_RETAIN_MS
      || previous.retainedUntil === previous.fetchedAt + LEGACY_SOURCE_RETAIN_MS)
    && now < previous.fetchedAt + SOURCE_RETAIN_MS
    && Number.isSafeInteger(previous.publishedAt) && previous.publishedAt >= 0 && previous.publishedAt <= previous.fetchedAt
    && (previous.quarantinedCount === undefined
      || (Number.isSafeInteger(previous.quarantinedCount) && previous.quarantinedCount >= 0))
    && validSourceRecords(source, previous.records);
  const snapshot = valid
    ? { version: 1, fetchedAt: now, retainedUntil: now + SOURCE_RETAIN_MS, publishedAt: result.publishedAt,
      quarantinedCount: result.quarantinedCount, records: result.records }
    : retained ? { ...previous, retainedUntil: previous.fetchedAt + SOURCE_RETAIN_MS } : null;
  return {
    snapshot,
    health: {
      status: valid ? 'ok' : snapshot ? 'retained' : 'unavailable',
      lastAttemptAt: now,
      lastSuccessAt: snapshot?.fetchedAt ?? null,
      retainedUntil: snapshot?.retainedUntil ?? null,
      publishedAt: snapshot?.publishedAt ?? null,
      recordCount: snapshot?.records.length ?? 0,
      errorCode: valid ? null : source === SEMA_SOURCE ? 'SEMA_INGEST_FAILED'
        : CSL_SOURCES.includes(source) ? 'CSL_INGEST_FAILED' : 'OFAC_INGEST_FAILED',
    },
  };
}

// Strip XML namespace prefix (e.g. "sanc:SanctionsEntry" → "SanctionsEntry")
function local(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function compactNote(value) {
  const note = String(value || '').replace(/\s+/g, ' ').trim();
  if (!note) return '';
  return note.length > 240 ? `${note.slice(0, 237)}...` : note;
}

function sortEntries(a, b) {
  return (Number(b.isNew) - Number(a.isNew))
    || (Number(b.effectiveAt) - Number(a.effectiveAt))
    || a.name.localeCompare(b.name);
}

function buildCountryPressure(entries) {
  const map = new Map();
  for (const entry of entries) {
    entry.countryCodes.forEach((code, index) => {
      if (!hasCountryCode(code)) return;
      const current = map.get(code) || {
        countryCode: code,
        countryName: entry.countryNames[index] || code,
        entryCount: 0,
        newEntryCount: 0,
        vesselCount: 0,
        aircraftCount: 0,
      };
      current.entryCount += 1;
      if (entry.isNew) current.newEntryCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL') current.vesselCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT') current.aircraftCount += 1;
      map.set(code, current);
    });
  }
  return [...map.values()]
    .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount || a.countryName.localeCompare(b.countryName))
    .slice(0, 12);
}

function hasCountryCode(code) {
  return Boolean(code) && code !== 'XX';
}

// Regulation targets describe a sanctions regime, never a designee's country.
// Reuse the display ranking only; this projection must not feed risk or briefs.
function buildRegulationTargets(entries) {
  return buildCountryPressure(entries.map(entry => ({ ...entry,
    countryCodes: entry._targetCountryCodes || [],
    countryNames: entry._targetCountryNames || [],
  })));
}

function buildFlagRegistries(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry._flagCode) continue;
    const current = map.get(entry._flagCode) || {
      countryCode: entry._flagCode,
      countryName: entry._flagName || entry._flagCode,
      vesselCount: 0,
      newVesselCount: 0,
      aircraftCount: 0,
      newAircraftCount: 0,
    };
    const asset = entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' ? 'aircraftCount' : 'vesselCount';
    current[asset] += 1;
    if (entry.isNew) current[asset === 'aircraftCount' ? 'newAircraftCount' : 'newVesselCount'] += 1;
    map.set(entry._flagCode, current);
  }
  const fresh = row => row.newVesselCount + row.newAircraftCount;
  const total = row => row.vesselCount + row.aircraftCount;
  return [...map.values()]
    .sort((a, b) => fresh(b) - fresh(a) || total(b) - total(a) || a.countryName.localeCompare(b.countryName))
    .slice(0, 12);
}

function countUnattributed(entries) {
  const summary = { entryCount: 0, vesselCount: 0, aircraftCount: 0 };
  for (const entry of entries) {
    if (entry._flagCode || entry.countryCodes.some(hasCountryCode) || entry.parentCountryCodes?.some(hasCountryCode)) continue;
    summary.entryCount += 1;
    if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL') summary.vesselCount += 1;
    if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT') summary.aircraftCount += 1;
  }
  return summary;
}

function ofacAttributionHealth(entries) {
  const vesselCount = entries.filter(entry => entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL').length;
  const aircraftCount = entries.filter(entry => entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT').length;
  // Location evidence cannot prove that aircraft registry resolution still works.
  const unattributedAircraftCount = entries.filter(entry => entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' && !hasCountryCode(entry._flagCode)).length;
  const aircraftWithTails = entries.filter(entry => entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' && entry._aircraftHasCurrentTail);
  const unresolvedAircraftWithTailCount = aircraftWithTails.filter(entry => !hasCountryCode(entry._flagCode)).length;
  const unattributed = countUnattributed(entries);
  const share = (count, total) => (total > 0 ? Math.round((count / total) * 10_000) / 10_000 : null);
  const entryShare = share(unattributed.entryCount, entries.length);
  const vesselShare = share(unattributed.vesselCount, vesselCount);
  const aircraftShare = share(unattributedAircraftCount, aircraftCount);
  return {
    entryCount: entries.length,
    unattributedCount: unattributed.entryCount,
    unattributedShare: entryShare,
    vesselCount,
    unattributedVesselCount: unattributed.vesselCount,
    unattributedVesselShare: vesselShare,
    aircraftCount,
    unattributedAircraftCount,
    unattributedAircraftShare: aircraftShare,
    maxShare: OFAC_UNATTRIBUTED_MAX_SHARE,
    aircraftWithTailCount: aircraftWithTails.length,
    unresolvedAircraftWithTailCount,
    unresolvedAircraftWithTailShare: share(unresolvedAircraftWithTailCount, aircraftWithTails.length),
    aircraftRegistryFailureCount: OFAC_AIRCRAFT_REGISTRY_FAILURE_COUNT,
    degraded: unattributed.entryCount > entries.length * OFAC_UNATTRIBUTED_MAX_SHARE
      || unattributed.vesselCount > vesselCount * OFAC_UNATTRIBUTED_MAX_SHARE
      || unresolvedAircraftWithTailCount >= OFAC_AIRCRAFT_REGISTRY_FAILURE_COUNT,
  };
}

function semaAttributionHealth(entries) {
  const regimes = Object.create(null);
  for (const entry of entries) {
    if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL') continue;
    const regime = entry._regime || 'Unknown';
    // Classify independently of semaTargetCountry: losing a known state's
    // targets must still alarm. Unknown/thematic schedules are informational.
    const regimeName = regime.replace(/\s*\([^)]*\)\s*$/, '');
    const targetExpected = !/^(ukraine|moldova|jvcfor|hamas|settler)$/i.test(regimeName)
      && Boolean(COUNTRY_NAME_TO_ISO2[normalizeCountryToken(regime)]
        || COUNTRY_NAME_TO_ISO2[normalizeCountryToken(regimeName)]);
    const row = Object.hasOwn(regimes, regime) ? regimes[regime] : (regimes[regime] = { entryCount: 0, unattributedCount: 0, targetExpected });
    row.entryCount += 1;
    if (!entry._targetCountryCodes?.some(hasCountryCode)) row.unattributedCount += 1;
  }
  for (const row of Object.values(regimes)) {
    row.unattributedShare = Math.round(row.unattributedCount / row.entryCount * 10_000) / 10_000;
    row.degraded = row.targetExpected && row.unattributedCount > row.entryCount * OFAC_UNATTRIBUTED_MAX_SHARE;
  }
  return { regimes, maxShare: OFAC_UNATTRIBUTED_MAX_SHARE, degraded: Object.values(regimes).some(row => row.degraded) };
}

// Full ISO2 → entryCount map across ALL entries (not truncated like buildCountryPressure).
// Used by get-country-risk RPC for accurate per-country sanctions screening.
function buildCountryCounts(entries) {
  const map = {};
  for (const entry of entries) {
    for (const code of entry.countryCodes) {
      if (code && code !== 'XX') map[code] = (map[code] ?? 0) + 1;
    }
  }
  return map;
}

function buildProgramPressure(entries) {
  const map = new Map();
  for (const entry of entries) {
    const programs = entry.programs.length > 0 ? entry.programs : ['UNSPECIFIED'];
    for (const program of programs) {
      const current = map.get(program) || { program, entryCount: 0, newEntryCount: 0 };
      current.entryCount += 1;
      if (entry.isNew) current.newEntryCount += 1;
      map.set(program, current);
    }
  }
  return [...map.values()]
    .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount || a.program.localeCompare(b.program))
    .slice(0, 12);
}

/**
 * Stream-parse one OFAC Advanced XML source via SAX.
 *
 * Memory model: response.body chunks → sax.parser (stateful, O(1) RAM per chunk)
 * → accumulate only the minimal data structures needed for output.
 * Peak heap is proportional to the number of entries/parties, not the XML size.
 */
async function fetchSource(source, { deadlineAt } = {}) {
  console.log(`  Fetching OFAC ${source.label}...`);
  const t0 = Date.now();
  const response = await fetchOfacSourceResponse(source.url, { deadlineAt });

  return new Promise((resolve, reject) => {
    // strict=true: case-sensitive tag names. xmlns=false: we strip prefixes manually.
    const parser = sax.parser(true, { trim: false, normalize: false });

    // ── Reference maps (built first, small, kept for cross-reference) ──────────
    const areaCodes   = new Map(); // ID → { code, name }
    const countriesByName = new Map();
    const countryNamesByCode = new Map();
    const featureTypes = new Map(); // ID → label string
    const relationTypes = new Map();
    const parentLinks = new Map(); // child profile ID -> direct parent profile IDs
    const entryProfiles = [];
    const legalBasis  = new Map(); // ID → shortRef string
    const idRegDocTypes = new Map(); // ID → label string
    const idRegDocsByIdentity = new Map(); // identityId → { typeId, number }[]
    const locations   = new Map(); // ID → { codes[], names[] }
    const parties     = new Map(); // profileId → { name, entityType, countryCodes[], countryNames[] }
    const entries     = [];
    let datasetDate   = 0;
    let bytesReceived = 0;

    // ── Element stack & text buffer ────────────────────────────────────────────
    const stack = []; // local element names
    let text = '';    // accumulated character data for current leaf

    // ── Section flags ──────────────────────────────────────────────────────────
    let inDateOfIssue       = false;
    let inAreaCodeValues    = false;
    let inCountryValues     = false;
    let inFeatureTypeValues = false;
    let inRelationTypeValues = false;
    let inLegalBasisValues  = false;
    let inIDRegDocTypeValues = false;
    let inIDRegDocuments    = false;
    let inLocations         = false;
    let inDistinctParties   = false;
    let inSanctionsEntries  = false;

    // ── Current-object accumulators ────────────────────────────────────────────
    // DateOfIssue
    let doiYear = 0, doiMonth = 1, doiDay = 1;

    // AreaCode / FeatureType / LegalBasis (reference value section)
    let refId = '', refShortRef = '', refDescription = '';
    let countryIso2 = '';

    // Location
    let locId = '';
    let locAreaCodeIds = null; // string[] | null

    // DistinctParty / Profile
    let partyFixedRef = '';
    let profileId = '', profileSubTypeId = '', identityId = '';
    let curDoc = null;           // { typeId, identityId, number }
    let aliases = null;          // Alias[]
    let curAlias = null;         // { primary, typeId, nameParts[] }
    let inDocumentedName = false;
    let namePartsBuf = null;     // string[] collecting NamePartValue text
    let profileFeatures = null;  // Feature[]
    let curFeature = null;       // { featureTypeId, locationIds[], detail, details[] }

    // SanctionsEntry
    let entryId = '', entryProfileId = '';
    let entryDates = null;       // number[] (epochs from EntryEvent.Date)
    let entryMeasureDates = null; // number[] (from SanctionsMeasure.DatePeriod)
    let entryPrograms = null;    // string[]
    let entryNoteComments = null; // string[] (non-program comments)
    let entryLegalIds = null;    // string[] (LegalBasisID from EntryEvent)

    // Date sub-elements (shared by multiple contexts)
    let dateYear = 0, dateMonth = 1, dateDay = 1;
    let inEntryEventDate = false;
    let inMeasureDatePeriod = false;

    // ── Helpers ────────────────────────────────────────────────────────────────
    function epoch(y, m, d) {
      if (!y) return 0;
      return Date.UTC(y, Math.max(1, m) - 1, Math.max(1, d));
    }

    function resolveLocation(_locId) {
      const ids = locAreaCodeIds;
      const mapped = ids.map((id) => areaCodes.get(id)).filter(Boolean);
      const pairs = [...new Map(mapped.map((item) => [item.code, item.name])).entries()]
        .filter(([code]) => code.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      return { codes: pairs.map(([c]) => c), names: pairs.map(([, n]) => n) };
    }

    function countryName(code) {
      return countryNamesByCode.get(code) ?? REGION_NAMES.of(code) ?? code;
    }

    // OFAC writes flags as names. Its own country list misses some flag states
    // (Cook Islands, Gabon) and spellings (Antigua & Barbuda); the shared map covers them.
    function flagCountry(flag) {
      if (/\bfalse\b/i.test(flag)) return null;
      // Exact aliases such as Congo (Kinshasa) are valid. Never strip an unknown
      // qualifier such as Former or Disputed to turn it into a current registry.
      if (/[()]/.test(flag)) {
        const officialName = /^(Iran \(Islamic Republic of\)|Bolivia \(Plurinational State of\)|Venezuela \(Bolivarian Republic of\)|Tanzania \(United Republic of\)|Micronesia \(Federated States of\)|Moldova \(Republic of\)|Netherlands \(Kingdom of the\)|Taiwan \(Province of China\))$/i;
        return COUNTRY_NAME_TO_ISO2[normalizeCountryToken(flag)]
          ?? (officialName.test(flag.trim()) ? countryNameToIso2(flag) : null);
      }
      const code = countriesByName.get(flag.toLowerCase()) ?? countryNameToIso2(flag);
      return hasCountryCode(code) ? code : null;
    }

    const REGISTRIES = {
      SANCTIONS_ENTITY_TYPE_VESSEL: { feature: 'Vessel Flag', country: flagCountry },
      SANCTIONS_ENTITY_TYPE_AIRCRAFT: { feature: 'Aircraft Tail Number', country: aircraftRegistrationCountry },
    };

    function registryCountry(entityType) {
      const registry = REGISTRIES[entityType];
      if (!registry) return null;
      const codes = (profileFeatures ?? [])
        .filter(feat => featureTypes.get(feat.featureTypeId) === registry.feature)
        .flatMap(feat => feat.details)
        .map(registry.country);
      const [code] = codes;
      return code && codes.every(other => other === code) ? code : null;
    }

    function finalizeParty() {
      const primaryAlias = aliases?.find((a) => a.primary)
        || aliases?.find((a) => a.typeId === '1403')
        || aliases?.[0];
      const name = primaryAlias?.nameParts.join(' ') || 'Unnamed designation';

      let entityType = 'SANCTIONS_ENTITY_TYPE_ENTITY';
      if (profileSubTypeId === '1') entityType = 'SANCTIONS_ENTITY_TYPE_VESSEL';
      else if (profileSubTypeId === '2') entityType = 'SANCTIONS_ENTITY_TYPE_AIRCRAFT';
      else if (profileFeatures?.some((f) => /birth|citizenship|nationality/i.test(featureTypes.get(f.featureTypeId) || ''))) {
        entityType = 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL';
      }

      const seen = new Map();
      for (const feat of profileFeatures ?? []) {
        if (!/location/i.test(featureTypes.get(feat.featureTypeId) || '')) continue;
        for (const lid of feat.locationIds) {
          const loc = locations.get(lid);
          if (!loc) continue;
          loc.codes.forEach((code, i) => { if (hasCountryCode(code) && !seen.has(code)) seen.set(code, loc.names[i] ?? ''); });
        }
      }
      // A vessel's flag or an aircraft's state of registry names a registry, often
      // of convenience, so it never joins countryCodes, which feed risk scores and
      // country briefs as sanctions pressure.
      const registryCode = registryCountry(entityType);
      const flag = registryCode ? { code: registryCode, name: countryName(registryCode) } : null;
      const sorted = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));

      const aliasNames = uniqueSorted((aliases ?? []).map((a) => a.nameParts.join(' ')).filter((part) => part && part !== name));
      const identifiers = uniqueSorted([
        ...(idRegDocsByIdentity.get(identityId) || []).map((doc) => (
          ofacRegistrationToIdentifier(idRegDocTypes.get(doc.typeId) || '', doc.number)
        )),
        ...(profileFeatures ?? []).map((feat) => (
          ofacRegistrationToIdentifier(featureTypes.get(feat.featureTypeId) || '', feat.detail)
        )),
      ]);
      parties.set(profileId, {
        name,
        entityType,
        countryCodes: sorted.map(([c]) => c),
        countryNames: sorted.map(([, n]) => n),
        flag,
        aircraftHasCurrentTail: entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' && (profileFeatures ?? []).some(feat =>
          featureTypes.get(feat.featureTypeId) === 'Aircraft Tail Number' && feat.details.some(detail => detail.trim())),
        aliases: aliasNames,
        identifiers,
      });
    }

    function finalizeEntry() {
      const party = parties.get(entryProfileId);
      const name = party?.name || 'Unnamed designation';
      const programs = uniqueSorted((entryPrograms ?? []).filter((c) => PROGRAM_CODE_RE.test(c)));
      const allDates = [...(entryDates ?? []), ...(entryMeasureDates ?? [])];
      const effectiveAt = String(allDates.length > 0 ? Math.max(...allDates) : 0);

      const commentNote = (entryNoteComments ?? []).find((c) => c);
      const legalNote = (entryLegalIds ?? []).map((id) => legalBasis.get(id) || '').find((n) => n) || '';
      const note = compactNote(commentNote || legalNote);

      entries.push({
        id: `${source.label}:${entryId || entryProfileId}`,
        name,
        entityType: party?.entityType || 'SANCTIONS_ENTITY_TYPE_ENTITY',
        countryCodes: party?.countryCodes ?? [],
        countryNames: party?.countryNames ?? [],
        programs: programs.length > 0 ? programs : [source.label],
        sourceLists: [source.label],
        effectiveAt,
        isNew: false,
        note,
        ...(party?.flag ? { _flagCode: party.flag.code, _flagName: party.flag.name } : {}),
        ...(party?.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' ? { _aircraftHasCurrentTail: party.aircraftHasCurrentTail } : {}),
        _aliases: party?.aliases ?? [],
        _identifiers: party?.identifiers ?? [],
      });
      entryProfiles.push(entryProfileId);
    }

    // ── SAX event handlers ─────────────────────────────────────────────────────
    parser.onopentag = (node) => {
      const name = local(node.name);
      const attrs = node.attributes;
      stack.push(name);
      text = '';

      switch (name) {
        // ── Section markers ──
        case 'DateOfIssue':       inDateOfIssue = true; break;
        case 'AreaCodeValues':    inAreaCodeValues = true; break;
        case 'CountryValues':     inCountryValues = true; break;
        case 'FeatureTypeValues': inFeatureTypeValues = true; break;
        case 'RelationTypeValues': inRelationTypeValues = true; break;
        case 'LegalBasisValues':  inLegalBasisValues = true; break;
        case 'IDRegDocTypeValues': inIDRegDocTypeValues = true; break;
        case 'IDRegDocuments':    inIDRegDocuments = true; break;
        case 'Locations':         inLocations = true; break;
        case 'DistinctParties':   inDistinctParties = true; break;
        case 'SanctionsEntries':  inSanctionsEntries = true; break;

        // ── Reference values ──
        case 'AreaCode':
          if (inAreaCodeValues) { refId = attrs.ID || ''; refDescription = attrs.Description || ''; }
          break;
        case 'Country':
          if (inCountryValues) countryIso2 = attrs.ISO2 || '';
          break;
        case 'FeatureType':
          if (inFeatureTypeValues) refId = attrs.ID || '';
          break;
        case 'RelationType':
          if (inRelationTypeValues) refId = attrs.ID || '';
          break;
        case 'ProfileRelationship': {
          if (attrs.Former !== 'false') break;
          const type = relationTypes.get(attrs.RelationTypeID);
          let child = attrs['From-ProfileID'], parent = attrs['To-ProfileID'];
          if (type === 'Owns, controls, or operates') [child, parent] = [parent, child];
          else if (!['Owned or Controlled By', 'Acting for or on behalf of', 'Property in the interest of'].includes(type)) break;
          if (child && parent && child !== parent) {
            const links = parentLinks.get(child) || new Set();
            links.add(parent);
            parentLinks.set(child, links);
          }
          break;
        }
        case 'LegalBasis':
          if (inLegalBasisValues) { refId = attrs.ID || ''; refShortRef = attrs.LegalBasisShortRef || ''; }
          break;
        case 'IDRegDocType':
          if (inIDRegDocTypeValues) { refId = attrs.ID || ''; refDescription = attrs.IDRegDocTypeName || ''; }
          break;
        case 'IDRegDocument':
          if (inIDRegDocuments) {
            curDoc = { typeId: attrs.IDRegDocTypeID || '', identityId: attrs.IdentityID || '', number: '' };
          }
          break;

        // ── Locations ──
        case 'Location':
          if (inLocations) { locId = attrs.ID || ''; locAreaCodeIds = []; }
          break;
        case 'LocationAreaCode':
          if (locAreaCodeIds && attrs.AreaCodeID) locAreaCodeIds.push(attrs.AreaCodeID);
          break;

        // ── DistinctParty / Profile ──
        case 'DistinctParty':
          if (inDistinctParties) { partyFixedRef = attrs.FixedRef || ''; aliases = []; profileFeatures = []; }
          break;
        case 'Profile':
          if (inDistinctParties) { profileId = attrs.ID || partyFixedRef; profileSubTypeId = attrs.PartySubTypeID || ''; identityId = ''; }
          break;
        case 'Identity':
          if (inDistinctParties) identityId = attrs.ID || '';
          break;
        case 'Alias':
          if (inDistinctParties) curAlias = { primary: attrs.Primary === 'true', typeId: attrs.AliasTypeID || '', nameParts: [] };
          break;
        case 'DocumentedName':
          if (curAlias) { inDocumentedName = true; namePartsBuf = []; }
          break;
        case 'Feature':
          if (inDistinctParties) curFeature = { featureTypeId: attrs.FeatureTypeID || '', locationIds: [], detail: '', details: [] };
          break;
        case 'VersionLocation':
          if (curFeature && attrs.LocationID) curFeature.locationIds.push(attrs.LocationID);
          break;

        // ── SanctionsEntry ──
        case 'SanctionsEntry':
          if (inSanctionsEntries) {
            entryId = attrs.ID || ''; entryProfileId = attrs.ProfileID || '';
            entryDates = []; entryMeasureDates = []; entryPrograms = []; entryNoteComments = []; entryLegalIds = [];
          }
          break;
        case 'EntryEvent':
          if (entryDates) inEntryEventDate = true;
          break;
        case 'SanctionsMeasure':
          if (entryDates) inMeasureDatePeriod = false; // reset, set when we see DatePeriod
          break;
        case 'DatePeriod':
          if (entryMeasureDates) inMeasureDatePeriod = true;
          break;
        case 'Date':
        case 'From':
          dateYear = 0; dateMonth = 1; dateDay = 1;
          break;
      }
    };

    parser.onclosetag = (rawName) => {
      const name = local(rawName);
      const t = text.trim();
      text = '';
      stack.pop();

      switch (name) {
        // ── DateOfIssue ──
        case 'DateOfIssue': inDateOfIssue = false; datasetDate = epoch(doiYear, doiMonth, doiDay); break;

        // ── Shared Year/Month/Day (context determined by flags) ──
        case 'Year':
          if (inDateOfIssue) doiYear = Number(t) || 0;
          else dateYear = Number(t) || 0;
          break;
        case 'Month':
          if (inDateOfIssue) doiMonth = Number(t) || 1;
          else dateMonth = Number(t) || 1;
          break;
        case 'Day':
          if (inDateOfIssue) doiDay = Number(t) || 1;
          else dateDay = Number(t) || 1;
          break;

        // ── Section close ──
        case 'AreaCodeValues':    inAreaCodeValues = false; break;
        case 'CountryValues':     inCountryValues = false; break;
        case 'FeatureTypeValues': inFeatureTypeValues = false; break;
        case 'RelationTypeValues': inRelationTypeValues = false; break;
        case 'LegalBasisValues':  inLegalBasisValues = false; break;
        case 'IDRegDocTypeValues': inIDRegDocTypeValues = false; break;
        case 'IDRegDocuments':    inIDRegDocuments = false; break;
        case 'Locations':         inLocations = false; break;
        case 'DistinctParties':   inDistinctParties = false; break;
        case 'SanctionsEntries':  inSanctionsEntries = false; break;

        // ── Reference values ──
        case 'AreaCode':
          if (inAreaCodeValues && refId) areaCodes.set(refId, { code: t, name: refDescription });
          break;
        case 'Country':
          if (inCountryValues && t && /^[A-Z]{2}$/.test(countryIso2) && hasCountryCode(countryIso2)) {
            countriesByName.set(t.toLowerCase(), countryIso2);
            countryNamesByCode.set(countryIso2, t);
          }
          break;
        case 'FeatureType':
          if (inFeatureTypeValues && refId) featureTypes.set(refId, t);
          break;
        case 'RelationType':
          if (inRelationTypeValues && refId) relationTypes.set(refId, t);
          break;
        case 'LegalBasis':
          if (inLegalBasisValues && refId) legalBasis.set(refId, refShortRef || t);
          break;
        case 'IDRegDocTypeName':
          if (inIDRegDocTypeValues) refDescription = t || refDescription;
          break;
        case 'IDRegDocType':
          if (inIDRegDocTypeValues && refId) idRegDocTypes.set(refId, refDescription || t);
          break;
        case 'IDRegistrationNo':
          if (curDoc) curDoc.number = t;
          break;
        case 'IDRegDocument':
          if (curDoc?.identityId) {
            const list = idRegDocsByIdentity.get(curDoc.identityId) || [];
            list.push(curDoc);
            idRegDocsByIdentity.set(curDoc.identityId, list);
          }
          curDoc = null;
          break;
        case 'VersionDetail':
          if (curFeature && t) {
            curFeature.detail = t;
            curFeature.details.push(t);
          }
          break;

        // ── Locations ──
        case 'Location':
          if (locAreaCodeIds !== null) {
            locations.set(locId, resolveLocation(locId));
            locId = ''; locAreaCodeIds = null;
          }
          break;

        // ── DistinctParty / Profile ──
        case 'NamePartValue':
          if (namePartsBuf !== null && t) namePartsBuf.push(t);
          break;
        case 'DocumentedName':
          if (curAlias && namePartsBuf !== null) { curAlias.nameParts = namePartsBuf; namePartsBuf = null; inDocumentedName = false; }
          break;
        case 'Alias':
          if (curAlias) { aliases.push(curAlias); curAlias = null; }
          break;
        case 'Feature':
          if (curFeature) { profileFeatures.push(curFeature); curFeature = null; }
          break;
        case 'Profile':
          if (inDistinctParties && profileId) finalizeParty();
          profileId = ''; profileSubTypeId = ''; identityId = ''; aliases = []; profileFeatures = [];
          break;
        case 'DistinctParty':
          partyFixedRef = '';
          break;

        // ── SanctionsEntry date contexts ──
        case 'Date':
          if (inEntryEventDate && entryDates) {
            const e = epoch(dateYear, dateMonth, dateDay);
            if (e > 0) entryDates.push(e);
          }
          break;
        case 'From':
          if (inMeasureDatePeriod && entryMeasureDates) {
            const e = epoch(dateYear, dateMonth, dateDay);
            if (e > 0) entryMeasureDates.push(e);
          }
          break;
        case 'EntryEvent':
          inEntryEventDate = false;
          break;
        case 'SanctionsMeasure':
          inMeasureDatePeriod = false;
          break;
        case 'DatePeriod':
          inMeasureDatePeriod = false;
          break;

        // ── SanctionsEntry leaf data ──
        case 'LegalBasisID':
          if (entryLegalIds) entryLegalIds.push(t);
          break;
        case 'Comment':
          if (entryPrograms !== null) entryPrograms.push(t);
          if (entryNoteComments !== null && t && !PROGRAM_CODE_RE.test(t)) entryNoteComments.push(t);
          break;

        case 'SanctionsEntry':
          if (entryDates !== null) finalizeEntry();
          entryId = ''; entryProfileId = ''; entryDates = null; entryMeasureDates = null;
          entryPrograms = null; entryNoteComments = null; entryLegalIds = null;
          break;
      }
    };

    parser.ontext = (chunk) => { text += chunk; };
    parser.oncdata = (chunk) => { text += chunk; };

    parser.onerror = (err) => {
      parser.resume(); // keep streaming; log but don't abort — partial results are valid
      console.warn(`  ${source.label}: SAX parse warning: ${err.message}`);
    };

    parser.onend = () => {
      // Relationships can follow SanctionsEntries. Resolve once all direct
      // addresses are known; do not recurse through missing parents or cycles.
      entries.forEach((entry, index) => {
        const countries = new Map();
        if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_ENTITY' && entry.countryCodes.length === 0) {
          for (const parentId of parentLinks.get(entryProfiles[index]) || []) {
            const parent = parties.get(parentId);
            parent?.countryCodes.forEach((code, i) => countries.set(code, parent.countryNames[i] || code));
          }
        }
        const sorted = [...countries].sort(([a], [b]) => a.localeCompare(b));
        entry.parentCountryCodes = sorted.map(([code]) => code);
        entry.parentCountryNames = sorted.map(([, name]) => name);
      });
      console.log(`  ${source.label}: ${(bytesReceived / 1024).toFixed(0)}KB streamed, ${entries.length} entries parsed (${Date.now() - t0}ms)`);
      resolve({ entries, datasetDate });
    };

    // Stream response body through the SAX parser chunk by chunk.
    // response.body is a web ReadableStream (Node.js 20 native fetch).
    const decoder = new TextDecoder('utf-8');
    (async () => {
      try {
        for await (const chunk of response.body) {
          bytesReceived += chunk.byteLength;
          parser.write(decoder.decode(chunk, { stream: true }));
        }
        // Flush any remaining bytes in the decoder
        const tail = decoder.decode();
        if (tail) parser.write(tail);
        parser.close();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

async function fetchSanctionsPressure() {
  const fetchStartedAt = Date.now();
  const previousState = await verifySeedKey(STATE_KEY).catch(() => null);
  const validPreviousIds = Array.isArray(previousState?.entryIds)
    && previousState.entryIds.every(id => validSourceId(SEMA_SOURCE, id)
      || OFAC_SOURCES.some(({ label }) => validSourceId(label, id)));
  const previousIds = new Set(validPreviousIds ? previousState.entryIds : []);
  const hasPrevious = previousIds.size > 0;
  console.log(`  Previous state: ${hasPrevious ? `${previousIds.size} known IDs` : 'none (first run or expired)'}`);

  const previousSnapshots = decodeSourceSnapshots(await readSeedSnapshot(SOURCE_SNAPSHOTS_KEY, { strict: true }));
  let previousChanges;
  let changesReadable = true;
  try {
    previousChanges = await readSeedSnapshot(CHANGES_KEY, { strict: true });
    if (previousChanges === null && await readSeedSnapshot(CHANGES_ACTIVATION_KEY, { strict: true }) !== null) {
      throw new Error('SANCTIONS_CHANGES_HISTORY_MISSING');
    }
  } catch {
    changesReadable = false;
    console.warn('  Sanctions change history unavailable; preserving history and its baseline.');
  }
  const outcomes = {};
  const deadlineAt = fetchStartedAt + FETCH_PHASE_TIMEOUT_MS - CSL_DEADLINE_MARGIN_MS;
  // SEMA and CSL run after OFAC; runSeed discards the whole run at the phase timeout.
  const ofacDeadlineAt = deadlineAt - CSL_TIMEOUT_MS - SEMA_TIMEOUT_MS;
  for (const source of OFAC_SOURCES) {
    try {
      const result = await fetchSource(source, { deadlineAt: ofacDeadlineAt });
      outcomes[source.label] = { records: result.entries, publishedAt: result.datasetDate || 0, quarantinedCount: 0, error: null };
    } catch (err) {
      console.warn(`  OFAC ${source.label} fetch failed: ${err?.message || err}`);
      outcomes[source.label] = { records: [], publishedAt: 0, error: 'OFAC_INGEST_FAILED' };
    }
  }
  const sema = await ingestSemaEntries();
  if (!sema.error && !Array.isArray(sema.quarantined)) throw new Error('SANCTIONS_QUARANTINE_INVALID');
  outcomes[SEMA_SOURCE] = { records: sema.records, publishedAt: sema.publishedAtMs || 0,
    quarantinedCount: sema.error ? null : sema.quarantined.length, error: sema.error };
  if (sema.error) console.warn(`  SEMA fetch failed: ${sema.error}`);
  // One bulk download covers all six CSL lists; a failed download fails each list.
  const csl = await ingestCslEntries({ deadlineAt });
  if (csl.error) console.warn(`  CSL fetch failed: ${csl.error}`);
  for (const source of CSL_SOURCES) {
    const list = csl.lists[source];
    outcomes[source] = { records: list?.records ?? [], publishedAt: list?.publishedAt ?? 0, quarantinedCount: 0,
      error: csl.error || (list ? list.error : 'CSL_LIST_MISSING') };
    if (!csl.error && list?.error) console.warn(`  CSL ${source} unavailable: ${list.error}`);
  }

  const now = Date.now();
  if (!validPressureClock(String(now)) || now + SOURCE_RETAIN_MS > 8640000000000000) {
    throw new Error('SANCTIONS_CLOCK_INVALID');
  }
  const _sourceSnapshots = {};
  const _sourceHealth = {};
  for (const [source, result] of Object.entries(outcomes)) {
    const selected = selectSanctionsSourceSnapshot(source, result, previousSnapshots[source], now);
    _sourceSnapshots[source] = selected.snapshot;
    _sourceHealth[source] = selected.health;
  }
  const eligiblePrevious = Object.fromEntries(Object.keys(outcomes).map(source => [source,
    selectSanctionsSourceSnapshot(source, { error: 'baseline' }, previousSnapshots[source], now).snapshot,
  ]));
  let _changes = null;
  if (changesReadable) {
    try {
      _changes = buildSanctionsChanges({ history: previousChanges, previous: eligiblePrevious,
        current: _sourceSnapshots, health: _sourceHealth, now });
    } catch {
      console.warn('  Sanctions change history invalid; preserving history and its baseline.');
    }
  }
  // Quarantined rows are bounded by SEMA_MAX_QUARANTINE_SHARE and belong to this
  // run's ingest only; a retained snapshot must not claim them.
  if (_sourceHealth[SEMA_SOURCE].status === 'ok' && sema.quarantined?.length) {
    _sourceHealth[SEMA_SOURCE].quarantined = sema.quarantined;
    console.warn(`  SEMA quarantined ${sema.quarantined.length} row(s): ${sema.quarantined.map(q => `${q.id} ${q.reason}`).join(', ')}`);
  }
  const semaEntries = _sourceSnapshots[SEMA_SOURCE]?.records ?? [];
  const semaError = _sourceHealth[SEMA_SOURCE].status === 'ok' ? null : sema.error || 'SEMA_INVALID_RECORD';
  const ofacEntries = OFAC_SOURCES.flatMap(({ label }) => _sourceSnapshots[label]?.records ?? []);
  const entries = mergeSanctionEntries({ ofac: ofacEntries, sema: semaEntries });
  const datasetDate = Math.max(0, ...PRESSURE_SOURCES.map(source => _sourceSnapshots[source]?.publishedAt ?? 0));
  const cslEntries = CSL_SOURCES.flatMap(source => _sourceSnapshots[source]?.records ?? []);

  if (hasPrevious) {
    for (const entry of entries) {
      entry.isNew = !previousIds.has(entry.id);
    }
  }

  const sortedEntries = [...entries].sort(sortEntries);
  const totalCount = entries.length;
  const newEntryCount = hasPrevious ? entries.filter((entry) => entry.isNew).length : 0;
  const vesselCount = entries.filter((entry) => entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL').length;
  const aircraftCount = entries.filter((entry) => entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT').length;
  const unattributed = countUnattributed(entries);
  const _ofacAttribution = ofacAttributionHealth(ofacEntries);
  // Legacy retained snapshots predate target fields; preserve fresh parser failures
  // and explicit empty targets. Normalize health input only, not history evidence.
  const semaHealthEntries = _sourceHealth[SEMA_SOURCE].status === 'retained'
    ? semaEntries.map(entry => {
      if (Object.hasOwn(entry, '_targetCountryCodes')) return entry;
      const target = semaTargetCountry(entry._regime || '', entry.entityType);
      return { ...entry, _targetCountryCodes: target ? [target.code] : [] };
    })
    : semaEntries;
  const _semaAttribution = semaAttributionHealth(semaHealthEntries);
  console.log(`  Sanctions attribution: ${JSON.stringify({
    attribution: _ofacAttribution,
    semaRegimeCount: Object.keys(_semaAttribution.regimes).length,
    semaUnattributedCount: Object.values(_semaAttribution.regimes).reduce((sum, row) => sum + row.unattributedCount, 0),
    semaAttribution: _semaAttribution,
  })}`);
  if (_ofacAttribution.degraded) {
    console.warn(`  ${ATTRIBUTION_DEGRADED_ERROR_CODE}: OFAC ${JSON.stringify(_ofacAttribution)}`);
  }
  if (_semaAttribution.degraded) console.warn(`  ${ATTRIBUTION_DEGRADED_ERROR_CODE}: SEMA ${JSON.stringify(_semaAttribution)}`);
  const semaCount = semaEntries.length;
  const sdnCount = _sourceSnapshots.SDN?.records.length ?? 0;
  const consolidatedCount = _sourceSnapshots.CONSOLIDATED?.records.length ?? 0;
  console.log(`  Merged: ${totalCount} total (${sdnCount} SDN + ${consolidatedCount} consolidated + ${semaCount} SEMA), ${newEntryCount} new, ${vesselCount} vessels, ${aircraftCount} aircraft; ${cslEntries.length} CSL screening rows`);

  // Keep lookup identities separate from the pressure display projection.
  const _entityIndex = [...entries, ...cslEntries].map((e) => ({
    id: e.id,
    name: e.name,
    et: ET_CODE[e.entityType] ?? 'entity',
    cc: e.countryCodes.slice(0, 3),
    pr: e.programs.slice(0, 3),
    al: (e._aliases ?? []).slice(0, 10),
    ids: e._identifiers ?? [],
    sl: e.sourceLists,
  }));
  const legacyIndexBytes = Buffer.byteLength(JSON.stringify(_entityIndex.map(({ al, ids, sl, ...record }) => record)), 'utf8');
  const indexBytes = Buffer.byteLength(JSON.stringify(_entityIndex), 'utf8');
  console.log(`  Entity index: ${_entityIndex.length} records, ${legacyIndexBytes} -> ${indexBytes} bytes with screening identities`);

  const knownWindow = hasPrevious && validPressureClock(previousState.observedAt)
    && Number(previousState.observedAt) < now;
  const pressureMetadata = {
    schemaVersion: 1,
    sourceVersion: SANCTIONS_SOURCE_VERSION,
    population: 'top-12-first-iso2-display-v1',
    cohort: { computationAt: String(now), datasetDate: String(datasetDate), totalCount, newEntryCount },
    comparison: {
      kind: knownWindow ? 'id-set-difference' : hasPrevious ? 'window-unavailable' : 'baseline-unavailable',
      from: knownWindow ? previousState.observedAt : null,
      to: String(now),
    },
    sourceHealth: Object.fromEntries(PRESSURE_SOURCES.map(source => [source, _sourceHealth[source]]).map(([source, health]) => [source, {
      status: health.status, lastAttemptAt: health.lastAttemptAt, lastSuccessAt: health.lastSuccessAt,
      retainedUntil: health.retainedUntil, publishedAt: health.publishedAt, recordCount: health.recordCount,
      errorCode: health.errorCode,
      quarantinedCount: _sourceSnapshots[source]?.quarantinedCount ?? null,
    }])),
  };
  if (Buffer.byteLength(JSON.stringify(pressureMetadata), 'utf8') > 4096) {
    throw new Error('SANCTIONS_METADATA_TOO_LARGE');
  }

  return {
    fetchedAt: String(now),
    datasetDate: String(datasetDate),
    totalCount,
    sdnCount,
    consolidatedCount,
    semaCount,
    ...(semaError ? { semaError } : {}),
    newEntryCount,
    vesselCount,
    aircraftCount,
    unattributed,
    countries: buildCountryPressure(entries),
    flagRegistries: buildFlagRegistries(entries),
    regulationTargets: buildRegulationTargets(entries),
    programs: buildProgramPressure(entries),
    entries: sortedEntries.slice(0, DEFAULT_RECENT_LIMIT),
    pressureMetadata,
    _entityIndex,
    _sourceSnapshots,
    _sourceHealth,
    _changes,
    _ofacAttribution,
    _semaAttribution,
    _countryCounts: buildCountryCounts(entries),
    _state: {
      observedAt: String(now),
      entryIds: entries.map((entry) => entry.id),
    },
  };
}

function validate(data) {
  return ['totalCount', 'sdnCount', 'consolidatedCount', 'semaCount']
    .every(field => Number.isSafeInteger(data?.[field]) && data[field] >= 0);
}

export function declareRecords(data) {
  return data?.totalCount ?? 0;
}

export function sanctionsPressureContentMeta(data, nowMs) {
  return sanctionsListContentMeta(data, nowMs);
}

runSeed('sanctions', 'pressure', CANONICAL_KEY, fetchSanctionsPressure, {
  ttlSeconds: CACHE_TTL,
  // Keep the fetch deadline explicit and the lock alive longer so a slow
  // recovery cannot race a second run.
  lockTtlMs: 660_000,
  fetchPhaseTimeoutMs: FETCH_PHASE_TIMEOUT_MS,
  validateFn: validate,
  sourceVersion: SANCTIONS_SOURCE_VERSION,
  recordCount: (data) => data.totalCount ?? 0,
  contentMeta: sanctionsPressureContentMeta,
  maxContentAgeMin: SANCTIONS_MAX_CONTENT_AGE_MIN,
  // Strip internal-only fields before writing the main key so the pressure payload
  // does not include the entity index (~hundreds of KB) or state snapshot.
  publishTransform: (data) => {
    const { _entityIndex: _ei, _state: _s, _countryCounts: _cc, _sourceSnapshots, _sourceHealth, _changes, _ofacAttribution, _semaAttribution, pressureMetadata, ...rest } = data;
    if (Array.isArray(rest.entries)) {
      rest.entries = rest.entries.map((entry) => {
        const { _aliases, _identifiers, _publishedAt, _regime, _flagCode, _flagName, _aircraftHasCurrentTail, _targetCountryCodes, _targetCountryNames, ...publicEntry } = entry;
        return publicEntry;
      });
    }
    const canonical = { ...rest, _state: pressureMetadata };
    const projection = projectCountrySanctions(canonical, 'ZZ', Number(canonical.fetchedAt));
    if (projection.state === 'unavailable' && !(canonical.totalCount === 0
      && ['All sources unavailable', 'Empty producer sentinel'].includes(projection.reason))) {
      throw new Error(`Invalid canonical sanctions publication: ${projection.reason}`);
    }
    return canonical;
  },
  zeroIsValid: true,
  beforePublish: async (data) => {
    if (!data._changes) return;
    const creds = getOptionalUpstashCreds();
    if (!creds) {
      console.warn('  Sanctions change history credentials unavailable; skipping history publication.');
      return;
    }
    try {
      // Encode first: an oversized snapshot must abort before history moves past its baseline.
      const encodedSnapshots = encodeSourceSnapshots(data._sourceSnapshots);
      const currentGaps = data._changes.gaps.filter(gap => gap.to === data._changes.fetchedAt
        && gap.reason !== 'baseline-unavailable');
      await writeExtraKeyWithMeta(CHANGES_KEY, data._changes, CHANGES_TTL, data._changes.events.length,
        CHANGES_META_KEY, CHANGES_TTL, undefined, {
          sourceState: currentGaps.length ? 'error' : 'ok',
          errorCode: currentGaps.some(gap => gap.reason === 'held') ? 'SANCTIONS_CHANGES_HELD'
            : currentGaps.length ? 'SANCTIONS_CHANGES_SOURCE_FAILED' : null,
          failedSources: [...new Set(currentGaps.map(gap => gap.list))],
        });
      const count = Object.values(data._sourceSnapshots).reduce((sum, snapshot) => sum + (snapshot?.records.length ?? 0), 0);
      await writeExtraKeyWithMeta(SOURCE_SNAPSHOTS_KEY, encodedSnapshots, SOURCE_SNAPSHOTS_TTL, count, SOURCE_SNAPSHOTS_META_KEY);
      await upstashCommand(creds, ['SET', CHANGES_ACTIVATION_KEY, '1']);
    } catch {
      console.warn('  Sanctions change history publication failed; core sanctions publication will continue.');
    }
  },
  extraKeys: [
    {
      key: STATE_KEY,
      ttl: CACHE_TTL,
      transform: (data) => data._state,
    },
  ],
  // Publisher hooks own these keys, so runSeed cannot infer them from extraKeys.
  // Preserve their data and metadata with the canonical cohort on a run failure.
  preserveKeys: [
    ENTITY_INDEX_KEY,
    ENTITY_INDEX_META_KEY,
    COUNTRY_COUNTS_KEY,
    COUNTRY_COUNTS_META_KEY,
  ],
  // The private snapshots must outlive the 48h retention even when whole runs
  // fail; the canonical 18h preservation TTL would shrink them.
  preserveKeyTtls: [
    { key: SOURCE_SNAPSHOTS_KEY, ttlSeconds: SOURCE_SNAPSHOTS_TTL },
    { key: SOURCE_SNAPSHOTS_META_KEY, ttlSeconds: SOURCE_SNAPSHOTS_TTL },
  ],
  afterPublish: async (data, _ctx) => {
    // Write entity lookup index with seed-meta so health.js can monitor it.
    // Uses writeExtraKeyWithMeta rather than extraKeys because runSeed's extraKeys
    // calls writeExtraKey (no meta), and we need a seed-meta key for health tracking.
    const sourceHealth = data._sourceHealth;
    if (data._entityIndex) {
      // The index holds every source, so any outage degrades its health. CSL
      // outages degrade only this key: screening is their only published surface.
      const indexFailed = Object.keys(sourceHealth).filter(source => sourceHealth[source]?.status !== 'ok');
      const indexErrorCode = indexFailed.includes(SEMA_SOURCE) ? 'SEMA_INGEST_FAILED'
        : indexFailed.some(source => !CSL_SOURCES.includes(source)) ? 'OFAC_INGEST_FAILED'
          : indexFailed.length ? 'CSL_INGEST_FAILED' : null;
      await writeExtraKeyWithMeta(
        ENTITY_INDEX_KEY,
        data._entityIndex,
        CACHE_TTL,
        data._entityIndex.length,
        ENTITY_INDEX_META_KEY,
        undefined,
        undefined,
        { sourceState: indexFailed.length ? 'error' : 'ok', errorCode: indexErrorCode, failedSources: indexFailed },
      );
    }
    // Write full ISO2→count map for per-country sanctions lookup (no top-12 truncation).
    if (data._countryCounts) {
      await writeExtraKeyWithMeta(
        COUNTRY_COUNTS_KEY,
        data._countryCounts,
        CACHE_TTL,
        Object.keys(data._countryCounts).length,
        COUNTRY_COUNTS_META_KEY,
      );
    }
    delete data._state;
    delete data._entityIndex;
    delete data._countryCounts;
    const failedSources = PRESSURE_SOURCES.filter(source => sourceHealth[source].status !== 'ok');
    const attribution = data._ofacAttribution;
    const semaAttribution = data._semaAttribution;
    const attributionDegraded = attribution.degraded || semaAttribution.degraded;
    return {
      freshnessMetaPatch: {
        sourceState: failedSources.length ? 'error' : attributionDegraded ? 'degraded' : 'ok',
        errorCode: failedSources.includes(SEMA_SOURCE) ? 'SEMA_INGEST_FAILED' : failedSources.length ? 'OFAC_INGEST_FAILED'
          : attributionDegraded ? ATTRIBUTION_DEGRADED_ERROR_CODE : null,
        failedSources,
        sourceHealth: Object.fromEntries(PRESSURE_SOURCES.map(source => [source, sourceHealth[source]])),
        attribution,
        semaAttribution,
      },
      completionState: failedSources.length || attributionDegraded ? 'DEGRADED' : 'OK',
    };
  },

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 720,
});
