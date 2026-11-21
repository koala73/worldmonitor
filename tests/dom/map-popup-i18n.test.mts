/**
 * #10065: MapPopup must not mix the selected locale with hardcoded English.
 * Deterministic labels come from the catalogue; free-form provider prose is
 * left in its original language.
 */
import i18next from 'i18next';
import type { AIDataCenter } from '@/types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('globe.gl', () => ({ default: vi.fn() }));
import { GlobeMap } from '@/components/GlobeMap';
import { MapPopup } from '@/components/MapPopup';
import {
  aptSectorLabel, aptTacticLabel, countryLabel, isSameLocation, localizeRelativePlace,
  parseGdeltReportTitle, severityLabel, statusLabel, weatherEventLabel,
} from '@/components/map-popup-i18n';
import { mapAlert } from '@/services/weather';
import de from '@/locales/de.json';
import en from '@/locales/en.json';

async function useLanguage(lng: 'en' | 'de'): Promise<void> {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng, fallbackLng: 'en', supportedLngs: ['en', 'de'],
      resources: { en: { translation: en as Record<string, unknown> }, de: { translation: de as Record<string, unknown> } },
      interpolation: { escapeValue: false },
    });
  } else {
    if (!i18next.hasResourceBundle('de', 'translation')) i18next.addResourceBundle('de', 'translation', de, true, true);
    await i18next.changeLanguage(lng);
  }
  if (i18next.language !== lng) throw new Error(`[dom-harness] wanted ${lng}, got ${i18next.language}`);
}

let container: HTMLElement;
let popup: MapPopup;
beforeAll(() => useLanguage('de'));
beforeEach(async () => {
  await useLanguage('de');
  container = document.createElement('div');
  document.body.appendChild(container);
  popup = new MapPopup(container);
});
afterEach(() => { popup.hide('replacement'); container.remove(); });

const nuclear = { id: 'n1', name: 'Bushehr', lat: 28.8, lon: 50.9, type: 'plant', status: 'active', operator: 'AEOI' };
const weather = {
  id: 'w1', event: 'Flood Warning', severity: 'Moderate', headline: 'Flood warning issued for the river basin',
  description: 'River levels are rising quickly.', areaDesc: 'Basin', onset: new Date().toISOString(),
  expires: new Date(Date.now() + 3_600_000).toISOString(), coordinates: [], centroid: [0, 0],
};
const apt = {
  id: 'a1', name: 'APT33', aka: 'Elfin', sponsor: 'Iran', lat: 35, lon: 51, mitreId: 'G0064',
  mitreUrl: 'https://attack.mitre.org/groups/G0064/', tactics: ['Initial Access', 'Exfiltration'],
  targetSectors: ['Energy', 'Oil & Gas', 'SWIFT'], description: 'Iranian espionage group.',
};
const quake = {
  id: 'q1', place: '6 km SE of Pitaloza Arriba, Panama', magnitude: 5.2, depthKm: 10,
  location: { latitude: 8, longitude: -80 }, occurredAt: Date.now() - 60_000, sourceUrl: 'https://usgs.gov/x',
};

describe('label helpers in German', () => {
  it('maps severities, statuses, tactics and sectors; unknown values fall back unchanged', () => {
    expect(severityLabel('Moderate', { upper: true })).toBe('MÄSSIG');
    expect(statusLabel('active')).toBe('AKTIV');
    expect(statusLabel('Something Novel')).toBe('SOMETHING NOVEL');
    expect(aptTacticLabel('Initial Access')).toBe(de.popups.aptTactics.initialAccess);
    expect(aptSectorLabel('Oil & Gas')).toBe(de.popups.aptSectors.oilAndGas);
    expect(aptSectorLabel('SWIFT')).toBe('SWIFT');
    expect(aptSectorLabel('NATO')).toBe('NATO');
    expect(aptSectorLabel('NGOs')).toBe(de.popups.aptSectors.ngo);
    expect(aptSectorLabel('Semiconductor')).toBe('Halbleiter');
  });
  it('translates weather event names across sources and falls back for unknown events', () => {
    expect(weatherEventLabel('FLOOD WARNING', { upper: true })).toBe('HOCHWASSERWARNUNG');
    expect(weatherEventLabel('  flood   warning ')).toBe('Hochwasserwarnung');
    expect(weatherEventLabel('freezing rain warning')).toBe(de.popups.weatherEvents.freezingRainWarning);
    expect(weatherEventLabel('ORAGE')).toBe(de.popups.weatherEvents.thunderstorm);
    expect(weatherEventLabel('IMD Coastal Bulletin')).toBe(de.popups.weatherEvents.imdCoastalBulletin);
    expect(weatherEventLabel('Unheard-of Sky Event')).toBe('Unheard-of Sky Event');
    expect(weatherEventLabel('هشدار هواشناسی')).toBe('هشدار هواشناسی');
  });
  it('localizes principal earthquake directions and leaves other phrasings original', () => {
    expect(localizeRelativePlace('6 km SE of Pitaloza Arriba, Panama')).toBe(
      i18next.t('popups.earthquake.relativePlace', { distance: '6', direction: de.popups.compass.se, place: 'Pitaloza Arriba, Panama' }),
    );
    expect(localizeRelativePlace('12 km ESE of Hualien City, Taiwan')).toBe(
      i18next.t('popups.earthquake.relativePlace', { distance: '12', direction: 'ostsüdöstlich', place: 'Hualien City, Taiwan' }),
    );
    expect(localizeRelativePlace('South of the Fiji Islands')).toBe('South of the Fiji Islands');
  });
  it('localizes country names and detects country-level GDELT locations', () => {
    expect(countryLabel('Canada')).toBe('Kanada');
    expect(countryLabel('Atlantis')).toBe('Atlantis');
    expect(isSameLocation('Canada', 'Canada')).toBe(true);
    expect(isSameLocation('Toronto', 'Canada')).toBe(false);
    expect(parseGdeltReportTitle('Canada (33 reports)')).toEqual({ place: 'Canada', count: 33 });
    expect(parseGdeltReportTitle('Clashes in Paris')).toBeNull();
  });
});

describe('MapPopup in German', () => {
  it('shows the nuclear status from the catalogue and keeps the raw value as data', () => {
    popup.show({ type: 'nuclear', data: nuclear as never, x: 10, y: 10 });
    const text = document.body.textContent ?? '';
    expect(text).toContain('AKTIV');
    expect(text).not.toContain('ACTIVE');
  });
  it('localizes weather event and severity, and leaves the provider headline original', () => {
    popup.show({ type: 'weather', data: weather as never, x: 10, y: 10 });
    expect(document.querySelector('.popup-header .popup-badge')?.textContent).toBe('MÄSSIG');
    const title = document.querySelector('.popup-header .popup-title');
    expect(title?.textContent).toBe('HOCHWASSERWARNUNG');
    expect(title?.getAttribute('data-event')).toBe('Flood Warning');
    expect(document.body.textContent).toContain(weather.headline);
  });
  it('shows the issuing authority and an http(s)-only source link for weather alerts', () => {
    popup.show({ type: 'weather', x: 10, y: 10, data: { ...weather, issuedBy: 'NWS Houston/Galveston TX', sourceUrl: 'https://api.weather.gov/alerts/w1' } as never });
    expect(document.body.textContent).toContain(de.popups.mapPopup.issuedBy);
    expect(document.body.textContent).toContain('NWS Houston/Galveston TX');
    const link = document.querySelector<HTMLAnchorElement>('.popup-provenance a.popup-source-link');
    expect(link?.getAttribute('href')).toBe('https://api.weather.gov/alerts/w1');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    popup.show({ type: 'weather', x: 10, y: 10, data: { ...weather, source: 'eccc', sourceUrl: 'javascript:alert(1)' } as never });
    expect(document.body.textContent).toContain('Environment and Climate Change Canada');
    expect(document.querySelector('.popup-provenance a')).toBeNull();
  });
  it('keeps provenance fields when mapping the bootstrap shape', () => {
    const mapped = mapAlert({ ...weather, source: 'swic', authority: 'Météo-France', sourceUrl: 'https://severeweather.wmo.int/x' } as never);
    expect(mapped.issuedBy).toBe('Météo-France');
    expect(mapped.sourceUrl).toBe('https://severeweather.wmo.int/x');
    expect(mapped.source).toBe('swic');
  });
  it('localizes APT tactics and the Targets label, keeping MITRE ids', () => {
    popup.show({ type: 'apt', data: apt as never, x: 10, y: 10 });
    const text = document.body.textContent ?? '';
    expect(text).toContain(de.popups.aptTactics.initialAccess);
    expect(text).toContain(`${de.popups.mapPopup.targets}:`);
    expect(text).not.toContain('Targets:');
    expect(text).toContain('G0064');
    expect(document.querySelector('[data-tactic="Initial Access"]')).not.toBeNull();
  });
  it('localizes the earthquake direction and keeps the original in the title', () => {
    popup.show({ type: 'earthquake', data: quake as never, x: 10, y: 10 });
    const loc = document.querySelector('.popup-location');
    expect(loc?.textContent).toContain(de.popups.compass.se);
    expect(loc?.getAttribute('title')).toBe(quake.place);
  });
  it('does not render "Canada, Canada" for a country-level GDELT signal', () => {
    popup.show({
      type: 'protest', x: 10, y: 10,
      data: {
        id: 'gdelt-ca', title: 'Canada (33 reports)', city: 'Canada', country: 'Canada', eventType: 'protest',
        severity: 'low', confidence: 'low', sourceType: 'gdelt', sources: ['GDELT'], sourceUrls: [], lat: 56, lon: -106,
        time: new Date(), validated: false, fatalities: 0, tags: [], actors: [],
      } as never,
    });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Canada, Canada|Kanada, Kanada/);
    expect(text).toContain('Kanada');
    expect(text).not.toContain('reports)');
  });
});

describe('English baseline', () => {
  it('renders English labels', async () => {
    await useLanguage('en');
    popup.show({ type: 'weather', data: weather as never, x: 10, y: 10 });
    expect(document.querySelector('.popup-header .popup-badge')?.textContent).toBe('MODERATE');
  });
});

describe('storage facility popup in German', () => {
  it('translates the facility type, badge and atlas action', async () => {
    await useLanguage('de');
    popup.show({
      type: 'storageFacility', x: 10, y: 10,
      data: {
        id: 'okoli', name: 'Okoli UGS', operator: 'PSP d.o.o.', facilityType: 'lng_export',
        country: 'HR', capacityDisplay: '5.8 TWh', badge: 'operational',
      } as never,
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain(de.popups.storageFacility.types.lngExport);
    expect(text).toContain(de.popups.statusValues.operational.toUpperCase());
    expect(document.querySelector('[data-open-storage-atlas]')?.textContent).toBe(de.popups.storageFacility.openInAtlas);
    expect(text).not.toContain('Open in Storage Atlas');
    expect(text).not.toContain('LNG export');
  });
});

// #10190: details preserve the stored precision without claiming live measurements.
describe('datacenter details', () => {
  const dc: AIDataCenter = {
    id: 'dc-55', name: 'NexGen Cloud Hyperstack AQ Compute Supercomputer',
    owner: 'NexGen Cloud', country: 'Norway', lat: 60.472, lon: 8.9689,
    status: 'existing', chipType: 'NVIDIA H100 SXM5 80GB', chipCount: 16384, powerMW: 23.4,
  };

  it.each(['en', 'de'] as const)('provides localized, initially collapsed precise details in %s', async (lng) => {
    await useLanguage(lng);
    popup.show({ type: 'datacenter', data: dc, x: 10, y: 10 });
    const details = document.querySelector('details.datacenter-details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(dc.name);
    expect(details.textContent).toContain(lng === 'de' ? '16.384' : '16,384');
    expect(details.textContent).toContain(lng === 'de' ? '23,4 MW' : '23.4 MW');
    const labels = lng === 'de' ? de : en;
    expect(details.textContent).toContain(labels.popups.datacenter.details.powerCaveat);
    expect(details.textContent).toContain(labels.popups.datacenter.details.locationUnknown);
    expect(details.querySelector('a')?.href).toBe('https://epoch.ai/data/gpu-clusters');
    expect(details.querySelector('img')).toBeNull();
  });

  it('escapes optional metadata and rejects unsafe source links', async () => {
    await useLanguage('en');
    popup.show({ type: 'datacenter', data: {
      ...dc, description: '<img src=x onerror=alert(1)>', sourceUrl: 'javascript:alert(1)',
      powerBasis: 'estimated', metadataReviewedAt: '2026-11-06', firstOperationalDate: '2024-04-19',
    }, x: 10, y: 10 });
    const details = document.querySelector('.datacenter-details')!;
    expect(details.querySelector('img')).toBeNull();
    expect(details.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(details.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(details.textContent).toContain('Estimated');
    expect(details.textContent).toContain('2026-11-06');
    expect(details.textContent).toContain('2024-04-19');
  });

  it('shows missing power as unknown and preserves a zero value', async () => {
    await useLanguage('en');
    for (const powerMW of [undefined, 0]) {
      popup.show({ type: 'datacenter', data: { ...dc, powerMW }, x: 10, y: 10 });
      expect(document.querySelector('.datacenter-details')?.textContent).toContain(
        powerMW === undefined ? en.popups.datacenter.details.notAvailable : '0 MW',
      );
    }
  });
});

it('opens the shared datacenter popup from a globe marker', async () => {
  await useLanguage('en');
  const anchor = document.createElement('button');
  container.append(anchor);
  const host = Object.assign(Object.create(GlobeMap.prototype), {
    container, popup, hideTooltip: vi.fn(), showMarkerTooltip: vi.fn(),
  });
  host.handleMarkerClick({ _kind: 'datacenter', id: 'dc-55' }, anchor);
  expect(document.querySelector('.datacenter-details')?.textContent).toContain('23.4 MW');
  expect(host.hideTooltip).toHaveBeenCalledOnce();
  expect(host.showMarkerTooltip).not.toHaveBeenCalled();
});
