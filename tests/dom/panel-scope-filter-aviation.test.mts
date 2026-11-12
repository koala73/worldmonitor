/**
 * Dashboard focus (#10453), aviation: airports resolve to a country through
 * the monitored-airport table, a flight through either end, an aviation
 * headline through the names it contains. Airlines, tracking and prices do
 * not filter and say so.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { AirportOpsSummary, AviationNewsItem, FlightInstance } from '@/services/aviation';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

const aviation = vi.hoisted(() => ({
  fetchAirportOpsSummary: vi.fn(),
  fetchAirportFlights: vi.fn(),
  fetchCarrierOps: vi.fn(async () => []),
  fetchAircraftPositions: vi.fn(async () => []),
  fetchFlightStatus: vi.fn(async () => []),
  fetchAviationNews: vi.fn(),
  fetchGoogleFlights: vi.fn(async () => ({ flights: [], degraded: false, error: '' })),
  fetchGoogleDates: vi.fn(async () => ({ dates: [], degraded: false, error: '' })),
}));
vi.mock('@/services/aviation', () => aviation);

const { AirlineIntelPanel } = await import('@/components/AirlineIntelPanel');

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const FOCUS = scopeOf(['TH', 'VN', 'ID']);

function ops(iata: string, name: string): AirportOpsSummary {
  return {
    iata, icao: '', name, delayPct: 0, avgDelayMinutes: 0, cancellationRate: 0, totalFlights: 10,
    closureStatus: false, notamFlags: [], severity: 'normal', topDelayReasons: [], source: 'test', updatedAt: new Date(0),
  };
}

function flight(number: string, from: string, to: string): FlightInstance {
  return {
    flightNumber: number, date: '2026-11-11', carrier: { iata: 'XX', name: 'Test Air' },
    origin: { iata: from, name: from }, destination: { iata: to, name: to },
    scheduledDeparture: null, scheduledArrival: null, estimatedDeparture: null, estimatedArrival: null,
    status: 'scheduled', delayMinutes: 0, cancelled: false, diverted: false, gate: '', terminal: '', aircraftType: '', source: 'test',
  } as FlightInstance;
}

function headline(title: string): AviationNewsItem {
  return { id: title, title, url: `https://news.example/${encodeURIComponent(title)}`, sourceName: 'Wire', publishedAt: new Date(0), snippet: '', matchedEntities: [] };
}

// BKK Thailand (chosen), KUL Malaysia (neighbour), JFK United States (hidden), VTE not a monitored airport (no country).
const OPS = [ops('JFK', 'John F. Kennedy'), ops('KUL', 'Kuala Lumpur'), ops('BKK', 'Suvarnabhumi'), ops('VTE', 'Wattay')];
const FLIGHTS = [flight('TK1', 'IST', 'JFK'), flight('TK2', 'IST', 'KUL'), flight('TK3', 'IST', 'BKK'), flight('ZZ9', 'AAA', 'BBB')];
const NEWS = [
  headline('FAA orders new inspections for United States carriers'),
  headline('Thailand grounds a budget carrier after an incident'),
  headline('Airline stocks rally on fuel prices'),
];

let panel: InstanceType<typeof AirlineIntelPanel>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  aviation.fetchAirportOpsSummary.mockReset().mockResolvedValue(OPS);
  aviation.fetchAirportFlights.mockReset().mockResolvedValue(FLIGHTS);
  aviation.fetchAviationNews.mockReset().mockResolvedValue(NEWS);
  panel = new AirlineIntelPanel();
  document.body.appendChild(panel.getElement());
  panel.notifyConnected(); // what panel-layout does on mount; starts the first load
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const opsCodes = () => [...el().querySelectorAll('.ops-row .ops-iata')].map((n) => n.textContent);
const opsRow = (iata: string) => [...el().querySelectorAll('.ops-row')].find((n) => n.querySelector('.ops-iata')?.textContent === iata);
const tab = (name: string) => el().querySelector<HTMLButtonElement>(`.panel-tabs .panel-tab[data-tab="${name}"]`);

describe('AirlineIntelPanel under a focus', () => {
  it('ops: the chosen country first, the neighbour marked, the rest counted; no refetch on focus changes', async () => {
    await settle();
    expect(opsCodes()).toEqual(['JFK', 'KUL', 'BKK', 'VTE']);
    const opsCalls = aviation.fetchAirportOpsSummary.mock.calls.length;

    panel.applyScope(FOCUS);
    await settle();
    expect(opsCodes()).toEqual(['BKK', 'KUL']);
    expect(opsRow('KUL')?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Malaysia');
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');

    stripButton('show-unattributed')?.click();
    await settle();
    expect(opsCodes()).toEqual(['BKK', 'KUL', 'VTE']);

    panel.applyScope(null);
    await settle();
    expect(opsCodes()).toEqual(['JFK', 'KUL', 'BKK', 'VTE']);
    expect(strip()?.hidden).toBe(true);
    expect(aviation.fetchAirportOpsSummary.mock.calls.length).toBe(opsCalls);
  });

  it('ops: no watched airport in the focus is an empty state, not an error', async () => {
    panel.destroy();
    aviation.fetchAirportOpsSummary.mockResolvedValue([ops('JFK', 'John F. Kennedy')]);
    panel = new AirlineIntelPanel();
    document.body.appendChild(panel.getElement());
    panel.notifyConnected();
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('None of your watched airports are in these countries');
    expect(stripButton('show-all')).toBeTruthy();
    stripButton('show-all')?.click();
    await settle();
    expect(opsCodes()).toEqual(['JFK']);
  });

  it('flights: a flight counts by either end; unknown at both ends has no country', async () => {
    panel.applyScope(FOCUS);
    await settle();
    tab('flights')?.click();
    await settle();
    const numbers = [...el().querySelectorAll('.flight-row .flight-num')].map((n) => n.textContent);
    expect(numbers).toEqual(['TK3', 'TK2']);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
  });

  it('flights: an endpoint outside the hub list never hides a flight; it counts as having no country', async () => {
    aviation.fetchAirportFlights.mockResolvedValue([flight('TK9', 'IST', 'HAN'), flight('TK8', 'HAN', 'BKK')]);
    panel.applyScope(scopeOf(['VN'], false));
    await settle();
    tab('flights')?.click();
    await settle();
    // HAN is not in the hub list. IST->HAN has no known end in the focus: counted, one click away.
    // HAN->BKK: BKK is Thailand, outside a Vietnam-only focus, HAN unknown: also counted, not hidden.
    expect(el().querySelectorAll('.flight-row').length).toBe(0);
    expect(strip()?.textContent).toContain('2 items with no country');
    expect(strip()?.textContent).not.toContain('hidden by focus');
    stripButton('show-unattributed')?.click();
    await settle();
    expect([...el().querySelectorAll('.flight-row .flight-num')].map((n) => n.textContent).sort()).toEqual(['TK8', 'TK9']);
  });

  it('news: headlines attributed by the country they name', async () => {
    panel.applyScope(FOCUS);
    await settle();
    tab('news')?.click();
    await settle();
    const titles = [...el().querySelectorAll('.news-item .news-link')].map((n) => n.textContent);
    expect(titles).toEqual(['Thailand grounds a budget carrier after an incident']);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
  });

  it('tabs that do not filter say so in the strip', async () => {
    panel.applyScope(FOCUS);
    await settle();
    tab('airlines')?.click();
    await settle();
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('This tab is not filtered by country');
    tab('ops')?.click();
    await settle();
    expect(strip()?.textContent).not.toContain('This tab is not filtered by country');
  });
});
