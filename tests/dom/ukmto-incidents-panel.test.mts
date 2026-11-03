import { afterEach, expect, it, vi } from 'vitest';
import french from '@/locales/fr.json';
vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  setCount() {}
  setSafeContent(value: unknown) { this.content.innerHTML = String(value); }
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) =>
  key.startsWith('panels.') ? Reflect.get(french.panels, key.slice(7)) ?? key : key,
}));
import { UkmtoIncidentsPanel } from '@/components/UkmtoIncidentsPanel';
import { PanelLayoutManager } from '@/app/panel-layout';

afterEach(() => { document.body.replaceChildren(); });

it('resolves the translated UKMTO name for Settings search', () => {
  expect(PanelLayoutManager.prototype.getLocalizedPanelName('ukmto-incidents', 'UKMTO Incidents'))
    .toBe('Incidents UKMTO');
});

it('separates unavailable, empty and stale states and escapes report text', () => {
  const panel = new UkmtoIncidentsPanel();
  panel.setData({ incidents: [], fetchedAt: 0, dataAvailable: false, stale: false });
  expect(document.body.textContent).toContain('ukmto.unavailable');
  panel.setData({ incidents: [], fetchedAt: Date.now(), dataAvailable: true, stale: false });
  expect(document.body.textContent).toContain('ukmto.empty');
  panel.setData({ incidents: [{ id: 'one', incidentNumber: 1, incidentType: 'Attack', place: '<img src=x>',
    description: '<script>alert(1)</script> suspected', occurredAt: Date.now(), reportedAt: Date.now(),
    location: { latitude: 26, longitude: 56 } }], fetchedAt: Date.now(), dataAvailable: true, stale: true });
  expect(document.body.textContent).toContain('ukmto.stale');
  expect(document.querySelector('img,script')).toBeNull();
  expect(document.body.textContent).toContain('suspected');
  const select = vi.fn();
  panel.setLocationClickHandler(select);
  document.querySelector<HTMLButtonElement>('button[data-id]')!.click();
  expect(select).toHaveBeenCalledWith(26, 56);
});

it('credits both publishers and omits a publication time the source does not carry', () => {
  const panel = new UkmtoIncidentsPanel();
  panel.setData({ incidents: [{ id: 'ukmto-186', incidentNumber: 186, incidentType: 'Attack', place: 'Strait of Hormuz',
    description: 'Tanker struck.', occurredAt: Date.parse('2026-10-29T17:50:00Z'), reportedAt: 0,
    location: { latitude: 26.38, longitude: 56.33 } }], fetchedAt: Date.now(), dataAvailable: true, stale: false });
  expect(document.body.textContent).toContain('ukmto.occurred: 2026-10-29 17:50 UTC');
  expect(document.body.textContent).not.toContain('ukmto.reported:');
  expect(document.body.textContent).not.toContain('1970');
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.ukmto-attribution a')].map(link => link.href);
  expect(links).toEqual([
    'https://www.ukmto.org/recent-incidents',
    'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    'https://hormuz.data-tracking.net/',
    'https://creativecommons.org/licenses/by/4.0/',
  ]);
});
