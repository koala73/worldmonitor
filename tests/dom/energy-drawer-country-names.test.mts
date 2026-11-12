import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { FuelShortagePanel } from '@/components/FuelShortagePanel';
import { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';

// Rows may stay compact (ISO2 codes), but the detail drawer must spell the
// country out: "CU · diesel" does not tell a reader the shortage is in Cuba.

const panels: Array<{ destroy(): void }> = [];

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

function mount<T extends { getElement(): HTMLElement; notifyConnected(): void; destroy(): void }>(panel: T): T {
  panels.push(panel);
  document.body.append(panel.getElement());
  panel.notifyConnected();
  return panel;
}

const noEvents = async () => ({ events: [], upstreamUnavailable: false }) as never;

describe('energy registry drawers show full country names', () => {
  it('fuel shortage drawer heading names the country', async () => {
    const shortage = {
      id: 'cu-diesel',
      country: 'CU',
      product: 'diesel',
      severity: 'confirmed',
      firstSeen: '2025-11-01',
      lastConfirmed: '2026-04-20',
      resolvedAt: '',
      impactTypes: [],
      causeChain: [],
      shortDescription: 'Severe diesel shortfalls.',
    };
    const panel = mount(new FuelShortagePanel({ getFuelShortageDetail: async () => ({ shortage }) as never }));
    await panel.presentDetail({ shortages: [], classifierVersion: 'v1', fetchedAt: '', upstreamUnavailable: false } as never, 'cu-diesel');

    const heading = panel.getElement().querySelector('.fs-drawer h3')?.textContent ?? '';
    expect(heading).toContain('Cuba · diesel');
  });

  it('pipeline drawer route names origin, destination and transit countries', async () => {
    const pipeline = {
      id: 'antonio-ricaurte',
      name: 'Antonio Ricaurte Pipeline',
      operator: 'TGI / PDVSA',
      commodityType: 'gas',
      fromCountry: 'CO',
      toCountry: 'VE',
      transitCountries: ['PA'],
      capacityBcmYr: 5,
      capacityMbd: 0,
      lengthKm: 224,
      inService: 2007,
      publicBadge: 'disputed',
    };
    const panel = mount(new PipelineStatusPanel({
      getPipelineDetail: async () => ({ pipeline }) as never,
      listEnergyDisruptions: noEvents,
    }));
    await panel.presentDetail({ pipelines: [], classifierVersion: 'v1', fetchedAt: '', upstreamUnavailable: false } as never, 'antonio-ricaurte');

    expect(panel.getElement().querySelector('.pp-drawer')?.textContent).toContain('Colombia → Venezuela via Panama');
  });

  it('storage facility drawer names the country', async () => {
    const facility = {
      id: 'cu-matanzas',
      name: 'Matanzas Supertanker Base',
      operator: 'CUPET',
      facilityType: 'crude_tank_farm',
      country: 'CU',
      capacityMb: 2.4,
      inService: 1990,
      location: { lat: 23.04, lon: -81.58 },
      publicBadge: 'operational',
    };
    const panel = mount(new StorageFacilityMapPanel({
      getStorageFacilityDetail: async () => ({ facility }) as never,
      listEnergyDisruptions: noEvents,
    }));
    await panel.presentDetail({ facilities: [], classifierVersion: 'v1', fetchedAt: '', upstreamUnavailable: false } as never, 'cu-matanzas');

    expect(panel.getElement().querySelector('.sf-drawer')?.textContent).toMatch(/Country\s*Cuba/);
  });
});
