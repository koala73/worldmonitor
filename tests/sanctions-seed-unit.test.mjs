import { buildSanctionsChanges } from '../scripts/_sanctions-changes.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import sax from 'sax';
import { ingestSemaEntries, mergeSanctionEntries, ofacRegistrationToIdentifier, parseSemaXml, SEMA_SOURCE, SEMA_TIMEOUT_MS, SANCTIONS_SOURCE_VERSION } from '../scripts/_sema-sanctions.mjs';
import { CSL_ROW_ID, CSL_SOURCES, CSL_TIMEOUT_MS } from '../scripts/_csl-sanctions.mjs';
import { aircraftRegistrationCountry } from '../scripts/shared/aircraft-registration-country.mjs';
import { countryNameToIso2, COUNTRY_NAME_TO_ISO2, normalizeCountryToken } from '../scripts/shared/country-name-to-iso2.cjs';

// Normalize values produced inside a vm context to host-realm equivalents.
// Needed because deepStrictEqual checks prototypes — vm Arrays ≠ host Arrays.
function normalize(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Load pure helper functions from the seed script in an isolated vm context.
// This avoids the ESM side-effects (loadEnvFile, runSeed) that fire on import.
// We strip: import lines, loadEnvFile() call, async network functions, runSeed.
// The SAX rewrite replaced all DOM-helper functions (listify, textValue, buildEpoch,
// buildReferenceMaps, buildLocationMap, extractPartyName, etc.) with a streaming
// state machine inside fetchSource. Only pure output-stage helpers remain testable.
// ---------------------------------------------------------------------------
const seedSrc = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');

const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);/, '')
  .replace(/async function fetchSource[\s\S]*/, ''); // remove network + runSeed tail

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp, SEMA_SOURCE, CSL_SOURCES, CSL_ROW_ID, COUNTRY_NAME_TO_ISO2, normalizeCountryToken });
vm.runInContext(pureSrc, ctx);

const {
  uniqueSorted,
  compactNote,
  sortEntries,
  buildCountryPressure,
  buildCountryCounts,
  buildProgramPressure,
} = ctx;

const fetchPressureSrc = seedSrc.slice(
  seedSrc.indexOf('async function fetchSanctionsPressure()'),
  seedSrc.indexOf('\nfunction validate('),
);

it('attributes OFAC vessels by flag and aircraft by registry, leaving unknown, false and former ones unattributed', async () => {
  const party = (subType) => (id, type, ...details) => `
    <DistinctParty><Profile ID="${id}" PartySubTypeID="${subType}">
      <Feature FeatureTypeID="${type}">
        ${details.map(detail => `<FeatureVersion><VersionDetail DetailTypeID="1432">${detail}</VersionDetail></FeatureVersion>`).join('')}
      </Feature>
    </Profile></DistinctParty>`;
  const profile = party(1);
  const aircraft = party(2);
  const xml = `<Sanctions>
    <CountryValues>
      <Country ID="11171" ISO2="RU">Russia</Country>
      <Country ID="11120" ISO2="KP">Korea, North</Country>
    </CountryValues>
    <FeatureTypeValues>
      <FeatureType ID="3">Vessel Flag</FeatureType>
      <FeatureType ID="24">Former Vessel Flag</FeatureType>
      <FeatureType ID="49">Previous Aircraft Tail Number</FeatureType>
      <FeatureType ID="64">Aircraft Tail Number</FeatureType>
    </FeatureTypeValues>
    <DistinctParties>
      ${profile('1', '3', 'Russia')}
      ${profile('2', '3', 'Unknown')}
      ${profile('3', '24', 'Russia')}
      ${profile('4', '3', "Democratic People's Republic of Korea")}
      ${profile('5', '3', "Democratic People's Republic of Korea", 'Korea, North')}
      ${profile('6', '3', "Democratic People's Republic of Korea", 'Russia')}
      ${profile('7', '3', "Democratic People's Republic of Korea", 'Unknown')}
      ${profile('8', '3', 'Gambia')}
      ${profile('9', '3', 'Cook Islands')}
      ${profile('10', '3', 'Antigua &amp; Barbuda')}
      ${profile('11', '3', 'Mozambique (False)')}
      ${aircraft('12', '64', 'EP-MMH')}
      ${aircraft('13', '64', 'YV2040')}
      ${aircraft('14', '64', 'RA-89049', 'EP-MMH')}
      ${aircraft('15', '49', 'EP-MMH')}
      ${profile('16', '3', 'Panama (Former)')}
      ${profile('17', '3', 'Panama (Disputed)')}
      ${profile('18', '3', 'Congo (Kinshasa)')}
      ${['Iran (Islamic Republic of)', 'Bolivia (Plurinational State of)', 'Venezuela (Bolivarian Republic of)', 'Tanzania (United Republic of)', 'Micronesia (Federated States of)', 'Moldova (Republic of)', 'Netherlands (Kingdom of the)', 'Taiwan (Province of China)'].map((name, i) => profile(String(i + 19), '3', name)).join('')}
    </DistinctParties>
    <SanctionsEntries>
      <SanctionsEntry ID="1" ProfileID="1"/>
      <SanctionsEntry ID="2" ProfileID="2"><Comment>RUSSIA-EO14024</Comment></SanctionsEntry>
      <SanctionsEntry ID="3" ProfileID="3"/>
      <SanctionsEntry ID="4" ProfileID="4"/>
      <SanctionsEntry ID="5" ProfileID="5"/>
      <SanctionsEntry ID="6" ProfileID="6"/>
      <SanctionsEntry ID="7" ProfileID="7"/>
      ${Array.from({ length: 19 }, (_, i) => `<SanctionsEntry ID="${i + 8}" ProfileID="${i + 8}"/>`).join('')}
    </SanctionsEntries>
  </Sanctions>`;
  const context = vm.createContext({
    console: { log() {}, warn() {} }, sax, TextDecoder, ofacRegistrationToIdentifier,
    aircraftRegistrationCountry, countryNameToIso2, COUNTRY_NAME_TO_ISO2, normalizeCountryToken, SEMA_SOURCE, CSL_SOURCES, CSL_ROW_ID,
    fetchOfacSourceResponse: async () => new Response(xml),
  });
  const fetchSourceSrc = seedSrc.slice(seedSrc.indexOf('async function fetchSource('), seedSrc.indexOf(fetchPressureSrc));
  vm.runInContext(`${pureSrc}\n${fetchSourceSrc}`, context);
  const { entries } = await context.fetchSource({ label: 'SDN' });
  assert.deepEqual(normalize(entries.map(entry => entry._flagCode ?? null)), [
    'RU', null, null, 'KP', 'KP', null, null,
    'GM', 'CK', 'AG', null,
    'IR', 'VE', null, null,
    null, null, 'CD', 'IR', 'BO', 'VE', 'TZ', 'FM', 'MD', 'NL', 'TW',
  ]);
  assert.equal(entries[0]._flagName, 'Russia');
  assert.equal(entries[3]._flagName, 'Korea, North');
  assert.equal(entries[8]._flagName, 'Cook Islands', 'a flag missing from OFAC\'s list still gets a name');
  assert.equal(entries[11]._aircraftHasCurrentTail, true);
  assert.equal(entries[14]._aircraftHasCurrentTail, false);
  assert.equal(entries[11].entityType, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT');
  assert.ok(entries.every(entry => entry.countryCodes.length === 0), 'a flag or registry is not a country association');
});

it('keeps linked-parent attribution separate and uses only current directional parent links', async () => {
  const party = (id, country = false, subType = '3') => `<DistinctParty><Profile ID="${id}" PartySubTypeID="${subType}">
    ${country ? '<Feature FeatureTypeID="1"><FeatureVersion><VersionLocation LocationID="1"/></FeatureVersion></Feature>' : ''}
  </Profile></DistinctParty>`;
  const link = (from, to, type = 'owns', former = 'false') => `<ProfileRelationship From-ProfileID="${from}" To-ProfileID="${to}" RelationTypeID="${type}" Former="${former}"/>`;
  const xml = `<Sanctions>
    <AreaCodeValues><AreaCode ID="1" Description="Russia">RU</AreaCode></AreaCodeValues>
    <FeatureTypeValues><FeatureType ID="1">Location</FeatureType></FeatureTypeValues>
    <RelationTypeValues><RelationType ID="owns">Owned or Controlled By</RelationType><RelationType ID="reverse">Owns, controls, or operates</RelationType><RelationType ID="associate">Associate Of</RelationType><RelationType ID="acting">Acting for or on behalf of</RelationType><RelationType ID="property">Property in the interest of</RelationType><RelationType ID="linked">Linked To</RelationType></RelationTypeValues>
    <Locations><Location ID="1"><LocationAreaCode AreaCodeID="1"/></Location></Locations>
    <DistinctParties>${party('1', true)}${party('2')}${party('3')}${party('4', true)}${party('5', false, '1')}${party('6')}${party('7')}${party('8')}${party('9')}${party('10')}${party('11')}${party('12')}${party('13')}</DistinctParties>
    <SanctionsEntries>${Array.from({ length: 13 }, (_, i) => `<SanctionsEntry ID="${i + 1}" ProfileID="${i + 1}"/>`).join('')}</SanctionsEntries>
    <ProfileRelationships>${link('2', '1')}${link('3', '1', 'owns', 'true')}${link('4', '1')}${link('5', '1')}${link('6', '1', 'associate')}${link('1', '7', 'reverse')}${link('8', 'missing')}${link('9', '10')}${link('10', '9')}${link('11', '1', 'acting')}${link('12', '1', 'property')}${link('13', '1', 'linked')}</ProfileRelationships>
  </Sanctions>`;
  const context = vm.createContext({ console: { log() {}, warn() {} }, sax, TextDecoder,
    ofacRegistrationToIdentifier, aircraftRegistrationCountry, countryNameToIso2, COUNTRY_NAME_TO_ISO2, normalizeCountryToken, SEMA_SOURCE, CSL_SOURCES, CSL_ROW_ID,
    fetchOfacSourceResponse: async () => new Response(xml) });
  vm.runInContext(`${pureSrc}\n${seedSrc.slice(seedSrc.indexOf('async function fetchSource('), seedSrc.indexOf(fetchPressureSrc))}`, context);
  const { entries } = await context.fetchSource({ label: 'SDN' });
  assert.deepEqual(normalize(entries[1].parentCountryCodes), ['RU']);
  assert.deepEqual(normalize(entries[1].parentCountryNames), ['Russia']);
  assert.deepEqual(normalize(entries[6].parentCountryCodes), ['RU']);
  for (const i of [10, 11]) assert.deepEqual(normalize(entries[i].parentCountryCodes), ['RU']);
  for (const i of [0, 2, 3, 4, 5, 7, 8, 9, 12]) assert.deepEqual(normalize(entries[i].parentCountryCodes), [], `entry ${i + 1}`);
  assert.deepEqual(normalize(context.buildCountryCounts(entries)), { RU: 2 }, 'parent links never become address or risk evidence');
  assert.deepEqual(normalize(entries[1].countryCodes), []);
  assert.equal(context.countUnattributed([entries[1]]).entryCount, 0);
});

it('keeps vessel flags out of the country counts that drive risk scores and briefs', async () => {
  const xml = `<Sanctions>
    <AreaCodeValues><AreaCode ID="1" Description="Russia">RU</AreaCode></AreaCodeValues>
    <CountryValues>
      <Country ID="11171" ISO2="RU">Russia</Country>
      <Country ID="11160" ISO2="PA">Panama</Country>
    </CountryValues>
    <FeatureTypeValues>
      <FeatureType ID="3">Vessel Flag</FeatureType>
      <FeatureType ID="25">Location</FeatureType>
      <FeatureType ID="64">Aircraft Tail Number</FeatureType>
    </FeatureTypeValues>
    <Locations><Location ID="900"><LocationAreaCode AreaCodeID="1"/></Location></Locations>
    <DistinctParties>
      <DistinctParty><Profile ID="1" PartySubTypeID="4">
        <Feature FeatureTypeID="25"><FeatureVersion><VersionLocation LocationID="900"/></FeatureVersion></Feature>
      </Profile></DistinctParty>
      <DistinctParty><Profile ID="2" PartySubTypeID="1">
        <Feature FeatureTypeID="3"><FeatureVersion><VersionDetail DetailTypeID="1432">Panama</VersionDetail></FeatureVersion></Feature>
      </Profile></DistinctParty>
      <DistinctParty><Profile ID="3" PartySubTypeID="1">
        <Feature FeatureTypeID="3"><FeatureVersion><VersionDetail DetailTypeID="1432">Panama</VersionDetail></FeatureVersion></Feature>
      </Profile></DistinctParty>
      <DistinctParty><Profile ID="4" PartySubTypeID="2">
        <Feature FeatureTypeID="64"><FeatureVersion><VersionDetail DetailTypeID="1432">EP-MMH</VersionDetail></FeatureVersion></Feature>
      </Profile></DistinctParty>
    </DistinctParties>
    <SanctionsEntries>
      <SanctionsEntry ID="1" ProfileID="1"/>
      <SanctionsEntry ID="2" ProfileID="2"/>
      <SanctionsEntry ID="3" ProfileID="3"/>
      <SanctionsEntry ID="4" ProfileID="4"/>
    </SanctionsEntries>
  </Sanctions>`;
  const context = vm.createContext({
    console: { log() {}, warn() {} }, sax, TextDecoder, ofacRegistrationToIdentifier,
    aircraftRegistrationCountry, countryNameToIso2, COUNTRY_NAME_TO_ISO2, normalizeCountryToken, SEMA_SOURCE, CSL_SOURCES, CSL_ROW_ID,
    fetchOfacSourceResponse: async () => new Response(xml),
  });
  const fetchSourceSrc = seedSrc.slice(seedSrc.indexOf('async function fetchSource('), seedSrc.indexOf(fetchPressureSrc));
  vm.runInContext(`${pureSrc}\n${fetchSourceSrc}`, context);
  const { entries } = await context.fetchSource({ label: 'SDN' });
  entries[1].isNew = true;

  assert.deepEqual(normalize(context.buildCountryCounts(entries)), { RU: 1 },
    'sanctions:country-counts:v1 feeds sanctionsBoost, so a Panama flag must not count as Panama');
  assert.deepEqual(normalize(context.buildCountryPressure(entries).map(row => row.countryCode)), ['RU'],
    'the top-12 rows feed the new-entry boost, forecasts and country signals');
  assert.deepEqual(normalize(context.buildFlagRegistries(entries)), [
    { countryCode: 'PA', countryName: 'Panama', vesselCount: 2, newVesselCount: 1, aircraftCount: 0, newAircraftCount: 0 },
    { countryCode: 'IR', countryName: 'Iran', vesselCount: 0, newVesselCount: 0, aircraftCount: 1, newAircraftCount: 0 },
  ]);
  assert.deepEqual(normalize(context.countUnattributed(entries)), { entryCount: 0, vesselCount: 0, aircraftCount: 0 },
    'a flagged vessel or registered aircraft is attributed to its registry');
});

async function partialPublication({ sources = ['CONSOLIDATED'], cached = [], snapshots = null, semaJson, deadlines = {} } = {}) {
  const context = vm.createContext({
    console: { log() {}, warn() {} }, COUNTRY_NAME_TO_ISO2, normalizeCountryToken,
    SEMA_SOURCE, SEMA_TIMEOUT_MS, CSL_TIMEOUT_MS, SANCTIONS_SOURCE_VERSION, Buffer, gzipSync, gunzipSync,
    mergeSanctionEntries, buildSanctionsChanges,
    verifySeedKey: async (key) => key === 'sanctions:pressure:v1' ? { entries: cached } : null,
    readSeedSnapshot: async key => key === 'sanctions:source-snapshots:v1' ? snapshots : null,
    ingestSemaEntries: semaJson === undefined
      ? async () => ({ records: [], publishedAtMs: 0, error: 'SEMA_INVALID_RECORD' })
      : () => ingestSemaEntries({ fetchFn: async () => new Response(JSON.stringify(semaJson)) }),
    CSL_SOURCES, CSL_ROW_ID, ingestCslEntries: async ({ deadlineAt }) => {
      deadlines.csl = deadlineAt;
      return { lists: {}, error: 'CSL_FIXTURE_OFF' };
    },
    fetchSource: async ({ label }, { deadlineAt }) => {
      deadlines[label] = deadlineAt;
      if (!sources.includes(label)) throw new Error('source timeout');
      return {
        datasetDate: Date.UTC(2026, 8, 14),
        entries: [{ id: `${label}:1`, name: `${label} entity`, sourceLists: [label],
          countryCodes: ['RU'], countryNames: ['Russia'], programs: [label],
          _aliases: Array.from({ length: 12 }, (_, i) => `Alias ${i}`), _identifiers: ['imo:1234567'],
          entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', effectiveAt: '0', isNew: false }],
      };
    },
  });
  vm.runInContext(`${pureSrc}\n${fetchPressureSrc}\nglobalThis.FETCH_PHASE_TIMEOUT_MS = FETCH_PHASE_TIMEOUT_MS;`, context);
  deadlines.fetchPhaseTimeoutMs = context.FETCH_PHASE_TIMEOUT_MS;
  return normalize(await context.fetchSanctionsPressure());
}

describe('partial sanctions publication', () => {
  it('publishes valid JSON and retains only eligible cached rows on JSON failure', async () => {
    const semaJson = JSON.parse(readFileSync(new URL('./fixtures/sema-table-slice.json', import.meta.url), 'utf8'));
    const healthy = await partialPublication({ semaJson });
    assert.equal(healthy.semaCount, semaJson.data.length);
    assert.equal(healthy.semaError, undefined);
    assert.equal(healthy._semaAttribution.regimes['Myanmar (Burma)'].targetExpected, true);
    assert.ok(healthy.entries.some(row => row.id === 'sema-ca:russia:1-1:731'));
    const cached = healthy.entries.filter(row => row.sourceLists.includes(SEMA_SOURCE));
    cached.push({ ...cached[0], id: 'sema-ca:unspecified:unspecified:0', name: '1, Part 1' });
    const snapshots = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify(healthy._sourceSnapshots)).toString('base64') };
    semaJson.data[1]['Item Number'] = '';
    const failed = await partialPublication({ semaJson, cached, snapshots });
    assert.equal(failed.semaError, 'SEMA_INVALID_RECORD');
    assert.equal(failed.semaCount, cached.length - 1);
    assert.equal(failed.sdnCount, 0);
    assert.equal(failed.consolidatedCount, 1);
    assert.ok(!failed.entries.some(row => row.id.endsWith(':0')));
  });

  it('keeps Consolidated counts attributed when SDN fails', async () => {
    const data = await partialPublication();
    assert.equal(data.sdnCount, 0);
    assert.equal(data.consolidatedCount, 1);
    assert.equal(data.entries[0].sourceLists[0], 'CONSOLIDATED');
    assert.equal(data.datasetDate, String(Date.UTC(2026, 8, 14)));
    assert.equal(data.semaError, 'SEMA_INVALID_RECORD');
  });

  it('keeps SDN counts attributed when Consolidated fails', async () => {
    const data = await partialPublication({ sources: ['SDN'] });
    assert.equal(data.sdnCount, 1);
    assert.equal(data.consolidatedCount, 0);
  });

  it('publishes bounded aliases, IMO identifiers and source lists in the screening index', async () => {
    const data = await partialPublication({ sources: ['SDN'] });
    assert.equal(data._entityIndex[0].al.length, 10);
    assert.deepEqual(data._entityIndex[0].ids, ['imo:1234567']);
    assert.deepEqual(data._entityIndex[0].sl, ['SDN']);
  });

  it('counts both sources when both succeed', async () => {
    const data = await partialPublication({ sources: ['SDN', 'CONSOLIDATED'] });
    assert.equal(data.sdnCount, 1);
    assert.equal(data.consolidatedCount, 1);
    assert.equal(data.totalCount, 2);
  });

  it('does not republish the malformed retained Canadian identities', async () => {
    const cached = ['sema-ca:unspecified:unspecified:0', 'sema-ca:1972:unspecified:0'].map((id) => ({
      id, name: '1, Part 1', sourceLists: [SEMA_SOURCE], countryCodes: [], countryNames: [],
      programs: ['SEMA'], entityType: 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL', effectiveAt: '0', isNew: false,
    }));
    const data = await partialPublication({ cached });
    assert.equal(data.semaCount, 0);
    assert.equal(data.totalCount, 1);
    assert.ok(data.entries.every((e) => !e.sourceLists.includes(SEMA_SOURCE)));
    assert.ok(data._entityIndex.every((e) => !e.id.startsWith('sema-ca:')));
    assert.equal((await partialPublication({ sources: [], cached })).totalCount, 0);
  });

  it('retains valid undated cached identities with an optional schedule', async () => {
    const { records } = parseSemaXml('<record><Country>Russia</Country><Item>7</Item><LastName>Example</LastName></record>');
    const cached = records.map(({ _aliases, _identifiers, _publishedAt, _regime, ...entry }) => entry);
    const fetchedAt = Date.now() - 1000;
    const snapshots = { version: 1, encoding: 'gzip-base64', data: gzipSync(JSON.stringify({
      [SEMA_SOURCE]: { version: 1, fetchedAt, retainedUntil: fetchedAt + 48 * 3600000, publishedAt: 0, records: cached },
    })).toString('base64') };
    const data = await partialPublication({ snapshots });
    assert.equal(data.semaCount, 1);
    assert.equal(data.totalCount, 2);
    assert.equal(data.entries.find((e) => e.id === records[0].id).effectiveAt, '0');
    assert.equal(data.semaError, 'SEMA_INVALID_RECORD');
  });

  // runSeed discards the whole run at the fetch-phase timeout, so OFAC must stop
  // early enough for SEMA and the CSL download that run after it.
  it('ends the OFAC fetches early enough for SEMA and CSL to finish inside the fetch phase', async () => {
    const deadlines = {};
    const before = Date.now();
    await partialPublication({ sources: ['SDN', 'CONSOLIDATED'], deadlines });
    const after = Date.now();
    const { fetchPhaseTimeoutMs, csl, SDN, CONSOLIDATED } = deadlines;

    assert.ok(Number.isFinite(fetchPhaseTimeoutMs) && fetchPhaseTimeoutMs > 0);
    assert.equal(CONSOLIDATED, SDN, 'both OFAC sources share one deadline');
    assert.ok(csl <= after + fetchPhaseTimeoutMs, 'CSL must stop inside the fetch phase');
    assert.ok(csl - SDN >= SEMA_TIMEOUT_MS + CSL_TIMEOUT_MS,
      `only ${csl - SDN} ms between the OFAC and CSL deadlines; SEMA and CSL need ${SEMA_TIMEOUT_MS + CSL_TIMEOUT_MS} ms`);
    assert.ok(SDN > before, 'OFAC keeps a positive budget');
  });
});

// ---------------------------------------------------------------------------
// uniqueSorted
// ---------------------------------------------------------------------------
describe('uniqueSorted', () => {
  it('deduplicates and sorts', () => {
    assert.deepEqual(normalize(uniqueSorted(['b', 'a', 'b'])), ['a', 'b']);
  });

  it('filters out empty strings and nulls', () => {
    assert.deepEqual(normalize(uniqueSorted([null, '', 'x', undefined])), ['x']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(normalize(uniqueSorted([])), []);
  });

  it('trims whitespace before deduplication', () => {
    assert.deepEqual(normalize(uniqueSorted([' a', 'a '])), ['a']);
  });
});

// ---------------------------------------------------------------------------
// compactNote
// ---------------------------------------------------------------------------
describe('compactNote', () => {
  it('returns empty string for empty input', () => {
    assert.equal(compactNote(''), '');
  });

  it('normalizes internal whitespace', () => {
    assert.equal(compactNote('hello   world'), 'hello world');
  });

  it('returns note unchanged when ≤240 chars', () => {
    const note = 'a'.repeat(240);
    assert.equal(compactNote(note), note);
  });

  it('truncates notes longer than 240 chars with ellipsis', () => {
    const note = 'x'.repeat(250);
    const result = compactNote(note);
    assert.equal(result.length, 240);
    assert.ok(result.endsWith('...'));
  });
});

// ---------------------------------------------------------------------------
// sortEntries
// ---------------------------------------------------------------------------
describe('sortEntries', () => {
  it('sorts new entries before old', () => {
    const a = { isNew: false, effectiveAt: '1000', name: 'Alpha' };
    const b = { isNew: true, effectiveAt: '500', name: 'Beta' };
    assert.ok(sortEntries(a, b) > 0, 'new entry must sort first');
  });

  it('sorts by effectiveAt descending when isNew is equal', () => {
    const a = { isNew: false, effectiveAt: '1000', name: 'A' };
    const b = { isNew: false, effectiveAt: '2000', name: 'B' };
    assert.ok(sortEntries(a, b) > 0, 'more recent effectiveAt must sort first');
  });

  it('sorts by name ascending when isNew and effectiveAt are equal', () => {
    const a = { isNew: false, effectiveAt: '1000', name: 'Zebra' };
    const b = { isNew: false, effectiveAt: '1000', name: 'Alpha' };
    assert.ok(sortEntries(a, b) > 0, 'earlier name must sort first');
  });
});

// ---------------------------------------------------------------------------
// buildCountryPressure
// ---------------------------------------------------------------------------
describe('buildCountryPressure', () => {
  it('groups entries by country code and counts them', () => {
    const entries = [
      { countryCodes: ['RU'], countryNames: ['Russia'], isNew: false, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
      { countryCodes: ['RU'], countryNames: ['Russia'], isNew: true, entityType: 'SANCTIONS_ENTITY_TYPE_VESSEL' },
    ];
    const result = buildCountryPressure(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].countryCode, 'RU');
    assert.equal(result[0].entryCount, 2);
    assert.equal(result[0].newEntryCount, 1);
    assert.equal(result[0].vesselCount, 1);
  });

  it('counts unattributed designations outside the country ranking', () => {
    const entries = [
      { countryCodes: [], countryNames: [], isNew: false, entityType: 'SANCTIONS_ENTITY_TYPE_VESSEL' },
      { countryCodes: ['XX'], countryNames: ['Unknown'], isNew: true, entityType: 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' },
      { countryCodes: ['RU', 'IR'], countryNames: ['Russia', 'Iran'], isNew: false, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
    ];
    assert.deepEqual(normalize(buildCountryPressure(entries).map(row => row.countryCode)), ['IR', 'RU']);
    const unattributed = normalize(ctx.countUnattributed(entries));
    assert.deepEqual(unattributed, { entryCount: 2, vesselCount: 1, aircraftCount: 1 });
    assert.equal(entries.filter(entry => entry.countryCodes.some(code => code !== 'XX')).length + unattributed.entryCount, entries.length);
  });

  it('limits output to 12 countries', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      countryCodes: [`C${i}`],
      countryNames: [`Country${i}`],
      isNew: false,
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
    }));
    assert.equal(buildCountryPressure(entries).length, 12);
  });

  it('sorts by newEntryCount descending', () => {
    const entries = [
      { countryCodes: ['DE'], countryNames: ['Germany'], isNew: false, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
      { countryCodes: ['IR'], countryNames: ['Iran'], isNew: true, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
      { countryCodes: ['IR'], countryNames: ['Iran'], isNew: true, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
    ];
    const result = buildCountryPressure(entries);
    assert.equal(result[0].countryCode, 'IR');
  });
});

describe('ofacAttributionHealth', () => {
  const rows = (count, entityType, countryCodes) => Array.from({ length: count }, () => ({ entityType, countryCodes, ...(entityType === 'SANCTIONS_ENTITY_TYPE_AIRCRAFT' ? { _aircraftHasCurrentTail: true } : {}) }));
  const { ofacAttributionHealth } = ctx;

  it('degrades when more than 10% of OFAC records are unattributed', () => {
    const health = normalize(ofacAttributionHealth([
      ...rows(89, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']), ...rows(11, 'SANCTIONS_ENTITY_TYPE_ENTITY', []),
    ]));
    assert.equal(health.unattributedShare, 0.11);
    assert.equal(health.degraded, true);
  });

  it('degrades on unattributed vessels even when the whole-list share is low', () => {
    const health = normalize(ofacAttributionHealth([
      ...rows(950, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']),
      ...rows(30, 'SANCTIONS_ENTITY_TYPE_VESSEL', ['PA']), ...rows(20, 'SANCTIONS_ENTITY_TYPE_VESSEL', ['XX']),
    ]));
    assert.equal(health.unattributedShare, 0.02);
    assert.equal(health.unattributedVesselShare, 0.4);
    assert.equal(health.degraded, true);
  });

  it('degrades on a breach that rounds to the threshold', () => {
    const health = normalize(ofacAttributionHealth([
      ...rows(18_503, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']), ...rows(2_056, 'SANCTIONS_ENTITY_TYPE_ENTITY', []),
    ]));
    assert.equal(health.unattributedShare, 0.1);
    assert.equal(health.degraded, true);
  });

  it('detects aircraft failures hidden by whole-list headroom', () => {
    const health = ofacAttributionHealth([
      ...rows(990, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']), ...rows(10, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', []),
    ]);
    assert.equal(health.unattributedShare, 0.01);
    assert.equal(health.unattributedAircraftShare, 1);
    assert.equal(health.degraded, true);
    const atThreshold = [
      ...rows(990, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']),
      ...rows(6, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', []),
      ...rows(4, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', []).map(row => ({ ...row, _flagCode: 'IR' })),
    ];
    assert.equal(ofacAttributionHealth(atThreshold).degraded, false);
  });

  it('detects registry loss even when aircraft have location countries', () => {
    const health = ofacAttributionHealth([
      ...rows(990, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']),
      ...rows(10, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', ['IR']),
    ]);
    assert.equal(health.unattributedShare, 0);
    assert.equal(health.unattributedAircraftCount, 10);
    assert.equal(health.unattributedAircraftShare, 1);
    assert.equal(health.degraded, true);
  });

  it('keeps the November 11 cohort healthy but detects 10 or 15 lost aircraft registries', () => {
    // Cohort-sized fixture: 156 current tails resolved, 186 without current tails.
    const cohort = [
      ...rows(10_000, 'SANCTIONS_ENTITY_TYPE_ENTITY', ['RU']),
      ...rows(156, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', []).map(row => ({ ...row, _flagCode: 'IR' })),
      ...rows(186, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', []).map(row => ({ ...row, _aircraftHasCurrentTail: false })),
    ];
    assert.equal(ofacAttributionHealth(cohort).unattributedAircraftCount, 186);
    assert.equal(ofacAttributionHealth(cohort).degraded, false);
    for (const lost of [9, 10, 15]) {
      const changed = cohort.map((row, i) => i >= 10_000 && i < 10_000 + lost ? { ...row, _flagCode: undefined } : row);
      assert.equal(ofacAttributionHealth(changed).degraded, lost >= 10, `${lost} lost registries`);
    }
    const noTails = rows(500, 'SANCTIONS_ENTITY_TYPE_AIRCRAFT', ['IR']).map(row => ({ ...row, _aircraftHasCurrentTail: false }));
    assert.equal(ofacAttributionHealth([...cohort, ...noTails]).degraded, false, 'new aircraft without tails do not trip the registry check');
  });

  it('stays healthy at the threshold and without OFAC records', () => {
    assert.equal(ofacAttributionHealth([
      ...rows(90, 'SANCTIONS_ENTITY_TYPE_VESSEL', ['RU']), ...rows(10, 'SANCTIONS_ENTITY_TYPE_VESSEL', []),
    ]).degraded, false);
    assert.deepEqual(normalize(ofacAttributionHealth([])), {
      entryCount: 0, unattributedCount: 0, unattributedShare: null,
      vesselCount: 0, unattributedVesselCount: 0, unattributedVesselShare: null, maxShare: 0.1, degraded: false,
      aircraftCount: 0, unattributedAircraftCount: 0, unattributedAircraftShare: null,
      aircraftWithTailCount: 0, unresolvedAircraftWithTailCount: 0, unresolvedAircraftWithTailShare: null,
      aircraftRegistryFailureCount: 10,
    });
  });
});

it('checks SEMA non-vessel target attribution per regime without diluting failures', () => {
  const row = (regime, codes = [], entityType = 'SANCTIONS_ENTITY_TYPE_ENTITY') => ({
    _regime: regime, _targetCountryCodes: codes, entityType,
  });
  const health = ctx.semaAttributionHealth([
    ...Array.from({ length: 100 }, () => row('Russia', ['RU'])),
    row('Iran'), row('Iran', [], 'SANCTIONS_ENTITY_TYPE_VESSEL'),
    ...['Ukraine', 'Moldova', 'JVCFOR', 'Hamas', 'Settler'].map(regime => row(regime)),
  ]);
  assert.equal(health.degraded, true);
  assert.equal(health.regimes.Iran.unattributedShare, 1);
  assert.equal(health.regimes.Iran.entryCount, 1);
  assert.equal(health.regimes.Russia.degraded, false);
  assert.equal(ctx.semaAttributionHealth([]).degraded, false);
  const unknown = ctx.semaAttributionHealth([row('Russia', ['RU']), row('New thematic regime')]);
  assert.equal(unknown.degraded, false);
  assert.equal(unknown.regimes['New thematic regime'].targetExpected, false);
  assert.equal(unknown.regimes['New thematic regime'].unattributedCount, 1);
  assert.equal(ctx.semaAttributionHealth([row('Russia')]).degraded, true);
  assert.equal(ctx.semaAttributionHealth([row('Myanmar (Burma)', ['MM'])]).degraded, false);
  assert.equal(ctx.semaAttributionHealth([row('Myanmar (Burma)')]).degraded, true, 'the live parenthetical country regime must retain target coverage');
  assert.equal(ctx.semaAttributionHealth([row('Ukraine (protected state)')]).degraded, false);
});

describe('buildCountryCounts', () => {
  it('keeps all country counts even when pressure rows are top-12 truncated', () => {
    const entries = Array.from({ length: 13 }, (_, i) => ({
      countryCodes: [`${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`],
      countryNames: [`Country${i}`],
      isNew: false,
      entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY',
    }));

    assert.equal(buildCountryPressure(entries).length, 12,
      'pressure rows remain a top-12 display summary');
    const counts = normalize(buildCountryCounts(entries));
    assert.equal(Object.keys(counts).length, 13,
      'country counts must retain the all-country sanctions pressure map for downstream scoring');
    assert.equal(counts.MM, 1,
      'the 13th country must not disappear from the all-country count map');
  });
});

// ---------------------------------------------------------------------------
// buildProgramPressure
// ---------------------------------------------------------------------------
describe('buildProgramPressure', () => {
  it('groups entries by program and counts them', () => {
    const entries = [
      { programs: ['IRAN'], isNew: false },
      { programs: ['IRAN', 'UKRAINE-EO13685'], isNew: true },
    ];
    const result = buildProgramPressure(entries);
    const iran = result.find((r) => r.program === 'IRAN');
    assert.ok(iran);
    assert.equal(iran.entryCount, 2);
    assert.equal(iran.newEntryCount, 1);
  });

  it('limits output to 12 programs', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      programs: [`PROG${i}`],
      isNew: false,
    }));
    assert.equal(buildProgramPressure(entries).length, 12);
  });
});

it('documents the OFAC location risk boundary in both methodology pages', () => {
  for (const path of ['docs/methodology/cii-risk-scores.mdx', 'docs/country-instability-index.mdx']) {
    assert.ok(readFileSync(path, 'utf8').includes('Sanctions counts use OFAC location-based country evidence only; nationality-only features are not counted, and SEMA regulation targets are shown separately and do not feed risk scores.'), path);
  }
});
