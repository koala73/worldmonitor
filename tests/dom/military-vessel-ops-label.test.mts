/**
 * Label surfaces for a vessel whose only military evidence is AIS ship type 35
 * ("Military Ops") — see #8611. Dropping the unsupported `destroyer` claim
 * leaves `vesselType: 'unknown'`, so every surface that prints the class must
 * fall back to the AIS activity rather than showing a bare "Unknown".
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MilitaryVessel, MilitaryVesselCluster } from '@/types';

import { MapPopup } from '@/components/MapPopup';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

function militaryOpsVessel(overrides: Partial<MilitaryVessel> = {}): MilitaryVessel {
  return {
    id: 'ais-235123456', mmsi: '235123456', name: 'SEA FALCON',
    vesselType: 'unknown', aisShipType: 'Military Ops',
    operator: 'other', operatorCountry: 'Yemen',
    lat: 12, lon: 44, heading: 0, speed: 4,
    lastAisUpdate: new Date('2026-09-24T00:00:00Z'), confidence: 'low',
    ...overrides,
  };
}

function badgeTexts(): (string | undefined)[] {
  return [...document.querySelectorAll('.popup-badge')].map(el => el.textContent?.trim());
}

describe('military-ops label surfaces', () => {
  let popup: MapPopup;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    popup = new MapPopup(container);
  });

  afterEach(() => {
    popup.hide('replacement');
    container.remove();
  });

  it('shows the AIS activity instead of a vessel class in the vessel popup', () => {
    popup.show({ type: 'militaryVessel', data: militaryOpsVessel(), x: 10, y: 10 });

    const stats = [...document.querySelectorAll('.stat-value')].map(el => el.textContent?.trim());
    expect(stats).toContain('Military Ops');
    // Match the badge by its exact text, not by position or the `elevated`
    // class -- the USNI deployment badge shares both.
    expect(badgeTexts()).toContain('MILITARY OPS');
    // Scoped to the type surfaces: an unrelated "destroyer" elsewhere in a
    // future popup body must not decide whether this assertion passes.
    expect(stats.join(' ')).not.toMatch(/destroyer/i);
    expect(badgeTexts()).not.toContain('DESTROYER');
  });

  it('keeps the class label for a vessel whose class is actually known', () => {
    popup.show({
      type: 'militaryVessel',
      data: militaryOpsVessel({ name: 'USS ZUMWALT', vesselType: 'destroyer', hullNumber: 'DDG-1000' }),
      x: 10, y: 10,
    });

    const stats = [...document.querySelectorAll('.stat-value')].map(el => el.textContent?.trim());
    expect(stats).toContain('Destroyer');
    expect(badgeTexts()).toContain('DESTROYER');
  });

  it('shows the AIS activity for cluster members too', () => {
    const cluster: MilitaryVesselCluster = {
      id: 'cluster-1', name: 'Gulf of Aden group', lat: 12, lon: 44,
      vesselCount: 1, vessels: [militaryOpsVessel()],
    };
    popup.show({ type: 'militaryVesselCluster', data: cluster, x: 10, y: 10 });

    const item = document.querySelector('.cluster-vessel-item')?.textContent?.trim();
    expect(item).toContain('Military Ops');
    expect(item).not.toMatch(/unknown|destroyer/i);
  });
});
