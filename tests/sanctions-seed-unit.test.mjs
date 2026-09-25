import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ingestSemaEntries, mergeSanctionEntries, parseSemaXml, SEMA_SOURCE } from '../scripts/_sema-sanctions.mjs';

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

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp });
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

async function partialPublication({ sources = ['CONSOLIDATED'], cached = [], snapshots = null, semaJson } = {}) {
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    SEMA_SOURCE, Buffer, gzipSync, gunzipSync,
    mergeSanctionEntries,
    verifySeedKey: async (key) => key === 'sanctions:pressure:v1' ? { entries: cached } : null,
    readSeedSnapshot: async () => snapshots,
    ingestSemaEntries: semaJson === undefined
      ? async () => ({ records: [], publishedAtMs: 0, error: 'SEMA_INVALID_RECORD' })
      : () => ingestSemaEntries({ fetchFn: async () => new Response(JSON.stringify(semaJson)) }),
    fetchSource: async ({ label }) => {
      if (!sources.includes(label)) throw new Error('source timeout');
      return {
        datasetDate: Date.UTC(2026, 8, 14),
        entries: [{ id: `${label}:1`, name: `${label} entity`, sourceLists: [label],
          countryCodes: ['RU'], countryNames: ['Russia'], programs: [label],
          entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY', effectiveAt: '0', isNew: false }],
      };
    },
  });
  vm.runInContext(`${pureSrc}\n${fetchPressureSrc}`, context);
  return normalize(await context.fetchSanctionsPressure());
}

describe('partial sanctions publication', () => {
  it('publishes valid JSON and retains only eligible cached rows on JSON failure', async () => {
    const semaJson = JSON.parse(readFileSync(new URL('./fixtures/sema-table-slice.json', import.meta.url), 'utf8'));
    const healthy = await partialPublication({ semaJson });
    assert.equal(healthy.semaCount, semaJson.data.length);
    assert.equal(healthy.semaError, undefined);
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
      [SEMA_SOURCE]: { version: 1, fetchedAt, retainedUntil: fetchedAt + 720 * 60000, publishedAt: 0, records: cached },
    })).toString('base64') };
    const data = await partialPublication({ snapshots });
    assert.equal(data.semaCount, 1);
    assert.equal(data.totalCount, 2);
    assert.equal(data.entries.find((e) => e.id === records[0].id).effectiveAt, '0');
    assert.equal(data.semaError, 'SEMA_INVALID_RECORD');
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

  it('assigns country code XX and name Unknown for entries with no country', () => {
    const entries = [
      { countryCodes: [], countryNames: [], isNew: false, entityType: 'SANCTIONS_ENTITY_TYPE_ENTITY' },
    ];
    const result = buildCountryPressure(entries);
    assert.equal(result[0].countryCode, 'XX');
    assert.equal(result[0].countryName, 'Unknown');
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
