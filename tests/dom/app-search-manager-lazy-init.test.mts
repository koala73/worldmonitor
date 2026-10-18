/**
 * `App.ensureSearchManager()` lazily loads the search manager on the first
 * Cmd+K. It must publish the manager as soon as it is initialised. Optional
 * source hydration (the military-base index behind `whenSearchIndexReady()`)
 * must not hold the palette back, or Cmd+K waits on a network fetch at startup.
 *
 * The App runs on a prototype instance so the constructor's full boot stays
 * out of the test. The search-manager module is replaced with a stub whose
 * index never becomes ready.
 */
import { describe, expect, it, vi } from 'vitest';

const searchStub = vi.hoisted(() => {
  const created: Array<{ initialized: boolean }> = [];
  class SearchManager {
    initialized = false;
    constructor() { created.push(this); }
    init(): void { this.initialized = true; }
    destroy(): void {}
    updateFlightSource(): void {}
    whenSearchIndexReady(): Promise<void> {
      return new Promise<void>(() => {});
    }
  }
  return { SearchManager, created };
});

vi.mock('@/app/search-manager', () => ({ SearchManager: searchStub.SearchManager }));

import { App } from '@/App';

describe('App lazy search-manager startup', () => {
  it('resolves with the initialised manager while the search index is still hydrating', async () => {
    const app = Object.create(App.prototype) as App;
    const modules: unknown[] = [];
    Reflect.set(app, 'state', { isDestroyed: false });
    Reflect.set(app, 'modules', modules);
    Reflect.set(app, 'eventHandlers', { enablePanelById: () => undefined });
    Reflect.set(app, 'latestSearchAdsb', []);
    Reflect.set(app, 'latestSearchMilitary', []);
    Reflect.set(app, 'latestSearchAdsbUpdatedAt', null);
    Reflect.set(app, 'searchManager', null);
    Reflect.set(app, 'searchManagerLoad', null);
    const ensureSearchManager = Reflect.get(app, 'ensureSearchManager') as () => Promise<unknown>;

    // The index never becomes ready, so a loader that waits on it never
    // settles. The timer turns that hang into a named failure.
    const manager = await Promise.race([
      ensureSearchManager.call(app),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('ensureSearchManager waited on search-index hydration')), 2_000);
      }),
    ]);

    expect(searchStub.created).toHaveLength(1);
    const created = searchStub.created[0]!;
    expect(manager).toBe(created);
    expect(created.initialized).toBe(true);
    expect(Reflect.get(app, 'searchManager')).toBe(created);
    expect(modules).toContain(created);
  });
});
