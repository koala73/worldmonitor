import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeHydratedOceanIce } from '../src/services/climate/ocean-ice.ts';

describe('normalizeHydratedOceanIce', () => {
  it('returns null for hydrated proto payloads that only contain an empty trend array', () => {
    const data = normalizeHydratedOceanIce({
      data: {
        iceTrend12m: [],
      },
    });

    assert.equal(data, null);
  });

  it('returns null for snake-case seed payloads that only contain an empty trend array', () => {
    const data = normalizeHydratedOceanIce({
      ice_trend_12m: [],
    });

    assert.equal(data, null);
  });

  it('keeps hydrated proto payloads when at least one real field is present', () => {
    const data = normalizeHydratedOceanIce({
      data: {
        arcticTrend: 'below_average',
        iceTrend12m: [],
      },
    });

    assert.ok(data);
    assert.equal(data.arcticTrend, 'below_average');
  });
});
