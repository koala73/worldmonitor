import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { Window } from 'happy-dom';

import {
  buildCorpus,
  chokepointMetaDescription,
  countryMetaDescription,
  GENERATED_DIRS,
  gitFileLastmod,
  loadCorpusData,
  SOURCE_CATALOG_LASTMOD_PATHS,
  sourcePageLastmod,
} from '../scripts/build-crawlable-corpus.mjs';
import { buildSitemapEntries } from '../scripts/build-sitemap.mjs';
import { buildSourceCatalog, sourceProviderDisplayName } from '../scripts/crawlable-sources-page.mjs';
import { resolveSourceOrigin, sourceOriginLabel } from '../scripts/source-origin.mjs';
import { rawCatalogProviderNames, rawManifestActiveEntries } from './helpers/raw-catalog-providers.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(outDir, path) {
  return readFileSync(join(outDir, path), 'utf8');
}

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

const DATASET_DESCRIPTION_MIN_LENGTH = 50;
const DATASET_DESCRIPTION_MAX_LENGTH = 5000;
const SOURCE_DOMAIN_IDS = new Set([
  'geopolitics',
  'military',
  'news',
  'finance',
  'energy',
  'infrastructure',
  'environment',
  'aviation',
  'china',
  'technology',
]);

describe('sources catalog domain assignment', () => {
  it('rejects an empty active-provider catalog', () => {
    assert.throws(() => buildSourceCatalog([]), /Source catalog cannot be empty/);
  });

  it('assigns mineral production hosts to energy instead of failing the corpus build', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'British Geological Survey World Mineral Statistics',
        host: 'ogcapi.bgs.ac.uk',
        kind: 'structured',
        references: [{ path: 'scripts/seed-mineral-production.mjs' }],
      },
      {
        provider: 'USGS ScienceBase (Mineral Commodity Summaries)',
        host: 'www.sciencebase.gov',
        kind: 'structured',
        references: [{ path: 'scripts/seed-mineral-production.mjs' }],
      },
    ]);
    assert.deepEqual(
      Object.fromEntries(catalog.map((row) => [row.provider, row.domainId])),
      {
        'British Geological Survey World Mineral Statistics': 'energy',
        'USGS ScienceBase (Mineral Commodity Summaries)': 'energy',
      },
    );
  });

  it('assigns VIA Rail Tracker (unofficial) to infrastructure instead of failing the corpus build', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'VIA Rail Tracker (unofficial)',
        host: 'tsimobile.viarail.ca',
        kind: 'structured',
        references: [{ path: 'scripts/viarail-live.mjs' }],
      },
    ]);
    assert.equal(catalog[0].domainId, 'infrastructure');
  });

  it('assigns the structured Sequoia provider to technology', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'www.sequoiacap.com',
        host: 'www.sequoiacap.com',
        kind: 'structured',
        references: [{ path: 'src/config/variants/tech.ts' }],
      },
    ]);
    assert.equal(catalog[0].domainId, 'technology');
  });

  it('assigns Toronto Transit Commission (TTC) GTFS-RT to infrastructure instead of failing the corpus build', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'Toronto Transit Commission (TTC) GTFS-RT',
        host: 'gtfsrt.ttc.ca',
        kind: 'structured',
        references: [{ path: 'scripts/seed-ttc-alerts.mjs' }],
      },
    ]);
    assert.equal(catalog[0].domainId, 'infrastructure');
  });

  it('assigns SaskAlert to environment instead of failing the corpus build', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'SaskAlert',
        host: 'emergencyalert.saskatchewan.ca',
        kind: 'structured',
        references: [{ path: 'scripts/lib/saskalert.mjs' }],
      },
    ]);
    assert.equal(catalog[0].domainId, 'environment');
  });

  it('keeps C4S CAD and TPS Open Data on distinct catalog domains', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'Toronto Police Service',
        host: 'services.arcgis.com',
        kind: 'structured',
        references: [{ path: 'scripts/lib/toronto-official-cad.mjs' }],
      },
      {
        provider: 'Toronto Police Service Open Data',
        host: 'data.tps.ca',
        kind: 'structured',
        references: [{ path: 'scripts/lib/tps-open-data.mjs' }],
      },
      {
        provider: 'Toronto Police Service Open Data',
        host: 'www.tps.ca',
        kind: 'structured',
        references: [{ path: 'scripts/lib/tps-open-data.mjs' }],
      },
    ]);
    assert.deepEqual(
      Object.fromEntries(catalog.map((row) => [row.provider, row.domainId])),
      {
        'Toronto Police Service': 'environment',
        'Toronto Police Service Open Data': 'geopolitics',
      },
    );
  });

  it('assigns Manitoba 511 to infrastructure instead of failing the corpus build', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'Manitoba 511',
        host: 'www.manitoba511.ca',
        kind: 'structured',
        references: [{ path: 'scripts/lib/provincial-511.mjs' }],
      },
    ]);
    assert.equal(catalog[0].domainId, 'infrastructure');
  });

  it('assigns the demographics providers to finance and economics', () => {
    const catalog = buildSourceCatalog([
      {
        provider: 'United Nations Population Division',
        host: 'population.un.org',
        kind: 'structured',
        references: [{ path: 'scripts/_demographics-capability-source.mjs' }],
      },
      {
        provider: 'ILOSTAT',
        host: 'sdmx.ilo.org',
        kind: 'structured',
        references: [{ path: 'scripts/_demographics-capability-source.mjs' }],
      },
    ]);

    assert.deepEqual(
      Object.fromEntries(catalog.map((row) => [row.provider, row.domainId])),
      {
        ILOSTAT: 'finance',
        'United Nations Population Division': 'finance',
      },
    );
  });

  it('still fails closed when a structured provider has no catalog domain', () => {
    assert.throws(
      () => buildSourceCatalog([{
        provider: 'Unclassified Structured Provider',
        host: 'example.invalid',
        kind: 'structured',
        references: [{ path: 'scripts/seed-example.mjs' }],
      }]),
      /Source provider needs a catalog domain: Unclassified Structured Provider/,
    );
  });
});

describe('sources catalog origin countries', () => {
  it('infers national ccTLDs and government suffixes', () => {
    assert.equal(resolveSourceOrigin({ provider: '24.hu', hosts: ['24.hu'] }), 'HU');
    assert.equal(resolveSourceOrigin({
      provider: 'Bank of Canada',
      hosts: ['www.bankofcanada.ca'],
    }), 'CA');
    assert.equal(resolveSourceOrigin({
      provider: 'U.S. Geological Survey (USGS)',
      hosts: ['earthquake.usgs.gov'],
    }), 'US');
  });

  it('uses publisher home country for generic-TLD outlets', () => {
    assert.equal(resolveSourceOrigin({
      provider: 'www.aljazeera.com',
      hosts: ['www.aljazeera.com'],
    }), 'QA');
    assert.equal(resolveSourceOrigin({
      provider: 'www.bbc.com',
      hosts: ['www.bbc.com'],
    }), 'GB');
    assert.equal(sourceOriginLabel('QA'), 'Qatar');
  });

  it('classifies every crisis-desk publisher added by #6813-#6830 and the Annahar follow-up', () => {
    const expectedOrigins = new Map([
      ['actuniger.com', 'NE'],
      ['airinfoagadez.com', 'NE'],
      ['annahar.com', 'LB'],
      ['amu.tv', 'AF'],
      ['ayibopost.com', 'HT'],
      ['dhakatribune.com', 'BD'],
      ['efectococuyo.com', 'VE'],
      ['english.enabbaladi.net', 'SY'],
      ['english.wafa.ps', 'PS'],
      ['havanatimes.org', 'CU'],
      ['lefaso.net', 'BF'],
      ['libyaherald.com', 'LY'],
      ['lorientlejour.com', 'LB'],
      ['madamasr.com', 'EG'],
      ['nation.africa', 'KE'],
      ['oko.press', 'PL'],
      ['pajhwok.com', 'AF'],
      ['sanaacenter.org', 'YE'],
      ['syriadirect.org', 'SY'],
      ['tchadinfos.com', 'TD'],
      ['thedailystar.net', 'BD'],
      ['theguardianpostcameroon.com', 'CM'],
      ['tvp.info', 'PL'],
      ['yemenonline.info', 'YE'],
      ['www.14ymedio.com', 'CU'],
      ['www.972mag.com', 'IL'],
      ['www.alwihdainfo.com', 'TD'],
      ['www.caracaschronicles.com', 'VE'],
      ['www.egyptindependent.com', 'EG'],
      ['www.haitilibre.com', 'HT'],
      ['www.naharnet.com', 'LB'],
      ['www.radiondekeluka.org', 'CF'],
      ['www.studiotamani.org', 'ML'],
    ]);

    for (const [host, country] of expectedOrigins) {
      assert.equal(
        resolveSourceOrigin({ provider: host, hosts: [host] }),
        country,
        `${host} must resolve to ${country}`,
      );
    }
  });

  it('marks international organizations as having no national origin', () => {
    assert.equal(resolveSourceOrigin({
      provider: 'International Monetary Fund (IMF)',
      hosts: ['api.imf.org'],
    }), null);
    assert.equal(sourceOriginLabel(null), 'International');
  });

  it('classifies GitHub-owned platform hosts as international', () => {
    for (const host of [
      'api.github.com',
      'github.blog',
      'raw.githubusercontent.com',
      'www.githubstatus.com',
    ]) {
      assert.equal(
        resolveSourceOrigin({ provider: host, hosts: [host] }),
        null,
        `${host} must use the catalog's global-platform classification`,
      );
    }
  });

  it('does not infer Serbia from the vanity domain lobste.rs', () => {
    assert.equal(resolveSourceOrigin({ provider: 'lobste.rs', hosts: ['lobste.rs'] }), 'US');
  });

  it('fails closed when one provider resolves to conflicting countries', () => {
    assert.throws(
      () => resolveSourceOrigin({
        provider: 'Conflicting Provider',
        hosts: ['24.hu', 'www.bbc.com'],
      }),
      /Source provider has conflicting origin countries: Conflicting Provider/,
    );
  });

  it('fails closed when a generic-TLD provider has no origin country', () => {
    assert.throws(
      () => buildSourceCatalog([{
        provider: 'Unknown Wire',
        host: 'unknown-wire.example',
        kind: 'structured',
        references: [{ path: 'scripts/seed-market.mjs' }],
      }]),
      /Source provider needs a catalog origin country: Unknown Wire/,
    );
  });
});

describe('sources catalog provider names', () => {
  it('uses public source names while retaining hostnames as separate metadata', () => {
    assert.equal(sourceProviderDisplayName('acleddata.com', ['acleddata.com']), 'ACLED');
    assert.equal(sourceProviderDisplayName('en.wikipedia.org', ['en.wikipedia.org']), 'Wikipedia');
    assert.equal(
      sourceProviderDisplayName('it.usembassy.gov', ['it.usembassy.gov']),
      'U.S. Embassy & Consulates in Italy',
    );
    assert.equal(sourceProviderDisplayName('airlinegeeks.com', ['airlinegeeks.com']), 'AirlineGeeks');
    assert.equal(sourceProviderDisplayName('feeds.arstechnica.com', ['feeds.arstechnica.com']), 'Ars Technica');
    assert.equal(sourceProviderDisplayName('api.gdeltproject.org', ['api.gdeltproject.org']), 'GDELT');
  });
});

const SOURCE_COUNTRY_FILTER_NOTE = (
  'This list shows monitored sources based in the selected country or region. Sources based elsewhere also cover it.'
);

describe('sources catalog country note layout', () => {
  it('does not cap the country filter note below the sentence length', () => {
    const src = readFileSync(join(repoRoot, 'scripts/crawlable-sources-page.mjs'), 'utf8');
    const rule = src.match(/\.catalog-country-note \{([^}]+)\}/)?.[1];
    assert.ok(rule, 'sources page must style the country coverage note');
    const maxWidth = rule.match(/max-width:\s*([^;]+)/)?.[1]?.trim();
    if (!maxWidth) return;
    const chMatch = maxWidth.match(/^(\d+(?:\.\d+)?)ch$/);
    assert.ok(
      chMatch && Number(chMatch[1]) >= SOURCE_COUNTRY_FILTER_NOTE.length,
      `country note max-width ${maxWidth} wraps a ${SOURCE_COUNTRY_FILTER_NOTE.length}-character sentence on a full-width catalog; omit max-width or size it to the sentence`,
    );
  });
});

function isJsonLdType(value, expectedType) {
  const type = value?.['@type'];
  return type === expectedType || (Array.isArray(type) && type.includes(expectedType));
}

function collectDatasets(value, datasets = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectDatasets(item, datasets);
    return datasets;
  }
  if (!value || typeof value !== 'object') return datasets;

  if (isJsonLdType(value, 'Dataset')) datasets.push(value);
  for (const child of Object.values(value)) collectDatasets(child, datasets);
  return datasets;
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertDatasetGoogleProperties(html, route, { requireDataset = false } = {}) {
  const datasets = jsonLdObjects(html).flatMap((entry) => collectDatasets(entry));
  if (requireDataset) {
    assert.ok(datasets.length > 0, `${route} must contain a Dataset JSON-LD object`);
  }

  for (const [index, dataset] of datasets.entries()) {
    const description = typeof dataset.description === 'string' ? dataset.description.trim() : '';
    assert.ok(
      description.length >= DATASET_DESCRIPTION_MIN_LENGTH,
      `${route} Dataset ${index + 1} description must be at least ${DATASET_DESCRIPTION_MIN_LENGTH} characters`,
    );
    assert.ok(
      description.length <= DATASET_DESCRIPTION_MAX_LENGTH,
      `${route} Dataset ${index + 1} description must be at most ${DATASET_DESCRIPTION_MAX_LENGTH} characters`,
    );

    const creators = Array.isArray(dataset.creator) ? dataset.creator : [dataset.creator];
    assert.ok(
      creators.some((creator) => (
        creator
        && (creator['@type'] === 'Person' || creator['@type'] === 'Organization')
        && typeof creator.name === 'string'
        && creator.name.trim().length > 0
      )),
      `${route} Dataset ${index + 1} must identify a Person or Organization creator`,
    );

    const licenses = Array.isArray(dataset.license) ? dataset.license : [dataset.license];
    assert.ok(
      licenses.some((license) => (
        isAbsoluteHttpUrl(license)
        || (
          license?.['@type'] === 'CreativeWork'
          && typeof license.name === 'string'
          && license.name.trim().length > 0
          && isAbsoluteHttpUrl(license.url)
        )
      )),
      `${route} Dataset ${index + 1} must link to a specific license URL`,
    );
  }

  return datasets;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function pageMetaDescription(html, route) {
  const raw = html.match(/<meta name="description" content="([^"]*)">/)?.[1];
  assert.ok(raw, `${route} must have a meta description`);
  return decodeHtmlAttribute(raw);
}

function productionScriptNonce() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'));
  const csp = config.headers
    .flatMap((rule) => rule.headers || [])
    .find((header) => header.key === 'Content-Security-Policy' && header.value.includes("'strict-dynamic'"));
  const nonce = csp?.value.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, 'production CSP must declare a strict-dynamic script nonce');
  return nonce;
}

describe('crawlable corpus generator', () => {
  it('advances the sources lastmod when the shared page template changes', () => {
    const baseline = sourcePageLastmod({
      manifestLastmod: '2026-08-10',
      rendererLastmod: '2026-08-11',
      sharedTemplateLastmod: '2026-08-12',
      generatorContentVersion: '2026-08-09',
      pageContentVersion: '2026-08-08',
    });
    const afterTemplateChange = sourcePageLastmod({
      manifestLastmod: '2026-08-10',
      rendererLastmod: '2026-08-11',
      sharedTemplateLastmod: '2026-08-13',
      generatorContentVersion: '2026-08-09',
      pageContentVersion: '2026-08-08',
    });
    assert.equal(baseline, '2026-08-12');
    assert.equal(afterTemplateChange, '2026-08-13');
  });

  it('advances the sources lastmod for every catalog identity input', () => {
    assert.deepEqual(SOURCE_CATALOG_LASTMOD_PATHS, [
      'scripts/source-catalog-identity.mjs',
      'shared/source-geography.json',
      'shared/publisher-families.js',
      'src/config/feeds.ts',
      'server/worldmonitor/news/v1/_feeds.ts',
    ]);
    for (let index = 0; index < SOURCE_CATALOG_LASTMOD_PATHS.length; index += 1) {
      const catalogInputLastmods = SOURCE_CATALOG_LASTMOD_PATHS.map(() => '2026-08-10');
      catalogInputLastmods[index] = '2026-08-13';
      assert.equal(
        sourcePageLastmod({
          manifestLastmod: '2026-08-10',
          rendererLastmod: '2026-08-11',
          originLastmod: '2026-08-09',
          catalogInputLastmods,
          sharedTemplateLastmod: '2026-08-12',
          generatorContentVersion: '2026-08-09',
          pageContentVersion: '2026-08-08',
        }),
        '2026-08-13',
        `${SOURCE_CATALOG_LASTMOD_PATHS[index]} must advance the sources lastmod`,
      );
    }
  });

  // #6492 added public/sources/ to GENERATED_DIRS and not to .gitignore, so
  // every built worktree carried it as untracked noise. Nothing tied the two
  // lists together, so the next directory added would repeat it.
  it('gitignores every directory the build deletes and rewrites', () => {
    const ignored = new Set(
      readFileSync(join(repoRoot, '.gitignore'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    );
    for (const dir of GENERATED_DIRS) {
      // 'reference/changelog' is covered by the broader 'public/reference/'.
      const [topLevel] = dir.split('/');
      assert.ok(
        ignored.has(`public/${topLevel}/`),
        `public/${topLevel}/ is missing from .gitignore — the build rewrites it every run, so it must not be tracked`,
      );
    }
  });

  it('keeps future long source names inside the meta-description boundary', () => {
    const descriptions = new Set();
    for (let length = 1; length <= 100; length += 1) {
      const cases = [
        {
          name: 'A'.repeat(length),
          description: countryMetaDescription({
            name: 'A'.repeat(length),
            rank: 999_999,
            rankedCount: 999_999,
          }),
        },
        {
          name: 'B'.repeat(length),
          description: countryMetaDescription({
            name: 'B'.repeat(length),
            rank: null,
            rankedCount: 999_999,
          }),
        },
        {
          name: 'C'.repeat(length),
          description: chokepointMetaDescription('C'.repeat(length)),
        },
      ];

      for (const { name, description } of cases) {
        assert.ok(description.length >= 155 && description.length <= 160);
        assert.ok(description.startsWith(name), 'fallback must retain the page-specific name');
        assert.match(description, /\.$/, 'fallback must remain a complete sentence');
        assert.ok(!descriptions.has(description), 'boundary descriptions must remain unique');
        descriptions.add(description);
      }
    }
  });

  it('does not treat a shallow boundary commit as a source update', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-corpus-shallow-'));
    const sourceRoot = join(tempRoot, 'source');
    const shallowRoot = join(tempRoot, 'shallow');
    const gitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    );
    try {
      mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: sourceRoot, env: gitEnv });
      execFileSync(
        'git',
        ['config', 'user.email', 'corpus-test@worldmonitor.app'],
        { cwd: sourceRoot, env: gitEnv },
      );
      execFileSync(
        'git',
        ['config', 'user.name', 'Corpus Test'],
        { cwd: sourceRoot, env: gitEnv },
      );

      writeFileSync(join(sourceRoot, 'material.txt'), 'material version one\n');
      execFileSync('git', ['add', 'material.txt'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'add material'], {
        cwd: sourceRoot,
        env: {
          ...gitEnv,
          GIT_AUTHOR_DATE: '2026-06-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-06-01T00:00:00Z',
        },
      });

      writeFileSync(join(sourceRoot, 'unrelated.txt'), 'release-only change\n');
      execFileSync('git', ['add', 'unrelated.txt'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'release change'], {
        cwd: sourceRoot,
        env: {
          ...gitEnv,
          GIT_AUTHOR_DATE: '2026-07-28T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-07-28T00:00:00Z',
        },
      });

      execFileSync(
        'git',
        ['clone', '--depth', '1', pathToFileURL(sourceRoot).href, shallowRoot],
        { env: gitEnv },
      );
      assert.equal(
        execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
          cwd: shallowRoot,
          encoding: 'utf8',
          env: gitEnv,
        }).trim(),
        'true',
      );
      assert.equal(gitFileLastmod(shallowRoot, 'material.txt'), null);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('builds a non-trivial static corpus with canonical raw HTML pages', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-crawlable-corpus-'));
    try {
      const manifest = await buildCorpus({
        rootDir: repoRoot,
        outDir,
        baseUrl: 'https://www.worldmonitor.app',
      });

      assert.equal(manifest.sections.countries.count, 196);
      assert.equal(manifest.sections.chokepoints.count, 13);
      assert.equal(manifest.sections.crises.count, 4);
      assert.equal(manifest.sections.tools.count, 2);
      assert.equal(manifest.sections.research.count, 1);
      assert.equal(manifest.sections.useCases.count, 3);
      assert.equal(manifest.sections.sources.count, 1);
      assert.equal(manifest.generatorContentVersion, '2026-08-12');
      const sitemapEntries = buildSitemapEntries({
        repoRoot,
        publicDir: outDir,
        existingSitemapSource: '',
        resolveMaterialLastmod: () => '2026-07-28',
        // Real current date: a pinned 'today' silently expires the moment any
        // material source is committed after it (this fixture went stale on
        // 2026-07-28 and failed every PR touching a corpus-backing file).
        today: new Date().toISOString().slice(0, 10),
      });
      const corpusLocations = new Set(
        sitemapEntries
          .filter((entry) => entry.family === 'content-corpus')
          .map((entry) => new URL(entry.loc).pathname),
      );
      assert.ok(corpusLocations.has('/sources/'), 'root sitemap must publish the sources catalog');
      const manifestLocations = new Set([
        manifest.sections.countries.index,
        ...manifest.sections.countries.routes,
        manifest.sections.chokepoints.index,
        ...manifest.sections.chokepoints.routes,
        manifest.sections.crises.index,
        ...manifest.sections.crises.routes,
        manifest.sections.tools.index,
        ...manifest.sections.tools.routes,
        manifest.sections.research.index,
        ...manifest.sections.research.routes,
        manifest.sections.useCases.index,
        ...manifest.sections.useCases.routes,
        manifest.sections.changelog.index,
        ...manifest.sections.changelog.routes,
        manifest.sections.sources.index,
        ...manifest.sections.sources.routes,
      ]);
      assert.deepEqual(corpusLocations, manifestLocations);
      const liveScriptTag = `<script type="module" nonce="${productionScriptNonce()}" src="/tools/live-tools.js"></script>`;
      assert.ok(manifest.sections.changelog.count >= 2, `expected paginated changelog pages, got ${manifest.sections.changelog.count}`);
      assert.ok(manifest.sections.glossary.count >= 15, `expected existing glossary manifest entries, got ${manifest.sections.glossary.count}`);

      const searchLandingRoutes = [
        ...manifest.sections.countries.routes,
        ...manifest.sections.chokepoints.routes,
      ];
      const descriptions = new Map();
      for (const route of searchLandingRoutes) {
        const description = pageMetaDescription(
          read(outDir, `${route.slice(1)}index.html`),
          route,
        );
        assert.ok(
          description.length >= 155 && description.length <= 160,
          `${route} meta description must be 155-160 characters, got ${description.length}`,
        );
        assert.doesNotMatch(
          description,
          /…$/,
          `${route} meta description must be a complete sentence, not a truncated lede`,
        );
        assert.ok(
          !descriptions.has(description),
          `${route} duplicates the meta description for ${descriptions.get(description)}`,
        );
        descriptions.set(description, route);
      }

      // Google requires Dataset descriptions to be 50-5000 characters and
      // recommends creator and license. Walk every generated JSON-LD object
      // recursively so this catches both the country snapshot Dataset and
      // nested datasets such as research report distributions, not only one
      // representative page.
      const generatedRoutes = new Set(
        Object.values(manifest.sections)
          .filter((section) => !section.generatedBy)
          .flatMap((section) => [section.index, ...(section.routes ?? [])])
          .filter(Boolean),
      );
      const datasetRequiredRoutes = new Set([
        ...manifest.sections.countries.routes,
        ...manifest.sections.research.routes,
      ]);
      for (const route of generatedRoutes) {
        assertDatasetGoogleProperties(
          read(outDir, `${route.slice(1)}index.html`),
          route,
          { requireDataset: datasetRequiredRoutes.has(route) },
        );
      }

      for (const path of [
        'countries/index.html',
        'countries/norway/index.html',
        'chokepoints/index.html',
        'chokepoints/strait-of-hormuz/index.html',
        'crises/index.html',
        'crises/red-sea-security/index.html',
        'tools/index.html',
        'tools/live-tools.js',
        'tools/natural-hazard-pulse/index.html',
        'tools/airspace-disruption-checker/index.html',
        'reference/changelog/index.html',
        'reference/changelog/page/2/index.html',
        'sources/index.html',
        'crawlable-corpus.json',
      ]) {
        assert.ok(existsSync(join(outDir, path)), `missing generated file ${path}`);
      }
      assert.ok(
        !existsSync(join(outDir, 'countries/live-risk.js')),
        'country pages must reuse the shared live-tools runtime',
      );

      const norway = read(outDir, 'countries/norway/index.html');
      assert.match(norway, /<h1>Norway country risk and resilience<\/h1>/);
      assert.match(norway, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/countries\/norway\/">/);
      assert.match(norway, /<meta name="lastmod" content="2026-08-12">/);
      assert.match(norway, /Source: docs\/snapshots\/resilience-ranking-2026-05-28\.json/);
      assert.doesNotMatch(norway, /id="app"/, 'country page must be raw static HTML, not the SPA shell');
      assert.match(norway, /data-live-country-risk data-country-code="NO" data-country-name="Norway"/);
      assert.match(norway, /Instability is a fast-moving composite/);
      assert.match(norway, /the two scores should not be combined/);
      assert.ok(norway.includes(liveScriptTag), 'country live script must match the production CSP nonce');
      // Deep-link CTA into the live map (opens the maximized country brief). `&` is HTML-escaped.
      // Carries utm_source (NOT ref= — that would be captured as an affiliate referral code).
      assert.match(norway, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?country=NO&amp;expanded=1&amp;utm_source=seo-country">Open Norway on the live map/);
      assert.doesNotMatch(norway, /[?&]ref=/, 'corpus CTAs must never use the affiliate ref= param');
      // Social preview + trust-link contracts.
      assert.match(norway, /<meta property="og:image" content="https:\/\/www\.worldmonitor\.app\/favico\/og-image\.png">/);
      assert.match(norway, /<meta name="twitter:card" content="summary_large_image">/);
      assert.match(norway, /href="\/docs\/methodology\/country-resilience-index"/);

      // Search-friendly display aliases: slug stays stable, reader-facing name is aliased.
      const uk = read(outDir, 'countries/uk/index.html');
      assert.match(uk, /<h1>United Kingdom country risk and resilience<\/h1>/);
      assert.doesNotMatch(uk, /<h1>Uk /);
      const dprk = read(outDir, 'countries/democratic-peoples-republic-of-korea/index.html');
      assert.match(dprk, /<title>North Korea Country Risk and Resilience \| World Monitor<\/title>/);

      const liveRiskScript = read(outDir, 'tools/live-tools.js');
      assert.match(liveRiskScript, /\/api\/wm-session/);
      assert.match(liveRiskScript, /\/api\/intelligence\/v1\/get-country-risk\?country_code=/);
      assert.match(liveRiskScript, /credentials:\s*'include'/);
      assert.match(liveRiskScript, /preflightSession:\s*true/);
      assert.match(liveRiskScript, /response\.status === 401/);
      assert.match(liveRiskScript, /payload\.upstreamUnavailable === true/);

      const norwayLd = jsonLdObjects(norway);
      const norwayWebPage = norwayLd.find((entry) => entry['@type'] === 'WebPage');
      assert.ok(norwayWebPage?.about?.['@type'] === 'Country' && norwayWebPage.about?.name === 'Norway');
      assert.ok(norwayLd.some((entry) => entry['@type'] === 'BreadcrumbList'));

      const chokepointsIndex = read(outDir, 'chokepoints/index.html');
      // The "N routes" / raw-id card subtitles are gone; cards now describe what each waterway connects.
      assert.doesNotMatch(chokepointsIndex, /\d+ routes?<\/span>/, 'chokepoint index must not expose raw "N routes" counts');
      assert.doesNotMatch(chokepointsIndex, /hormuz_strait &middot;/, 'chokepoint index must not expose raw canonical ids');
      assert.match(chokepointsIndex, /Persian Gulf ↔ Gulf of Oman/, 'chokepoint cards should show the human region');

      const sourcesPage = read(outDir, 'sources/index.html');
      assert.match(sourcesPage, /<h1>See every source behind World Monitor\.<\/h1>/);
      assert.match(sourcesPage, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/sources\/">/);
      assert.doesNotMatch(sourcesPage, /id="app"/, 'sources page must be raw static HTML, not the SPA shell');
      // The hero counts render from the committed attribution manifest with the
      // same active-host predicate as scripts/source-attribution.mjs
      // sourceAttributionStats — a formula fork would advertise numbers the
      // audited docs inventory does not back.
      const attributionManifest = JSON.parse(
        readFileSync(join(repoRoot, 'shared/source-attribution-manifest.json'), 'utf8'),
      );
      const activeAttributionEntries = rawManifestActiveEntries(attributionManifest);
      const activeProviderNames = rawCatalogProviderNames(attributionManifest);
      assert.ok(
        sourcesPage.includes(`<strong>${activeAttributionEntries.length}</strong>`),
        'sources page must render the tracked active-host count',
      );
      assert.match(
        sourcesPage,
        new RegExp(`${activeProviderNames.size} active providers across ${activeAttributionEntries.length} observed source hosts`),
        'sources page must label provider and host counts as different inventory layers',
      );
      assert.match(sourcesPage, /id="source-search"/);
      assert.match(sourcesPage, /id="source-country"/);
      assert.match(sourcesPage, /id="source-coverage"/);
      assert.match(sourcesPage, />Country of origin</);
      assert.match(sourcesPage, />Country covered</);
      assert.match(sourcesPage, /data-source-catalog/);
      assert.match(sourcesPage, /data-source-filter="all"/);
      const renderedProviders = [...sourcesPage.matchAll(/data-provider="([^"]+)"/g)]
        .map((match) => match[1]);
      assert.equal(
        renderedProviders.length,
        activeProviderNames.size,
        'sources page must render one crawlable catalog row for every active provider',
      );
      assert.equal(
        new Set(renderedProviders).size,
        activeProviderNames.size,
        'sources page must not duplicate providers in the complete catalog',
      );
      assert.deepEqual(
        new Set(renderedProviders.map(decodeHtmlAttribute)),
        activeProviderNames,
        'sources page must render the exact active provider set from the attribution manifest',
      );
      assert.match(
        sourcesPage,
        /data-provider="L&#39;Orient Today"[\s\S]*?lorientlejour\.com/,
        "sources page must list L'Orient Today under its own host",
      );
      assert.match(
        sourcesPage,
        /data-provider="Annahar"[\s\S]*?annahar\.com/,
        'sources page must list Annahar under its own host',
      );
      assert.match(
        sourcesPage,
        /data-provider="OKO.press"[\s\S]*?oko\.press/,
        'sources page must list OKO.press under its own host',
      );
      assert.match(
        sourcesPage,
        /data-provider="PAP"[\s\S]*?pap\.pl/,
        'sources page must list PAP under its own host',
      );
      assert.doesNotMatch(
        sourcesPage,
        /data-provider="news\.google\.com"|<h3>Google News<\/h3>/,
        'sources page must not list Google News as a publisher',
      );
      assert.doesNotMatch(
        sourcesPage,
        /FeedBurner-hosted publishers|<h3>FeedBurner/,
        'sources page must not list FeedBurner as a publisher',
      );
      assert.match(
        sourcesPage,
        /data-provider="NDTV"[\s\S]*?Origin: India[\s\S]*?Covers: India/,
        'NDTV must appear as an Indian publisher with India coverage',
      );
      assert.match(
        sourcesPage,
        /<h3>BBC<\/h3>[\s\S]*?Origin: United Kingdom[\s\S]*?Covers:[^<]*India/,
        'BBC Hindi must keep BBC origin while declaring India coverage',
      );
      assert.match(
        sourcesPage,
        /<h3>Reuters<\/h3>[\s\S]*?Origin: United Kingdom[\s\S]*?Covers:[^<]*India/,
        'India-focused Reuters routes must stay Reuters with India coverage',
      );
      assert.doesNotMatch(
        sourcesPage,
        /via Google News|acquisition transport/i,
        'the public catalog must not expose feed transport mechanics',
      );
      const renderedDomains = [...sourcesPage.matchAll(/data-source-domain="([^"]+)"/g)]
        .map((match) => match[1]);
      assert.equal(renderedDomains.length, activeProviderNames.size);
      assert.ok(renderedDomains.every((domain) => SOURCE_DOMAIN_IDS.has(domain)));
      const renderedKinds = [...sourcesPage.matchAll(/data-source-kind="([^"]+)"/g)]
        .map((match) => match[1]);
      const renderedCountries = [...sourcesPage.matchAll(/data-source-country="([^"]+)"/g)]
        .map((match) => match[1]);
      assert.equal(renderedCountries.length, activeProviderNames.size);
      assert.ok(renderedCountries.every((country) => /^[a-z]{2}$|^intl$/.test(country)));
      const renderedCoverage = [...sourcesPage.matchAll(/data-source-coverage="([^"]*)"/g)]
        .map((match) => match[1]);
      assert.equal(renderedCoverage.length, activeProviderNames.size);
      assert.doesNotMatch(
        sourcesPage,
        /audited upstream|audited &amp; attributed/i,
        'inventory reconciliation must not be presented as completed rights review',
      );
      const filterScript = [...sourcesPage.matchAll(/<script nonce="wm-static-bootstrap">([\s\S]*?)<\/script>/g)].at(-1)?.[1];
      assert.ok(filterScript, 'sources page must ship its progressive filter script');
      const window = new Window({ url: 'https://www.worldmonitor.app/sources/' });
      window.document.write(sourcesPage);
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.eval(filterScript);
      const providerTitle = (provider) => (
        window.document.querySelector(`.provider-card[data-provider="${provider}"] h3`)?.textContent
      );
      assert.equal(providerTitle('acleddata.com'), 'ACLED');
      assert.equal(providerTitle('en.wikipedia.org'), 'Wikipedia');
      assert.equal(providerTitle('it.usembassy.gov'), 'U.S. Embassy & Consulates in Italy');
      assert.equal(providerTitle('airlinegeeks.com'), 'AirlineGeeks');
      assert.equal(
        window.document.querySelector('.provider-card[data-provider="acleddata.com"] .provider-hosts a')?.textContent,
        'acleddata.com',
        'the exact hostname must remain available as the traceability link',
      );
      const visibleProviderCount = () => (
        [...window.document.querySelectorAll('.provider-card')].filter((card) => !card.hidden).length
      );
      const financeCount = renderedDomains.filter((domain) => domain === 'finance').length;
      const financeButton = window.document.querySelector('[data-source-filter="finance"]');
      financeButton.click();
      assert.equal(visibleProviderCount(), financeCount, 'domain cards must filter the complete catalog');
      assert.equal(financeButton.getAttribute('aria-pressed'), 'true');
      const resetButton = window.document.querySelector('[data-source-filter="all"]');
      resetButton.click();
      assert.equal(visibleProviderCount(), activeProviderNames.size, 'reset must restore all providers');
      const kindSelect = window.document.getElementById('source-kind');
      kindSelect.value = 'structured';
      kindSelect.dispatchEvent(new window.Event('change'));
      assert.equal(
        visibleProviderCount(),
        renderedKinds.filter((kinds) => kinds.split(' ').includes('structured')).length,
        'source type selection must filter the complete catalog',
      );
      resetButton.click();
      const countrySelect = window.document.getElementById('source-country');
      const countryNote = window.document.getElementById('source-country-note');
      assert.equal(countryNote.hidden, true, 'country coverage note must stay hidden without a country filter');
      countrySelect.value = 'hu';
      countrySelect.dispatchEvent(new window.Event('change'));
      assert.equal(
        visibleProviderCount(),
        renderedCountries.filter((country) => country === 'hu').length,
        'country selection must filter the complete catalog',
      );
      assert.ok(visibleProviderCount() > 0, 'Hungary must have at least one classified source');
      assert.equal(
        window.document.querySelector('.provider-card[data-provider="24.hu"] .provider-country')?.textContent,
        'Origin: Hungary',
      );
      assert.equal(countryNote.hidden, false, 'country selection must show the coverage clarification');
      assert.equal(countryNote.textContent, SOURCE_COUNTRY_FILTER_NOTE);
      for (const country of ['us', 'eu']) {
        countrySelect.value = country;
        countrySelect.dispatchEvent(new window.Event('change'));
        assert.equal(countryNote.hidden, false, `${country} selection must show the coverage clarification`);
        assert.equal(countryNote.textContent, SOURCE_COUNTRY_FILTER_NOTE);
      }
      countrySelect.value = 'intl';
      countrySelect.dispatchEvent(new window.Event('change'));
      assert.equal(countryNote.hidden, true, 'international selection must hide the coverage clarification');
      assert.equal(countryNote.textContent, '', 'international selection must clear the coverage clarification');
      countrySelect.value = 'eu';
      countrySelect.dispatchEvent(new window.Event('change'));
      resetButton.click();
      assert.equal(countryNote.hidden, true, 'reset must hide the country coverage clarification');
      assert.equal(countryNote.textContent, '', 'reset must clear the country coverage clarification');
      const coverageSelect = window.document.getElementById('source-coverage');
      coverageSelect.value = 'in';
      coverageSelect.dispatchEvent(new window.Event('change'));
      const indiaCoverageCount = [...window.document.querySelectorAll('.provider-card')].filter((card) => (
        !card.hidden && (card.dataset.sourceCoverage || '').split(' ').includes('in')
      )).length;
      assert.equal(visibleProviderCount(), indiaCoverageCount, 'coverage selection must filter the complete catalog');
      assert.ok(indiaCoverageCount > 0, 'India coverage must include at least one provider');
      const bbcCard = [...window.document.querySelectorAll('.provider-card')]
        .find((card) => card.querySelector('h3')?.textContent === 'BBC');
      const ndtvCard = window.document.querySelector('.provider-card[data-provider="NDTV"]');
      assert.ok(bbcCard && !bbcCard.hidden, 'BBC Hindi must remain visible under India coverage');
      assert.ok(ndtvCard && !ndtvCard.hidden, 'NDTV must remain visible under India coverage');
      const catalogSize = window.document.querySelectorAll('.provider-card').length;
      resetButton.click();
      assert.equal(coverageSelect.value, 'all', 'reset must clear the coverage filter');
      assert.equal(visibleProviderCount(), catalogSize, 'reset from coverage must show the full catalog');
      const countryOriginSelect = window.document.getElementById('source-country');
      countryOriginSelect.value = 'in';
      countryOriginSelect.dispatchEvent(new window.Event('change'));
      assert.ok(ndtvCard && !ndtvCard.hidden, 'NDTV origin is India');
      assert.ok(bbcCard?.hidden, 'BBC origin stays United Kingdom when filtering India origin');
      resetButton.click();
      const searchInput = window.document.getElementById('source-search');
      searchInput.value = 'Hyperliquid';
      searchInput.dispatchEvent(new window.Event('input'));
      assert.equal(visibleProviderCount(), 1, 'search must match provider names and hosts');
      searchInput.value = 'a provider that cannot exist';
      searchInput.dispatchEvent(new window.Event('input'));
      assert.equal(visibleProviderCount(), 0);
      assert.equal(window.document.getElementById('source-no-results').hidden, false);
      resetButton.click();
      const composableCard = [...window.document.querySelectorAll('.provider-card')]
        .find((card) => card.dataset.sourceKind.split(' ').length > 0);
      assert.ok(composableCard, 'the catalog must contain a provider for the combined-filter test');
      const combinedDomain = composableCard.dataset.sourceDomain;
      const combinedKind = composableCard.dataset.sourceKind.split(' ')[0];
      const combinedCountry = composableCard.dataset.sourceCountry;
      const combinedQuery = composableCard.dataset.provider;
      window.document.getElementById('source-domain').value = combinedDomain;
      kindSelect.value = combinedKind;
      countrySelect.value = combinedCountry;
      searchInput.value = combinedQuery;
      searchInput.dispatchEvent(new window.Event('input'));
      const combinedMatches = [...window.document.querySelectorAll('.provider-card')].filter((card) => (
        card.dataset.sourceDomain === combinedDomain
        && card.dataset.sourceKind.split(' ').includes(combinedKind)
        && card.dataset.sourceCountry === combinedCountry
        && card.textContent.toLowerCase().includes(combinedQuery.toLowerCase())
      ));
      assert.ok(combinedMatches.length > 0, 'the selected filters must retain at least one provider');
      assert.equal(
        visibleProviderCount(),
        combinedMatches.length,
        'domain, type, country, and search filters must compose with AND semantics',
      );
      window.close();
      assert.doesNotMatch(sourcesPage, /[?&]ref=/, 'sources CTAs must never use the affiliate ref= param');
      // Domain cards deep-link into the docs catalog with the query BEFORE the
      // fragment (utm after the anchor would be swallowed by the fragment).
      assert.match(sourcesPage, /href="\/docs\/data-sources\?utm_source=seo-sources#finance-%26-economics"/);
      assert.match(sourcesPage, /href="\/docs\/source-attribution\?utm_source=seo-sources"/);

      const hormuz = read(outDir, 'chokepoints/strait-of-hormuz/index.html');
      assert.match(hormuz, /<h1>Strait of Hormuz<\/h1>/);
      assert.match(hormuz, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/chokepoints\/strait-of-hormuz\/">/);
      // Deep-link CTA into the live map (pans to + opens the waterway popup).
      assert.match(hormuz, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?chokepoint=hormuz_strait&amp;utm_source=seo-chokepoint">Open Strait of Hormuz on the live map/);
      assert.match(hormuz, /href="\/docs\/methodology\/chokepoints"/);
      // Human trade-route names replace the old raw route-id dump.
      assert.match(hormuz, /Persian Gulf → Europe \(Oil\)/);
      assert.doesNotMatch(hormuz, /Canonical ID|Energy baseline|Route IDs:/, 'chokepoint page must not dump raw registry fields');
      // Cross-link to the matching glossary term.
      assert.match(hormuz, /href="\/blog\/glossary\/strait-of-hormuz\/"/);
      assert.match(hormuz, /data-live-chokepoint data-chokepoint-id="hormuz_strait"/);
      assert.match(hormuz, /traffic-light badge is a disruption score, not an operational closure declaration/i);
      assert.ok(hormuz.includes(liveScriptTag), 'chokepoint live script must match the production CSP nonce');
      assert.doesNotMatch(hormuz, /id="app"/, 'chokepoint page must be raw static HTML, not the SPA shell');

      const hormuzLd = jsonLdObjects(hormuz);
      assert.ok(hormuzLd.some((entry) => entry['@type'] === 'WebPage' && entry.about?.['@type'] === 'Place' && entry.about?.name === 'Strait of Hormuz'));

      // A chokepoint with no modelled trade routes must degrade gracefully — never "0 routes".
      const dover = read(outDir, 'chokepoints/dover-strait/index.html');
      assert.doesNotMatch(dover, /0 routes?|none configured/);
      assert.match(dover, /tracked as a strategic waterway reference/);

      const crisesIndex = read(outDir, 'crises/index.html');
      assert.match(crisesIndex, /<h1>Current crisis trackers<\/h1>/);
      assert.match(crisesIndex, /href="\/crises\/red-sea-security\/"/);

      const redSea = read(outDir, 'crises/red-sea-security/index.html');
      assert.match(redSea, /data-live-crisis/);
      assert.match(redSea, /data-country-code="YE" data-country-name="Yemen"/);
      assert.match(redSea, /Missing countries are unavailable, not zero/);
      assert.match(redSea, /HAPI\/HDX humanitarian conflict summaries/);
      assert.ok(redSea.includes(liveScriptTag), 'crisis live script must match the production CSP nonce');
      assert.doesNotMatch(redSea, /id="app"/);

      const toolsIndex = read(outDir, 'tools/index.html');
      assert.match(toolsIndex, /<h1>Check a current operational signal<\/h1>/);
      assert.match(toolsIndex, /href="\/tools\/natural-hazard-pulse\/"/);
      assert.match(toolsIndex, /href="\/tools\/airspace-disruption-checker\/"/);

      const hazard = read(outDir, 'tools/natural-hazard-pulse/index.html');
      assert.match(hazard, /data-natural-hazard-tool/);
      assert.match(hazard, /<option value="">Worldwide<\/option>/);
      assert.match(hazard, /<option value="JP" data-bounds="31\.11,129\.85,45\.51,145\.77">Japan<\/option>/);
      assert.doesNotMatch(hazard, /<option value="US"/);
      // Bare ISO2 codes must never surface as user-facing option labels.
      assert.doesNotMatch(hazard, /<option value="[A-Z]{2}"[^>]*>[A-Z]{2}<\/option>/);
      assert.match(hazard, /Countries with oversized or discontinuous envelopes are omitted/i);
      assert.match(hazard, /approximate geographic filter, not a territorial polygon/i);
      // Sources are trust links, not bare tokens.
      assert.match(hazard, /<a href="https:\/\/eonet\.gsfc\.nasa\.gov\/">NASA EONET<\/a>/);
      assert.match(hazard, /<a href="https:\/\/www\.gdacs\.org\/">GDACS<\/a>/);
      assert.match(hazard, /href="\/docs\/natural-disasters"/);
      assert.doesNotMatch(hazard, /id="app"/);

      const airspace = read(outDir, 'tools/airspace-disruption-checker/index.html');
      assert.match(airspace, /data-airspace-tool/);
      assert.match(airspace, /Commercial disruption and observed military aircraft are independent evidence domains/);
      assert.match(airspace, /Unknown.+not counted as normal/s);
      assert.match(airspace, /capped at 100 returned observations/);
      assert.match(airspace, /<option value="JP" data-bounds="31\.11,129\.85,45\.51,145\.77" selected>Japan<\/option>/);
      assert.doesNotMatch(airspace, /<option value="US"/);
      assert.doesNotMatch(airspace, /id="app"/);

      const liveToolsScript = read(outDir, 'tools/live-tools.js');
      assert.match(liveToolsScript, /\/api\/supply-chain\/v1\/get-chokepoint-status/);
      assert.match(liveToolsScript, /\/api\/conflict\/v1\/get-humanitarian-summary/);
      assert.match(liveToolsScript, /\/api\/natural\/v1\/list-natural-events/);
      assert.match(liveToolsScript, /\/api\/aviation\/v1\/list-airport-delays/);
      assert.match(liveToolsScript, /\/api\/military\/v1\/list-military-flights/);
      assert.match(liveToolsScript, /response\.status === 401/);
      assert.match(liveToolsScript, /credentials:\s*'include'/);
      assert.doesNotMatch(liveToolsScript, /list-natural-events\?days=/);
      assert.doesNotMatch(liveToolsScript, /generation:/);

      const changelogIndex = read(outDir, 'reference/changelog/index.html');
      const changelogPage2 = read(outDir, 'reference/changelog/page/2/index.html');
      assert.match(changelogIndex, /<link rel="next" href="https:\/\/www\.worldmonitor\.app\/reference\/changelog\/page\/2\/">/);
      assert.match(changelogIndex, /server scorer read non-existent/);
      assert.match(changelogIndex, /methodology_version is now v8/);
      assert.match(changelogPage2, /<link rel="prev" href="https:\/\/www\.worldmonitor\.app\/reference\/changelog\/">/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('loads deterministic source data without network access', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    assert.equal(data.sources.resilienceSnapshot, 'docs/snapshots/resilience-ranking-2026-05-28.json');
    assert.equal(data.sources.liveToolsScript, 'scripts/crawlable-live-tools.mjs');
    assert.equal(data.sources.countryBboxes, 'shared/country-bboxes.js');
    assert.equal(data.sources.crisisRegistry, 'shared/crawlable-crises.json');
    assert.equal(data.sources.sourcePageRenderer, 'scripts/crawlable-sources-page.mjs');
    assert.equal(data.sources.sourceOrigin, 'scripts/source-origin.mjs');
    assert.deepEqual(data.sources.sourceCatalogInputs, SOURCE_CATALOG_LASTMOD_PATHS);
    assert.equal(data.sources.sharedPageTemplate, 'scripts/build-crawlable-corpus.mjs');
    assert.equal(data.resilience.capturedAt, '2026-05-28');
    assert.equal(data.lastmod.countries, '2026-08-12');
    assert.equal(data.lastmod.research, '2026-08-12');
    assert.equal(
      data.lastmod.sources,
      sourcePageLastmod({
        manifestLastmod: gitFileLastmod(repoRoot, data.sources.sourceAttributionManifest),
        rendererLastmod: gitFileLastmod(repoRoot, data.sources.sourcePageRenderer),
        originLastmod: gitFileLastmod(repoRoot, data.sources.sourceOrigin),
        catalogInputLastmods: data.sources.sourceCatalogInputs.map((path) => gitFileLastmod(repoRoot, path)),
        sharedTemplateLastmod: gitFileLastmod(repoRoot, data.sources.sharedPageTemplate),
      }),
      'source-page lastmod must include manifest, renderer, origin, catalog-input, and shared-template changes',
    );
    assert.equal(data.crises.length, 4);
    assert.ok(data.crises.some((crisis) => crisis.slug === 'ukraine-war' && crisis.coverage.some((country) => country.code === 'UA')));
    assert.ok(data.countryBounds.some((country) => country.code === 'JP' && country.bounds[0] === 31.11));
    assert.ok(!data.countryBounds.some((country) => country.code === 'US'));
    assert.ok(data.countryBounds.every(({ bounds: [south, west, north, east] }) => (
      north - south <= 45 && east - west <= 60
    )));
    assert.ok(data.countries.some((country) => country.slug === 'norway' && country.rank === 1));
    assert.ok(data.chokepoints.some((chokepoint) => chokepoint.slug === 'strait-of-hormuz' && chokepoint.id === 'hormuz_strait'));
    assert.ok(data.glossaryTerms.some((term) => term.slug === 'country-resilience-index'));
    // Position-independent: the parser must carry full bullet prose through,
    // but pinning the NEWEST bullet made every changelog addition a test
    // failure. Assert the known CII v8 entry exists wherever it now sits.
    const allBullets = data.changelog.flatMap((entry) => entry.bullets);
    assert.ok(allBullets.some((bullet) => bullet.includes('server scorer read non-existent')));
    assert.ok(allBullets.some((bullet) => bullet.includes('methodology_version is now v8')));
    assert.match(data.lastmod.chokepoints, /^\d{4}-\d{2}-\d{2}$/);
  });
});
