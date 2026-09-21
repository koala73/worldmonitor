import { describe, it, expect } from 'vitest';

import {
  acceleratorVisibleAt,
  datacenterVisibleAt,
  growthFlagsForEraSeek,
  layersVisibleAtFocus,
  techEventVisibleAt,
} from '@/config/ai-era-visibility';
import type { AIDataCenter } from '@/types';

function dc(
  partial: Partial<AIDataCenter> & Pick<AIDataCenter, 'id' | 'status'>,
): AIDataCenter {
  return {
    name: partial.id,
    owner: 'test',
    lat: 0,
    lon: 0,
    country: 'Test',
    chipType: 'GPU',
    firstOperationalMs: null,
    ...partial,
  };
}

describe('ai-era-visibility datacenterVisibleAt', () => {
  const chatgpt = Date.parse('2022-11-30T00:00:00Z');
  const existingDated = dc({
    id: 'dated',
    status: 'existing',
    firstOperationalMs: Date.parse('2020-01-01T00:00:00Z'),
  });
  const existingUndated = dc({
    id: 'undated',
    status: 'existing',
    firstOperationalMs: null,
  });
  const planned = dc({ id: 'planned', status: 'planned', firstOperationalMs: null });
  const decommissioned = dc({
    id: 'gone',
    status: 'decommissioned',
    firstOperationalMs: Date.parse('2018-01-01T00:00:00Z'),
  });
  const future = dc({
    id: 'future',
    status: 'existing',
    firstOperationalMs: Date.parse('2024-06-01T00:00:00Z'),
  });

  it('Live shows existing + planned, not decommissioned', () => {
    expect(datacenterVisibleAt(existingDated, null)).toBe(true);
    expect(datacenterVisibleAt(existingUndated, null)).toBe(true);
    expect(datacenterVisibleAt(planned, null)).toBe(true);
    expect(datacenterVisibleAt(decommissioned, null)).toBe(false);
  });

  it('historical shows only dated existing with firstOperationalMs <= focus', () => {
    expect(datacenterVisibleAt(existingDated, chatgpt)).toBe(true);
    expect(datacenterVisibleAt(existingUndated, chatgpt)).toBe(false);
    expect(datacenterVisibleAt(planned, chatgpt)).toBe(false);
    expect(datacenterVisibleAt(future, chatgpt)).toBe(false);
    expect(datacenterVisibleAt(decommissioned, chatgpt)).toBe(false);
  });
});

describe('ai-era-visibility accelerators / techEvents', () => {
  it('accelerator founded year gates historical frames', () => {
    expect(acceleratorVisibleAt({ founded: 2015 }, null)).toBe(true);
    expect(acceleratorVisibleAt({ founded: 2015 }, Date.UTC(2014, 11, 31))).toBe(false);
    expect(acceleratorVisibleAt({ founded: 2015 }, Date.UTC(2015, 0, 1))).toBe(true);
    expect(acceleratorVisibleAt({ founded: null }, Date.UTC(2020, 0, 1))).toBe(false);
  });

  it('techEvent startDate gates historical frames', () => {
    expect(techEventVisibleAt({ startDate: '2023-11-06' }, null)).toBe(true);
    expect(
      techEventVisibleAt({ startDate: '2023-11-06' }, Date.parse('2023-11-05T00:00:00Z')),
    ).toBe(false);
    expect(
      techEventVisibleAt({ startDate: '2023-11-06' }, Date.parse('2023-11-06T00:00:00Z')),
    ).toBe(true);
    expect(techEventVisibleAt({ startDate: null }, Date.UTC(2024, 0, 1))).toBe(false);
  });
});

describe('ai-era-visibility layersVisibleAtFocus / growthFlagsForEraSeek', () => {
  const catalog = {
    datacenters: [
      dc({
        id: 'old',
        status: 'existing',
        firstOperationalMs: Date.parse('2019-01-01T00:00:00Z'),
      }),
    ],
    accelerators: [{ founded: 2012 } as { founded: number }],
    techEvents: [{ startDate: '2023-01-01' }],
  };

  it('Live enables growth layers with catalog data', () => {
    const keys = layersVisibleAtFocus(null, catalog);
    expect(keys).toContain('datacenters');
    expect(keys).toContain('accelerators');
    expect(keys).toContain('techHQs');
    const flags = growthFlagsForEraSeek(null, catalog);
    expect(flags.datacenters).toBe(true);
    expect(flags.techHQs).toBe(true);
  });

  it('historical enables only dated layers with points at focus', () => {
    const beforeEvent = Date.parse('2022-06-01T00:00:00Z');
    const keys = layersVisibleAtFocus(beforeEvent, catalog);
    expect(keys).toContain('datacenters');
    expect(keys).toContain('accelerators');
    expect(keys).not.toContain('techEvents');
    expect(keys).not.toContain('techHQs');
    expect(keys).not.toContain('startupHubs');
    expect(keys).not.toContain('cloudRegions');
  });
});
