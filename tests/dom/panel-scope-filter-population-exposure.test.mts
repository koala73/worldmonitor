import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopulationExposurePanel } from '@/components/PopulationExposurePanel';
import { addExposureCoverage, enrichEventsWithExposure, type EventForExposure, type ExposureSources } from '@/services/population-exposure';
import { resolveScope } from '../../shared/tab-scope-resolve';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
const focus = (countries: string[], neighbours = false) => {
  const scope = { countries, neighbours };
  return { scope, ...resolveScope(scope) };
};
const event = (id: string, country = 'Yemen', lat = 13.58, lon = 44.02): EventForExposure => ({
  id, name: id, country, lat, lon, type: 'conflict', hasPreciseLocation: true,
});
const bulk = Array.from({ length: 12 }, (_, i) => event(`ukraine-${i}`, 'Ukraine', 48 + i / 20, 30));
let panel: PopulationExposurePanel;
type FullSet = { events: EventForExposure[]; fromCache: boolean };
let loadFullSet: ReturnType<typeof vi.fn<() => Promise<FullSet | null>>>;
beforeEach(() => {
  vi.useFakeTimers();
  loadFullSet = vi.fn(async () => ({ events: [event('full-yemen')], fromCache: false }));
  panel = new PopulationExposurePanel({ loadFullSet });
  document.body.append(panel.getElement());
});
afterEach(() => { panel.destroy(); document.body.replaceChildren(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(300);
const text = () => panel.getElement().textContent ?? '';
const cards = () => [...panel.getElement().querySelectorAll('.popexp-card-name')].map(el => el.textContent);
const action = (name: string) => {
  const button = panel.getElement().querySelector<HTMLButtonElement>(`[data-scope-action="${name}"]`);
  expect(button).not.toBeNull(); button!.click();
};
const deliver = (sources: ExposureSources) => {
  const a = enrichEventsWithExposure(sources.unrest, 10);
  const b = enrichEventsWithExposure(sources.ucdp, 10, true);
  panel.setExposures([...a.exposures, ...b.exposures], false, addExposureCoverage(a.coverage, b.coverage), sources);
};

describe('population exposure focus before source limits', () => {
  it('finds both sources beyond the global ten, with scoped precision and location coverage', async () => {
    const yemen = [event('taiz'), { ...event('duplicate'), eventCount: 2 }, { ...event('imprecise'), hasPreciseLocation: false }];
    deliver({ unrest: [...bulk, ...yemen], ucdp: [...bulk, event('aden', 'Yemen', 12.8, 45)], ucdpIsProjection: false });
    panel.applyScope(focus(['YE'])); await flush();
    expect(cards()).toHaveLength(2);
    expect(text()).toContain('taiz'); expect(text()).toContain('aden');
    expect(cards().join('')).not.toContain('ukraine');
    expect(text()).toContain('Events shown: 4 of 5');
    expect(text()).toContain('24 hidden by focus');
    expect(loadFullSet).not.toHaveBeenCalled();
    panel.applyScope(null); await flush(); expect(cards()).toHaveLength(20);
  });

  it('orders chosen before neighbours and keeps hidden and unattributed events reachable', async () => {
    deliver({ unrest: [event('ukraine', 'Ukraine', 48, 30), event('syria', 'Syria', 33.5, 36.3), event('unknown', '', 0, 0), event('israel', 'Israel', 32, 34.8)], ucdp: [], ucdpIsProjection: false });
    panel.applyScope(focus(['IL'], true)); await flush();
    expect(cards()[0]).toContain('israel');
    expect(cards()[1]).toContain('Neighbour: Syria');
    expect(text()).toContain('1 item with no country');
    action('show-unattributed'); await flush();
    // Unknown points cannot receive an estimate; they remain in the no-estimate coverage bucket.
    expect(text()).toContain('1 in countries without density data');
    action('show-all'); await flush(); expect(cards().join('')).toContain('ukraine');
    panel.applyScope(focus(['MM'])); await flush(); expect(text()).toContain('No population exposure locations for these countries');
    panel.showError('offline'); panel.applyScope(focus(['YE'])); await flush(); expect(text()).toContain('offline');
  });

  it('loads full UCDP once for a projection, reuses it and ignores superseded requests', async () => {
    let resolve!: (result: FullSet) => void;
    loadFullSet.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const projection = { unrest: [], ucdp: bulk.slice(0, 10), ucdpIsProjection: true };
    deliver(projection); panel.applyScope(focus(['YE'])); await flush();
    expect(text()).toContain('Loading full UCDP locations');
    resolve({ events: [event('full-yemen')], fromCache: true }); await flush();
    expect(cards()[0]).toContain('full-yemen');
    expect(panel.getElement().querySelector('.panel-data-badge.cached')?.textContent).toContain('UCDP');
    panel.applyScope(null); await flush();
    expect(panel.getElement().querySelector<HTMLElement>('.panel-data-badge')?.style.display).toBe('none');
    panel.applyScope(focus(['UA'])); await flush(); panel.applyScope(focus(['YE'])); await flush();
    expect(loadFullSet).toHaveBeenCalledTimes(1);
    loadFullSet.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    deliver(projection); await flush();
    deliver({ unrest: [event('fresh')], ucdp: [], ucdpIsProjection: false });
    resolve({ events: [event('obsolete')], fromCache: true }); await flush();
    expect(cards().join('')).toContain('fresh'); expect(text()).not.toContain('obsolete');
    expect(panel.getElement().querySelector<HTMLElement>('.panel-data-badge')?.style.display).toBe('none');
  });

  it('keeps projection failures explicitly incomplete and retries on a new focus', async () => {
    loadFullSet.mockRejectedValueOnce(new Error('offline'));
    deliver({ unrest: [event('taiz')], ucdp: bulk.slice(0, 10), ucdpIsProjection: true });
    panel.applyScope(focus(['YE'])); await flush();
    expect(text()).toContain('Full UCDP locations could not load');
    expect(text()).toContain('Unrest coverage');
    expect(text()).toContain('taiz');
    panel.applyScope(focus(['UA'])); await flush(); expect(loadFullSet).toHaveBeenCalledTimes(2);
  });
});
