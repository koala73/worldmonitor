import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #6770 — the shared `inFlight` mutex is keyed by ad-hoc job-name strings. A
// logical job must be locked under ONE key across boot-hydration, refresh, and
// layer toggles, or the same work double-runs (or a same-key wrapper around a
// self-guarding loader becomes a guaranteed no-op). These source-structural
// assertions pin the alignment; behavioral scheduling is covered by
// load-all-data-scheduling.test.mts.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const dataLoader = readFileSync(resolve(REPO_ROOT, 'src/app/data-loader.ts'), 'utf8');
const app = readFileSync(resolve(REPO_ROOT, 'src/App.ts'), 'utf8');

describe('hydration lock keys (#6770)', () => {
  it('never wraps loadDailyMarketBrief in a same-key runGuarded (self-defeating no-op)', () => {
    // loadDailyMarketBrief self-guards on inFlight.has('dailyMarketBrief'), so a
    // runGuarded('dailyMarketBrief', () => loadDailyMarketBrief()) wrapper would
    // always return immediately — the brief would only ever run via the direct
    // post-hydration call.
    assert.doesNotMatch(
      dataLoader,
      /runGuarded\(\s*'dailyMarketBrief'/,
      'daily market brief must not be wrapped in a same-key runGuarded',
    );
    assert.match(
      dataLoader,
      /this\.loadDailyMarketBrief\(\)/,
      'the brief must still be loaded directly (post-hydration pass)',
    );
  });

  it('one-flights firms/radiation hydration with their map-layer toggles', () => {
    // loadDataForLayer locks by the MapLayers key ('fires' / 'radiationWatch');
    // the hydration loaders have no internal guard, so they must lock the SAME
    // key or a hydration/toggle race double-fetches.
    assert.match(dataLoader, /runGuarded\(\s*'fires'/, "firms hydration must lock 'fires' (the layer key)");
    assert.match(dataLoader, /runGuarded\(\s*'radiationWatch'/, "radiation hydration must lock 'radiationWatch'");
    assert.doesNotMatch(dataLoader, /runGuarded\(\s*'firms'/, "'firms' inFlight key diverges from the 'fires' layer key");
    assert.doesNotMatch(dataLoader, /runGuarded\(\s*'radiation'\s*,/, "'radiation' inFlight key diverges from 'radiationWatch'");
    // The firms REFRESH is the third guard-less-loadFirmsData call site; it must
    // lock the same 'fires' key or a hydration/refresh overlap double-fetches.
    const firmsRefreshRegistrations = app
      .split('\n')
      .filter(line => line.includes('fn: () => this.dataLoader.loadFirmsData()'));
    assert.equal(firmsRefreshRegistrations.length, 1, 'loadFirmsData must have exactly one refresh registration');
    const firmsRefreshRegistration = firmsRefreshRegistrations[0];
    assert.match(
      firmsRefreshRegistration,
      /name: 'fires'/,
      "firms refresh must lock 'fires' (matches hydration + layer toggle)",
    );
    assert.doesNotMatch(
      firmsRefreshRegistration,
      /name: 'firms'/,
      "firms refresh must not lock the divergent 'firms' key",
    );
  });

  it('locks the stock refreshes under the same inFlight key the loader uses', () => {
    // loadStockAnalysis / loadStockBacktest have no internal guard, so a boot
    // hydration and a refresh tick must share an inFlight key or they double-
    // fetch during the overlap window. The panel/viewport key stays kebab.
    assert.match(dataLoader, /runGuarded\(\s*'stockAnalysis'/, 'hydration locks stockAnalysis');
    assert.match(dataLoader, /runGuarded\(\s*'stockBacktest'/, 'hydration locks stockBacktest');
    assert.match(
      app,
      /'stockAnalysis',\s*\n\s*\(\) => this\.dataLoader\.loadStockAnalysis\(\)/,
      'refresh for loadStockAnalysis must lock the same camelCase key the loader uses',
    );
    assert.match(
      app,
      /'stockBacktest',\s*\n\s*\(\) => this\.dataLoader\.loadStockBacktest\(\)/,
      'refresh for loadStockBacktest must lock the same camelCase key the loader uses',
    );
  });
});
