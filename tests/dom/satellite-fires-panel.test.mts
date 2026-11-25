/**
 * #11273: the Satellite Fires panel mixes a capped page of FIRMS detections with
 * CWFIS / BC agency reports. Totals must describe the rows shown, the source line
 * must name the satellites and agencies in the data, and agency reports must show
 * their own report dates instead of passing as 24-hour thermal detections.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FireDetection } from '@/services/wildfires';
import { summarizeFires } from '@/services/wildfires';
import { initTestI18n } from './helpers/i18n.mts';

const { SatelliteFiresPanel } = await import('@/components/SatelliteFiresPanel');

const NOW = Date.parse('2026-11-24T12:00:00Z');

function firms(region: string, satellite: string, over: Partial<FireDetection> = {}): FireDetection {
  return {
    id: `${region}-${satellite}-${Math.random()}`, location: { latitude: 48.5, longitude: 37.2 },
    brightness: 340, frp: 25, confidence: 'FIRE_CONFIDENCE_NOMINAL', satellite, detectedAt: NOW - 3_600_000,
    region, dayNight: 'D', possibleExplosion: false, source: 'firms', kind: 'active', emergency: true, ...over,
  } as FireDetection;
}

function agency(region: string, detectedAt: number): FireDetection {
  return {
    id: `cwfis:${region}-${detectedAt}`, location: { latitude: 52.1, longitude: -73.4 },
    brightness: 0, frp: 0, confidence: 'FIRE_CONFIDENCE_HIGH', satellite: 'CWFIS', detectedAt,
    region, dayNight: '', possibleExplosion: false, source: 'cwfis', kind: 'active', emergency: true,
  } as FireDetection;
}

const REGIONS: Record<string, FireDetection[]> = {
  Ukraine: [firms('Ukraine', 'N20', { brightness: 370, confidence: 'FIRE_CONFIDENCE_HIGH', frp: 120 }), firms('Ukraine', 'N21')],
  Iran: [firms('Iran', 'N21')],
  Quebec: [agency('Quebec', Date.parse('2026-08-04T12:00:00Z')), agency('Quebec', Date.parse('2026-11-20T12:00:00Z'))],
};

let panel: InstanceType<typeof SatelliteFiresPanel>;
const text = (selector: string): string => panel.getElement().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeAll(async () => { await initTestI18n(); });
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  panel = new SatelliteFiresPanel();
  document.body.appendChild(panel.getElement());
  panel.update(summarizeFires(REGIONS), 3_372);
});
afterEach(async () => {
  panel.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const flush = () => vi.advanceTimersByTimeAsync(151);

describe('SatelliteFiresPanel', () => {
  it('totals only the rows it shows and states the shown-of-total population', async () => {
    await flush();
    expect(text('.fires-table .fire-totals')).toBe('Total 3 1 170');
    expect(text('.fires-shown-of-total')).toBe('Showing 5 of 3,372 fire records');
  });

  it('credits the satellites and agencies present in the data', async () => {
    await flush();
    expect(text('.fires-source')).toBe('NASA FIRMS (VIIRS NOAA-20, NOAA-21) · CWFIS');
  });

  it('lists agency reports apart from thermal detections, with their report dates', async () => {
    await flush();
    const thermalRegions = Array.from(panel.getElement().querySelectorAll('.fires-table .fire-region')).map((cell) => cell.textContent);
    expect(thermalRegions).toEqual(['Ukraine', 'Iran']);
    expect(text('.fires-agency-table tbody')).toBe('Quebec 2 Aug 4 – Nov 20');
  });
});
