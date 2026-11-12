/**
 * Dashboard focus (#10453), disease outbreaks: each outbreak carries an ISO
 * code (some carry none). Under a focus the panel lists the chosen countries,
 * then neighbours marked, counts the rest, and its level counts follow the
 * focus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { DiseaseOutbreaksPanel } from '@/components/DiseaseOutbreaksPanel';
import { fetchDiseaseOutbreaks, type DiseaseOutbreakItem } from '@/services/disease-outbreaks';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

vi.mock('@/services/disease-outbreaks', () => ({ fetchDiseaseOutbreaks: vi.fn() }));

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
// TH's neighbours are KH, LA, MM and MY.
const FOCUS = scopeOf(['TH']);

function outbreak(id: string, disease: string, countryCode: string, alertLevel: string): DiseaseOutbreakItem {
  return {
    id,
    disease,
    location: `${disease} location`,
    countryCode,
    alertLevel,
    summary: '',
    sourceUrl: '',
    publishedAt: 1,
    sourceName: 'Test',
    lat: 0,
    lng: 0,
    cases: 0,
  };
}

const US = outbreak('us', 'Cholera', 'US', 'alert');
const LAOS = outbreak('la', 'Dengue', 'LA', 'warning');
const THAILAND = outbreak('th', 'Measles', 'TH', 'watch');
const NONE = outbreak('none', 'Mpox', '', 'alert');
const OUTBREAKS = [US, LAOS, THAILAND, NONE];

let panel: DiseaseOutbreaksPanel;

beforeEach(() => {
  vi.useFakeTimers();
  panel = new DiseaseOutbreaksPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  vi.mocked(fetchDiseaseOutbreaks).mockReset();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const content = () => el().querySelector<HTMLElement>('.panel-content')!;
const ALL = ['Cholera', 'Dengue', 'Measles', 'Mpox'];
/** The disease names rendered, in order. */
const diseases = () => {
  const text = content().textContent ?? '';
  return ALL.filter((d) => text.includes(d)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
};
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const levelButton = (level: string) => content().querySelector<HTMLButtonElement>(`button[data-filter="${level}"]`);

describe('DiseaseOutbreaksPanel under a focus', () => {
  it('lists the chosen country then the marked neighbour, counts hidden and no-country items, and scopes the level counts', async () => {
    panel.updateData(OUTBREAKS);
    panel.applyScope(FOCUS);
    await settle();

    expect(diseases()).toEqual(['Measles', 'Dengue']);
    const tags = [...content().querySelectorAll('.panel-scope-tag-neighbour')];
    expect(tags.map((n) => n.textContent)).toEqual(['Neighbour: Laos']);
    expect(strip()?.hidden).toBe(false);
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    // Level counts follow the focus: the only alerts are outside it.
    expect(levelButton('alert')).toBeNull();
    expect(levelButton('warning')?.textContent).toContain('1');
    expect(levelButton('watch')?.textContent).toContain('1');
  });

  it('shows the no-country outbreak on request, Show all shows everything, Apply focus filters again', async () => {
    panel.updateData(OUTBREAKS);
    panel.applyScope(FOCUS);
    await settle();

    stripButton('show-unattributed')!.click();
    await settle();
    expect(diseases()).toEqual(['Measles', 'Dengue', 'Mpox']);
    expect(content().querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')!.click();
    await settle();
    expect(diseases()).toEqual(['Cholera', 'Mpox', 'Dengue', 'Measles']);
    expect(levelButton('alert')?.textContent).toContain('2');

    // Apply focus keeps this session's "show items with no country" choice.
    stripButton('apply')!.click();
    await settle();
    expect(diseases()).toEqual(['Measles', 'Dengue', 'Mpox']);
  });

  it('the level chip filters within the focused set', async () => {
    panel.updateData(OUTBREAKS);
    panel.applyScope(FOCUS);
    await settle();
    levelButton('warning')!.click();
    await settle();
    expect(diseases()).toEqual(['Dengue']);
  });

  it('applies a focus set before the data arrives, and clears back to the full list', async () => {
    panel.applyScope(scopeOf(['TH'], false));
    expect(strip()?.hidden).toBe(true);
    panel.updateData(OUTBREAKS);
    await settle();
    expect(diseases()).toEqual(['Measles']);
    panel.applyScope(null);
    await settle();
    expect(diseases()).toEqual(['Cholera', 'Mpox', 'Dengue', 'Measles']);
    expect(strip()?.hidden).toBe(true);
    expect(content().querySelector('.panel-scope-tag')).toBeNull();
  });

  it('says nothing matched the focus, distinct from the panel empty state, and keeps the counts reachable', async () => {
    panel.updateData(OUTBREAKS);
    panel.applyScope(scopeOf(['NZ'], false));
    await settle();
    expect(content().querySelector('.panel-scope-empty')?.textContent).toContain('No disease outbreaks for these countries');
    expect(content().textContent).not.toContain('No outbreaks match filter');
    expect(strip()?.textContent).toContain('3 hidden by focus');
    stripButton('show-all')!.click();
    await settle();
    expect(diseases()).toHaveLength(4);
  });

  it('hides the strip while loading and after a load failure, and a focus change keeps the failure', async () => {
    vi.mocked(fetchDiseaseOutbreaks).mockRejectedValue(new Error('Outbreaks failed'));
    panel.applyScope(FOCUS);
    expect(await panel.fetchData()).toBe(false);
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Outbreaks failed');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(null);
    panel.applyScope(scopeOf(['US']));
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Outbreaks failed');
    expect(strip()?.hidden).toBe(true);

    panel.updateData(OUTBREAKS);
    await settle();
    expect(diseases()).toEqual(['Cholera']);
    expect(strip()?.hidden).toBe(false);

    panel.showLoading();
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-loading-text, .panel-loading-radar')).toBeTruthy();
    expect(diseases()).toEqual([]);
  });

  it('is unchanged without a focus', async () => {
    panel.updateData(OUTBREAKS);
    await settle();
    expect(diseases()).toEqual(['Cholera', 'Mpox', 'Dengue', 'Measles']);
    expect(strip()?.hidden).toBe(true);
    expect(levelButton('alert')?.textContent).toContain('2');
  });
});
