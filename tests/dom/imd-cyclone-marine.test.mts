import { describe, expect, it } from 'vitest';
import { mapImdSnapshot } from '@/services/imd-cyclone-marine';
import { readFileSync } from 'node:fs';
// @ts-expect-error The producer is a JavaScript worker module.
import { assembleImdSnapshot, parseCycloneTrackPayload, parseCycloneWindPayload, parseCycloneCouPayload, parsePortWarningPayload, parseSeaBulletinPayload, parseCoastalBulletinPayload } from '../../scripts/lib/imd-cyclone-marine.mjs';

describe('IMD snapshot boundary', () => {
  it('preserves the real producer fixtures through JSON transport and browser mapping', () => {
    const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/imd-${name}.json`, 'utf8'));
    const raw = assembleImdSnapshot({
      now: Date.parse('2019-11-06T00:00:00Z'),
      productResults: {
        cycloneTrack: { status: 'ok', records: parseCycloneTrackPayload(fixture('cyclone-track')) },
        cycloneWind: { status: 'ok', records: parseCycloneWindPayload(fixture('cyclone-wind')) },
        cycloneCou: { status: 'ok', records: parseCycloneCouPayload(fixture('cyclone-cou')) },
        portWarning: { status: 'ok', records: parsePortWarningPayload(fixture('port-warning')) },
        seaBulletin: { status: 'ok', records: parseSeaBulletinPayload(fixture('sea-bulletin')) },
        coastalBulletin: { status: 'ok', records: parseCoastalBulletinPayload(fixture('coastal-bulletin')) },
      },
    });
    const mapped = mapImdSnapshot(JSON.parse(JSON.stringify(raw)));
    expect(mapped.cycloneEvents).toHaveLength(1);
    expect(mapped.portAlerts).toHaveLength(raw.portAlerts.length);
    expect(mapped.marineBulletins).toHaveLength(raw.marineBulletins.length);
    const event = mapped.cycloneEvents[0]!;
    for (const field of ['pastTrack', 'forecastTrack', 'conePolygon', 'windRadii', 'agencyObservations'] as const) {
      expect(event[field]).toEqual(raw.cycloneEvents[0][field]);
    }
    expect(event.date.getTime()).toBe(raw.cycloneEvents[0].date);
    expect(event.sourceUrl).toBe('https://rsmcnewdelhi.imd.gov.in/');
    expect(mapped.portAlerts[0]?.issuedBy).toBe('ACWC CHENNAI');
  });
  it('rejects malformed product lists and rows without throwing', () => {
    const result = mapImdSnapshot({ cycloneEvents: {}, portAlerts: [null, 5], marineBulletins: 'bad' } as never);
    expect(result.cycloneEvents).toEqual([]);
    expect(result.portAlerts).toEqual([]);
    expect(result.marineBulletins).toEqual([]);
  });
  it('drops malformed nested geometry and retains only known track fields', () => {
    const mapped = mapImdSnapshot({ generatedAt: 1000, cycloneEvents: [{
      // Records need a real timestamp (an invalid one rejects the whole record;
      // see tests/imd-browser-boundary.test.mts), so use a valid date here.
      id: 'storm', lat: 10, lon: 70, date: 2000,
      pastTrack: [null, { lat: 1000, lon: 70 }, { lat: 10, lon: 70, timestamp: 1000, extra: 'drop' }],
      conePolygon: [[[70, 10], [71, 11], [72, 12], [999, 10]]],
      windRadii: [null],
      agencyObservations: [{ lat: 10, lon: 70, sourceUrl: 'javascript:alert(1)', extra: 'drop' }],
    }] });
    const storm = mapped.cycloneEvents[0]!;
    expect(storm.date.getTime()).toBe(2000);
    expect(storm.pastTrack).toHaveLength(1);
    expect(storm.pastTrack?.[0]).not.toHaveProperty('extra');
    expect(storm.conePolygon).toEqual([]);
    expect(storm.windRadii).toEqual([]);
    expect(storm.agencyObservations?.[0]).not.toHaveProperty('extra');
    expect(storm.agencyObservations?.[0]?.sourceUrl).toBeUndefined();
  });
  it('copies valid fields and drops extra keys and unsafe source URLs', () => {
    for (const sourceUrl of ['javascript:alert(1)', 'data:text/html,bad', 'https://evil.example']) {
      const result = mapImdSnapshot({ generatedAt: 1000, cycloneEvents: [{ id: 'storm', title: 'Storm', lat: 10, lon: 70, date: 1000, sourceUrl, surprise: true }], portAlerts: [{ id: 'port', headline: 'Warning', onset: 1000, expires: 2000, sourceUrl, surprise: true, coordinates: [[70, 10], [999, 0]] }] } as never);
      expect(result.cycloneEvents[0]).toMatchObject({ id: 'storm', title: 'Storm', lat: 10, lon: 70 });
      expect(result.cycloneEvents[0]).not.toHaveProperty('surprise');
      expect(result.cycloneEvents[0]?.sourceUrl).toBeUndefined();
      expect(result.portAlerts[0]).not.toHaveProperty('surprise');
      expect(result.portAlerts[0]?.sourceUrl).toBeUndefined();
      expect(result.portAlerts[0]?.coordinates).toEqual([[70, 10]]);
    }
  });
});
