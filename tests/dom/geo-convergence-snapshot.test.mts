import { beforeEach, describe, expect, it } from 'vitest';

import type { MilitaryFlight } from '@/types';
import { clearCells, debugGetCells, ingestFlights, ingestProtests } from '@/services/geo-convergence';

describe('browser geo-convergence snapshots', () => {
  beforeEach(() => {
    clearCells();
  });

  it('replaces protest counts on refresh and leaves flights in place', () => {
    ingestProtests([{ lat: 32.4, lon: 44.9, time: new Date('2026-09-19T00:00:00Z') } as never]);
    ingestProtests([{ lat: 32.4, lon: 44.9, time: new Date('2026-09-19T00:10:00Z') } as never]);
    ingestFlights([{ lat: 32.4, lon: 44.9, lastSeen: new Date('2026-09-19T00:05:00Z') } as MilitaryFlight]);

    const cell = debugGetCells().get('32,44') as { events: Map<string, { count: number }> } | undefined;
    expect(cell?.events.get('protest')?.count).toBe(1);
    expect(cell?.events.get('military_flight')?.count).toBe(1);
  });
});
