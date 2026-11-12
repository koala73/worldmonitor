/**
 * Dashboard focus (#10453), security advisories: each advisory carries the
 * ISO code of the country it covers. Under a focus the panel lists the chosen
 * countries, then neighbours marked, and counts the rest.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { SecurityAdvisoriesPanel } from '@/components/SecurityAdvisoriesPanel';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const FOCUS = scopeOf(['TH', 'VN', 'ID']);

function advisory(title: string, country: string | undefined, level: SecurityAdvisory['level'] = 'caution'): SecurityAdvisory {
  return {
    title,
    link: `https://travel.example/${encodeURIComponent(title)}`,
    pubDate: new Date('2026-11-10T00:00:00.000Z'),
    source: 'US State Dept',
    sourceCountry: 'US',
    level,
    ...(country ? { country } : {}),
  };
}

const US = advisory('United States travel advisory', 'US');
const LAOS = advisory('Laos travel advisory', 'LA', 'reconsider');
const THAILAND = advisory('Thailand travel advisory', 'TH');
const HEALTH = advisory('WHO outbreak notice', undefined, 'info');
const ADVISORIES = [US, LAOS, THAILAND, HEALTH];

let panel: SecurityAdvisoriesPanel;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
  vi.stubGlobal('fetch', fetchSpy);
  panel = new SecurityAdvisoriesPanel();
  document.body.appendChild(panel.getElement());
});

afterEach(() => {
  panel.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const titles = () => [...el().querySelectorAll('.sa-item .sa-title')].map((n) => n.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const itemFor = (title: string) => [...el().querySelectorAll('.sa-item')].find((n) => n.querySelector('.sa-title')?.textContent === title);
const count = () => el().querySelector('.panel-count')?.textContent;

describe('SecurityAdvisoriesPanel under a focus', () => {
  it('shows the chosen country, then the neighbour marked, and counts hidden and no-country items', async () => {
    panel.setData(ADVISORIES);
    panel.applyScope(FOCUS);
    await settle();

    expect(titles()).toEqual([THAILAND.title, LAOS.title]);
    expect(itemFor(LAOS.title)?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(count()).toBe('2');
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    // The summary counts follow the focus: Laos is the one "reconsider".
    expect(el().querySelector('.sa-summary-item.sa-level-reconsider .sa-summary-count')?.textContent).toBe('1');
    expect(el().querySelector('.sa-summary-item.sa-level-caution .sa-summary-count')?.textContent).toBe('1');
  });

  it('shows the no-country advisory on request, and "Show all" shows everything', async () => {
    panel.setData(ADVISORIES);
    panel.applyScope(FOCUS);
    await settle();

    stripButton('show-unattributed')?.click();
    await settle();
    expect(titles()).toEqual([THAILAND.title, LAOS.title, HEALTH.title]);
    expect(itemFor(HEALTH.title)?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')?.click();
    await settle();
    expect(titles()).toEqual(ADVISORIES.map((a) => a.title));
    expect(count()).toBe('4');
  });

  it('applies, re-applies and clears the focus from memory without a fetch', async () => {
    panel.setData(ADVISORIES);
    await settle();
    panel.applyScope(FOCUS);
    panel.applyScope(scopeOf(['TH', 'VN', 'ID']));
    await settle();
    expect(titles()).toEqual([THAILAND.title, LAOS.title]);
    panel.applyScope(null);
    await settle();
    expect(titles()).toEqual(ADVISORIES.map((a) => a.title));
    expect(strip()?.hidden).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a focus change during a load failure keeps the failure visible', async () => {
    panel.setData([US, LAOS, THAILAND, HEALTH]);
    panel.showError('Advisories failed');
    expect(el().querySelector('.panel-header-error')).toBeTruthy();
    panel.applyScope(FOCUS);
    await settle();
    panel.applyScope(null);
    await settle();
    expect(el().querySelector('.panel-header-error')).toBeTruthy();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Advisories failed');
    // Recovery draws with the focus that is current by then.
    panel.applyScope(FOCUS);
    panel.setData([US, LAOS, THAILAND, HEALTH]);
    await settle();
    expect(el().querySelector('.panel-header-error')).toBeNull();
    expect(titles().length).toBeGreaterThan(0);
  });

  it('a focus change during a refresh keeps the loading state until the new data lands', async () => {
    panel.setData([US, LAOS, THAILAND, HEALTH]);
    panel.showLoading('Refreshing advisories');
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-loading-text, .panel-loading-radar')).toBeTruthy();
    expect(el().querySelector('.sa-item')).toBeNull();
    panel.setData([US, LAOS, THAILAND, HEALTH]);
    await settle();
    expect(titles().length).toBeGreaterThan(0);
  });

  it('an empty focused result is distinct from a load failure', async () => {
    panel.setData([US, HEALTH]);
    panel.applyScope(FOCUS);
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No travel advisories for these countries');
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(stripButton('show-all')).toBeTruthy();

    panel.showError('Advisories failed');
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Advisories failed');
    expect(strip()?.hidden).toBe(true);
  });
});
