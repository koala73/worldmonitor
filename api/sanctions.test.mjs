import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import test helpers
const mod = await import('./sanctions.js');
const {
  __testParseSdnCsv: parseSdnCsv,
  __testAggregateByCountry: aggregateByCountry,
  __testExtractCountry: extractCountry,
  __testParseCsvLine: parseCsvLine,
  __testGetProgramSeverity: getProgramSeverity,
} = mod;

describe('sanctions CSV parsing', () => {
  it('parses a basic SDN CSV line', () => {
    const csv = `12345,"DOE, John",individual,SDGT,"Minister",,,,,,,"Nationality: Iran; DOB 01 Jan 1970"`;
    const entities = parseSdnCsv(csv);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'DOE, John');
    assert.equal(entities[0].type, 'individual');
    assert.equal(entities[0].program, 'SDGT');
    assert.equal(entities[0].country, 'Iran');
    assert.equal(entities[0].severity, 'severe');
  });

  it('parses entity type correctly', () => {
    const csv = `100,"ACME Corp",-0- entity,IRAN,,,,,,,,""`;
    const entities = parseSdnCsv(csv);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].type, 'entity');
  });

  it('parses vessel type correctly', () => {
    const csv = `200,"M/V HAPPINESS",vessel,DPRK,"Master",,Bulk Carrier,5000,3000,NK,,"Flag: North Korea"`;
    const entities = parseSdnCsv(csv);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].type, 'vessel');
    assert.equal(entities[0].severity, 'severe');
  });

  it('handles empty/malformed lines', () => {
    const csv = `
12345,"SMITH, Jane",individual,IRAN,,,,,,,,""
,,,,
bad
`;
    const entities = parseSdnCsv(csv);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'SMITH, Jane');
  });

  it('handles quoted fields with commas', () => {
    const line = parseCsvLine('12345,"DOE, John ""Jack""",individual,SDGT');
    assert.equal(line[0], '12345');
    assert.equal(line[1], 'DOE, John "Jack"');
    assert.equal(line[2], 'individual');
    assert.equal(line[3], 'SDGT');
  });

  it('skips header rows', () => {
    const csv = `ent_num,SDN_Name,SDN_Type,Program,Title
12345,"TEST ENTITY",entity,IRAN,,,,,,,,""`;
    const entities = parseSdnCsv(csv);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].id, '12345');
  });
});

describe('country extraction', () => {
  it('extracts from Nationality in remarks', () => {
    assert.equal(extractCountry('Nationality: Iran; DOB 1970', ''), 'Iran');
  });

  it('extracts from Country in remarks', () => {
    assert.equal(extractCountry('Country: Russia; Other info', ''), 'Russia');
  });

  it('extracts from Citizenship in remarks', () => {
    assert.equal(extractCountry('Citizenship: Syria.', ''), 'Syria');
  });

  it('falls back to program-based inference', () => {
    assert.equal(extractCountry('', 'IRAN-TRA'), 'Iran');
    assert.equal(extractCountry('', 'DPRK2'), 'North Korea');
    assert.equal(extractCountry('', 'UKRAINE-EO13661'), 'Russia');
    assert.equal(extractCountry('', 'CUBA'), 'Cuba');
    assert.equal(extractCountry('', 'VENEZUELA-EO13692'), 'Venezuela');
  });

  it('returns empty string when no country found', () => {
    assert.equal(extractCountry('', 'GLOMAG'), '');
  });
});

describe('program severity', () => {
  it('rates terrorism programs as severe', () => {
    assert.equal(getProgramSeverity('SDGT'), 'severe');
    assert.equal(getProgramSeverity('FTO'), 'severe');
    assert.equal(getProgramSeverity('SDNTK'), 'severe');
  });

  it('rates country programs correctly', () => {
    assert.equal(getProgramSeverity('IRAN'), 'high');
    assert.equal(getProgramSeverity('DPRK'), 'severe');
    assert.equal(getProgramSeverity('VENEZUELA'), 'moderate');
    assert.equal(getProgramSeverity('CUBA'), 'moderate');
  });

  it('handles partial matches', () => {
    assert.equal(getProgramSeverity('IRAN-EO13846'), 'high');
    assert.equal(getProgramSeverity('UKRAINE-EO14024'), 'high');
    assert.equal(getProgramSeverity('DPRK4'), 'severe');
  });

  it('defaults to moderate for unknown programs', () => {
    assert.equal(getProgramSeverity('UNKNOWN-PROGRAM'), 'moderate');
    assert.equal(getProgramSeverity(''), 'moderate');
  });
});

describe('country aggregation', () => {
  it('aggregates entities by country', () => {
    const entities = [
      { id: '1', name: 'A', type: 'individual', program: 'IRAN', country: 'Iran', severity: 'high' },
      { id: '2', name: 'B', type: 'entity', program: 'IRAN', country: 'Iran', severity: 'high' },
      { id: '3', name: 'C', type: 'individual', program: 'DPRK', country: 'North Korea', severity: 'severe' },
    ];

    const countries = aggregateByCountry(entities);
    assert.equal(countries['Iran'].count, 2);
    assert.equal(countries['Iran'].types.individual, 1);
    assert.equal(countries['Iran'].types.entity, 1);
    assert.equal(countries['North Korea'].count, 1);
    assert.equal(countries['North Korea'].severity, 'severe');
  });

  it('escalates severity to highest found', () => {
    const entities = [
      { id: '1', name: 'A', type: 'individual', program: 'SDGT', country: 'Iran', severity: 'severe' },
      { id: '2', name: 'B', type: 'entity', program: 'IRAN', country: 'Iran', severity: 'high' },
    ];

    const countries = aggregateByCountry(entities);
    assert.equal(countries['Iran'].severity, 'severe');
  });

  it('handles entities with no country', () => {
    const entities = [
      { id: '1', name: 'A', type: 'individual', program: 'GLOMAG', country: '', severity: 'high' },
    ];

    const countries = aggregateByCountry(entities);
    assert.equal(countries['Unknown'].count, 1);
  });
});
