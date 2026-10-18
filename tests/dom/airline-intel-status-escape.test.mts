import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace only the transport under the real aviation service, as
// airline-intel-prices.test.mts does, so the panel mounts and settles.
const transport = vi.hoisted(() => ({
  premiumFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/services/premium-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/premium-fetch')>()),
  premiumFetch: transport.premiumFetch,
}));

import type { FlightInstance } from '@/services/aviation';
import { AirlineIntelPanel } from '@/components/AirlineIntelPanel';
import { initTestI18n } from './helpers/i18n.mts';

const HOSTILE = '<img src=x onerror="window.__pwned=1">';

function flight(status: string): FlightInstance {
  return {
    flightNumber: 'EK3', date: '2026-10-13',
    carrier: { iata: 'EK', name: 'Emirates' },
    origin: { iata: 'DXB', name: 'Dubai' },
    destination: { iata: 'LHR', name: 'London Heathrow' },
    scheduledDeparture: null, scheduledArrival: null,
    estimatedDeparture: null, estimatedArrival: null,
    status, delayMinutes: 0, cancelled: false, diverted: false,
    gate: '', terminal: '', aircraftType: '', source: 'test',
  } as unknown as FlightInstance;
}

type Internals = {
  flightsData: FlightInstance[];
  trackingFlightData: FlightInstance[];
  renderFlights(): void;
  renderTracking(): void;
};

async function mountPanel(): Promise<{ panel: AirlineIntelPanel; content: HTMLElement; internals: Internals }> {
  const panel = new AirlineIntelPanel();
  const root = panel.getElement();
  document.body.appendChild(root);
  panel.notifyConnected();
  const content = root.querySelector<HTMLElement>('.airline-intel-content')!;
  await vi.waitFor(() => expect(content.querySelector('.panel-loading')).toBeNull());
  return { panel, content, internals: panel as unknown as Internals };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  transport.premiumFetch.mockReset();
  transport.premiumFetch.mockImplementation(async () => Response.json({}));
});

describe('AirlineIntelPanel renders a flight status as text', () => {
  it('on the flight board', async () => {
    const { panel, content, internals } = await mountPanel();
    internals.flightsData = [flight(HOSTILE)];
    internals.renderFlights();

    const cell = content.querySelector('.flight-status');
    expect(cell).not.toBeNull();
    expect(cell!.querySelector('img')).toBeNull();
    expect(cell!.textContent).toBe(HOSTILE);
    expect(content.querySelector('img')).toBeNull();
    panel.destroy();
  });

  it('in the tracking results card', async () => {
    const { panel, content, internals } = await mountPanel();
    internals.trackingFlightData = [flight(HOSTILE)];
    internals.renderTracking();

    const card = content.querySelector('.track-flight-card');
    expect(card).not.toBeNull();
    expect(card!.querySelector('img')).toBeNull();
    expect(card!.textContent).toContain(HOSTILE);
    expect(content.querySelector('img')).toBeNull();
    panel.destroy();
  });
});
