import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { DATASETS, parseEurostatResponse } from '../scripts/seed-eurostat-country-data.mjs';

// Eurostat froze prc_hicp_manr (and the rest of the ECOICOP ver. 1 HICP family)
// at 2025-12 when HICP moved to ECOICOP ver. 2; prc_hicp_minr continues the
// series, with the basket keyed as coicop18 and the rate selected by unit.
describe('Eurostat country tile CPI', () => {
  it('reads the annual HICP rate from the live ECOICOP ver. 2 dataset', () => {
    assert.equal(DATASETS.cpi.id, 'prc_hicp_minr');
    assert.equal(DATASETS.cpi.params.coicop18, 'TOTAL');
    assert.equal(DATASETS.cpi.params.unit, 'RCH_A');
    assert.equal(DATASETS.cpi.params.coicop, undefined);
  });

  it('takes the newest and prior print from a prc_hicp_minr cube', () => {
    // Shape captured live 2026-09-23 (geo=DE&geo=FR, lastTimePeriod=2).
    const minr = {
      id: ['freq', 'unit', 'coicop18', 'geo', 'time'],
      size: [1, 1, 1, 2, 2],
      dimension: {
        geo: { category: { index: { DE: 0, FR: 1 } } },
        time: { category: { index: { '2026-07': 0, '2026-08': 1 } } },
      },
      value: { 0: 2.8, 1: 2.9, 2: 2.4, 3: 2.6 },
    };
    assert.deepEqual(parseEurostatResponse(minr, 'DE'), {
      value: 2.9, priorValue: 2.8, hasPrior: true, date: '2026-08',
    });
    assert.deepEqual(parseEurostatResponse(minr, 'FR'), {
      value: 2.6, priorValue: 2.4, hasPrior: true, date: '2026-08',
    });
  });
});
