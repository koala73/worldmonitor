import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';

const panels: StorageFacilityMapPanel[] = [];

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function facility(id: string, name: string, lastEvidenceUpdate: string) {
  return {
    id,
    name,
    operator: 'QatarEnergy',
    facilityType: 'lng_export',
    country: 'QA',
    capacityMtpa: 77,
    inService: 1999,
    location: { lat: 25.9, lon: 51.55 },
    evidence: { physicalState: 'operational', physicalStateSource: 'operator', commercialState: 'under_contract', sanctionRefs: [], lastEvidenceUpdate },
    publicBadge: 'operational',
  };
}

async function present(selected: ReturnType<typeof facility>, all: ReturnType<typeof facility>[]) {
  const panel = new StorageFacilityMapPanel({
    getStorageFacilityDetail: async () => ({ facility: selected }) as never,
    listEnergyDisruptions: async () => ({ events: [], upstreamUnavailable: false }) as never,
  });
  panels.push(panel);
  document.body.append(panel.getElement());
  await panel.presentDetail({ facilities: all, classifierVersion: 'v1', fetchedAt: '2026-11-25T00:00:00Z', upstreamUnavailable: false } as never, selected.id);
  return panel.getElement();
}

function rowStatus(root: HTMLElement, id: string): string {
  const cell = root.querySelector(`tr[data-facility-id="${id}"] td:last-child`);
  return [...(cell?.children ?? [])].map(el => el.textContent?.trim()).join(' ');
}

describe('Storage atlas evidence age', () => {
  it('dates each status and flags operational badges whose evidence is older than 14 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z'));
    const stale = facility('ras-laffan', 'Ras Laffan LNG', '2026-04-22T00:00:00Z');
    const fresh = facility('fresh-lng', 'Fresh LNG', '2026-11-20T00:00:00Z');
    const undated = facility('undated-lng', 'Undated LNG', '');

    const root = await present(stale, [stale, fresh, undated]);

    expect(rowStatus(root, 'ras-laffan')).toBe('Operational Evidence 2026-04-22 · stale');
    expect(rowStatus(root, 'fresh-lng')).toBe('Operational Evidence 2026-11-20');
    expect(rowStatus(root, 'undated-lng')).toBe('Operational Evidence date unknown · stale');
    expect(root.querySelector('.sf-drawer')?.textContent?.replace(/\s+/g, ' '))
      .toContain('Evidence as of: 2026-04-22 · stale (older than 14 days, status may have changed)');
  });

  it('shows fresh evidence in the drawer without a stale marker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T00:00:00Z'));
    const fresh = facility('fresh-lng', 'Fresh LNG', '2026-11-20T00:00:00Z');

    const drawer = (await present(fresh, [fresh])).querySelector('.sf-drawer')?.textContent?.replace(/\s+/g, ' ') ?? '';

    expect(drawer).toContain('Evidence as of: 2026-11-20');
    expect(drawer).not.toContain('stale');
  });
});
