/**
 * The two label surfaces outside MapPopup that #8611 wired to vesselTypeLabel:
 * the globe tooltip and the country brief timeline. A vessel whose only
 * military evidence is AIS ship type 35 carries vesselType 'unknown', so both
 * must print the supported 'Military Ops' fact rather than a bare "Unknown".
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { MilitaryVessel } from '@/types';

import { initTestI18n } from './helpers/i18n.mts';

const timeline = vi.hoisted(() => ({ rendered: [] as unknown[][] }));
vi.mock('@/components/CountryTimeline', () => ({
  CountryTimeline: class {
    render(events: unknown[]) { timeline.rendered.push(events); }
    destroy() {}
  },
}));

import { GlobeMap } from '@/components/GlobeMap';
import { CountryIntelManager } from '@/app/country-intel';

beforeAll(async () => {
  await initTestI18n();
});

function militaryOpsVessel(overrides: Partial<MilitaryVessel> = {}): MilitaryVessel {
  return {
    id: 'ais-235123456', mmsi: '235123456', name: 'SEA FALCON',
    vesselType: 'unknown', aisShipType: 'Military Ops',
    operator: 'other', operatorCountry: 'YE',
    lat: 12, lon: 44, heading: 0, speed: 4,
    lastAisUpdate: new Date(), confidence: 'low',
    ...overrides,
  };
}

describe('globe tooltip vessel type', () => {
  // GlobeMap's marker arrays are private, so an intersection with the class
  // collapses to never. Describe only what this test touches.
  type GlobeHost = {
    vesselData: Map<string, MilitaryVessel>;
    clusterData: Map<string, unknown>;
    vessels: { typeLabel: string; type: string }[];
    flushMarkers: () => void;
    setMilitaryVessels: (vessels: MilitaryVessel[]) => void;
  };

  function host(): GlobeHost {
    const instance = Object.create(GlobeMap.prototype) as GlobeHost;
    instance.vesselData = new Map();
    instance.clusterData = new Map();
    instance.flushMarkers = () => {};
    return instance;
  }

  it('shows the AIS activity for an AIS-only military contact', () => {
    const globe = host();
    globe.setMilitaryVessels([militaryOpsVessel()]);
    expect(globe.vessels[0]?.typeLabel).toBe('Military Ops');
    // The raw enum still drives colour/icon lookup and must not become prose.
    expect(globe.vessels[0]?.type).toBe('unknown');
  });

  it('keeps the mapped class label when the class is actually known', () => {
    const globe = host();
    globe.setMilitaryVessels([militaryOpsVessel({ vesselType: 'destroyer', name: 'USS ZUMWALT' })]);
    expect(globe.vessels[0]?.typeLabel).toBe('Destroyer');
  });
});

describe('country brief timeline vessel type', () => {
  beforeEach(() => { timeline.rendered.length = 0; });

  function mountTimeline(vessel: MilitaryVessel): string[] {
    const intel = new CountryIntelManager({
      latestClusters: [],
      intelligenceCache: { military: { vessels: [vessel], flights: [] } },
      countryBriefPage: { getTimelineMount: () => document.createElement('div') },
      countryTimeline: null,
    } as unknown as AppContext);
    // 'ZZ' has no geometry and no COUNTRY_BOUNDS entry, so the operatorCountry
    // branch selects the vessel without dragging in country polygons.
    (intel as unknown as {
      mountCountryTimeline: (code: string, country: string) => void;
    }).mountCountryTimeline('ZZ', 'Testland');
    const last = timeline.rendered[timeline.rendered.length - 1] ?? [];
    return last.map((e: unknown) => (e as { label: string }).label);
  }

  it('shows the AIS activity for an AIS-only military contact', () => {
    const labels = mountTimeline(militaryOpsVessel({ operatorCountry: 'ZZ' }));
    expect(labels).toContain('SEA FALCON (Military Ops)');
  });

  it('keeps the raw class for a vessel whose class is known', () => {
    const labels = mountTimeline(militaryOpsVessel({
      operatorCountry: 'ZZ', vesselType: 'destroyer', name: 'USS ZUMWALT',
    }));
    expect(labels).toContain('USS ZUMWALT (destroyer)');
  });
});
