import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import test helpers
const mod = await import('./reliefweb.js');
const { __testParseReports: parseReports } = mod;

describe('ReliefWeb report parsing', () => {
  it('parses a well-formed report with country coordinates', () => {
    const data = {
      data: [
        {
          id: 4321,
          fields: {
            title: 'Sudan: Flash floods displace thousands',
            date: { created: '2026-02-10T12:00:00+00:00' },
            url: 'https://reliefweb.int/report/sudan/flash-floods',
            country: [
              { name: 'Sudan', location: { lat: 15.5, lon: 32.5 } },
            ],
            disaster: [
              { type: [{ name: 'Flash Flood' }] },
            ],
            source: [
              { name: 'UN OCHA' },
            ],
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, '4321');
    assert.equal(reports[0].title, 'Sudan: Flash floods displace thousands');
    assert.equal(reports[0].country, 'Sudan');
    assert.equal(reports[0].lat, 15.5);
    assert.equal(reports[0].lon, 32.5);
    assert.equal(reports[0].disasterType, 'Flash Flood');
    assert.equal(reports[0].source, 'UN OCHA');
    assert.equal(reports[0].url, 'https://reliefweb.int/report/sudan/flash-floods');
  });

  it('skips reports without country coordinates', () => {
    const data = {
      data: [
        {
          id: 1,
          fields: {
            title: 'Report with no coords',
            country: [{ name: 'Unknown' }],
          },
        },
        {
          id: 2,
          fields: {
            title: 'Report with no country',
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports.length, 0);
  });

  it('handles missing disaster type and source gracefully', () => {
    const data = {
      data: [
        {
          id: 99,
          fields: {
            title: 'Minimal report',
            country: [
              { name: 'Yemen', location: { lat: 15.5, lon: 48.5 } },
            ],
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].disasterType, '');
    assert.equal(reports[0].source, '');
  });

  it('truncates long titles to 200 characters', () => {
    const longTitle = 'A'.repeat(300);
    const data = {
      data: [
        {
          id: 10,
          fields: {
            title: longTitle,
            country: [
              { name: 'Somalia', location: { lat: 5.0, lon: 46.0 } },
            ],
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports[0].title.length, 200);
  });

  it('handles empty data array', () => {
    const reports = parseReports({ data: [] });
    assert.equal(reports.length, 0);
  });

  it('handles null/undefined data', () => {
    assert.equal(parseReports({}).length, 0);
    assert.equal(parseReports({ data: null }).length, 0);
  });

  it('picks first country when multiple are provided', () => {
    const data = {
      data: [
        {
          id: 50,
          fields: {
            title: 'Multi-country report',
            country: [
              { name: 'Lebanon', location: { lat: 33.9, lon: 35.5 } },
              { name: 'Syria', location: { lat: 34.8, lon: 38.9 } },
            ],
            disaster: [
              { type: [{ name: 'Conflict' }] },
            ],
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].country, 'Lebanon');
    assert.equal(reports[0].lat, 33.9);
  });

  it('parses multiple reports correctly', () => {
    const data = {
      data: [
        {
          id: 1,
          fields: {
            title: 'Report A',
            country: [{ name: 'Nigeria', location: { lat: 9.0, lon: 8.0 } }],
            disaster: [{ type: [{ name: 'Flood' }] }],
            source: [{ name: 'IFRC' }],
          },
        },
        {
          id: 2,
          fields: {
            title: 'Report B',
            country: [{ name: 'Pakistan', location: { lat: 30.0, lon: 70.0 } }],
            disaster: [{ type: [{ name: 'Earthquake' }] }],
            source: [{ name: 'WHO' }],
          },
        },
      ],
    };

    const reports = parseReports(data);
    assert.equal(reports.length, 2);
    assert.equal(reports[0].country, 'Nigeria');
    assert.equal(reports[0].disasterType, 'Flood');
    assert.equal(reports[1].country, 'Pakistan');
    assert.equal(reports[1].disasterType, 'Earthquake');
  });
});
