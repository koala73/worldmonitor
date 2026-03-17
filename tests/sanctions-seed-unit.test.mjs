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
// ---------------------------------------------------------------------------
const seedSrc = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');

const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);/, '')
  .replace(/async function fetchSource[\s\S]*/, ''); // remove network + runSeed tail

// Stub XMLParser: only the module-level XML_PARSER constant is constructed at load time;
// the actual parse() method is only called in fetchSource (stripped above).
class XMLParser { parse() { return {}; } }

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp, XMLParser });
vm.runInContext(pureSrc, ctx);

const {
  listify,
  textValue,
  buildEpoch,
  uniqueSorted,
  compactNote,
  extractDocumentedName,
  normalizeDateOfIssue,
  buildReferenceMaps,
  buildLocationMap,
  extractPartyName,
  resolveEntityType,
  extractPartyCountries,
  buildPartyMap,
  extractPrograms,
  extractEffectiveAt,
  extractNote,
  buildEntriesForDocument,
  sortEntries,
  buildCountryPressure,
  buildProgramPressure,
} = ctx;

// ---------------------------------------------------------------------------
// listify
// ---------------------------------------------------------------------------
describe('listify', () => {
  it('wraps a scalar in an array', () => {
    assert.deepEqual(normalize(listify('x')), ['x']);
  });

  it('returns the array as-is', () => {
    assert.deepEqual(normalize(listify([1, 2])), [1, 2]);
  });

  it('returns [] for null', () => {
    assert.deepEqual(normalize(listify(null)), []);
  });

  it('returns [] for undefined', () => {
    assert.deepEqual(normalize(listify(undefined)), []);
  });

  it('wraps a number', () => {
    assert.deepEqual(normalize(listify(0)), [0]);
  });
});

// ---------------------------------------------------------------------------
// textValue
// ---------------------------------------------------------------------------
describe('textValue', () => {
  it('returns empty string for null', () => {
    assert.equal(textValue(null), '');
  });

  it('trims a plain string', () => {
    assert.equal(textValue('  hello  '), 'hello');
  });

  it('converts a number', () => {
    assert.equal(textValue(42), '42');
  });

  it('converts a boolean', () => {
    assert.equal(textValue(true), 'true');
  });

  it('extracts #text from an object', () => {
    assert.equal(textValue({ '#text': ' inner ' }), 'inner');
  });

  it('extracts NamePartValue from an object', () => {
    assert.equal(textValue({ NamePartValue: ' name ' }), 'name');
  });

  it('returns empty string for an object with no recognized key', () => {
    assert.equal(textValue({ other: 'x' }), '');
  });
});

// ---------------------------------------------------------------------------
// buildEpoch
// ---------------------------------------------------------------------------
describe('buildEpoch', () => {
  it('returns 0 for null parts', () => {
    assert.equal(buildEpoch(null), 0);
  });

  it('returns 0 when Year is 0', () => {
    assert.equal(buildEpoch({ Year: '0', Month: '1', Day: '1' }), 0);
  });

  it('builds correct UTC epoch', () => {
    assert.equal(buildEpoch({ Year: '2023', Month: '6', Day: '15' }), Date.UTC(2023, 5, 15));
  });

  it('defaults missing Month and Day to 1', () => {
    assert.equal(buildEpoch({ Year: '2023' }), Date.UTC(2023, 0, 1));
  });

  it('clamps Month 0 to 1', () => {
    assert.equal(buildEpoch({ Year: '2022', Month: '0', Day: '5' }), Date.UTC(2022, 0, 5));
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
// extractDocumentedName
// ---------------------------------------------------------------------------
describe('extractDocumentedName', () => {
  it('joins multiple DocumentedNamePart values', () => {
    const dn = {
      DocumentedNamePart: [
        { NamePartValue: 'John' },
        { NamePartValue: 'Doe' },
      ],
    };
    assert.equal(extractDocumentedName(dn), 'John Doe');
  });

  it('falls back to textValue of the whole object when no parts', () => {
    assert.equal(extractDocumentedName({ '#text': 'Fallback Name' }), 'Fallback Name');
  });

  it('returns empty string for null', () => {
    assert.equal(extractDocumentedName(null), '');
  });
});

// ---------------------------------------------------------------------------
// normalizeDateOfIssue
// ---------------------------------------------------------------------------
describe('normalizeDateOfIssue', () => {
  it('returns 0 for null', () => {
    assert.equal(normalizeDateOfIssue(null), 0);
  });

  it('returns correct epoch for valid date parts', () => {
    assert.equal(normalizeDateOfIssue({ Year: '2024', Month: '1', Day: '15' }), Date.UTC(2024, 0, 15));
  });
});

// ---------------------------------------------------------------------------
// buildReferenceMaps
// ---------------------------------------------------------------------------
describe('buildReferenceMaps', () => {
  const doc = {
    ReferenceValueSets: {
      AreaCodeValues: {
        AreaCode: [{ ID: '10', Description: 'Russia', '#text': 'RU' }],
      },
      FeatureTypeValues: {
        FeatureType: [{ ID: '20', '#text': 'Citizenship Country' }],
      },
      LegalBasisValues: {
        LegalBasis: [{ ID: '30', LegalBasisShortRef: 'EO13685' }],
      },
    },
  };

  it('builds areaCodes map keyed by ID', () => {
    const { areaCodes } = buildReferenceMaps(doc);
    assert.deepEqual(normalize(areaCodes.get('10')), { code: 'RU', name: 'Russia' });
  });

  it('builds featureTypes map keyed by ID', () => {
    const { featureTypes } = buildReferenceMaps(doc);
    assert.equal(featureTypes.get('20'), 'Citizenship Country');
  });

  it('builds legalBasis map using LegalBasisShortRef', () => {
    const { legalBasis } = buildReferenceMaps(doc);
    assert.equal(legalBasis.get('30'), 'EO13685');
  });

  it('returns empty maps for missing ReferenceValueSets', () => {
    const { areaCodes, featureTypes, legalBasis } = buildReferenceMaps({});
    assert.equal(areaCodes.size, 0);
    assert.equal(featureTypes.size, 0);
    assert.equal(legalBasis.size, 0);
  });
});

// ---------------------------------------------------------------------------
// buildLocationMap
// ---------------------------------------------------------------------------
describe('buildLocationMap', () => {
  it('maps location ID to aligned code/name pairs', () => {
    const areaCodes = new Map([
      ['10', { code: 'RU', name: 'Russia' }],
      ['11', { code: 'BY', name: 'Belarus' }],
    ]);
    const doc = {
      Locations: {
        Location: [
          { ID: '200', LocationAreaCode: [{ AreaCodeID: '10' }, { AreaCodeID: '11' }] },
        ],
      },
    };
    const locations = buildLocationMap(doc, areaCodes);
    const loc = locations.get('200');
    assert.deepEqual(normalize(loc.codes), ['BY', 'RU']); // sorted alpha
    assert.deepEqual(normalize(loc.names), ['Belarus', 'Russia']);
  });

  it('deduplicates repeated area codes within a location', () => {
    const areaCodes = new Map([['10', { code: 'RU', name: 'Russia' }]]);
    const doc = {
      Locations: {
        Location: [
          { ID: '300', LocationAreaCode: [{ AreaCodeID: '10' }, { AreaCodeID: '10' }] },
        ],
      },
    };
    const locations = buildLocationMap(doc, areaCodes);
    assert.deepEqual(normalize(locations.get('300').codes), ['RU']);
  });
});

// ---------------------------------------------------------------------------
// resolveEntityType
// ---------------------------------------------------------------------------
describe('resolveEntityType', () => {
  it('returns VESSEL for PartySubTypeID 1', () => {
    assert.equal(resolveEntityType({ PartySubTypeID: '1' }, new Map()), 'SANCTIONS_ENTITY_TYPE_VESSEL');
  });

  it('returns AIRCRAFT for PartySubTypeID 2', () => {
    assert.equal(resolveEntityType({ PartySubTypeID: '2' }, new Map()), 'SANCTIONS_ENTITY_TYPE_AIRCRAFT');
  });

  it('returns INDIVIDUAL when a feature type contains "birth"', () => {
    const featureTypes = new Map([['99', 'Date of Birth']]);
    const profile = {
      Feature: [{ FeatureTypeID: '99' }],
    };
    assert.equal(resolveEntityType(profile, featureTypes), 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL');
  });

  it('returns INDIVIDUAL when a feature type contains "nationality"', () => {
    const featureTypes = new Map([['88', 'Nationality Country']]);
    const profile = { Feature: [{ FeatureTypeID: '88' }] };
    assert.equal(resolveEntityType(profile, featureTypes), 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL');
  });

  it('returns ENTITY for non-individual, non-vessel, non-aircraft', () => {
    const featureTypes = new Map([['77', 'Address']]);
    const profile = { Feature: [{ FeatureTypeID: '77' }] };
    assert.equal(resolveEntityType(profile, featureTypes), 'SANCTIONS_ENTITY_TYPE_ENTITY');
  });
});

// ---------------------------------------------------------------------------
// extractPartyName
// ---------------------------------------------------------------------------
describe('extractPartyName', () => {
  it('uses primary alias DocumentedName', () => {
    const profile = {
      Identity: [{
        Alias: [
          {
            Primary: 'true',
            DocumentedName: { DocumentedNamePart: [{ NamePartValue: 'Corp' }, { NamePartValue: 'LLC' }] },
          },
        ],
      }],
    };
    assert.equal(extractPartyName(profile), 'Corp LLC');
  });

  it('falls back to first alias when no primary', () => {
    const profile = {
      Identity: [{
        Alias: [
          { DocumentedName: { '#text': 'Fallback Entity' } },
        ],
      }],
    };
    assert.equal(extractPartyName(profile), 'Fallback Entity');
  });

  it('returns empty string when no identity', () => {
    assert.equal(extractPartyName({}), '');
  });
});

// ---------------------------------------------------------------------------
// extractPrograms
// ---------------------------------------------------------------------------
describe('extractPrograms', () => {
  it('extracts valid program codes from SanctionsMeasure comments', () => {
    const entry = {
      SanctionsMeasure: [
        { Comment: 'UKRAINE-EO13685' },
        { Comment: 'RUSSIA-EO14024' },
      ],
    };
    const result = extractPrograms(entry);
    assert.deepEqual(normalize(result), ['RUSSIA-EO14024', 'UKRAINE-EO13685']); // sorted
  });

  it('excludes free-text comments that fail the program code regex', () => {
    const entry = {
      SanctionsMeasure: [{ Comment: 'Blocked for human rights violations' }],
    };
    assert.deepEqual(normalize(extractPrograms(entry)), []);
  });

  it('deduplicates program codes', () => {
    const entry = {
      SanctionsMeasure: [{ Comment: 'IRAN' }, { Comment: 'IRAN' }],
    };
    assert.deepEqual(normalize(extractPrograms(entry)), ['IRAN']);
  });

  it('returns empty array for empty entry', () => {
    assert.deepEqual(normalize(extractPrograms({})), []);
  });
});

// ---------------------------------------------------------------------------
// extractEffectiveAt
// ---------------------------------------------------------------------------
describe('extractEffectiveAt', () => {
  it('returns max epoch across EntryEvent dates', () => {
    const entry = {
      EntryEvent: [
        { Date: { Year: '2020', Month: '1', Day: '1' } },
        { Date: { Year: '2022', Month: '6', Day: '15' } },
      ],
    };
    assert.equal(extractEffectiveAt(entry), Date.UTC(2022, 5, 15));
  });

  it('also considers SanctionsMeasure DatePeriod', () => {
    const entry = {
      EntryEvent: [{ Date: { Year: '2021', Month: '1', Day: '1' } }],
      SanctionsMeasure: [{
        DatePeriod: { Start: { From: { Year: '2023', Month: '3', Day: '1' } } },
      }],
    };
    assert.equal(extractEffectiveAt(entry), Date.UTC(2023, 2, 1));
  });

  it('returns 0 when no dates are present', () => {
    assert.equal(extractEffectiveAt({}), 0);
  });
});

// ---------------------------------------------------------------------------
// extractNote
// ---------------------------------------------------------------------------
describe('extractNote', () => {
  it('prefers free-text SanctionsMeasure comment over legal basis', () => {
    const legalBasis = new Map([['1', 'EO13661']]);
    const entry = {
      SanctionsMeasure: [{ Comment: 'Involved in arms trafficking' }],
      EntryEvent: [{ LegalBasisID: '1' }],
    };
    assert.equal(extractNote(entry, legalBasis), 'Involved in arms trafficking');
  });

  it('falls back to legal basis short ref when comment is a program code', () => {
    const legalBasis = new Map([['1', 'EO13661']]);
    const entry = {
      SanctionsMeasure: [{ Comment: 'IRAN' }], // valid program code — filtered out
      EntryEvent: [{ LegalBasisID: '1' }],
    };
    assert.equal(extractNote(entry, legalBasis), 'EO13661');
  });

  it('returns empty string when nothing available', () => {
    assert.equal(extractNote({}, new Map()), '');
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

// ---------------------------------------------------------------------------
// buildEntriesForDocument — integration
// ---------------------------------------------------------------------------
describe('buildEntriesForDocument', () => {
  const doc = {
    DateOfIssue: { Year: '2024', Month: '1', Day: '15' },
    ReferenceValueSets: {
      AreaCodeValues: {
        AreaCode: [{ ID: '10', Description: 'Russia', '#text': 'RU' }],
      },
      FeatureTypeValues: {
        FeatureType: [{ ID: '20', '#text': 'Registered Location' }],
      },
      LegalBasisValues: {
        LegalBasis: [{ ID: '30', LegalBasisShortRef: 'EO13685' }],
      },
    },
    Locations: {
      Location: [{ ID: '200', LocationAreaCode: [{ AreaCodeID: '10' }] }],
    },
    DistinctParties: {
      DistinctParty: [{
        FixedRef: '1001',
        Profile: {
          ID: '1001',
          PartySubTypeID: '4',
          Identity: [{
            Alias: [{
              Primary: 'true',
              DocumentedName: {
                DocumentedNamePart: [{ NamePartValue: 'Acme' }, { NamePartValue: 'Corp' }],
              },
            }],
          }],
          Feature: [{
            FeatureTypeID: '20',
            FeatureVersion: [{ VersionLocation: [{ LocationID: '200' }] }],
          }],
        },
      }],
    },
    SanctionsEntries: {
      SanctionsEntry: [{
        ID: '5001',
        ProfileID: '1001',
        EntryEvent: [{ Date: { Year: '2022', Month: '3', Day: '1' }, LegalBasisID: '30' }],
        SanctionsMeasure: [{ Comment: 'UKRAINE-EO13685' }],
      }],
    },
  };

  it('produces one entry with correct id', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'SDN:5001');
  });

  it('resolves party name from DistinctParties', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.equal(entries[0].name, 'Acme Corp');
  });

  it('resolves country codes and names from features', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.deepEqual(normalize(entries[0].countryCodes), ['RU']);
    assert.deepEqual(normalize(entries[0].countryNames), ['Russia']);
  });

  it('resolves programs from SanctionsMeasure', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.deepEqual(normalize(entries[0].programs), ['UKRAINE-EO13685']);
  });

  it('sets effectiveAt from EntryEvent date', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.equal(entries[0].effectiveAt, String(Date.UTC(2022, 2, 1)));
  });

  it('sets isNew to false by default', () => {
    const { entries } = buildEntriesForDocument(doc, 'SDN');
    assert.equal(entries[0].isNew, false);
  });

  it('returns correct datasetDate', () => {
    const { datasetDate } = buildEntriesForDocument(doc, 'SDN');
    assert.equal(datasetDate, Date.UTC(2024, 0, 15));
  });

  it('falls back to sourceLabel as program when no valid program codes', () => {
    const docNoProgram = {
      ...doc,
      SanctionsEntries: {
        SanctionsEntry: [{
          ID: '5002',
          ProfileID: '1001',
          EntryEvent: [],
          SanctionsMeasure: [{ Comment: 'Suspected money laundering' }],
        }],
      },
    };
    const { entries } = buildEntriesForDocument(docNoProgram, 'SDN');
    assert.deepEqual(normalize(entries[0].programs), ['SDN']);
  });

  it('sets sourceLists to [sourceLabel]', () => {
    const { entries } = buildEntriesForDocument(doc, 'CONSOLIDATED');
    assert.deepEqual(normalize(entries[0].sourceLists), ['CONSOLIDATED']);
  });

  it('handles empty SanctionsEntries gracefully', () => {
    const emptyDoc = { ...doc, SanctionsEntries: {} };
    const { entries } = buildEntriesForDocument(emptyDoc, 'SDN');
    assert.equal(entries.length, 0);
  });

  it('uses Unnamed designation when party not found', () => {
    const docNoParty = {
      ...doc,
      SanctionsEntries: {
        SanctionsEntry: [{ ID: '9999', ProfileID: '9999', EntryEvent: [], SanctionsMeasure: [] }],
      },
    };
    const { entries } = buildEntriesForDocument(docNoParty, 'SDN');
    assert.equal(entries[0].name, 'Unnamed designation');
  });
});
