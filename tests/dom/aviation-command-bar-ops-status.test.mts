import { afterEach, expect, it, vi } from 'vitest';

const summaries = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/services/aviation', () => ({
  fetchAirportOpsSummary: async () => summaries.rows,
  fetchFlightStatus: async () => [],
  fetchFlightPrices: async () => ({ quotes: [] }),
  fetchAviationNews: async () => [],
  fetchGoogleFlights: async () => ({ flights: [] }),
}));

import { AviationCommandBar } from '@/components/AviationCommandBar';

afterEach(() => { document.body.innerHTML = ''; });

const row = { iata: 'IKA', icao: 'OIIE', name: 'Imam Khomeini International', avgDelayMinutes: 0, closureStatus: false };

it.each([
  ['notam', 'normal', 'Open'],
  ['aviationstack', 'normal', 'Normal ops'],
] as const)('an ops row sourced to %s reads "%s / %s"', async (source, severity, text) => {
  summaries.rows = [{ ...row, source, severity }];
  const bar = new AviationCommandBar();
  bar.open();
  const input = document.querySelector<HTMLInputElement>('#aviation-cmd-input')!;
  input.value = 'ops IKA';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await vi.waitFor(() => expect(document.querySelector('#aviation-cmd-result .cmd-row')).not.toBeNull());
  expect(document.querySelector('#aviation-cmd-result .cmd-row')!.textContent).toContain(text);
  bar.destroy();
});
