import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import type { MilitaryVessel, MilitaryVesselCluster } from '@/types';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(() => initTestI18n());

describe('naval group member navigation', () => {
  let container: HTMLElement;
  let popup: MapPopup;
  const vessel = (index: number): MilitaryVessel => ({
    id: `ship-${index}`, name: `Ship ${index}`, mmsi: `${index}`,
    vesselType: 'destroyer', operator: 'usn', operatorCountry: 'US', lat: 12, lon: 44,
    heading: 0, speed: 0, confidence: 'low', lastAisUpdate: new Date(),
    ...(index === 5 ? { usniSource: true, mmsi: '', usniRegion: 'Indian Ocean' } : {}),
  });
  const cluster: MilitaryVesselCluster = {
    id: 'naval-group', name: 'Indian Ocean Naval Group', lat: 12, lon: 44,
    vesselCount: 7, vessels: Array.from({ length: 7 }, (_, i) => vessel(i)),
  };
  const click = (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    expect(button?.tagName).toBe('BUTTON');
    button!.click();
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    popup = new MapPopup(container);
    popup.show({ type: 'militaryVesselCluster', data: cluster, x: 10, y: 10 });
  });
  afterEach(() => {
    popup.hide('replacement');
    container.remove();
  });

  it('opens the exact hidden member and restores group DOM, expansion, scroll and focus', () => {
    const original = document.querySelector<HTMLElement>('.map-popup')!;
    click('.cluster-toggle');
    const body = document.querySelector<HTMLElement>('.popup-body')!;
    original.scrollTop = 38;
    click('[data-vessel-index="5"]');
    expect(document.querySelector('.popup-title')?.textContent).toBe('Ship 5');
    expect(document.querySelector('.map-popup')).toBe(original);
    expect(original.scrollTop).toBe(0);
    expect(document.body.textContent).toContain('Indian Ocean');
    expect(document.body.textContent).toContain('Position approximate');
    const stats = new Map([...document.querySelectorAll('.popup-stat')].map(stat => [
      stat.querySelector('.stat-label')?.textContent?.trim(),
      stat.querySelector('.stat-value')?.textContent?.trim(),
    ]));
    expect(stats.get('SPEED')).toBe('Unknown');
    expect(stats.get('HEADING')).toBe('Unknown');
    expect(document.querySelector('.popup-back')).toBe(document.activeElement);
    click('.popup-back');
    expect(document.querySelector('.popup-title')?.textContent).toBe(cluster.name);
    expect(document.querySelector('.popup-body')).toBe(body);
    expect(original.scrollTop).toBe(38);
    expect(document.querySelector<HTMLElement>('.cluster-vessels-hidden')?.style.display).toBe('');
    expect(document.activeElement?.getAttribute('data-vessel-index')).toBe('5');
    click('.cluster-toggle');
    expect(document.querySelector<HTMLElement>('.cluster-vessels-hidden')?.style.display).toBe('none');
  });

  it('preserves observed AIS details and safely renders vessel names', () => {
    click('[data-vessel-index="1"]');
    expect(document.querySelector('.popup-title')?.textContent).toBe('Ship 1');
    expect(document.body.textContent).toContain('Live ship tracking');
    expect(document.body.textContent).toContain('0 kts');
    expect(document.body.textContent).toContain('0°');
    click('.popup-back');
    const unsafeName = { ...vessel(0), name: '<img src=x onerror=alert(1)>' };
    const unsafeCluster = { ...cluster, vessels: [unsafeName, ...cluster.vessels.slice(1)] };
    popup.show({ type: 'militaryVesselCluster', data: unsafeCluster, x: 10, y: 10 });
    expect(document.querySelector('[data-vessel-index="0"] img')).toBeNull();
    click('[data-vessel-index="0"]');
    expect(document.querySelector('.popup-title')?.textContent).toBe(unsafeName.name);
  });

  it('does not carry group navigation into a replacement popup', () => {
    click('[data-vessel-index="2"]');
    popup.show({ type: 'militaryVessel', data: vessel(3), x: 10, y: 10 });
    expect(document.querySelector('.popup-back')).toBeNull();
    expect(document.querySelector('.popup-title')?.textContent).toBe('Ship 3');
    click('.popup-close');
    expect(document.querySelector('.map-popup')).toBeNull();
  });
});
