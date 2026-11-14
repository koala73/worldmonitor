import { afterEach, expect, it, vi } from 'vitest';
import english from '@/locales/en.json';

const orbital = vi.hoisted(() => ({ passes: null as Map<string, unknown> | null, calls: 0 }));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
vi.mock('@/services/climate/reservoir-context-loader', () => ({
  loadReservoirNextPasses: async () => { orbital.calls++; return orbital.passes; },
  loadReservoirLevelsById: async () => new Map(),
}));
vi.mock('@/components/Panel', () => ({ Panel: class {
  content = document.body.appendChild(document.createElement('div'));
  setCount() {}
  showError(message: string) { this.content.textContent = `error:${message}`; }
  setSafeContent(value: unknown, afterUpdate?: () => void) { this.content.innerHTML = String(value); afterUpdate?.(); }
} }));
vi.mock('@/services/i18n', () => ({
  getLocale: () => 'en-GB',
  t: (key: string, params?: Record<string, string>) => {
    const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], english);
    return typeof text === 'string' ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? '') : key;
  },
}));
import { ReservoirLevelsPanel } from '@/components/ReservoirLevelsPanel';
import type { ReservoirLevel } from '@/services/climate';

afterEach(() => { document.body.replaceChildren(); orbital.passes = null; orbital.calls = 0; });

const reservoir = (id: string): ReservoirLevel => ({
  id, name: id, country: 'ET', riparians: ['ET'], river: 'Blue Nile', lat: 11, lon: 35, tags: [], why: '',
  latest: { observedAt: new Date('2026-09-06T00:00:00Z'), levelM: 600, madM: 0.02, segments: 30, ageDays: 69 },
  prevDate: null, changePrevM: null, change30dM: null, change90dM: null, change365dM: -2,
  seasonalAnomalyM: -1, seasonalZ: -1, recordMinM: null, recordMaxM: null, recordStart: null,
  percentOfRange: null, recordLow: false, recordHigh: false, status: 'normal', series: [],
});
const ok = (reservoirs: ReservoirLevel[]) => ({ ok: true, snapshot: { reservoirs, fetchedAt: new Date(), methodology: '', sourceName: '' } }) as const;
const nextLine = (id: string) => document.querySelector(`[data-reservoir-id="${id}"] .wl-next`)?.textContent?.replace(/\s+/g, ' ').trim();

it('shows a predicted crossing or the normal no-crossing answer, each with the orbit data date', async () => {
  const epoch = Date.parse('2026-11-13T18:00:00Z');
  const windowEndMs = Date.parse('2026-11-21T12:00:00Z');
  orbital.passes = new Map([
    ['gerd', { status: 'pass', timeMs: Date.parse('2026-11-16T03:12:00Z'), windowEndMs, elementsEpochMs: epoch }],
    ['aswan', { status: 'none', windowEndMs, elementsEpochMs: epoch }],
  ]);
  const panel = new ReservoirLevelsPanel();
  panel.setResult(ok([reservoir('gerd'), reservoir('aswan')]));
  await vi.waitFor(() => expect(nextLine('gerd')).toBeTruthy());
  expect(nextLine('gerd')).toBe('Next ICESat-2 crossing: 16 Nov 2026 (predicted from orbit data of 13 Nov 2026; cloud can block the lidar)');
  expect(nextLine('aswan')).toBe('Next ICESat-2 crossing: No measurement in this window (to 21 Nov 2026); orbit data of 13 Nov 2026');
  expect(document.querySelector('[data-reservoir-id="gerd"] .wl-detail')?.textContent).toContain('measured');
  orbital.passes = new Map([['gerd', { status: 'none', windowEndMs, elementsEpochMs: epoch }]]);
  panel.setResult(ok([reservoir('gerd')]));
  await vi.waitFor(() => expect(nextLine('gerd')).toContain('No measurement in this window'));
  expect(orbital.calls).toBe(2);
});

it('adds no row when orbit data is unavailable', async () => {
  const panel = new ReservoirLevelsPanel();
  panel.setResult(ok([reservoir('gerd')]));
  await vi.waitFor(() => expect(orbital.calls).toBe(1));
  expect(document.querySelector('.wl-next')).toBeNull();
});
