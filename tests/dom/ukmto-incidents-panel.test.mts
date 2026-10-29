import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  setCount() {}
  setSafeContent(value: unknown) { this.content.innerHTML = String(value); }
} }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
import { UkmtoIncidentsPanel } from '@/components/UkmtoIncidentsPanel';

afterEach(() => { document.body.replaceChildren(); });

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
