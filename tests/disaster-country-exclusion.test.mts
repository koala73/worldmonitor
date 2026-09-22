import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { disasterAdapter } from '../src/services/correlation-engine/adapters/disaster.ts';

describe('disaster adapter country exclusion', () => {
  it('excludes an outage when the protest country differs only by case', () => {
    const now = new Date();
    const ctx = {
      intelligenceCache: {
        earthquakes: [],
        protests: {
          events: [{
            country: 'ir',
            lat: 35.7,
            lon: 51.4,
            time: now,
          }],
        },
        outages: [{
          country: 'IR',
          lat: 35.7,
          lon: 51.4,
          pubDate: now,
          severity: 'major',
          title: 'Tehran backbone outage',
        }],
      },
    } as never;

    const signals = disasterAdapter.collectSignals(ctx);
    assert.equal(signals.some((signal) => signal.type === 'infra_outage'), false);
  });

  it('keeps an outage in a different country', () => {
    const now = new Date();
    const ctx = {
      intelligenceCache: {
        earthquakes: [],
        protests: {
          events: [{
            country: 'IR',
            lat: 35.7,
            lon: 51.4,
            time: now,
          }],
        },
        outages: [{
          country: 'JP',
          lat: 35.6,
          lon: 139.7,
          pubDate: now,
          severity: 'partial',
          title: 'Tokyo metro outage',
        }],
      },
    } as never;

    const signals = disasterAdapter.collectSignals(ctx);
    assert.equal(signals.filter((signal) => signal.type === 'infra_outage').length, 1);
  });
});
