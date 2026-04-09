#!/usr/bin/env node

// SAX streaming parser: response.body is piped chunk-by-chunk into the parser.
// The full XML string is never held in memory, which avoids the OOM crash that
// occurred when fast-xml-parser tried to build a ~300MB object tree from a
// 120MB XML download against Railway's 512MB container limit.
import sax from 'sax';

import { CHROME_UA, loadEnvFile, runSeed, verifySeedKey, writeExtraKeyWithMeta } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'sanctions:pressure:v1';
const STATE_KEY = 'sanctions:pressure:state:v1';
const ENTITY_INDEX_KEY = 'sanctions:entities:v1';
const COUNTRY_COUNTS_KEY = 'sanctions:country-counts:v1';
const CACHE_TTL = 15 * 60 * 60; // 15h — 3h buffer over 12h cron cadence (was 12h = 0 buffer)
// Compact entity type codes for the lookup index (saves space vs full enum strings)
const ET_CODE = {
  SANCTIONS_ENTITY_TYPE_VESSEL: 'vessel',
  SANCTIONS_ENTITY_TYPE_AIRCRAFT: 'aircraft',
  SANCTIONS_ENTITY_TYPE_INDIVIDUAL: 'individual',
  SANCTIONS_ENTITY_TYPE_ENTITY: 'entity',
};
const DEFAULT_RECENT_LIMIT = 60;
const OFAC_TIMEOUT_MS = 45_000;
const PROGRAM_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,24}$/;

const OFAC_SOURCES = [
  { label: 'SDN', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml' },
  { label: 'CONSOLIDATED', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/cons_advanced.xml' },
];

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
    const codes = entry.countryCodes.length > 0 ? entry.countryCodes : ['XX'];
    const names = entry.countryNames.length > 0 ? entry.countryNames : ['Unknown'];
    codes.forEach((code, index) => {
      const key = `${code}:${names[index] || names[0] || 'Unknown'}`;
      const current = map.get(key) || {
        countryCode: code,
        countryName: names[index] || names[0] || 'Unknown',
        entryCount: 0,
        newEntryCount: 0,
        vesselCount: 0,
        aircraftCount: 0,
      };
      current.entryCount += 1;
      if (entry.isNew) current.newEntryCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_VESSEL') current.vesselCount += 1;
      if (entry.entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT') current.aircraftCount += 1;
      map.set(key, current);
    });
  }
  return [...map.values()]
    .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount || a.countryName.localeCompare(b.countryName))
    .slice(0, 12);
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
async function fetchSource(source) {
  console.log(`  Fetching OFAC ${source.label}...`);
  const t0 = Date.now();
  const response = await fetch(source.url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(OFAC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OFAC ${source.label} HTTP ${response.status}`);

  return new Promise((resolve, reject) => {
    // strict=true: case-sensitive tag names. xmlns=false: we strip prefixes manually.
    const parser = sax.parser(true, { trim: false, normalize: false });

    // ── Reference maps (built first, small, kept for cross-reference) ──────────
    const areaCodes   = new Map(); // ID → { code, name }
    const featureTypes = new Map(); // ID → label string
    const legalBasis  = new Map(); // ID → shortRef string
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
    let inFeatureTypeValues = false;
    let inLegalBasisValues  = false;
    let inLocations         = false;
    let inDistinctParties   = false;
    let inSanctionsEntries  = false;

    // ── Current-object accumulators ────────────────────────────────────────────
    // DateOfIssue
    let doiYear = 0, doiMonth = 1, doiDay = 1;

    // AreaCode / FeatureType / LegalBasis (reference value section)
    let refId = '', refShortRef = '', refDescription = '';

    // Location
    let locId = '';
    let locAreaCodeIds = null; // string[] | null

    // DistinctParty / Profile
    let partyFixedRef = '';
    let profileId = '', profileSubTypeId = '';
    let aliases = null;          // Alias[]
    let curAlias = null;         // { primary, typeId, nameParts[] }
    let inDocumentedName = false;
    let namePartsBuf = null;     // string[] collecting NamePartValue text
    let profileFeatures = null;  // Feature[]
    let curFeature = null;       // { featureTypeId, locationIds[] }

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

    function resolveLocation(locId) {
      const ids = locAreaCodeIds;
      const mapped = ids.map((id) => areaCodes.get(id)).filter(Boolean);
      const pairs = [...new Map(mapped.map((item) => [item.code, item.name])).entries()]
        .filter(([code]) => code.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      return { codes: pairs.map(([c]) => c), names: pairs.map(([, n]) => n) };
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
          loc.codes.forEach((code, i) => { if (code && !seen.has(code)) seen.set(code, loc.names[i] ?? ''); });
        }
      }
      const sorted = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));

      parties.set(profileId, {
        name,
        entityType,
        countryCodes: sorted.map(([c]) => c),
        countryNames: sorted.map(([, n]) => n),
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
      });
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
        case 'FeatureTypeValues': inFeatureTypeValues = true; break;
        case 'LegalBasisValues':  inLegalBasisValues = true; break;
        case 'Locations':         inLocations = true; break;
        case 'DistinctParties':   inDistinctParties = true; break;
        case 'SanctionsEntries':  inSanctionsEntries = true; break;

        // ── Reference values ──
        case 'AreaCode':
          if (inAreaCodeValues) { refId = attrs.ID || ''; refDescription = attrs.Description || ''; }
          break;
        case 'FeatureType':
          if (inFeatureTypeValues) refId = attrs.ID || '';
          break;
        case 'LegalBasis':
          if (inLegalBasisValues) { refId = attrs.ID || ''; refShortRef = attrs.LegalBasisShortRef || ''; }
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
          if (inDistinctParties) { profileId = attrs.ID || partyFixedRef; profileSubTypeId = attrs.PartySubTypeID || ''; }
          break;
        case 'Alias':
          if (inDistinctParties) curAlias = { primary: attrs.Primary === 'true', typeId: attrs.AliasTypeID || '', nameParts: [] };
          break;
        case 'DocumentedName':
          if (curAlias) { inDocumentedName = true; namePartsBuf = []; }
          break;
        case 'Feature':
          if (inDistinctParties) curFeature = { featureTypeId: attrs.FeatureTypeID || '', locationIds: [] };
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
        case 'FeatureTypeValues': inFeatureTypeValues = false; break;
        case 'LegalBasisValues':  inLegalBasisValues = false; break;
        case 'Locations':         inLocations = false; break;
        case 'DistinctParties':   inDistinctParties = false; break;
        case 'SanctionsEntries':  inSanctionsEntries = false; break;

        // ── Reference values ──
        case 'AreaCode':
          if (inAreaCodeValues && refId) areaCodes.set(refId, { code: t, name: refDescription });
          break;
        case 'FeatureType':
          if (inFeatureTypeValues && refId) featureTypes.set(refId, t);
          break;
        case 'LegalBasis':
          if (inLegalBasisValues && refId) legalBasis.set(refId, refShortRef || t);
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
          profileId = ''; profileSubTypeId = ''; aliases = []; profileFeatures = [];
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
  const previousState = await verifySeedKey(STATE_KEY).catch(() => null);
  const previousIds = new Set(Array.isArray(previousState?.entryIds) ? previousState.entryIds.map((id) => String(id)) : []);
  const hasPrevious = previousIds.size > 0;
  console.log(`  Previous state: ${hasPrevious ? `${previousIds.size} known IDs` : 'none (first run or expired)'}`);

  // Sequential fetch: SDN then Consolidated. SAX streaming keeps peak RAM low
  // regardless of file size — no full XML string or DOM tree is ever built.
  const results = [];
  for (const source of OFAC_SOURCES) {
    results.push(await fetchSource(source));
  }
  const entries = results.flatMap((result) => result.entries);
  const datasetDate = results.reduce((max, result) => Math.max(max, result.datasetDate || 0), 0);

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
  console.log(`  Merged: ${totalCount} total (${results[0]?.entries.length ?? 0} SDN + ${results[1]?.entries.length ?? 0} consolidated), ${newEntryCount} new, ${vesselCount} vessels, ${aircraftCount} aircraft`);

  // Build compact entity index for name-based lookup (Phase 1 — issue #2042).
  // Each record: { id, name, et (compact type), cc (country codes), pr (programs) }
  // Stored as a flat array in a single Redis key for O(N) in-memory search.
  const _entityIndex = entries.map((e) => ({
    id: e.id,
    name: e.name,
    et: ET_CODE[e.entityType] ?? 'entity',
    cc: e.countryCodes.slice(0, 3),
    pr: e.programs.slice(0, 3),
  }));
  console.log(`  Entity index: ${_entityIndex.length} records (~${Math.round(JSON.stringify(_entityIndex).length / 1024)}KB)`);

  return {
    fetchedAt: String(Date.now()),
    datasetDate: String(datasetDate),
    totalCount,
    sdnCount: results[0]?.entries.length ?? 0,
    consolidatedCount: results[1]?.entries.length ?? 0,
    newEntryCount,
    vesselCount,
    aircraftCount,
    countries: buildCountryPressure(entries),
    programs: buildProgramPressure(entries),
    entries: sortedEntries.slice(0, DEFAULT_RECENT_LIMIT),
    _entityIndex,
    _countryCounts: buildCountryCounts(entries),
    _state: {
      entryIds: entries.map((entry) => entry.id),
    },
  };
}

function validate(data) {
  return (data?.totalCount ?? 0) > 0;
}

runSeed('sanctions', 'pressure', CANONICAL_KEY, fetchSanctionsPressure, {
  ttlSeconds: CACHE_TTL,
  validateFn: validate,
  sourceVersion: 'ofac-sls-advanced-xml-v1',
  recordCount: (data) => data.totalCount ?? 0,
  // Strip internal-only fields before writing the main key so the pressure payload
  // does not include the entity index (~hundreds of KB) or state snapshot.
  publishTransform: (data) => {
    const { _entityIndex: _ei, _state: _s, _countryCounts: _cc, ...rest } = data;
    return rest;
  },
  extraKeys: [
    {
      key: STATE_KEY,
      ttl: CACHE_TTL,
      transform: (data) => data._state,
    },
    {
      key: COUNTRY_COUNTS_KEY,
      ttl: CACHE_TTL,
      transform: (data) => data._countryCounts,
    },
  ],
  afterPublish: async (data, _ctx) => {
    // Write entity lookup index with seed-meta so health.js can monitor it.
    // Uses writeExtraKeyWithMeta rather than extraKeys because runSeed's extraKeys
    // calls writeExtraKey (no meta), and we need a seed-meta key for health tracking.
    if (data._entityIndex) {
      await writeExtraKeyWithMeta(
        ENTITY_INDEX_KEY,
        data._entityIndex,
        CACHE_TTL,
        data._entityIndex.length,
      );
    }
    // Write full ISO2→count map for per-country sanctions lookup (no top-12 truncation).
    if (data._countryCounts) {
      await writeExtraKeyWithMeta(
        COUNTRY_COUNTS_KEY,
        data._countryCounts,
        CACHE_TTL,
        Object.keys(data._countryCounts).length,
      );
    }
    delete data._state;
    delete data._entityIndex;
    delete data._countryCounts;
  },
});
