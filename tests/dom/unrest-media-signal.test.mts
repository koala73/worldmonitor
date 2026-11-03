import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { MapPopup } from '@/components/MapPopup';
import { toSocialUnrestEvent } from '@/services/unrest';
import type { UnrestEvent } from '@/generated/client/worldmonitor/unrest/v1/service_client';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
let container: HTMLElement;
let popup: MapPopup;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  popup = new MapPopup(container);
});
afterEach(() => { popup.hide('replacement'); container.remove(); });

const legacy: UnrestEvent = {
  id: 'gdelt-old', title: 'Paris (105 reports)', summary: '', city: 'Paris', country: 'France', region: '',
  eventType: 'UNREST_EVENT_TYPE_RIOT', severity: 'SEVERITY_LEVEL_HIGH', confidence: 'CONFIDENCE_LEVEL_HIGH',
  sourceType: 'UNREST_SOURCE_TYPE_GDELT', sources: ['GDELT'], sourceUrls: ['https://news.example/cairo-riot'],
  occurredAt: 1, location: { latitude: 48.85, longitude: 2.35 }, fatalities: 0, tags: [], actors: [],
};

it('does not validate an old high-confidence GDELT cache record', () => {
  const event = toSocialUnrestEvent(legacy);
  expect(event.validated).toBe(false);
  expect(event.confidence).toBe('low');
  expect(event.severity).toBe('low');
  expect(event.eventType).not.toBe('riot');
});
it('labels the single signal and its article link without asserting event severity', () => {
  popup.show({ type: 'protest', data: toSocialUnrestEvent(legacy), x: 10, y: 10 });
  expect(document.body.textContent).toContain('Unverified media signal');
  expect(document.body.textContent).toContain('local event is not verified');
  expect(document.querySelector('.popup-source-label')?.textContent).toContain('Related article');
  expect(document.querySelector('.popup-header')?.textContent).not.toMatch(/RIOT|HIGH|LOW|VERIFIED/);
});
it('labels each media signal in a mixed cluster and preserves ACLED verification', () => {
  const media = toSocialUnrestEvent(legacy);
  const acled = toSocialUnrestEvent({ ...legacy, id: 'acled', sourceType: 'UNREST_SOURCE_TYPE_ACLED', sources: ['ACLED'], sourceUrls: ['https://acled.example/event'] });
  popup.show({ type: 'protestCluster', data: { country: 'France', items: [media, acled] }, x: 10, y: 10 });
  const item = document.querySelector('a[href="https://news.example/cairo-riot"]')?.closest('li');
  expect(item?.textContent).toContain('Unverified media signal');
  expect(item?.textContent).toContain('Related article');
  expect(document.querySelector('.summary-item.verified')?.textContent).toContain('1');
  expect(acled.validated).toBe(true);
  expect(acled.eventType).toBe('riot');
});

it('counts cluster records without asserting that media mentions are events', () => {
  const media = toSocialUnrestEvent(legacy);
  popup.show({ type: 'protestCluster', data: { country: 'France', items: [media], count: 25, sampled: true }, x: 10, y: 10 });
  expect(document.querySelector('.popup-badge')?.textContent).toBe('25 RECORDS');
  expect(document.querySelector('.cluster-more')?.textContent).toBe('+24 records');
});

it('keeps low-confidence media signals in the SVG map feed without changing ACLED filtering', async () => {
  const { MapComponent } = await import('@/components/Map');
  const media = toSocialUnrestEvent(legacy);
  const quietAcled = { ...media, id: 'quiet-acled', sourceType: 'acled' as const };
  const riotAcled = { ...quietAcled, id: 'riot-acled', eventType: 'riot' as const };
  const map = Object.create(MapComponent.prototype);
  Object.assign(map, { state: { layers: { protests: true }, timeRange: 'all' }, protests: [media, quietAcled, riotAcled], newsLocations: [] });
  expect(map.overlayFeedSlices().protests.map((e: { id: string }) => e.id)).toEqual(['gdelt-old', 'riot-acled']);
  map.state.layers.protests = false;
  expect(map.overlayFeedSlices().protests).toEqual([]);
});
