#!/usr/bin/env node

import { XMLParser } from 'fast-xml-parser';

import { CHROME_UA, loadEnvFile, runSeed, verifySeedKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'sanctions:pressure:v1';
const STATE_KEY = 'sanctions:pressure:state:v1';
const CACHE_TTL = 12 * 60 * 60;
const DEFAULT_RECENT_LIMIT = 60;
const OFAC_TIMEOUT_MS = 45_000;
const PROGRAM_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,24}$/;

const OFAC_SOURCES = [
  { label: 'SDN', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml' },
  { label: 'CONSOLIDATED', url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/cons_advanced.xml' },
];

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function listify(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value['#text'] === 'string') return value['#text'].trim();
    if (typeof value.NamePartValue === 'string') return value.NamePartValue.trim();
  }
  return '';
}

function buildEpoch(parts) {
  const year = Number(parts?.Year || 0);
  if (!year) return 0;
  const month = Math.max(1, Number(parts?.Month || 1));
  const day = Math.max(1, Number(parts?.Day || 1));
  return Date.UTC(year, month - 1, day);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function compactNote(value) {
  const note = String(value || '').replace(/\s+/g, ' ').trim();
  if (!note) return '';
  return note.length > 240 ? `${note.slice(0, 237)}...` : note;
}

function extractDocumentedName(documentedName) {
  const parts = listify(documentedName?.DocumentedNamePart)
    .map((part) => textValue(part?.NamePartValue))
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return textValue(documentedName);
}

function normalizeDateOfIssue(value) {
  const epoch = buildEpoch(value);
  return Number.isFinite(epoch) ? epoch : 0;
}

function buildReferenceMaps(doc) {
  const refs = doc?.ReferenceValueSets ?? {};
  const areaCodes = new Map();
  for (const area of listify(refs?.AreaCodeValues?.AreaCode)) {
    areaCodes.set(String(area.ID || ''), {
      code: textValue(area),
      name: String(area.Description || '').trim(),
    });
  }

  const featureTypes = new Map();
  for (const feature of listify(refs?.FeatureTypeValues?.FeatureType)) {
    featureTypes.set(String(feature.ID || ''), textValue(feature));
  }

  const legalBasis = new Map();
  for (const basis of listify(refs?.LegalBasisValues?.LegalBasis)) {
    legalBasis.set(String(basis.ID || ''), String(basis.LegalBasisShortRef || textValue(basis) || '').trim());
  }

  return { areaCodes, featureTypes, legalBasis };
}

function buildLocationMap(doc, areaCodes) {
  const locations = new Map();
  for (const location of listify(doc?.Locations?.Location)) {
    const ids = listify(location?.LocationAreaCode).map((item) => String(item.AreaCodeID || ''));
    const mapped = ids.map((id) => areaCodes.get(id)).filter(Boolean);
    // Sort code/name as pairs so codes[i] always corresponds to names[i]
    const pairs = [...new Map(mapped.map((item) => [item.code, item.name])).entries()]
      .filter(([code]) => code.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    locations.set(String(location.ID || ''), {
      codes: pairs.map(([code]) => code),
      names: pairs.map(([, name]) => name),
    });
  }
  return locations;
}

function extractPartyName(profile) {
  const identities = listify(profile?.Identity);
  const aliases = identities.flatMap((identity) => listify(identity?.Alias));
  const primaryAlias = aliases.find((alias) => alias?.Primary === 'true')
    || aliases.find((alias) => alias?.AliasTypeID === '1403')
    || aliases[0];
  return extractDocumentedName(primaryAlias?.DocumentedName);
}

function resolveEntityType(profile, featureTypes) {
  const subtype = String(profile?.PartySubTypeID || '');
  if (subtype === '1') return 'SANCTIONS_ENTITY_TYPE_VESSEL';
  if (subtype === '2') return 'SANCTIONS_ENTITY_TYPE_AIRCRAFT';

  const featureNames = listify(profile?.Feature)
    .map((feature) => featureTypes.get(String(feature?.FeatureTypeID || '')) || '')
    .filter(Boolean);

  if (featureNames.some((name) => /birth|citizenship|nationality/i.test(name))) {
    return 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL';
  }
  return 'SANCTIONS_ENTITY_TYPE_ENTITY';
}

function extractPartyCountries(profile, featureTypes, locations) {
  // Use a Map to deduplicate by code while preserving code→name alignment
  const seen = new Map();

  for (const feature of listify(profile?.Feature)) {
    const featureType = featureTypes.get(String(feature?.FeatureTypeID || '')) || '';
    if (!/location/i.test(featureType)) continue;

    const versions = listify(feature?.FeatureVersion);
    for (const version of versions) {
      const locationIds = listify(version?.VersionLocation).map((item) => String(item?.LocationID || ''));
      for (const locationId of locationIds) {
        const location = locations.get(locationId);
        if (!location) continue;
        location.codes.forEach((code, i) => {
          if (code && !seen.has(code)) seen.set(code, location.names[i] ?? '');
        });
      }
    }
  }

  const sorted = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    countryCodes: sorted.map(([c]) => c),
    countryNames: sorted.map(([, n]) => n),
  };
}

function buildPartyMap(doc, featureTypes, locations) {
  const parties = new Map();

  for (const distinctParty of listify(doc?.DistinctParties?.DistinctParty)) {
    const profile = distinctParty?.Profile;
    const profileId = String(profile?.ID || distinctParty?.FixedRef || '');
    if (!profileId) continue;

    parties.set(profileId, {
      name: extractPartyName(profile),
      entityType: resolveEntityType(profile, featureTypes),
      ...extractPartyCountries(profile, featureTypes, locations),
    });
  }

  return parties;
}

function extractPrograms(entry) {
  const directPrograms = listify(entry?.SanctionsMeasure)
    .map((measure) => textValue(measure?.Comment))
    .filter((value) => PROGRAM_CODE_RE.test(value));
  return uniqueSorted(directPrograms);
}

function extractEffectiveAt(entry) {
  const dates = [];

  for (const event of listify(entry?.EntryEvent)) {
    const epoch = buildEpoch(event?.Date);
    if (epoch > 0) dates.push(epoch);
  }

  for (const measure of listify(entry?.SanctionsMeasure)) {
    const epoch = buildEpoch(measure?.DatePeriod?.Start?.From || measure?.DatePeriod?.Start);
    if (epoch > 0) dates.push(epoch);
  }

  return dates.length > 0 ? Math.max(...dates) : 0;
}

function extractNote(entry, legalBasis) {
  const comments = listify(entry?.SanctionsMeasure)
    .map((measure) => textValue(measure?.Comment))
    .filter((value) => value && !PROGRAM_CODE_RE.test(value));
  if (comments.length > 0) return compactNote(comments[0]);

  const legal = listify(entry?.EntryEvent)
    .map((event) => legalBasis.get(String(event?.LegalBasisID || '')) || '')
    .filter(Boolean);
  return compactNote(legal[0] || '');
}

function buildEntriesForDocument(doc, sourceLabel) {
  const { areaCodes, featureTypes, legalBasis } = buildReferenceMaps(doc);
  const locations = buildLocationMap(doc, areaCodes);
  const parties = buildPartyMap(doc, featureTypes, locations);
  const datasetDate = normalizeDateOfIssue(doc?.DateOfIssue);
  const entries = [];

  for (const entry of listify(doc?.SanctionsEntries?.SanctionsEntry)) {
    const profileId = String(entry?.ProfileID || '');
    const party = parties.get(profileId);
    const name = party?.name || 'Unnamed designation';
    const programs = extractPrograms(entry);

    entries.push({
      id: `${sourceLabel}:${String(entry?.ID || profileId || name)}`,
      name,
      entityType: party?.entityType || 'SANCTIONS_ENTITY_TYPE_ENTITY',
      countryCodes: party?.countryCodes ?? [],
      countryNames: party?.countryNames ?? [],
      programs: programs.length > 0 ? programs : [sourceLabel],
      sourceLists: [sourceLabel],
      effectiveAt: String(extractEffectiveAt(entry)),
      isNew: false,
      note: extractNote(entry, legalBasis),
    });
  }

  return { entries, datasetDate };
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

async function fetchSource(source) {
  console.log(`  Fetching OFAC ${source.label}...`);
  const t0 = Date.now();
  const response = await fetch(source.url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(OFAC_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OFAC ${source.label} HTTP ${response.status}`);
  }
  const xml = await response.text();
  console.log(`  ${source.label}: ${(xml.length / 1024).toFixed(0)}KB downloaded (${Date.now() - t0}ms)`);
  const parsed = XML_PARSER.parse(xml)?.Sanctions;
  if (!parsed) throw new Error(`OFAC ${source.label} parse returned no Sanctions root`);
  const result = buildEntriesForDocument(parsed, source.label);
  console.log(`  ${source.label}: ${result.entries.length} entries parsed`);
  return result;
}

async function fetchSanctionsPressure() {
  const previousState = await verifySeedKey(STATE_KEY).catch(() => null);
  const previousIds = new Set(Array.isArray(previousState?.entryIds) ? previousState.entryIds.map((id) => String(id)) : []);
  const hasPrevious = previousIds.size > 0;
  console.log(`  Previous state: ${hasPrevious ? `${previousIds.size} known IDs` : 'none (first run or expired)'}`);

  // Sequential fetch to halve peak heap: SDN (~10MB) then Consolidated (~20MB).
  // Combined parallel parse can approach 150MB, tight against the 512MB limit.
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
  extraKeys: [
    {
      key: STATE_KEY,
      ttl: CACHE_TTL,
      transform: (data) => data._state,
    },
  ],
  afterPublish: async (data, _ctx) => {
    delete data._state;
  },
});
