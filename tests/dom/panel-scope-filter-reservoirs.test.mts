import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReservoirLevelsPanel } from '@/components/ReservoirLevelsPanel';
import { toDisplayReservoirLevel } from '@/services/climate/reservoir-levels';
import { getPanelScopeBehaviour } from '@/config/panel-scope';
import { scopeNoticeFor } from '@/components/panel-scope-notice';
import { resolveScope } from '../../shared/tab-scope-resolve';
import fixture from '../../e2e/fixtures/reservoir-levels.json';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
let panel: ReservoirLevelsPanel;
const focus = (countries: string[], neighbours = false) => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const reservoirs = fixture.reservoirs.map(toDisplayReservoirLevel);
const ids = () => [...panel.getElement().querySelectorAll<HTMLElement>('[data-reservoir-id]')].map(el => el.dataset.reservoirId);
const strip = () => panel.getElement().querySelector<HTMLElement>('.panel-scope-strip');
const action = (name: string) => {
  const button = strip()?.querySelector<HTMLButtonElement>(`[data-scope-action="${name}"]`);
  if (!button) throw new Error(`Missing scope action: ${name}`);
  button.click();
};
const load = () => panel.setResult({ ok: true, snapshot: { reservoirs, fetchedAt: null, methodology: '', sourceName: '' } });
beforeEach(() => { vi.useFakeTimers(); panel = new ReservoirLevelsPanel(); document.body.append(panel.getElement()); });
afterEach(() => { panel.destroy(); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(300);

describe('Strategic Water Levels country focus', () => {
  it('matches host OR riparian countries once, and clearing restores all rows', async () => {
    load(); panel.applyScope(focus(['EG', 'ET'])); await flush();
    expect(ids()).toContain('gerd');
    expect(ids()).not.toContain('mead');
    expect(new Set(ids()).size).toBe(ids().length);
    expect(ids().sort()).toEqual(reservoirs.filter(r => [r.country, ...r.riparians].some(c => ['EG', 'ET'].includes(c))).map(r => r.id).sort());
    expect(getPanelScopeBehaviour('reservoir-levels')).toBe('filters');
    expect(scopeNoticeFor(getPanelScopeBehaviour('reservoir-levels'), panel, focus(['EG']))).toBeNull();
    panel.applyScope(null); await flush(); expect(ids()).toHaveLength(reservoirs.length);
  });
  it('orders chosen before neighbours and exposes hidden rows with Show all', async () => {
    load(); panel.applyScope(focus(['EG'], true)); await flush();
    const rows = [...panel.getElement().querySelectorAll('[data-reservoir-id]')];
    const tagged = rows.findIndex(row => row.querySelector('.panel-scope-tag-neighbour'));
    expect(tagged).toBeGreaterThan(-1);
    expect(rows.slice(tagged).every(row => row.querySelector('.panel-scope-tag-neighbour'))).toBe(true);
    expect(strip()?.textContent).toContain('hidden by focus');
    action('show-all'); await flush(); expect(ids()).toHaveLength(reservoirs.length);
    action('apply'); await flush(); expect(ids().length).toBeLessThan(reservoirs.length);
  });
  it('composes status filters and their counts with focus, keeping hidden rows reachable', async () => {
    load(); panel.applyScope(focus(['EG'])); panel.setFilter('attention'); await flush();
    expect(ids()).not.toContain('mead');
    const count = panel.getElement().querySelector('.panel-count')?.textContent;
    expect(Number(count)).toBe(ids().length);
    expect(strip()?.hidden).toBe(false);
    action('show-all'); await flush(); expect(ids()).toContain('mead');
  });
  it('distinguishes focus-empty, unknown attribution, empty data and failure', async () => {
    const unknown = { ...reservoirs[0]!, id: 'unknown', country: '', riparians: [] };
    panel.setResult({ ok: true, snapshot: { reservoirs: [...reservoirs, unknown], fetchedAt: null, methodology: '', sourceName: '' } });
    panel.applyScope(focus(['NZ'])); await flush();
    expect(panel.getElement().querySelector('.panel-scope-empty')).not.toBeNull();
    expect(strip()?.textContent).toContain('1 item with no country');
    action('show-unattributed'); await flush(); expect(ids()).toEqual(['unknown']);
    panel.showError('Failed'); panel.applyScope(focus(['EG'])); await flush();
    expect(panel.getElement().textContent).toContain('Failed'); expect(strip()?.hidden).toBe(true);
    panel.setResult({ ok: true, snapshot: null }); await flush();
    expect(panel.getElement().querySelector('.wl-empty')?.textContent).toBe('No readings yet');
    expect(strip()?.hidden).toBe(true);
  });
  it('ends a failed refresh using the retained snapshot and the latest focus', async () => {
    load(); await flush();
    panel.showLoading(); panel.applyScope(focus(['EG']));
    panel.setResult({ ok: false, snapshot: null }); await flush();
    expect(ids()).toContain('gerd'); expect(ids()).not.toContain('mead');
    panel.applyScope(focus(['US'])); await flush();
    expect(ids()).toContain('mead'); expect(ids()).not.toContain('gerd');
  });
  it('applies focus before data without replacing loading or refresh states', async () => {
    panel.applyScope(focus(['EG'])); await flush(); expect(ids()).toHaveLength(0);
    load(); await flush(); expect(ids()).toContain('gerd');
    panel.showLoading(); panel.applyScope(focus(['US'])); await flush();
    expect(panel.getElement().querySelector('.panel-loading-radar, .panel-loading-text')).not.toBeNull();
    expect(strip()?.hidden).toBe(true);
    load(); await flush(); expect(ids()).toContain('mead'); expect(ids()).not.toContain('gerd');
  });
});
