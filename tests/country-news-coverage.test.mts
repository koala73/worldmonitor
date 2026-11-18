import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { NEWS_CATALOG, buildDigestWarmCells } from '../shared/news-catalog';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache';
import { migrateCountryCoverageOptInsV12, migrateBrazilOptInsV11, migratePublisherDirectOptInsV13, buildMigrations, applyMigrationChain } from '../src/utils/cloud-prefs-migrations';
import { SOURCE_PROPAGANDA_RISK } from '../shared/source-provenance';
import { resolveHostOrigin } from '../scripts/source-origin.mjs';
import { restoreGateOwnedSources, reconcileSourceGateOwnership, stringSetsEqual, inferExactSourceGateOwnership, transferSourceGateOwnershipToUser } from '../src/services/source-cap';
import { persistGateOwnershipTransition } from '../src/services/variant-panel-ownership';
import type { Feed } from '../src/types';

const audit = JSON.parse(readFileSync('shared/country-news-coverage.json', 'utf8')) as {
  countries: Record<string, { sources: string[] }>;
  additions: Record<string, { kind: string; url: string; language: string; items: number; newest: string | null; verificationStatus: string }>;
};
const optIns: string[] = JSON.parse(readFileSync('shared/country-news-opt-ins.json', 'utf8'));
type Client = { FULL_FEEDS: Record<string, Feed[]>; computeDefaultDisabledSources(locale: string): string[] };
const tempDir = mkdtempSync(join(tmpdir(), 'country-news-'));
let client: Client;
before(async () => { client = await bundleFeedsModule<Client>({ repoRoot: process.cwd(), tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

const key = 'worldmonitor-disabled-feeds';
describe('optional country news coverage', () => {
  it('applies cloud choices while replaying unsaved session edits through tier changes', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf('  private reconcileSourceLimitForTier(');
    const end = app.indexOf('  /**\n   * Enforce free-tier panel', start);
    const cloudStart = app.indexOf('  private applyCloudSyncedPrefsToRuntime(');
    const cloudEnd = app.indexOf('  private isPanelNearViewport(', cloudStart);
    const handlers = readFileSync('src/app/event-handlers.ts', 'utf8');
    const saveStart = handlers.indexOf('  private persistSourcePreferences(');
    const saveEnd = handlers.indexOf('  getAllSourceNames()', saveStart);
    const code = transpileModule(`class Harness { ${app.slice(start, end)}
      ${app.slice(cloudStart, cloudEnd)}
      ${handlers.slice(saveStart, saveEnd)}
      cloud() { this.applyCloudSyncedPrefsToRuntime(['disabled']); }
    }; Harness;`, {}).outputText;
    for (const [pro, sidecar, failedWrite] of [true, false].flatMap(pro =>
      [true, false].flatMap(sidecar => ['both', 'disabled', 'owned'].map(failedWrite =>
        [pro, sidecar, failedWrite] as const)))) {
      const stored = new Map<string, string[]>([['disabled', ['existing', 'gate-owned']], ['owned', ['gate-owned']]]);
      if (!sidecar) {
        stored.delete('owned');
        stored.set('disabled', ['existing', 'cap-fixture']);
      }
      const markers = new Map<string, string>();
      let markerWritable = false;
      const Harness = runInNewContext(code, {
        safeStorageSetChecked: (name: string, value: string) => { if (!markerWritable) return false; markers.set(name, value); return true; },
        STORAGE_KEYS: { disabledFeeds: 'disabled', sourceGateOwnership: 'owned' },
        FONT_SCALE_STORAGE_KEY: 'font', invalidatePanelStorageCacheForKeys() {},
        releaseSourceGateOwnership: transferSourceGateOwnershipToUser,
        writeStorageValue: () => false, saveToStorage: () => false,
        localStorage: { getItem: () => sidecar ? 'present' : null },
        computeDefaultDisabledSources: () => ['existing', 'country-opt-in'],
        inferExactSourceGateOwnership,
        loadFromStorage: (name: string, fallback: unknown) => stored.get(name) ?? fallback,
        restoreGateOwnedSources, reconcileSourceGateOwnership, stringSetsEqual, persistGateOwnershipTransition,
        selectSourcesUnderCap: () => ({ autoDisabled: new Set(['cap-fixture']) }),
        FEEDS: {}, INTEL_SOURCES: [], FREE_MAX_SOURCES: 1, console: { log() {} },
      });
      const instance = new Harness();
      instance.state = { disabledSources: new Set(['existing', 'country-opt-in', sidecar ? 'gate-owned' : 'cap-fixture']) };
      instance.state.pendingSourcePreferences = { gateOwned: null, migrationMarkers: ['worldmonitor-country-coverage-optin-v1', 'worldmonitor-brazil-optin-v1'], edits: new Map([['country-opt-in', true]]) };
      instance.ctx = instance.state;
      instance.shouldDeferTierPreferenceReconciliation = () => false;
      instance.enforceFreeTierLimits = () => instance.reconcileSourceLimitForTier(pro);
      instance.currentSourceCapLanguage = () => 'en';
      instance.sourceCapProtectedNames = () => new Set();
      instance.persistJsonStorageValue = (name: string, value: string[]) => {
        if (failedWrite === 'both' || name === failedWrite) return false;
        stored.set(name, value);
        return true;
      };
      if (!sidecar) {
        instance.reconcileSourceLimitForTier(true);
        assert.ok(!instance.state.disabledSources.has('cap-fixture'), 'missing sidecar infers legacy cap ownership');
      }
      instance.reconcileSourceLimitForTier(false);
      assert.ok(instance.state.pendingSourcePreferences.gateOwned.has('cap-fixture'), 'pending live ownership tracks the active cap');
      instance.persistSourcePreferences([]);
      assert.ok(instance.state.pendingSourcePreferences.gateOwned.has('cap-fixture'), 'settings save retains live cap ownership when writes fail');
      instance.reconcileSourceLimitForTier(true);
      assert.ok(!instance.state.disabledSources.has('cap-fixture'), 'Pro restores the session cap after a failed ownership write');
      instance.reconcileSourceLimitForTier(pro);
      assert.ok(instance.state.disabledSources.has('country-opt-in'), `${pro}: tier reconciliation`);
      if (pro && sidecar && failedWrite === 'both') {
        assert.ok(stored.get('disabled')!.includes('gate-owned'), 'restoration is still unsaved');
        stored.set('owned', []);
        instance.applyCloudSyncedPrefsToRuntime(['owned']);
        assert.ok(!instance.state.disabledSources.has('gate-owned'), 'ownership-only cloud write must preserve pending Pro restoration');
        instance.shouldDeferTierPreferenceReconciliation = () => true;
        instance.applyCloudSyncedPrefsToRuntime(['owned']);
        assert.ok(!instance.state.disabledSources.has('gate-owned'), 'ownership-only cloud event during handoff must preserve the live selection');
        instance.shouldDeferTierPreferenceReconciliation = () => false;
      }
      stored.set('disabled', ['cloud-choice']);
      stored.set('owned', []);
      instance.cloud();
      assert.ok(instance.state.disabledSources.has('cloud-choice'), 'cloud choices apply before durable save');
      assert.ok(!instance.state.disabledSources.has('existing'), 'cloud can enable an untouched source');
      instance.shouldDeferTierPreferenceReconciliation = () => true;
      stored.set('disabled', ['deferred-cloud-choice']);
      instance.cloud();
      assert.ok(instance.state.disabledSources.has('deferred-cloud-choice'), 'cloud choices apply during tier handoff');
      assert.ok(instance.state.disabledSources.has('country-opt-in'), `${pro}: cloud reload`);
      instance.shouldDeferTierPreferenceReconciliation = () => false;
      instance.enforceFreeTierLimits = () => false;
      stored.set('disabled', ['unresolved-tier-cloud-choice']);
      instance.cloud();
      assert.ok(instance.state.disabledSources.has('unresolved-tier-cloud-choice'), 'cloud choices apply after handoff while entitlement remains unresolved');
      assert.ok(instance.state.disabledSources.has('country-opt-in'), 'pending migration survives unresolved entitlement');
      instance.enforceFreeTierLimits = () => instance.reconcileSourceLimitForTier(pro);
      instance.state.disabledSources.delete('country-opt-in');
      instance.persistSourcePreferences(['country-opt-in']);
      instance.state.disabledSources.add('session-opt-out');
      instance.persistSourcePreferences(['session-opt-out']);
      stored.set('disabled', ['country-opt-in', 'second-cloud-choice']);
      instance.cloud();
      assert.ok(instance.state.disabledSources.has('session-opt-out'), 'local opt-out overrides cloud');
      assert.ok(instance.state.disabledSources.has('second-cloud-choice'), 'later cloud snapshot replaces untouched choices');
      assert.ok(!instance.state.disabledSources.has('cloud-choice'), 'old cloud choice is not a session edit');
      instance.reconcileSourceLimitForTier(pro);
      assert.ok(!instance.state.disabledSources.has('country-opt-in'), 'later explicit choice remains authoritative');
      instance.persistJsonStorageValue = (name: string, value: string[]) => { stored.set(name, value); return true; };
      instance.reconcileSourceLimitForTier(pro);
      assert.equal(instance.state.pendingSourcePreferences?.migrationMarkers.length, 2, 'failed marker remains retryable');
      markerWritable = true;
      instance.reconcileSourceLimitForTier(pro);
      assert.equal(instance.state.pendingSourcePreferences, undefined);
      assert.equal(markers.get('worldmonitor-brazil-optin-v1'), 'done');
      assert.equal(markers.get('worldmonitor-country-coverage-optin-v1'), 'done', 'recovery acknowledges the migration before later choices');
      stored.set('disabled', ['cloud-choice']);
      instance.shouldDeferTierPreferenceReconciliation = () => true;
      instance.cloud();
      assert.deepEqual([...instance.state.disabledSources], ['cloud-choice'], 'cloud changes resume after durable save');
      if (pro && sidecar && failedWrite === 'both') {
        const initStart = app.indexOf('    let sessionDisabledSources:');
        const initEnd = app.indexOf('    // One-time migration: reduce default-enabled sources', initStart);
        const defaults = runInNewContext(transpileModule(`
          function initialize() { ${app.slice(initStart, initEnd)}
            return { sessionDisabledSources, sessionSourceEdits }; }
          initialize.call({ currentSourceCapLanguage: () => 'en' });
        `, {}).outputText, {
          currentVariant: 'full', storageAvailable: false,
          computeDefaultDisabledSources: () => ['fallback-default'],
        });
        assert.equal(defaults.sessionSourceEdits.size, 0, 'fallback defaults are a base, not session edits');
        stored.set('disabled', ['old-local-choice']);
        stored.set('owned', []);
        instance.state.pendingSourcePreferences = {
          gateOwned: null, baselineGateOwned: null, migrationMarkers: [],
          edits: defaults.sessionSourceEdits,
          fallbackDisabledSources: new Set(defaults.sessionDisabledSources),
        };
        instance.persistJsonStorageValue = () => false;
        instance.shouldDeferTierPreferenceReconciliation = () => false;
        instance.reconcileSourceLimitForTier(true);
        assert.ok(instance.state.disabledSources.has('fallback-default'), 'defaults survive without a cloud snapshot');
        instance.state.disabledSources.add('session-choice');
        instance.persistSourcePreferences(['session-choice']);
        stored.set('disabled', ['cloud-choice']);
        instance.cloud();
        assert.ok(!instance.state.disabledSources.has('fallback-default'), 'cloud replaces fallback defaults');
        assert.ok(instance.state.disabledSources.has('session-choice'), 'explicit edits survive fallback replacement');
      }
    }
  });
  it('preserves explicit ownership transfers and acknowledges migration on a recovered settings save', () => {
    const source = readFileSync('src/app/event-handlers.ts', 'utf8');
    const start = source.indexOf('  private persistSourcePreferences(');
    const end = source.indexOf('  getAllSourceNames()', start);
    const code = transpileModule(`class Harness { ${source.slice(start, end)} }; Harness;`, {}).outputText;
    const stored = new Map<string, unknown>([['owned', ['old-cap']], ['disabled', ['existing']]]);
    let writable = false;
    const Harness = runInNewContext(code, {
      STORAGE_KEYS: { disabledFeeds: 'disabled', sourceGateOwnership: 'owned' },
      loadFromStorage: (name: string, fallback: unknown) => stored.get(name) ?? fallback,
      releaseSourceGateOwnership: transferSourceGateOwnershipToUser, stringSetsEqual,
      writeStorageValue: (name: string, value: string) => {
        if (!writable) return false;
        stored.set(name, name === 'owned' ? JSON.parse(value) : value);
        return true;
      },
      saveToStorage: (name: string, value: unknown) => {
        if (!writable) return false;
        stored.set(name, value);
        return true;
      },
    });
    const instance = new Harness();
    instance.ctx = {
      disabledSources: new Set(['existing', 'new-cap']),
      pendingSourcePreferences: { gateOwned: new Set(['new-cap']), edits: new Map(), migrationMarkers: ['worldmonitor-country-coverage-optin-v1', 'worldmonitor-publisher-direct-optin-v1'] },
    };
    instance.persistSourcePreferences(['new-cap']);
    assert.equal(instance.ctx.pendingSourcePreferences.edits.get('new-cap'), true, 'explicit opt-out stays pending when storage fails');
    assert.equal(stored.get('worldmonitor-country-coverage-optin-v1'), undefined);
    writable = true;
    instance.persistSourcePreferences([]);
    assert.equal(instance.ctx.pendingSourcePreferences, undefined);
    assert.deepEqual([...stored.get('disabled') as string[]], ['existing', 'new-cap']);
    assert.equal(stored.get('worldmonitor-country-coverage-optin-v1'), 'done');
    assert.equal(stored.get('worldmonitor-publisher-direct-optin-v1'), 'done', 'every deferred migration is acknowledged');
    instance.ctx.disabledSources = new Set(['new-cap', 'other-toggle']);
    instance.ctx.pendingSourcePreferences = {
      gateOwned: new Set(['new-cap']), baselineGateOwned: new Set(),
      edits: new Map([['new-cap', false]]), migrationMarkers: [],
    };
    instance.persistSourcePreferences(['other-toggle'][Symbol.iterator]());
    const restored = restoreGateOwnedSources(new Set(stored.get('disabled') as string[]), new Set(stored.get('owned') as string[]));
    assert.ok(!restored.has('new-cap'), 'Pro restores an earlier enabled source that was subsequently auto-capped');
    assert.ok(restored.has('other-toggle'), 'the current explicit disable remains');
  });
  it('keeps default seeding separate from failed migration edits with missing preferences', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf('      const sourceMigrationBaseline');
    const end = app.indexOf('    const disabledSources =', start);
    const code = transpileModule(`let sessionDisabledSources; let sourcePreferencesMissing = false;
      const sessionSourceEdits = new Map(); const pendingSourceMigrationMarkers = [];
      { ${app.slice(start, end)}
      ({ sessionDisabledSources, sessionSourceEdits });`, {}).outputText;
    const defaults = ['ordinary-default', 'country-opt-in', 'brazil-opt-in', 'publisher-opt-in'];
    const result = runInNewContext(code, {
      STORAGE_KEYS: { disabledFeeds: 'disabled' }, userLang: 'en',
      COUNTRY_COVERAGE_OPT_IN_SOURCES: ['country-opt-in'],
      BRAZIL_OPT_IN_SOURCES: ['brazil-opt-in'], PUBLISHER_DIRECT_OPT_IN_SOURCES: ['publisher-opt-in'],
      migrateCountryCoverageOptInsV12, migrateBrazilOptInsV11, migratePublisherDirectOptInsV13,
      computeDefaultDisabledSources: () => defaults,
      loadFromStorage: (_name: string, fallback: unknown) => fallback,
      safeStorageGet: () => null, saveToStorage: () => false,
      safeStorageSetChecked: () => false,
    });
    assert.ok(result.sessionDisabledSources.includes('ordinary-default'), 'defaults still apply before cloud arrives');
    assert.equal(result.sessionSourceEdits.has('ordinary-default'), false, 'default seeding must not override a cloud enable');
    for (const name of defaults.slice(1)) assert.equal(result.sessionSourceEdits.get(name), true, `${name} migration stays pending`);
  });

  it('offers four distinct feeds for all 197 reviewed countries', () => {
    assert.equal(Object.keys(audit.countries).length, 197);
    const available = new Set(Object.values(client.FULL_FEEDS).flat().map(feed => feed.name));
    for (const [country, row] of Object.entries(audit.countries)) {
      assert.ok(row.sources.length >= 4, country);
      const urls = row.sources.map(name => NEWS_CATALOG.feeds.find(feed => feed.name === name)?.url);
      assert.equal(new Set(urls).size, row.sources.length, `${country}: duplicate feed`);
      for (const source of row.sources) assert.ok(available.has(source), `${country}: ${source} selectable`);
    }
  });

  it('keeps every addition off in every supported content language', () => {
    assert.deepEqual([...optIns].sort(), Object.keys(audit.additions).sort());
    for (const lang of new Set(['en', 'pt-BR', ...Object.values(audit.additions).map(source => source.language)])) {
      const disabled = new Set(client.computeDefaultDisabledSources(lang));
      for (const name of optIns) assert.ok(disabled.has(name), `${lang}: ${name} must be opt-in`);
    }
  });

  it('uses the language of the verified content, including feeds with incorrect publisher language tags', () => {
    const profiles = JSON.parse(readFileSync('shared/outlet-profile.json', 'utf8'));
    const languages = {
      Franceinfo: 'fr', 'Le Soir': 'fr', Sme: 'sk', TA3: 'sk',
      'Al Mada Newspaper': 'ar', 'Bahrain Mirror': 'ar', 'Carta de Moçambique': 'pt',
      'De West': 'nl', Dhauru: 'dv', IciLome: 'fr', Kallxo: 'sq', Nawaat: 'ar',
      'Online Khabar': 'ne', 'Página/12': 'es', 'RTV Slovenija': 'sl',
      'RTVE Noticias': 'es', 'The Cambodia Daily': 'km', 'Sudan War Monitor': 'ar',
      'Le Nouvelliste': 'en', 'Palestine News Network': 'en', Tatoli: 'tet',
      'Habari Za Comores': 'fr', 'Seychelles Broadcasting Corporation': 'crs',
    };
    for (const [name, lang] of Object.entries(languages)) {
      assert.equal(NEWS_CATALOG.feeds.find(feed => feed.name === name)?.lang, lang, name);
      assert.equal(profiles[name].language, lang, name);
      assert.equal(audit.additions[name].language, lang, name);
      assert.ok(NEWS_LANGUAGES.has(lang), lang);
    }
  });

  it('excludes rejected content and uses article endpoints rather than RSS error or index entries', () => {
    for (const name of ['Business Bhutan', 'Fraternité', 'Le Républicain', 'Telefuturo']) {
      assert.ok(!NEWS_CATALOG.feeds.some(feed => feed.name === name), name);
      assert.ok(!optIns.includes(name), name);
    }
    assert.equal(audit.additions['RÚV (Ríkisútvarpið)'].url, 'https://www.ruv.is/rss/frettir');
    assert.equal(audit.additions['Al-Sumaria'].url, 'https://www.alsumaria.tv/Rss/iraq-latest-news/ar');
  });

  it('records publisher countries and government ownership separately from coverage', () => {
    const profiles = JSON.parse(readFileSync('shared/outlet-profile.json', 'utf8'));
    assert.equal(resolveHostOrigin('www.larepublica.co'), 'CO');
    assert.equal(profiles['La República Colombia'].country, 'CO');
    assert.equal(resolveHostOrigin('n1info.hr'), profiles['N1 Croatia'].country);
    for (const [name, country] of [['Ahram Online', 'Egypt'], ['Bernama', 'Malaysia']]) {
      assert.equal(SOURCE_PROPAGANDA_RISK[name].stateAffiliated, country);
      assert.equal(profiles[name].ownershipClass, 'state');
    }
  });

  it('keeps new sources disabled for the session when preference or marker writes fail', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf('      const countryCoverageOptInKey =');
    const end = app.indexOf('      // Locale boost:', start);
    const initialization = app.match(/    const disabledSources = new Set\([^\n]+/)!;
    const code = transpileModule(`let sessionDisabledSources; const pendingSourceMigrationMarkers = [];\n${app.slice(start, end)}\n${initialization[0]}\n[...disabledSources];`, {}).outputText;
    for (const failedWrite of ['preferences', 'marker']) {
      const store = new Map([[key, '["existing-choice"]']]);
      const disabled = runInNewContext(code, {
        STORAGE_KEYS: { disabledFeeds: key }, COUNTRY_COVERAGE_OPT_IN_SOURCES: optIns,
        BRAZIL_OPT_IN_SOURCES: ['Brazil fixture'], PUBLISHER_DIRECT_OPT_IN_SOURCES: ['Publisher fixture'], userLang: 'en',
        computeDefaultDisabledSources: client.computeDefaultDisabledSources,
        migrateCountryCoverageOptInsV12, migrateBrazilOptInsV11, migratePublisherDirectOptInsV13,
        safeStorageGet: (name: string) => store.get(name) ?? null,
        loadFromStorage: (name: string, fallback: unknown) => store.has(name) ? JSON.parse(store.get(name)!) : fallback,
        saveToStorage: (name: string, value: unknown) => {
          if (failedWrite === 'preferences') return false;
          store.set(name, JSON.stringify(value)); return true;
        },
        safeStorageSetChecked: (name: string, value: string) => {
          if (failedWrite === 'marker') return false;
          store.set(name, value); return true;
        },
        safeStorageRemoveChecked: (name: string) => store.delete(name),
      }) as string[];
      for (const name of [...optIns, 'existing-choice', 'Brazil fixture', 'Publisher fixture']) assert.ok(disabled.includes(name), `${failedWrite}: ${name}`);
      assert.ok(!store.has('worldmonitor-country-coverage-optin-v1'));
    }
  });

  it('registers verified feeds for ingestion without adding invalid warm languages', () => {
    for (const [name, evidence] of Object.entries(audit.additions)) {
      const feed = NEWS_CATALOG.feeds.find(feed => feed.name === name);
      assert.ok(feed, name);
      assert.equal(feed.url, evidence.url, name);
      assert.ok(feed.placements.some(p => p.edition === 'full' && p.serverOrder !== undefined), name);
      assert.equal(feed.fetchInAllLanguages, true, name);
      if (evidence.verificationStatus === 'empty-window') {
        assert.equal(evidence.items, 0, name);
        assert.equal(evidence.newest, null, name);
        assert.equal(new URL(evidence.url).hostname, 'news.google.com', name);
      } else {
        assert.ok(evidence.items > 0 && evidence.newest && Number.isFinite(Date.parse(evidence.newest)), `${name}: dated RSS evidence`);
      }
      if (new URL(evidence.url).hostname === 'news.google.com') {
        assert.match(new URL(evidence.url).searchParams.get('q') ?? '', /when:(7|30)d\b/, name);
      }
      if (evidence.kind === 'international') {
        const query = new URL(evidence.url).searchParams.get('q') ?? '';
        assert.match(query, /^site:(reuters\.com|apnews\.com|bbc\.com|theguardian\.com|aljazeera\.com) /);
      }
    }
    for (const cell of buildDigestWarmCells()) assert.ok(NEWS_LANGUAGES.has(cell.lang), cell.lang);
  });

  it('migrates local and cloud selections once, preserving explicit enable-all and later choices', () => {
    const original = { [key]: '["existing-choice"]', unrelated: 'keep' };
    const migrated = migrateCountryCoverageOptInsV12(original, optIns);
    assert.deepEqual(JSON.parse(migrated[key] as string), ['existing-choice', ...optIns]);
    assert.equal(migrated.unrelated, 'keep');
    assert.equal(migrateCountryCoverageOptInsV12(migrated, optIns), migrated);
    const migrations = buildMigrations({}, { countryCoverage: { optInSources: optIns } });
    assert.deepEqual(applyMigrationChain(original, 11, 12, migrations), migrated);
    assert.equal(applyMigrationChain(original, 12, 12, migrations), original);
    for (const raw of [undefined, '[]', 'invalid', '[42]', '{}']) {
      const data = { [key]: raw };
      assert.equal(migrateCountryCoverageOptInsV12(data, optIns), data);
    }
  });

  it('retries failed startup writes without losing subsequent opt-in choices', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf('      const countryCoverageOptInKey =');
    const end = app.indexOf('      const brazilOptInKey =', start);
    assert.ok(start >= 0 && end > start);
    const startup = transpileModule(`let sessionDisabledSources; const pendingSourceMigrationMarkers = [];\n${app.slice(start, end)}`, {}).outputText;
    const marker = 'worldmonitor-country-coverage-optin-v1';
    const store = new Map<string, string>([[key, '["existing-choice"]']]);
    let failMarker = true;
    const boot = () => runInNewContext(startup, {
      STORAGE_KEYS: { disabledFeeds: key }, COUNTRY_COVERAGE_OPT_IN_SOURCES: optIns, userLang: 'en',
      computeDefaultDisabledSources: client.computeDefaultDisabledSources, migrateCountryCoverageOptInsV12,
      safeStorageGet: (name: string) => store.get(name) ?? null,
      loadFromStorage: (name: string, fallback: unknown) => store.has(name) ? JSON.parse(store.get(name)!) : fallback,
      saveToStorage: (name: string, value: unknown) => { store.set(name, JSON.stringify(value)); return true; },
      safeStorageSetChecked: (name: string, value: string) => { if (failMarker) return false; store.set(name, value); return true; },
      safeStorageRemoveChecked: (name: string) => { store.delete(name); return true; },
    });
    boot();
    assert.equal(store.get(key), '["existing-choice"]');
    assert.equal(store.has(marker), false);
    failMarker = false;
    boot();
    assert.equal(store.get(marker), 'done');
    assert.ok(JSON.parse(store.get(key)!).includes(optIns[0]));
    store.set(key, '["existing-choice"]');
    boot();
    assert.equal(store.get(key), '["existing-choice"]');
  });
});
