/**
 * Dashboard focus (#10453), correlation panels (military, escalation,
 * economic, disaster share CorrelationPanel): each convergence card carries
 * the ISO codes of its countries. Under a focus the panel lists chosen-country
 * cards, then neighbour cards marked, and counts the rest. The Force Posture
 * panel keeps its Taiwan Strait official-activity block only while Taiwan or
 * China is in the focus (chosen or neighbour).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import type { CorrelationSnapshotState } from '@/services/correlation-snapshots';
import type { ResolvedScope } from '@/services/tab-focus';
import { resolveScope } from '../../shared/tab-scope-resolve';

const snapshots = vi.hoisted(() => ({ listeners: new Map<string, (state: unknown) => void>() }));
vi.mock('@/services/correlation-snapshots', () => ({
  publishLocalCorrelationCards: vi.fn(),
  subscribeCorrelationSnapshot: (domain: string, listener: (state: unknown) => void) => {
    snapshots.listeners.set(domain, listener);
    return () => snapshots.listeners.delete(domain);
  },
}));
vi.mock('@/services/bootstrap', () => ({
  getHydratedData: () => ({ fixture: true }),
  ensureHydrated: vi.fn(),
  waitForBootstrapSlowTier: vi.fn(async () => true),
}));
vi.mock('@/components/cross-strait-activity-summary', () => ({
  isCrossStraitActivitySnapshot: () => true,
  crossStraitSourceHealthHeading: () => '',
  tryBuildCrossStraitActivityPanelModel: () => ({
    heading: 'Taiwan Strait official activity',
    disclaimer: '',
    coverageLabel: '',
    japanCoverageLabel: null,
    mnd: null,
    japan: [],
    sourceHealth: null,
  }),
}));

const { Panel } = await import('@/components/Panel');
const { CorrelationPanel } = await import('@/components/CorrelationPanel');
const { MilitaryCorrelationPanel } = await import('@/components/MilitaryCorrelationPanel');

beforeAll(async () => {
  await initTestI18n();
});

const scopeOf = (countries: string[], neighbours = true): ResolvedScope => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};

function card(id: string, title: string, countries: string[]): ConvergenceCard {
  return {
    id, domain: 'economic', title, score: 40, timestamp: 1, countries, trend: 'stable',
    signals: [{ type: 'sanctions', source: 'fixture', severity: 40, timestamp: 1, label: 'Signal' }],
  };
}

const LAOS = card('la', 'Laos convergence', ['LA']);
const US = card('us', 'US convergence', ['US']);
const MULTI = card('multi', 'Vietnam and US convergence', ['US', 'VN']);
const THAI = card('th', 'Thailand convergence', ['TH']);
const NONE = card('none', 'Unplaced convergence', []);
const CARDS = [LAOS, US, MULTI, THAI, NONE];

function publish(domain: CorrelationDomain, cards: ConvergenceCard[] | null, status: CorrelationSnapshotState['status'] = 'current'): void {
  const state = {
    status,
    offline: false,
    snapshot: cards ? { cards, computedAt: Date.now(), origin: 'seed' } : null,
  } as CorrelationSnapshotState;
  snapshots.listeners.get(domain)!(state);
}

let panel: InstanceType<typeof CorrelationPanel>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 1)));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.spyOn(Panel.prototype, 'observeNearViewport').mockImplementation((callback: () => void) => { callback(); });
});

afterEach(() => {
  panel?.destroy();
  snapshots.listeners.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function mount(): void {
  panel = new CorrelationPanel('economic-correlation', 'Economic Warfare', 'economic');
  document.body.appendChild(panel.getElement());
}

const settle = () => vi.advanceTimersByTimeAsync(300);
const el = () => panel.getElement();
const titles = () => [...el().querySelectorAll('.correlation-card-header')].map((n) => n.children[1]?.textContent);
const strip = () => el().querySelector<HTMLElement>('.panel-scope-strip');
const stripButton = (action: string) => strip()?.querySelector<HTMLButtonElement>(`button[data-scope-action="${action}"]`);
const cardFor = (title: string) => [...el().querySelectorAll('.correlation-card')].find((n) => n.querySelector('.correlation-card-header')?.children[1]?.textContent === title);
const count = () => el().querySelector('.panel-count')?.textContent;

describe('CorrelationPanel under a focus', () => {
  it('lists chosen-country cards, then the neighbour marked, and counts hidden and no-country cards', async () => {
    mount();
    publish('economic', CARDS);
    panel.applyScope(scopeOf(['TH', 'VN']));
    await settle();

    expect(titles()).toEqual([MULTI.title, THAI.title, LAOS.title]);
    expect(cardFor(LAOS.title)?.querySelector('.panel-scope-tag-neighbour')?.textContent).toBe('Neighbour: Laos');
    expect(cardFor(THAI.title)?.querySelector('.panel-scope-tag')).toBeNull();
    expect(strip()?.textContent).toContain('1 hidden by focus');
    expect(strip()?.textContent).toContain('1 item with no country');
    expect(count()).toBe('3');
  });

  it('shows the no-country card on request, everything on Show all, and filters again on Apply focus', async () => {
    mount();
    publish('economic', CARDS);
    panel.applyScope(scopeOf(['TH', 'VN']));
    await settle();

    stripButton('show-unattributed')!.click();
    await settle();
    expect(titles()).toEqual([MULTI.title, THAI.title, LAOS.title, NONE.title]);
    expect(cardFor(NONE.title)?.querySelector('.panel-scope-tag-none')?.textContent).toBe('No country');

    stripButton('show-all')!.click();
    await settle();
    expect(titles()).toEqual(CARDS.map((c) => c.title));
    expect(count()).toBe('5');

    stripButton('apply')!.click();
    await settle();
    expect(titles()).toEqual([MULTI.title, THAI.title, LAOS.title, NONE.title]);
  });

  it('applies a focus set before the data arrives, and clears back to the full list', async () => {
    mount();
    panel.applyScope(scopeOf(['TH'], false));
    await settle();
    expect(strip()?.hidden).toBe(true);
    publish('economic', CARDS);
    await settle();
    expect(titles()).toEqual([THAI.title]);
    panel.applyScope(null);
    await settle();
    expect(titles()).toEqual(CARDS.map((c) => c.title));
    expect(strip()?.hidden).toBe(true);
    expect(count()).toBe('5');
  });

  it('an empty focused result is distinct from the panel empty state, with the counts reachable', async () => {
    mount();
    publish('economic', CARDS);
    panel.applyScope(scopeOf(['NZ'], false));
    await settle();
    expect(el().querySelector('.panel-scope-empty')?.textContent).toContain('No signals for these countries');
    expect(el().querySelector('.correlation-empty')).toBeNull();
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(strip()?.textContent).toContain('4 hidden by focus');
    stripButton('show-all')!.click();
    await settle();
    expect(titles()).toHaveLength(5);
  });

  it('keeps its own empty and waiting states, with no strip', async () => {
    mount();
    panel.applyScope(scopeOf(['TH']));
    publish('economic', null, 'loading');
    await settle();
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.correlation-cards')).toBeNull();

    publish('economic', []);
    await settle();
    expect(el().querySelector('.correlation-empty')).not.toBeNull();
    expect(el().querySelector('.panel-scope-empty')).toBeNull();
    expect(strip()?.hidden).toBe(true);
  });

  it('hides the strip while loading and after a load failure, and a focus change keeps the failure', async () => {
    mount();
    publish('economic', CARDS);
    panel.applyScope(scopeOf(['TH']));
    await settle();
    expect(strip()?.hidden).toBe(false);
    panel.showLoading();
    expect(strip()?.hidden).toBe(true);
    panel.showError('Correlation failed');
    expect(strip()?.hidden).toBe(true);
    panel.applyScope(scopeOf(['VN']));
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Correlation failed');
    expect(strip()?.hidden).toBe(true);
  });

  it('a focus redraw already queued does not erase a failure that arrives before the frame', async () => {
    mount();
    publish('economic', CARDS);
    await settle();
    panel.applyScope(scopeOf(['TH']));
    panel.showError('Correlation failed');
    await settle();
    expect(el().querySelector('.panel-error-state')?.textContent).toContain('Correlation failed');
    expect(strip()?.hidden).toBe(true);
  });

  it('a new snapshot after a failure still recovers the panel', async () => {
    mount();
    publish('economic', CARDS);
    await settle();
    panel.applyScope(scopeOf(['TH']));
    panel.showError('Correlation failed');
    await settle();
    publish('economic', CARDS);
    await settle();
    expect(el().querySelector('.panel-error-state')).toBeNull();
    expect(titles()).toContain(THAI.title);
  });

  it('is unchanged when unfocused', async () => {
    mount();
    publish('economic', CARDS);
    await settle();
    expect(titles()).toEqual(CARDS.map((c) => c.title));
    expect(strip()?.hidden).toBe(true);
    expect(el().querySelector('.panel-scope-tag')).toBeNull();
    expect(count()).toBe('5');
  });
});

describe('Force Posture under a focus', () => {
  const official = () => el().querySelector('.cross-strait-official-activity');

  it('keeps the Taiwan Strait block only while Taiwan or China is chosen or a neighbour', async () => {
    panel = new MilitaryCorrelationPanel();
    document.body.appendChild(panel.getElement());
    publish('military', [card('tw', 'Taiwan Strait convergence', ['TW'])]);
    await settle();
    expect(official()).not.toBeNull();

    panel.applyScope(scopeOf(['FR']));
    await settle();
    expect(official()).toBeNull();

    // The Philippines neighbours Taiwan and China.
    panel.applyScope(scopeOf(['PH']));
    await settle();
    expect(official()).not.toBeNull();

    panel.applyScope(scopeOf(['TW'], false));
    await settle();
    expect(official()).not.toBeNull();

    panel.applyScope(scopeOf(['FR']));
    await settle();
    stripButton('show-all')!.click();
    await settle();
    expect(official()).not.toBeNull();

    panel.applyScope(null);
    await settle();
    expect(official()).not.toBeNull();
  });
});
