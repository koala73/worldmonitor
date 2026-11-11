import { afterEach, expect, it, vi } from 'vitest';
import french from '@/locales/fr.json';
vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  count = -1;
  setCount(n: number) { this.count = n; }
  showError(message: string) { this.content.textContent = `error:${message}`; }
  setSafeContent(value: unknown) { this.content.innerHTML = String(value); }
} }));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'en',
  t: (key: string) => key.startsWith('panels.') ? Reflect.get(french.panels, key.slice(7)) ?? key : key,
}));
import { ReservoirLevelsPanel } from '@/components/ReservoirLevelsPanel';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { ReservoirLevel } from '@/services/climate';

afterEach(() => { document.body.replaceChildren(); });

function reservoir(id: string, overrides: Partial<ReservoirLevel> = {}): ReservoirLevel {
  return {
    id, name: id, country: 'ET', riparians: ['ET'], river: 'Blue Nile', lat: 11, lon: 35, tags: [], why: '',
    latest: { observedAt: new Date(Date.now() - 60 * 86_400_000), levelM: 600, madM: 0.02, segments: 30, ageDays: 60 },
    prevDate: null, changePrevM: null, change30dM: null, change90dM: -0.5, change365dM: -2,
    seasonalAnomalyM: -1, seasonalZ: -1, recordMinM: null, recordMaxM: null, recordStart: null,
    percentOfRange: null, recordLow: false, recordHigh: false, status: 'normal',
    series: [{ date: '2025-01-01', levelM: 601 }, { date: '2026-01-01', levelM: 600 }],
    ...overrides,
  };
}

const ok = (reservoirs: ReservoirLevel[]) => ({
  ok: true,
  snapshot: reservoirs.length ? { reservoirs, fetchedAt: new Date(), methodology: '', sourceName: '' } : null,
});
const rowIds = () => [...document.querySelectorAll<HTMLElement>('[data-reservoir-id]')].map((el) => el.dataset.reservoirId);

it('resolves the translated panel name for Settings search', () => {
  expect(PanelLayoutManager.prototype.getLocalizedPanelName('reservoir-levels', 'Strategic Water Levels'))
    .toBe('Niveaux d’eau stratégiques');
});

it('sorts attention first, filters, and hands the clicked reservoir to the map', () => {
  const panel = new ReservoirLevelsPanel();
  panel.setResult(ok([
    reservoir('calm', { tags: ['transboundary'] }),
    reservoir('stale', { status: 'no_recent_data', seasonalZ: null }),
    reservoir('mead', { status: 'record_low', seasonalZ: -2.4 }),
    reservoir('<img src=x onerror=alert(1)>', { status: 'low', seasonalZ: -1.8, tags: ['transboundary'] }),
  ]));
  expect(rowIds()).toEqual(['mead', '<img src=x onerror=alert(1)>', 'calm', 'stale']);
  expect(document.querySelector('img')).toBeNull();
  expect((panel as unknown as { count: number }).count).toBe(4);

  document.querySelector<HTMLButtonElement>('button[data-wl-filter="attention"]')!.click();
  expect(rowIds()).toEqual(['mead', '<img src=x onerror=alert(1)>']);
  expect(document.querySelector('button[data-wl-filter="attention"]')!.getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('button[data-wl-filter="transboundary"]')!.click();
  expect(rowIds()).toEqual(['<img src=x onerror=alert(1)>', 'calm']);

  const select = vi.fn();
  panel.setSelectHandler(select);
  document.querySelector<HTMLElement>('[data-reservoir-id="calm"] .wl-name')!.click();
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'calm' }));
});

it('tells an empty dataset from a failed request and keeps rows through a later failure', () => {
  const panel = new ReservoirLevelsPanel();
  panel.setResult({ ok: false, snapshot: null });
  expect(document.body.textContent).toContain('error:components.reservoirLevels.unavailable');
  panel.setResult(ok([]));
  expect(document.body.textContent).toContain('components.reservoirLevels.empty');
  expect(document.body.textContent).toContain('components.reservoirLevels.note');
  panel.setResult(ok([reservoir('mead')]));
  panel.setResult({ ok: false, snapshot: null });
  expect(rowIds()).toEqual(['mead']);
});

it('credits NASA ICESat-2 and SlideRule Earth with links', () => {
  const panel = new ReservoirLevelsPanel();
  panel.setResult(ok([reservoir('mead')]));
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.wl-footer a')].map((link) => link.href);
  expect(links).toEqual(['https://nsidc.org/data/atl13', 'https://slideruleearth.io/']);
});
