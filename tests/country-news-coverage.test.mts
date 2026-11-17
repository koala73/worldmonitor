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
import { migrateCountryCoverageOptInsV12, migrateBrazilOptInsV11, buildMigrations, applyMigrationChain } from '../src/utils/cloud-prefs-migrations';
import { SOURCE_PROPAGANDA_RISK } from '../shared/source-provenance';
import { resolveHostOrigin } from '../scripts/source-origin.mjs';
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
    const code = transpileModule(`let sessionDisabledSources;\n${app.slice(start, end)}\n${initialization[0]}\n[...disabledSources];`, {}).outputText;
    for (const failedWrite of ['preferences', 'marker']) {
      const store = new Map([[key, '["existing-choice"]']]);
      const disabled = runInNewContext(code, {
        STORAGE_KEYS: { disabledFeeds: key }, COUNTRY_COVERAGE_OPT_IN_SOURCES: optIns,
        BRAZIL_OPT_IN_SOURCES: ['Brazil fixture'], userLang: 'en',
        computeDefaultDisabledSources: client.computeDefaultDisabledSources,
        migrateCountryCoverageOptInsV12, migrateBrazilOptInsV11,
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
      for (const name of [...optIns, 'existing-choice', 'Brazil fixture']) assert.ok(disabled.includes(name), `${failedWrite}: ${name}`);
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
