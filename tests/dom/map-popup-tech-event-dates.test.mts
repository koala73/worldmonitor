import { afterEach, beforeAll, expect, it } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import { initTestI18n } from './helpers/i18n.mts';

const originalTz = process.env.TZ;
beforeAll(initTestI18n);
afterEach(() => { process.env.TZ = originalTz; document.body.innerHTML = ''; });

it('shows every day of a date-only tech event west of UTC', () => {
  process.env.TZ = 'America/Los_Angeles';
  const container = document.createElement('div');
  document.body.append(container);
  const popup = new MapPopup(container);
  popup.show({ type: 'techEvent', x: 100, y: 100, data: {
    id: 'expo', title: 'Ongoing Expo', location: 'San Francisco', lat: 37.77, lng: -122.42,
    country: 'USA', startDate: '2026-11-25', endDate: '2026-11-27', url: null, daysUntil: 0,
  } } as Parameters<MapPopup['show']>[0]);
  expect(document.querySelector('.map-popup')!.textContent).toContain('Nov 25, 2026 - Nov 27');
  popup.hide();
});
