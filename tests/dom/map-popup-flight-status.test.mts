import { afterEach, beforeAll, expect, it } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import type { AirportDelayAlert } from '@/services/aviation';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => { document.body.innerHTML = ''; });

const base: AirportDelayAlert = {
  id: 'x', iata: 'IKA', icao: 'OIIE', name: 'Imam Khomeini International', city: 'Tehran', country: 'Iran',
  lat: 35.4161, lon: 51.1522, region: 'mena', delayType: 'general', severity: 'normal',
  avgDelayMinutes: 0, delayedFlightsPct: 0, cancelledFlights: 0, totalFlights: 0,
  reason: 'Normal operations', source: 'faa', updatedAt: new Date('2026-10-25T10:00:00Z'),
};

function title(delay: AirportDelayAlert): string {
  const container = document.createElement('div');
  document.body.append(container);
  const popup = new MapPopup(container);
  popup.show({ type: 'flight', x: 100, y: 100, data: delay } as Parameters<MapPopup['show']>[0]);
  const text = document.querySelector('.map-popup .popup-title')!.textContent!;
  popup.hide();
  return text;
}

it.each([
  ['a NOTAM-only open airport', { source: 'notam', reason: 'Open' }, 'IKA - OPEN'],
  ['a normal airport with delay telemetry', {}, 'IKA - NORMAL OPERATIONS'],
  ['an airport with no coverage', { severity: 'unknown', source: 'unspecified' }, 'IKA - Coverage unavailable'],
  ['an airport with delays', { severity: 'major' }, 'IKA - DELAYS REPORTED'],
] as const)('titles %s without claiming delays it does not have', (_label, patch, expected) => {
  expect(title({ ...base, ...patch } as AirportDelayAlert)).toBe(expected);
});
