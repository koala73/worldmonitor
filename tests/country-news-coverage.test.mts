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
  it('retains session choices through tier and cloud reloads until preferences can be saved', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf('  private reconcileSourceLimitForTier(');
    const end = app.indexOf('  /**\n   * Enforce free-tier panel', start);
    const cloudStart = app.indexOf('    if (\n      keySet.has(STORAGE_KEYS.disabledFeeds)');
    const cloudEnd = app.indexOf('    if (keySet.has(STORAGE_KEYS.monitors))', cloudStart);
    const code = transpileModule(`class Harness { ${app.slice(start, end)}
      cloud() { const keySet = new Set(['disabled']); const tierReconciliationDeferred = true;
        const freeTierLimitsInvoked = false; ${app.slice(cloudStart, cloudEnd)} }
    }; Harness;`, {}).outputText;
    for (const [pro, sidecar] of [[true, true], [false, true], [true, false], [false, false]]) {
      const stored = new Map<string, string[]>([['disabled', ['existing', 'gate-owned']], ['owned', ['gate-owned']]]);
      if (!sidecar) stored.delete('owned');
      const markers = new Map<string, string>();
      let markerWritable = false;
      const Harness = runInNewContext(code, {
        safeStorageSetChecked: (name: string, value: string) => { if (!markerWritable) return false; markers.set(name, value); return true; },
        STORAGE_KEYS: { disabledFeeds: 'disabled', sourceGateOwnership: 'owned' },
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
      instance.state.pendingSourcePreferences = { gateOwned: null, migrationMarkers: ['worldmonitor-country-coverage-optin-v1'] };
      instance.currentSourceCapLanguage = () => 'en';
      instance.sourceCapProtectedNames = () => new Set();
      instance.persistJsonStorageValue = () => false;
      if (!sidecar) {
        instance.reconcileSourceLimitForTier(true);
        assert.ok(!instance.state.disabledSources.has('cap-fixture'), 'missing sidecar infers legacy cap ownership');
      }
      instance.reconcileSourceLimitForTier(false);
      instance.reconcileSourceLimitForTier(true);
      assert.ok(!instance.state.disabledSources.has('cap-fixture'), 'Pro restores the session cap after a failed ownership write');
      instance.reconcileSourceLimitForTier(pro);
      assert.ok(instance.state.disabledSources.has('country-opt-in'), `${pro}: tier reconciliation`);
      instance.cloud();
      assert.ok(instance.state.disabledSources.has('country-opt-in'), `${pro}: cloud reload`);
      instance.state.disabledSources.delete('country-opt-in');
      instance.reconcileSourceLimitForTier(pro);
      assert.ok(!instance.state.disabledSources.has('country-opt-in'), 'later explicit choice remains authoritative');
      instance.persistJsonStorageValue = (name: string, value: string[]) => { stored.set(name, value); return true; };
      instance.reconcileSourceLimitForTier(pro);
      assert.deepEqual([...instance.state.pendingSourcePreferences?.migrationMarkers ?? []], ['worldmonitor-country-coverage-optin-v1'], 'failed marker remains retryable');
      markerWritable = true;
      instance.reconcileSourceLimitForTier(pro);
      assert.equal(instance.state.pendingSourcePreferences, undefined);
      assert.equal(markers.get('worldmonitor-country-coverage-optin-v1'), 'done', 'recovery acknowledges the migration before later choices');
      stored.set('disabled', ['cloud-choice']);
      instance.cloud();
      assert.deepEqual([...instance.state.disabledSources], ['cloud-choice'], 'cloud changes resume after durable save');
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
      pendingSourcePreferences: {
        gateOwned: new Set(['new-cap']),
        migrationMarkers: ['worldmonitor-country-coverage-optin-v1', 'worldmonitor-publisher-direct-optin-v1'],
      },
    };
    instance.persistSourcePreferences(['new-cap']);
    assert.equal(instance.ctx.pendingSourcePreferences.gateOwned.size, 0, 'explicit opt-out transfers the session ownership even when storage fails');
    assert.equal(stored.get('worldmonitor-country-coverage-optin-v1'), undefined);
    writable = true;
    instance.persistSourcePreferences([]);
    assert.equal(instance.ctx.pendingSourcePreferences, undefined);
    assert.deepEqual([...stored.get('disabled') as string[]], ['existing', 'new-cap']);
    assert.equal(stored.get('worldmonitor-country-coverage-optin-v1'), 'done');
    assert.equal(stored.get('worldmonitor-publisher-direct-optin-v1'), 'done', 'every deferred migration is acknowledged');
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
    const code = transpileModule(`let sessionDisabledSources;\nconst pendingMigrationMarkers = [];\n${app.slice(start, end)}\n${initialization[0]}\n[...disabledSources];`, {}).outputText;
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
    const startup = transpileModule(`let sessionDisabledSources;\n${app.slice(start, end)}`, {}).outputText;
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
