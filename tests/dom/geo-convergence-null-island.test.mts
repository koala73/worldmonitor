import { describe, expect, it } from 'vitest';

import { clearCells, getCellCount, ingestEarthquakes } from '@/services/geo-convergence';

describe('ingestEarthquakes coordinate guard', () => {
  it('skips missing, non-finite, and null-island coordinates', () => {
    clearCells();
    ingestEarthquakes([
      { location: undefined, occurredAt: Date.now() },
      { location: { latitude: 0, longitude: 0 }, occurredAt: Date.now() },
      { location: { latitude: Number.NaN, longitude: 10 }, occurredAt: Date.now() },
      { location: { latitude: 91, longitude: 10 }, occurredAt: Date.now() },
      { location: { latitude: 35.6, longitude: 139.7 }, occurredAt: Date.now() },
    ] as never);
    expect(getCellCount()).toBe(1);
    clearCells();
  });
});
