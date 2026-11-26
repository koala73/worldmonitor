import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { UcdpEventsPanel } from '@/components/UcdpEventsPanel';
import type { UcdpGeoEvent } from '@/types';

beforeAll(async () => {
  await initTestI18n();
});

function event(id: string, best: number, low: number, high: number): UcdpGeoEvent {
  return {
    id,
    date_start: '2026-10-31',
    date_end: '2026-10-31',
    latitude: 9,
    longitude: 38,
    country: 'Ethiopia',
    side_a: `Government of Ethiopia ${id}`,
    side_b: 'EPFAS',
    deaths_best: best,
    deaths_low: low,
    deaths_high: high,
    type_of_violence: 'state-based',
    source_original: 'test',
  };
}

let panel: UcdpEventsPanel;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function deathsCell(events: UcdpGeoEvent[], id: string): Promise<string> {
  panel = new UcdpEventsPanel();
  document.body.appendChild(panel.getElement());
  panel.setEvents(events);
  await vi.advanceTimersByTimeAsync(300);
  const row = [...panel.getElement().querySelectorAll('.ucdp-row')]
    .find((n) => n.querySelector('.ucdp-actors')?.textContent?.startsWith(`Government of Ethiopia ${id} `));
  return row?.querySelector('.ucdp-deaths')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('UcdpEventsPanel deaths column', () => {
  it('shows the UCDP range when the best estimate is zero but the high estimate is not', async () => {
    expect(await deathsCell([event('a', 0, 0, 500)], 'a')).toBe('0 (0-500)');
  });

  it('shows a bare zero when every estimate is zero', async () => {
    expect(await deathsCell([event('b', 0, 0, 0)], 'b')).toBe('0');
  });

  it('shows the best estimate with its range', async () => {
    expect(await deathsCell([event('c', 12, 10, 40)], 'c')).toBe('12 (10-40)');
  });
});
