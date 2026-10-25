import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

const boundaries = [
  ['2026-10-24T20:59:59Z', 'Upcoming forecast'],
  ['2026-10-24T21:00:00Z', 'Current forecast'],
  ['2026-10-25T09:00:00Z', 'Expired forecast'],
] as const;

it.each(['sea-area-bulletin', 'coastal-bulletin'].flatMap(kind =>
  boundaries.map(([now, state]) => [kind, now, state]),
))('shows %s validity at %s', (kind, now, state) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const container = document.createElement('div');
  document.body.append(container);
  const popup = new MapPopup(container);
  popup.show({ type: 'weather', x: 100, y: 100, data: {
    id: 'imd-bay', event: 'IMD Sea Area Bulletin', headline: 'Bay forecast',
    description: 'Weather seasonal.', areaDesc: 'Bay of Bengal', severity: 'Minor',
    productKind: kind, onset: new Date('2026-10-24T21:00:00Z'),
    expires: new Date('2026-10-25T09:00:00Z'),
  } } as Parameters<MapPopup['show']>[0]);
  const content = document.querySelector('.map-popup')!.textContent!;
  expect(content).toContain(state);
  expect(content).toContain('2026-10-24 21:00 UTC');
  expect(content).toContain('2026-10-25 09:00 UTC');
  popup.hide();
});
