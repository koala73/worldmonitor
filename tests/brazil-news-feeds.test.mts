import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { isFeedInLanguage } from '../src/services/feed-language';
import { digestCarriesFeed } from '../shared/news-catalog-browser';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { publisherFamilyFor, publisherFamilyForDomain } from '../shared/publisher-families.js';
import { assessCorroboration, evidenceFromCluster } from '../server/_shared/corroboration';
import { SOURCE_PROPAGANDA_RISK } from '../shared/source-provenance';
import { SOURCE_TIERS } from '../server/_shared/source-tiers';
import { applyMigrationChain, buildMigrations, migrateBrazilOptInsV11 } from '../src/utils/cloud-prefs-migrations';
import type { Feed } from '../src/types';

const countryAdditions = new Set<string>(JSON.parse(readFileSync('shared/country-news-opt-ins.json', 'utf8')));
const SOURCES = [
  { name: 'Guardian Brazil', url: 'https://www.theguardian.com/world/brazil/rss', lang: undefined },
  { name: 'Brazil Reports', url: 'https://brazilreports.com/feed/', lang: undefined },
  { name: 'G1 Política', url: 'https://g1.globo.com/rss/g1/politica/', lang: 'pt' },
  { name: 'Agência Brasil', url: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml', lang: 'pt' },
] as const;
const names = SOURCES.map(source => source.name);
type Client = {
  FULL_FEEDS: Record<string, Feed[]>;
  computeDefaultDisabledSources: (locale?: string) => string[];
  getLocaleBoostedSources: (locale: string) => Set<string>;
};
const tempDir = mkdtempSync(join(tmpdir(), 'brazil-news-'));
let client: Client;
before(async () => { client = await bundleFeedsModule<Client>({ repoRoot: process.cwd(), tempDir }); });
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('opt-in Brazil news coverage', () => {
  it('rolls back startup preferences when the completion marker cannot be saved', () => {
    const app = readFileSync('src/App.ts', 'utf8');
    const start = app.indexOf("      const brazilOptInKey =");
    const end = app.indexOf('      // Locale boost:', start);
    assert.ok(start >= 0 && end > start);
    const startup = transpileModule(`let sessionDisabledSources; const pendingSourceMigrationMarkers = [];\n${app.slice(start, end)}`, {}).outputText;
    const key = 'worldmonitor-disabled-feeds';
    const marker = 'worldmonitor-brazil-optin-v1';
    for (const previous of [undefined, '["existing-choice"]']) {
      const store = new Map<string, string>();
      if (previous !== undefined) store.set(key, previous);
      let rejectMarker = true;
      let rejectPreferences = false;
      const boot = () => runInNewContext(startup, {
        STORAGE_KEYS: { disabledFeeds: key }, BRAZIL_OPT_IN_SOURCES: names, userLang: 'pt',
        computeDefaultDisabledSources: client.computeDefaultDisabledSources,
        migrateBrazilOptInsV11,
        safeStorageGet: (name: string) => store.get(name) ?? null,
        loadFromStorage: (name: string, fallback: unknown) => store.has(name) ? JSON.parse(store.get(name)!) : fallback,
        saveToStorage: (name: string, value: unknown) => {
          if (rejectPreferences) return false;
          store.set(name, JSON.stringify(value));
          return true;
        },
        safeStorageSetChecked: (name: string, value: string) => {
          if (rejectMarker) return false;
          store.set(name, value);
          return true;
        },
        safeStorageRemoveChecked: (name: string) => { store.delete(name); return true; },
      });
      boot();
      assert.equal(store.get(key), previous, 'marker failure preserves the prior preferences');
      assert.equal(store.get(marker), undefined);
      rejectMarker = false;
      rejectPreferences = true;
      boot();
      assert.equal(store.get(marker), undefined, 'failed preferences stay retryable');
      rejectPreferences = false;
      boot();
      assert.equal(store.get(marker), 'done');
      for (const name of names) assert.ok(JSON.parse(store.get(key)!).includes(name));
      store.set(key, '["existing-choice"]');
      boot();
      assert.equal(store.get(key), '["existing-choice"]', 'later explicit selections survive startup');
    }
  });

  it('does not count Grupo Globo desks as independent corroboration', () => {
    const family = publisherFamilyFor('O Globo');
    assert.equal(publisherFamilyFor('G1 Política'), family);
    for (const host of ['g1.globo.com', 'oglobo.globo.com']) {
      assert.equal(publisherFamilyForDomain(host), family);
    }
    assert.deepEqual(assessCorroboration(evidenceFromCluster({
      allItems: [{ source: 'G1 Política' }, { source: 'O Globo' }],
    })), { state: 'single-publisher', publishers: 1 });
  });

  it('starts disabled in English and Portuguese while remaining selectable in every language', () => {
    for (const language of ['en', 'pt', 'pt-BR', 'fr', 'ar']) {
      const disabled = new Set(client.computeDefaultDisabledSources(language));
      const boosted = client.getLocaleBoostedSources(language);
      for (const source of SOURCES) {
        assert.ok(disabled.has(source.name), `${source.name} disabled in ${language}`);
        assert.ok(!boosted.has(source.name), `${source.name} cannot be locale-boosted`);
        const feed = client.FULL_FEEDS.latam!.find(feed => feed.name === source.name)!;
        assert.ok(isFeedInLanguage(feed, language));
        assert.ok(digestCarriesFeed(feed, language));
      }
    }
    assert.ok(client.getLocaleBoostedSources('pt').has('Folha de S.Paulo'), 'existing Portuguese defaults stay intact');
  });

  it('migrates local and cloud preferences once without overwriting subsequent choices', () => {
    const key = 'worldmonitor-disabled-feeds';
    const before = { [key]: '["existing-choice"]', unrelated: 'keep' };
    const result = migrateBrazilOptInsV11(before, names);
    assert.deepEqual(JSON.parse(result[key] as string), ['existing-choice', ...names]);
    assert.equal(result.unrelated, 'keep');
    assert.equal(migrateBrazilOptInsV11(result, names), result);
    const migrations = buildMigrations({}, { brazil: { optInSources: names } });
    assert.deepEqual(applyMigrationChain(before, 10, 11, migrations), result);
    assert.equal(applyMigrationChain(before, 11, 11, migrations), before, 'later explicit opt-ins survive sync');
    for (const raw of ['[]', 'bad-json', '[42]', '{}']) {
      const blob = { [key]: raw };
      assert.equal(migrateBrazilOptInsV11(blob, names), blob, 'preserve enable-all and invalid preferences');
    }
    const missing = {};
    assert.equal(migrateBrazilOptInsV11(missing, names), missing);
  });

  it('preserves the Brazil block before later Full Latin America additions and schedules their selected content', () => {
    for (const view of [client.FULL_FEEDS, VARIANT_FEEDS.full]) {
      assert.deepEqual(view.latam!.filter(feed => !countryAdditions.has(feed.name)).slice(-4).map(feed => feed.name), names);
      for (const source of SOURCES) {
        const feed = view.latam!.find(feed => feed.name === source.name)!;
        assert.equal(feed.url, source.url);
        assert.equal(feed.lang, source.lang);
        assert.ok(!feed.strategicDefault);
      }
    }
    for (const language of ['en', 'pt', 'fr']) {
      const scheduled = __testing__.buildDigestFeedBatches('full', language).batches.flat();
      for (const name of names) assert.ok(scheduled.some(entry => entry.feed.name === name));
    }
  });

  it('keeps publisher links, rejects unrelated hosts, and declares source provenance', () => {
    for (const source of SOURCES) {
      const feed = VARIANT_FEEDS.full!.latam!.find(feed => feed.name === source.name)!;
      const host = new URL(source.url).hostname;
      assert.ok(isAllowedDomain(host));
      assert.ok(!isAllowedDomain(`${host}.evil.example`));
      assert.equal(SOURCE_TIERS[source.name], source.name === 'Brazil Reports' ? 3 : 2);
      const link = `https://${host}/politica/test-story`;
      const xml = (url: string) => `<rss><channel><item><title>Brasil anuncia medidas econômicas</title><link>${url}</link><pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate></item></channel></rss>`;
      assert.equal(__testing__.parseRssXml(xml(link), feed, 'full')?.items[0]?.link, link);
      assert.equal(__testing__.parseRssXml(xml('https://evil.example/story'), feed, 'full')?.items[0]?.link, '');
    }
    assert.equal(publisherFamilyFor('Guardian Brazil'), publisherFamilyFor('Guardian World'));
    assert.equal(SOURCE_PROPAGANDA_RISK['Agência Brasil'].stateAffiliated, 'Brazil');
  });
});
