import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
  buildProgramPressure,
} = ctx;

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

