import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { FuelShortagePanel } from '@/components/FuelShortagePanel';
import { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';

// The detail drawer covers the registry table. Everything under it must leave
// the tab order, or keyboard focus lands on content the reader cannot see.

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

function tabStops(root: HTMLElement, prefix: string) {
  const wrapper = root.querySelector<HTMLElement>(`.${prefix}-wrap .table-scroll`);
  const rows = [...root.querySelectorAll<HTMLElement>(`.${prefix}-row`)];
  expect(wrapper, 'the table sits in its scroll group').not.toBeNull();
  expect(rows.length).toBeGreaterThan(0);
  return [wrapper!, ...rows].map((el) => el.getAttribute('tabindex'));
}

async function closeDrawer(root: HTMLElement, prefix: string) {
  root.querySelector<HTMLElement>(`.${prefix}-drawer-close`)!.click();
  await expect.poll(() => root.querySelector(`.${prefix}-drawer`)).toBeNull();
}

const shortage = {
  id: 'cu-diesel', country: 'CU', product: 'diesel', severity: 'confirmed', firstSeen: '2025-11-01',
  lastConfirmed: '2026-04-20', resolvedAt: '', impactTypes: [], causeChain: [], shortDescription: 'Severe diesel shortfalls.',
  evidenceQuality: 'strong',
};
const pipeline = {
  id: 'antonio-ricaurte', name: 'Antonio Ricaurte Pipeline', operator: 'TGI / PDVSA', commodityType: 'gas',
  fromCountry: 'CO', toCountry: 'VE', transitCountries: ['PA'], capacityBcmYr: 5, capacityMbd: 0, lengthKm: 224,
  inService: 2007, publicBadge: 'disputed',
};
const facility = {
  id: 'cu-matanzas', name: 'Matanzas Supertanker Base', operator: 'CUPET', facilityType: 'crude_tank_farm',
  country: 'CU', capacityMb: 2.4, inService: 1990, location: { lat: 23.04, lon: -81.58 }, publicBadge: 'operational',
};
const registry = { classifierVersion: 'v1', fetchedAt: '', upstreamUnavailable: false };

describe('energy registry drawers take the covered table out of the tab order', () => {
  it('fuel shortages', async () => {
    const panel = mount(new FuelShortagePanel({ getFuelShortageDetail: async () => ({ shortage }) as never }));
    await panel.presentDetail({ ...registry, shortages: [shortage] } as never, 'cu-diesel');
    const root = panel.getElement();
    expect(root.querySelector('.fs-drawer')).not.toBeNull();
    expect(tabStops(root, 'fs').every((t) => t === '-1'), 'nothing under the open drawer is a tab stop').toBe(true);

    await closeDrawer(root, 'fs');
    expect(tabStops(root, 'fs').every((t) => t === '0'), 'the closed drawer gives the table back').toBe(true);
  });

  it('pipelines', async () => {
    const panel = mount(new PipelineStatusPanel({ getPipelineDetail: async () => ({ pipeline }) as never, listEnergyDisruptions: noEvents }));
    await panel.presentDetail({ ...registry, pipelines: [pipeline] } as never, 'antonio-ricaurte');
    const root = panel.getElement();
    expect(root.querySelector('.pp-drawer')).not.toBeNull();
    expect(tabStops(root, 'pp').every((t) => t === '-1'), 'nothing under the open drawer is a tab stop').toBe(true);

    await closeDrawer(root, 'pp');
    expect(tabStops(root, 'pp').every((t) => t === '0'), 'the closed drawer gives the table back').toBe(true);
  });

  it('storage facilities', async () => {
    const panel = mount(new StorageFacilityMapPanel({ getStorageFacilityDetail: async () => ({ facility }) as never, listEnergyDisruptions: noEvents }));
    await panel.presentDetail({ ...registry, facilities: [facility] } as never, 'cu-matanzas');
    const root = panel.getElement();
    expect(root.querySelector('.sf-drawer')).not.toBeNull();
    expect(tabStops(root, 'sf').every((t) => t === '-1'), 'nothing under the open drawer is a tab stop').toBe(true);

    await closeDrawer(root, 'sf');
    expect(tabStops(root, 'sf').every((t) => t === '0'), 'the closed drawer gives the table back').toBe(true);
  });
});
