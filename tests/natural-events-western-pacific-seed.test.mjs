import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import { fetchNaturalEvents } from '../scripts/seed-natural-events.mjs';

const fixture = (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/natural', name), 'utf8'));
const NOW = Date.parse('2026-07-13T12:00:00.000Z');

describe('natural-event western Pacific seed', () => {
  it('keeps HKO warnings and canonical western-Pacific storms when JMA is not operational', async () => {
    const requests = [];
    const payload = await fetchNaturalEvents({
      now: NOW,
      fetchFn: async (url) => {
        requests.push(String(url));
        if (String(url).includes('eonet.gsfc.nasa.gov')) return new Response(JSON.stringify({ events: [] }));
        if (String(url).includes('gdacs.org')) {
          return new Response(JSON.stringify({
            features: [{
              geometry: { type: 'Point', coordinates: [128.6, 19.8] },
              properties: {
                eventtype: 'TC', eventid: '12345', alertlevel: 'Orange', name: 'Typhoon Nari',
                description: 'Maximum winds 55 kt', fromdate: '2026-07-13T10:00:00Z',
                url: { report: 'https://www.gdacs.org/report/12345' }, severitydata: {},
              },
            }],
          }));
        }
        if (String(url).includes('data.weather.gov.hk')) return new Response(JSON.stringify(fixture('hko-warnsum-tropical-cyclone.json')));
        if (String(url).includes('mapservices.weather.noaa.gov')) return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }));
        throw new Error(`unexpected source ${url}`);
      },
    });

    assert.ok(payload);
    assert.equal(payload.events.filter((event) => event.sourceName === 'HKO').length, 1);
    assert.equal(payload.events.filter((event) => event.canonicalId?.startsWith('wp:')).length, 1);
    assert.equal(payload.westernPacific.dataAvailable, true);
    assert.equal(payload.hkoWarnings.dataAvailable, true);
    assert.equal(
      payload.westernPacific.sourceDecisions.find((entry) => entry.source === 'JMA RSMC Tokyo')?.reason,
      'EXPERIMENTAL_CAP_NOT_OPERATIONAL',
    );
    assert.ok(requests.every((url) => !url.includes('jma.go.jp')));
  });
});
