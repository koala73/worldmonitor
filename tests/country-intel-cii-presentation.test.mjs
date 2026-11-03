import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/app/country-intel.ts'), 'utf8');
const ast = ts.createSourceFile('country-intel.ts', source, ts.ScriptTarget.Latest, true);
const managerClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CountryIntelManager');
assert.ok(managerClass);
const bundled = await build({
  stdin: { contents: `
import { buildImfEconomicIndicators } from './src/services/imf-country-data';
import { CountryBriefController } from './src/components/CountryBriefController';
import { isBriefAviationDisruption } from './src/services/country-aviation-context';
const fixture = globalThis.__ciiPresentationTest;
const createWebsiteCountryBriefSource = () => ({ mode: 'website', clearLoadedData() {} });
const COUNTRY_ACTIVITY_BOUNDS = {}, COUNTRY_ALIASES = {};
const TIER1_COUNTRIES = { CN: 'China', US: 'United States' };
const getCachedCountryScore = code => { fixture.getterCalls++; return fixture.scores[code] ?? null; };
const getCountryData = code => fixture.countryData[code];
const normalizeCiiCountryCode = code => code.toUpperCase();
const canonicalizeCountryCode = code => code.toUpperCase();
const throwIfWebMcpAborted = signal => { signal?.throwIfAborted(); };
const raceWebMcpAbort = promise => promise;
const trackCountryBriefOpened = () => {};
const getChinaDecisionSignalsData = async () => ({});
const projectChinaCountrySummary = () => ({groups: []});
const CHINA_DECISION_SIGNAL_GROUP_IDS = [];
const t = key => key;
const yieldToMain = async () => {};
const effectivePubDateMs = () => 0;
const getCountryCentroid = () => null;
const ME_STRIKE_BOUNDS = {};
const preloadCountryGeometry = async () => {};
const preloadMilitaryBases = async () => [];
const preloadInfrastructureTables = async () => {};
const getSignalAggregator = async () => ({ getCountryClusters: () => [], getRegionalConvergence: () => [] });
const collectBriefSources = () => [];
const isHeadlineMemoryEnabled = () => false;
const mlWorker = { isAvailable: false };
const getActiveFrameworkForPanel = () => null;
const BETA_MODE = false;
const getCurrentLanguage = () => 'en';
${managerClass.getText(ast)}
export { CountryBriefController };
`, loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'controlled-country-services', setup(builder) {
    const stubs = {
      '@/components/StoryModal': 'export const openStoryModal = () => {}',
      '@/services/bootstrap': 'export async function ensureHydrated() { throw Error("Unexpected bootstrap read"); }',
      '@/utils/embedded-preview': 'export const IS_EMBEDDED_PREVIEW = true;',
      '@/services/prediction': 'export const fetchCountryMarkets = async () => []; export const protoToMarket = value => value;',
      '@/services/defense-industrial': 'export const getCountryDefenseIndustrialBase = async () => ({});',
      '@/utils/country-codes': 'export const iso2ToIso3 = value => value, iso2ToUnCode = value => value, iso2ToComtradeReporterCode = value => value;',
      '@/services/runtime': 'export const toApiUrl = value => value;',
      '@/services/aviation': 'export const fetchFlightDelays = async () => [];',
      '@/services/country-coverage': 'export async function fetchCountryCoverage() { return {headlines: [], timelineEvents: []}; }',
      '@/components/CountryDeepDivePanel': 'export const CountryDeepDivePanel = class { constructor() { return globalThis.__ciiPresentationTest.makePanel(); } };',
    };
    builder.onResolve({ filter: /^@\// }, args => args.path in stubs
      ? { path: args.path, namespace: 'controlled' }
      : { path: resolve(root, 'src', args.path.slice(2) + '.ts') });
    builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  } }],
});
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64');
const score = (value = 68, code = 'CN') => ({ code, name: code, score: value, level: 'high', trend: 'stable', change24h: 0,
  components: { unrest: 0, conflict: 0, security: 100, information: 0 }, lastUpdated: new Date('2026-10-16T07:56:53.961Z') });
const stock = { available: true, code: 'CN', symbol: 'FIX', indexName: 'Fixture index', price: '100.25', currency: 'CNY', weekChangePercent: '-1.25', fetchedAt: '2026-10-16T07:00:00Z' };
const imf = { macro: { inflationPct: 2.25 }, growth: { realGdpGrowthPct: 4.25, gdpPerCapitaUsd: 12345 }, labor: { unemploymentPct: 5.15 }, external: null, fetchedAt: 1 };
function deferred() { let resolve, reject; const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; }); return { promise, resolve, reject }; }
async function drain() { for (let iteration = 0; iteration < 40; iteration++) await Promise.resolve(); }
let serial = 0;
async function fixture(run, { initial = score(), realController = false } = {}) {
  const state = { scores: { CN: initial, US: score(75, 'US') }, getterCalls: 0, countryData: {}, signalQueue: [], hydrations: [], openings: [], signalCalls: 0, assessmentCalls: 0, networkAttempts: 0, warnings: [], errors: [] };
  globalThis.__ciiPresentationTest = state;
  const { CountryIntelManager, CountryBriefController } = await import(moduleUrl + '#' + serial++);
  const harness = await createCountryDeepDivePanelHarness();
  const originalFetch = globalThis.fetch, warn = console.warn, error = console.error;
  globalThis.fetch = () => { state.networkAttempts++; throw Error('Network forbidden in CII presentation test'); };
  console.warn = (...args) => state.warnings.push(args);
  console.error = (...args) => state.errors.push(args);
  CountryIntelManager.resolveCountryName = code => code;
  CountryIntelManager.isCountryHeadline = () => false;
  CountryIntelManager.getCountrySearchTerms = () => [];
  CountryIntelManager.firstMentionPosition = () => Infinity;
  state.makePanel = () => {
    const panel = harness.createPanel();
    for (const name of ['updateSignalDetails', 'updateMilitaryActivity', 'updateSignals', 'updateChinaCountrySummary', 'updateNews', 'updateInfrastructure', 'updateBrief', 'updateCountryFacts', 'updateEnergyProfile', 'updateMaritimeActivity', 'updateMarkets', 'updateHousingCycle', 'setSectionFailure', 'setSectionCoverage']) panel[name] = () => {};
    return panel;
  };
  const map = { setRenderPaused() {}, clearCountryHighlight() {}, highlightCountry() {}, fitCountry() {} };
  const ctx = { countryBriefPage: null, isDestroyed: false, map, allNews: [], intelligenceCache: {} };
  const manager = new CountryIntelManager(ctx);
    manager.getCountryController = page => {
    if (realController) {
      if (!manager.countryController || manager.countryControllerPage !== page) {
        manager.countryController?.dispose();
        state.controllerReads ??= [];
        const source = { mode: 'host', canRequestPremium: () => false,
          market: { getCountryStockIndex: () => state.controllerReads.at(-1).stock.promise },
          fetch: async url => { const read = state.controllerReads.at(-1); return { ok: true, json: () => url.includes('imfMacro') ? read.imf.promise : {} }; },
          intelligence: { getCountryFacts: async () => ({}), getCountryEnergyProfile: async () => ({}), getCountryPortActivity: async () => ({}) },
          prediction: { listPredictionMarkets: async () => ({ dataAvailable: true, markets: [] }) } };
        manager.countryController = new CountryBriefController(source, page);
        const hydrate = manager.countryController.hydrate.bind(manager.countryController);
        manager.countryController.hydrate = (...args) => {
          state.controllerReads.push({ stock: deferred(), imf: deferred() });
          state.hydrations.push(args[2]);
          return hydrate(...args);
        };
        manager.countryControllerPage = page;
      }
    } else if (!manager.countryController || manager.countryControllerPage !== page) {
      manager.countryController?.dispose();
      manager.countryController = { dispose() {}, hydrate(_code, _name, callbacks) { state.hydrations.push(callbacks); return { stockPromise: Promise.resolve(null) }; } };
      manager.countryControllerPage = page;
    }
    return manager.countryController;
  };
  Object.assign(manager, {
    getCountrySignals: () => { state.signalCalls++; return state.signalQueue.length ? state.signalQueue.shift().promise : Promise.resolve({}); },
    buildSignalDetails: async () => ({}), buildMilitarySummary: () => ({ coverageNotes: [] }),
    mountCountryTimeline() {}, buildBriefContextSnapshot: () => '',
    fetchCountryIntelBrief: async () => { state.assessmentCalls++; return { brief: '', sources: [] }; },
    buildFallbackSignalLines: () => [], showToast: message => { throw Error(message); },
  });
  state.manager = manager; state.ctx = ctx;
  state.open = async (code = 'CN') => {
    const done = manager.openCountryBriefByCode(code, code, { trackAnalytics: false });
    state.openings.push(done); await drain(); return done;
  };
  state.startOpen = (code = 'CN', opts = {}) => { const done = manager.openCountryBriefByCode(code, code, { trackAnalytics: false, ...opts }); state.openings.push(done); return done; };
  state.refresh = async value => { state.scores[ctx.countryBriefPage.getCode()] = value; manager.refreshOpenBrief(); await drain(); };
  state.panelRoot = () => harness.getPanelRoot();
  state.rows = () => [...harness.getPanelRoot().querySelectorAll('.cdp-economic-item')].map(row => ({
    label: row.querySelector('.cdp-economic-label').textContent, value: row.querySelector('.cdp-economic-value').textContent,
    source: row.querySelector('.cdp-economic-source')?.textContent ?? null,
  }));
  state.check = value => {
    const card = harness.getPanelRoot().querySelector('.cdp-score-card');
    assert.equal(card.querySelector('.cdp-score-value')?.textContent ?? null, value == null ? null : `${value}/100`, 'headline score');
    const regimes = state.rows().filter(row => row.label === 'Instability Regime');
    assert.deepEqual(regimes.map(row => row.value), value == null ? [] : [`${value}/100 (high)`], 'economic Regime must equal the applied headline');
    if (value == null) { assert.match(card.textContent, /countryBrief\.ciiUnavailable/); assert.equal(card.querySelector('.cdp-updated').textContent, 'Updated —'); }
  };
  try { await run(state); assert.deepEqual(state.errors, [], 'no swallowed opening/render failures'); assert.equal(state.networkAttempts, 0); }
  finally {
    manager.destroy();
    await drain();
    globalThis.fetch = originalFetch; console.warn = warn; console.error = error;
    harness.cleanup(); delete globalThis.__ciiPresentationTest;
  }
}

test('R1-R2: refreshing CII synchronizes real headline and economic DOM, including null', async () => {
  await fixture(async fixtureState => { await fixtureState.open(); fixtureState.check(68); const chips = fixtureState.panelRoot().querySelector('.cdp-signal-chips'); await fixtureState.refresh(score(71)); fixtureState.check(71); assert.equal(chips.parentNode, null); assert.notEqual(fixtureState.panelRoot().querySelector('.cdp-signal-chips'), chips); await fixtureState.refresh(null); fixtureState.check(null); assert.equal(fixtureState.assessmentCalls, 1); });
});

test('R2: olderRefresh direct 68-to-null refresh removes Regime without fabricating zero', async () => {
  await fixture(async fixtureState => { await fixtureState.open(); fixtureState.check(68); await fixtureState.refresh(null); fixtureState.check(null); assert.equal(fixtureState.assessmentCalls, 1); });
});

for (const value of [71, null]) for (const order of ['stock-first', 'imf-first']) {
  test(`R3-R5: late opening data retains ${value} CII (${order})`, async () => {
    await fixture(async fixtureState => {
      await fixtureState.open(); await fixtureState.refresh(value == null ? null : score(value));
      const callbacks = fixtureState.hydrations[0];
      for (const name of order === 'stock-first' ? ['stock', 'imf'] : ['imf', 'stock']) { callbacks[name](name === 'stock' ? stock : imf); fixtureState.check(value); }
      assert.deepEqual(fixtureState.rows().slice(0, 2).map(indicator => [indicator.label, indicator.value]), [['Stock Index', 'Fixture index: 100.25 CNY'], ['Weekly Momentum', '-1.25%']]);
      assert.ok(fixtureState.rows().some(indicator => indicator.label === 'Real GDP Growth' && indicator.value === '+4.3%'));
      assert.ok(fixtureState.rows().length <= 6);
    });
  });
}
test('R6/R16: null-to-available preserves economic order, precision, attribution and cap', async () => {
  await fixture(async fixtureState => {
    fixtureState.countryData.CN = { displacementOutflow: 1500000 };
    await fixtureState.open(); fixtureState.hydrations[0].stock(stock); fixtureState.hydrations[0].imf(imf); fixtureState.check(null);
    await fixtureState.refresh(score(71)); fixtureState.check(71);
    assert.deepEqual(fixtureState.rows().map(indicator => [indicator.label, indicator.value, indicator.source]), [
      ['Stock Index', 'Fixture index: 100.25 CNY', 'Market Service'], ['Weekly Momentum', '-1.25%', null],
      ['Instability Regime', '71/100 (high)', 'Country Instability Index'], ['Displacement Outflow', '1.5M', 'UN-style displacement feed'],
      ['Real GDP Growth', '+4.3%', 'IMF WEO · Year not supplied · IMF release not supplied'], ['CPI Inflation', '+2.3%', 'IMF WEO · Year not supplied · IMF release not supplied'],
    ]);
    fixtureState.hydrations[0].imf(imf); assert.equal(fixtureState.rows().length, 6); fixtureState.check(71);
  }, { initial: null });
});
for (const value of [71, null]) {
  test(`R7: late opening signal continuation cannot roll ${value} back to 68`, async () => {
    await fixture(async fixtureState => {
      const initial = deferred(), late = deferred(); fixtureState.signalQueue.push(initial, late);
      const opening = fixtureState.startOpen(); initial.resolve({}); await drain();
      assert.equal(fixtureState.signalCalls, 2, 'opening paused at its second signal read');
      await fixtureState.refresh(value == null ? null : score(value)); fixtureState.check(value);
      late.resolve({}); await opening; fixtureState.check(value);
      assert.equal(fixtureState.signalCalls, 3); assert.equal(fixtureState.assessmentCalls, 1);
    });
  });
  test(`R8-R9: latest invoked refresh wins and reads score at completion (${value})`, async () => {
    await fixture(async fixtureState => {
      await fixtureState.open(); const olderRefresh = deferred(), newerRefresh = deferred(); fixtureState.signalQueue.push(olderRefresh, newerRefresh);
      const getterBefore = fixtureState.getterCalls; fixtureState.manager.refreshOpenBrief(); fixtureState.manager.refreshOpenBrief();
      fixtureState.scores.CN = value == null ? null : score(value); newerRefresh.resolve({}); await drain(); fixtureState.check(value);
      fixtureState.scores.CN = score(69); olderRefresh.resolve({}); await drain(); fixtureState.check(value);
      assert.equal(fixtureState.getterCalls - getterBefore, 1, 'only latest completion reads the cached getter');
    });
  });
}
for (const code of ['US', 'CN']) {
  test(`R10-R11: callbacks and refreshes from olderRefresh superseded opening cannot write ${code}`, async () => {
    await fixture(async fixtureState => {
      await fixtureState.open(); const old = fixtureState.hydrations[0], pending = deferred(); fixtureState.signalQueue.push(pending); fixtureState.manager.refreshOpenBrief();
      fixtureState.scores[code] = score(75, code); await fixtureState.open(code); fixtureState.check(75);
      old.stock(stock); old.imf(imf); pending.resolve({}); await drain(); fixtureState.check(75);
      assert.ok(!fixtureState.rows().some(indicator => indicator.label === 'Stock Index' || indicator.label === 'Real GDP Growth'));
    });
  });
}
test('R12: same-country page replacement rejects pending work on the detached page', async () => {
  await fixture(async fixtureState => {
    await fixtureState.open(); const oldPage = fixtureState.ctx.countryBriefPage, old = fixtureState.hydrations[0], pending = deferred();
    fixtureState.signalQueue.push(pending); fixtureState.manager.refreshOpenBrief();
    fixtureState.ctx.countryBriefPage = null; fixtureState.scores.CN = score(75); await fixtureState.open(); fixtureState.check(75);
    let oldWrites = 0; oldPage.updateScore = oldPage.updateEconomicIndicators = () => oldWrites++;
    old.stock(stock); old.imf(imf); pending.resolve({}); await drain();
    assert.equal(oldWrites, 0); fixtureState.check(75); oldPage.hide();
  });
});
for (const action of ['close', 'destroy']) {
  test(`R13: real ${action} invalidates pending refresh and hydration`, async () => {
    await fixture(async fixtureState => {
      await fixtureState.open(); const page = fixtureState.ctx.countryBriefPage, old = fixtureState.hydrations[0], pending = deferred();
      fixtureState.signalQueue.push(pending); fixtureState.manager.refreshOpenBrief();
      if (action === 'close') page.hide(); else fixtureState.manager.destroy();
      let writes = 0; page.updateScore = page.updateEconomicIndicators = () => writes++;
      old.stock(stock); old.imf(imf); pending.resolve({}); await drain(); assert.equal(writes, 0);
      fixtureState.ctx.countryBriefPage = null; fixtureState.scores.CN = score(75); await fixtureState.open(); fixtureState.check(75);
    });
  });
}
test('R14: olderRefresh pending same-country opening preserves current callbacks until the new presentation commits', async () => {
  await fixture(async fixtureState => {
    await fixtureState.open(); const old = fixtureState.hydrations[0], pending = deferred(); fixtureState.signalQueue.push(pending);
    const opening = fixtureState.startOpen(); await drain();
    old.stock(stock); fixtureState.check(68); assert.ok(fixtureState.rows().some(indicator => indicator.label === 'Stock Index'));
    fixtureState.scores.CN = score(75); pending.resolve({}); await opening; fixtureState.check(75);
    old.imf(imf); fixtureState.check(75); assert.ok(!fixtureState.rows().some(indicator => indicator.label === 'Real GDP Growth'));
  });
});
test('R15: failed latest refresh retains applied pair and cannot revive an older completion', async () => {
  await fixture(async fixtureState => {
    await fixtureState.open(); fixtureState.scores.CN = score(69); const olderRefresh = deferred(), newerRefresh = deferred(); fixtureState.signalQueue.push(olderRefresh, newerRefresh);
    fixtureState.manager.refreshOpenBrief(); fixtureState.manager.refreshOpenBrief(); newerRefresh.reject(Error('controlled signal failure')); await drain();
    fixtureState.scores.CN = score(71); olderRefresh.resolve({}); await drain(); fixtureState.check(68); assert.equal(fixtureState.warnings.length, 1);
    fixtureState.hydrations[0].stock({ ...stock, available: false }); fixtureState.check(68); assert.ok(!fixtureState.rows().some(indicator => indicator.label === 'Stock Index'));
  });
});
for (const value of [71, null]) for (const order of ['stock-first', 'imf-first']) {
  test(`R4-R5: actual controller preserves ${value} CII (${order})`, async () => {
    await fixture(async fixtureState => {
      const opening = fixtureState.startOpen(); await drain(); const reads = fixtureState.controllerReads[0];
      await fixtureState.refresh(value == null ? null : score(value));
      for (const name of order === 'stock-first' ? ['stock', 'imf'] : ['imf', 'stock']) {
        reads[name].resolve(name === 'stock' ? stock : { data: { imfGrowth: { countries: { CN: imf.growth } } } });
        await drain(); fixtureState.check(value);
      }
      await opening; fixtureState.check(value);
      assert.ok(fixtureState.rows().some(indicator => indicator.label === 'Stock Index'));
      assert.ok(fixtureState.rows().some(indicator => indicator.label === 'Real GDP Growth'));
    }, { realController: true });
  });
}
test('R10-R11: actual controller discards old transport completions after rehydration', async () => {
  await fixture(async fixtureState => {
    const firstOpening = fixtureState.startOpen(); await drain(); const first = fixtureState.controllerReads[0];
    const secondOpening = fixtureState.startOpen('US'); await drain(); const second = fixtureState.controllerReads[1];
    second.stock.resolve({ ...stock, code: 'US', indexName: 'US index' });
    second.imf.resolve({ data: {} }); await secondOpening; await drain(); fixtureState.check(75);
    first.stock.resolve(stock); first.imf.resolve({ data: { imfGrowth: { countries: { CN: imf.growth } } } });
    await firstOpening; await drain(); fixtureState.check(75);
    assert.ok(fixtureState.rows().some(indicator => indicator.value === 'US index: 100.25 CNY'));
    assert.ok(!fixtureState.rows().some(indicator => indicator.label === 'Real GDP Growth'));
  }, { realController: true });
});
