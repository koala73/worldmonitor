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
