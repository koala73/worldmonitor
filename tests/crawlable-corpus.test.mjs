import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { Window } from 'happy-dom';

import {
  buildCiiRankingEntries,
  buildChokepointHubRows,
  buildCorpus,
  buildMicrostateCoverageStory,
  CHOKEPOINT_PAGE_CONTENT_VERSION,
  CHOKEPOINT_PAGE_LASTMOD_PATHS,
  CII_COUNTRY_PAGE_CONTENT_VERSION,
  chokepointMetaDescription,
  countryMetaDescription,
  COUNTRY_PAGE_CONTENT_VERSION,
  DATASET_SCHEMA_CONTENT_VERSION,
  datasetTemporalCoverage,
  describeHeadlineIneligibilityReason,
  describeInventoryScope,
  GENERATED_DIRS,
  gitFileLastmod,
  hasObservedValue,
  laterDate,
  loadCorpusData,
  MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS,
  renderCountryAnalysis,
  resolveChokepointObservation,
  resolveLatestLivePulseSnapshotPath,
  SOURCE_CATALOG_LASTMOD_PATHS,
  sourcePageLastmod,
  withSchemaContext,
} from '../scripts/build-crawlable-corpus.mjs';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_LIVE_SNAPSHOT_AGE_MS,
} from '../scripts/crawlable-live-tools.mjs';
import { buildSitemapEntries } from '../scripts/build-sitemap.mjs';
import {
  auditMicrostateCorpusSimilarity,
  maskedSentences,
  wordShingles,
} from '../scripts/audit-microstate-corpus-similarity.mjs';
import { buildMicrostateCoverageStoryContent } from '../scripts/microstate-coverage-stories.mjs';
import { buildSourceCatalog, sourceProviderDisplayName } from '../scripts/crawlable-sources-page.mjs';
import { resolveSourceOrigin, sourceOriginLabel } from '../scripts/source-origin.mjs';
import { rawCatalogProviderNames, rawManifestActiveEntries } from './helpers/raw-catalog-providers.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(outDir, path) {
  return readFileSync(join(outDir, path), 'utf8');
}

function writeRankedAuditSnapshot(corpusDir, {
  code,
  slug,
  rank = 1,
  overallScore = 70,
  headlineEligible = true,
}) {
  writeFileSync(
    join(corpusDir, `countries/${slug}/resilience.json`),
    JSON.stringify({ countryCode: code, rank, overallScore, headlineEligible }),
  );
}

function jsonLdObjects(html) {
  // Tolerate attributes on the open tag (`nonce`, `id`). The corpus emits none
  // today, but a bare-literal match would silently skip an attributed block
  // rather than fail -- and skipping blocks is the #7502 defect class.
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

function proseWordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function assertDefaultSpeakable(node, label) {
  assert.deepEqual(
    node?.speakable,
    { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.lede'] },
    `${label} must carry SpeakableSpecification`,
  );
}

function htmlDocument(html, url) {
  const window = new Window({ url });
  window.document.write(html);
  return window.document;
}

function words(value) {
  return String(value || '')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
}

function pairwiseUniqueShare(left, right) {
  const leftShingles = wordShingles(left);
  const rightShingles = wordShingles(right);
  const shared = [...leftShingles].filter((shingle) => rightShingles.has(shingle)).length;
  return 1 - (shared / Math.max(leftShingles.size, rightShingles.size));
}

function decodeBasicHtml(value) {
  return String(value || '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function unpublishedHeadingParagraph(html, headingRe) {
  const match = html.match(new RegExp(`<h3>${headingRe}</h3>\\s*<p>([\\s\\S]*?)</p>`));
  return decodeBasicHtml(match?.[1] || '');
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

function assertDatasetDownloadsAreGenerated(html, outDir, route, baseUrl = 'https://www.worldmonitor.app') {
  const datasets = jsonLdObjects(html).flatMap((entry) => collectDatasets(entry));
  const downloads = datasets.flatMap((dataset) => {
    const distributions = Array.isArray(dataset.distribution)
      ? dataset.distribution
      : dataset.distribution == null
        ? []
        : [dataset.distribution];
    return distributions.filter((item) => isJsonLdType(item, 'DataDownload'));
  });
  if (datasets.length === 0) return;
  assert.ok(downloads.length > 0, `${route} Dataset must expose at least one DataDownload`);
  const origin = new URL(baseUrl).origin;
  for (const item of downloads) {
    assert.ok(isAbsoluteHttpUrl(item.contentUrl), `${route} DataDownload contentUrl must be absolute`);
    const url = new URL(item.contentUrl);
    assert.equal(url.origin, origin, `${route} DataDownload must stay on ${origin}`);
    assert.doesNotMatch(
      url.pathname,
      /^\/api\//,
      `${route} DataDownload must not point at an authenticated API route: ${item.contentUrl}`,
    );
    const relativePath = url.pathname.replace(/^\/+/, '');
    assert.ok(
      existsSync(join(outDir, relativePath)),
      `${route} DataDownload ${item.contentUrl} must map to generated file ${relativePath}`,
    );
  }
}

function assertDatasetGoogleProperties(html, route, { requireDataset = false, requireCatalogLinkage = false } = {}) {
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

    // A creator must be BOTH anchored on the canonical @id and self-describing.
    // An @id alone would reference a node no generated page declares, so a
    // per-page parser resolves it to nothing (#7459b); a name alone would mint a
    // competing anonymous Organization. Require both together.
    const creators = Array.isArray(dataset.creator) ? dataset.creator : [dataset.creator];
    assert.ok(
      creators.some((creator) => (
        creator
        && creator['@id'] === 'https://www.worldmonitor.app/#organization'
        && (creator['@type'] === 'Person' || creator['@type'] === 'Organization')
        && typeof creator.name === 'string'
        && creator.name.trim().length > 0
      )),
      `${route} Dataset ${index + 1} creator must be the canonical Organization AND carry @type + name so the reference resolves in-page`,
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

    if (requireCatalogLinkage) {
      assert.equal(
        dataset.isAccessibleForFree,
        true,
        `${route} Dataset ${index + 1} must declare isAccessibleForFree`,
      );
      assert.ok(
        dataset.includedInDataCatalog
          && (
            isJsonLdType(dataset.includedInDataCatalog, 'DataCatalog')
            || typeof dataset.includedInDataCatalog['@id'] === 'string'
          ),
        `${route} Dataset ${index + 1} must link includedInDataCatalog`,
      );
      const measured = Array.isArray(dataset.variableMeasured)
        ? dataset.variableMeasured
        : dataset.variableMeasured == null
          ? []
          : [dataset.variableMeasured];
      assert.ok(
        measured.length > 0,
        `${route} Dataset ${index + 1} must declare variableMeasured`,
      );
      const distributions = Array.isArray(dataset.distribution)
        ? dataset.distribution
        : dataset.distribution == null
          ? []
          : [dataset.distribution];
      assert.ok(
        distributions.some((item) => (
          isJsonLdType(item, 'DataDownload')
          && isAbsoluteHttpUrl(item.contentUrl)
        )),
        `${route} Dataset ${index + 1} must expose a DataDownload distribution`,
      );
      if (dataset.temporalCoverage) {
        assert.equal(
          dataset.temporalCoverage,
          datasetTemporalCoverage(dataset.temporalCoverage),
          `${route} Dataset ${index + 1} temporalCoverage must be an observation date or closed interval`,
        );
      }
    }

    if (requireCatalogLinkage) {
      assert.ok(
        dataset.spatialCoverage,
        `${route} Dataset ${index + 1} must declare spatialCoverage`,
      );
    }
    if (dataset.spatialCoverage != null) {
      // Google's Dataset parser uses an exact allowlist here: non-empty Text or
      // a literal Place. It rejects Place subtypes such as Country.
      const coverages = Array.isArray(dataset.spatialCoverage)
        ? dataset.spatialCoverage
        : [dataset.spatialCoverage];
      assert.ok(
        coverages.length > 0,
        `${route} Dataset ${index + 1} spatialCoverage must be Text or exact @type Place, got []`,
      );
      for (const coverage of coverages) {
        assert.ok(
          typeof coverage === 'string'
            ? coverage.trim().length > 0
            : coverage?.['@type'] === 'Place',
          `${route} Dataset ${index + 1} spatialCoverage must be Text or exact @type Place, got ${JSON.stringify(coverage?.['@type'] ?? coverage)}`,
        );
      }
    }
  }

  return datasets;
}

describe('Dataset spatialCoverage Google contract', () => {
  function datasetHtml(spatialCoverage) {
    return `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Dataset',
      name: 'Contract test dataset',
      description: 'A focused contract fixture with enough detail for the Google Dataset description requirement.',
      creator: {
        '@id': 'https://www.worldmonitor.app/#organization',
        '@type': 'Organization',
        name: 'World Monitor',
      },
      license: 'https://www.worldmonitor.app/docs/terms',
      spatialCoverage,
    })}</script>`;
  }

  it('accepts only non-empty Text or exact Place values on every Dataset route', () => {
    assert.doesNotThrow(() => assertDatasetGoogleProperties(
      datasetHtml('Worldwide'),
      '/tools/signal-convergence/',
    ));
    assert.doesNotThrow(() => assertDatasetGoogleProperties(
      datasetHtml({ '@type': 'Place', name: 'Norway' }),
      '/countries/',
    ));

    for (const invalidCoverage of [
      { '@type': 'Country', name: 'Norway' },
      { '@type': ['Place', 'Country'], name: 'Norway' },
      [],
    ]) {
      assert.throws(
        () => assertDatasetGoogleProperties(
          datasetHtml(invalidCoverage),
          '/countries/',
        ),
        /spatialCoverage must be Text or exact @type Place/,
      );
    }
  });
});

function assertDataCatalogPresent(html, route) {
  const catalogs = jsonLdObjects(html).filter((entry) => isJsonLdType(entry, 'DataCatalog'));
  assert.ok(catalogs.length > 0, `${route} must emit a DataCatalog JSON-LD node`);
  const catalog = catalogs[0];
  assert.ok(typeof catalog['@id'] === 'string' && catalog['@id'].includes('#data-catalog'), `${route} DataCatalog must use a stable @id`);
  assert.equal(catalog.isAccessibleForFree, true, `${route} DataCatalog must be free`);
  assert.ok(typeof catalog.name === 'string' && catalog.name.trim().length > 0, `${route} DataCatalog must have a name`);
  const CANONICAL_ORG_ROLE = {
    '@id': 'https://www.worldmonitor.app/#organization',
    '@type': 'Organization',
    name: 'World Monitor',
    url: 'https://www.worldmonitor.app/',
  };
  assert.deepEqual(
    catalog.publisher,
    CANONICAL_ORG_ROLE,
    `${route} DataCatalog.publisher must reference the canonical Organization`,
  );
  assert.deepEqual(
    catalog.creator,
    CANONICAL_ORG_ROLE,
    `${route} DataCatalog.creator must reference the canonical Organization`,
  );
  return catalog;
}

// A root JSON-LD node with no `@context` has no vocabulary binding: `@type`
// resolves to nothing, and every schema.org consumer discards the block
// silently rather than erroring. #7491 shipped 62 such blocks across the 31
// CII-covered country pages (found in #7502), which undid the
// Dataset/DataCatalog work from #7379 on exactly the highest-intent pages and
// was invisible to every existing assertion. Nested nodes inherit the root
// context, so only the top-level block of each script tag is checked.
const SCHEMA_ORG_CONTEXT_URLS = new Set(['https://schema.org', 'http://schema.org']);

function jsonLdContextIsResolvable(context) {
  if (typeof context === 'string') {
    return SCHEMA_ORG_CONTEXT_URLS.has(context.replace(/\/$/, ''));
  }
  if (Array.isArray(context)) return context.some((entry) => jsonLdContextIsResolvable(entry));
  if (context && typeof context === 'object') return jsonLdContextIsResolvable(context['@vocab']);
  return false;
}

function assertJsonLdContexts(html, route) {
  const blocks = jsonLdObjects(html);
  assert.ok(blocks.length > 0, `${route} must emit at least one JSON-LD block`);
  for (const [index, block] of blocks.entries()) {
    const type = Array.isArray(block['@type']) ? block['@type'].join('+') : block['@type'];
    const label = block['@id'] || type || `block ${index + 1}`;
    assert.ok(
      jsonLdContextIsResolvable(block['@context']),
      `${route} JSON-LD block ${index + 1} (${label}) must declare a schema.org @context; without one @type binds to no vocabulary and consumers discard the block silently`,
    );
    // A context binds a vocabulary; a type is what binds an entity. Now that
    // the context is stamped unconditionally, a typeless node (a bare `@id`
    // reference, or an array flattened into an object) would sail through the
    // check above while still describing nothing.
    assert.ok(
      typeof type === 'string' && type.length > 0,
      `${route} JSON-LD block ${index + 1} (${label}) must declare an @type; a context without one binds a vocabulary but no entity`,
    );
  }
  // Returned so the caller can prove the sweep actually ran: a loop that never
  // executes is indistinguishable from one where every page passed.
  return blocks.length;
}

// Walk what the build actually wrote, not the manifest's route list. The two
// disagree: `manifest.sections.changelog` reports one route for fourteen
// published pages, so a manifest-driven sweep silently skips the thirteen
// `/reference/changelog/page/N/` pages (229 of 242 covered). A structured-data
// guard that skips pages is the defect class it exists to catch.
function generatedPageRoutes(outDir) {
  const routes = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(outDir, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(relative, entry.name));
      else if (entry.name === 'index.html') routes.push(`/${relative === '.' ? '' : `${relative}/`}`);
    }
  };
  visit('.');
  return routes.sort();
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

function pageLastmod(html) {
  return html.match(/<meta name="lastmod" content="([^"]+)">/)?.[1] ?? null;
}

function assertSourceDerivedTemporalCoverage(dataset, {
  route,
  observationInterval,
  lastmod,
  index = 1,
  publishedDate,
} = {}) {
  const expected = datasetTemporalCoverage(observationInterval);
  assert.equal(
    dataset.temporalCoverage,
    expected,
    `${route} Dataset ${index} temporalCoverage must come from the artifact observation interval`,
  );
  // Equality alone is a tautology: both sides derive from the same value through
  // the same normalizer, so a malformed interval makes both undefined and the
  // assertion passes over a Dataset with no temporalCoverage at all. When the
  // artifact declared an interval, require the Dataset to actually carry it.
  if (observationInterval) {
    assert.match(
      String(dataset.temporalCoverage ?? ''),
      /^\d{4}-\d{2}(-\d{2})?(\/\d{4}-\d{2}(-\d{2})?)?$/,
      `${route} Dataset ${index} declared observation interval ${observationInterval} but published temporalCoverage ${JSON.stringify(dataset.temporalCoverage)}`,
    );
  }
  if (expected && lastmod && expected !== lastmod) {
    assert.notEqual(
      dataset.temporalCoverage,
      lastmod,
      `${route} Dataset ${index} temporalCoverage must not reuse page lastmod`,
    );
  }
  if (dataset.datePublished) {
    assert.equal(
      dataset.datePublished,
      publishedDate ?? expected,
      `${route} Dataset ${index} datePublished must match the published snapshot date`,
    );
  }
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

// The corpus-wide @context sweep is an absence assertion — it stays green if
// the rule is deleted, weakened, or never sees a block. These controls prove it
// still rejects each way the defect can present.
describe('JSON-LD @context guard', () => {
  const ldBlock = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  const route = '/countries/taiwan/';

  it('rejects a top-level block with no @context (the #7502 shape)', () => {
    const html = ldBlock({ '@context': 'https://schema.org', '@type': 'WebPage' })
      + ldBlock({ '@type': 'Dataset', '@id': 'https://www.worldmonitor.app/countries/taiwan/#cii-dataset' });
    assert.throws(
      () => assertJsonLdContexts(html, route),
      /block 2 \(https:\/\/www\.worldmonitor\.app\/countries\/taiwan\/#cii-dataset\) must declare a schema\.org @context/,
    );
  });

  it('rejects a top-level block whose @context resolves to a non-schema.org vocabulary', () => {
    const html = ldBlock({ '@context': 'https://example.invalid/vocab', '@type': 'Dataset' });
    assert.throws(() => assertJsonLdContexts(html, route), /must declare a schema\.org @context/);
  });

  it('rejects a block that binds a vocabulary but no entity', () => {
    const html = ldBlock({ '@context': 'https://schema.org', '@id': 'https://www.worldmonitor.app/countries/taiwan/#cii-dataset' });
    assert.throws(() => assertJsonLdContexts(html, route), /must declare an @type/);
  });

  it('sees a block whose open tag carries attributes', () => {
    // A bare-literal tag match would return zero blocks here and pass by
    // vacuity if the "at least one block" floor were ever relaxed.
    const html = '<script type="application/ld+json" nonce="wm-static-bootstrap">'
      + JSON.stringify({ '@type': 'Dataset' })
      + '</script>';
    assert.throws(() => assertJsonLdContexts(html, route), /must declare a schema\.org @context/);
  });

  it('rejects a page that emits no JSON-LD at all', () => {
    assert.throws(() => assertJsonLdContexts('<html><body>no structured data</body></html>', route), /must emit at least one JSON-LD block/);
  });

  it('stamps a missing or unusable @context and preserves a deliberate one', () => {
    // The stamp is what makes the defect unreproducible, so both branches are
    // pinned: forgetting the key gets it back, and choosing a vocabulary keeps
    // it. `null`/`''` count as forgetting -- they bind no vocabulary either.
    assert.deepEqual(
      withSchemaContext({ '@type': 'Dataset', name: 'CII' }),
      { '@context': 'https://schema.org', '@type': 'Dataset', name: 'CII' },
    );
    for (const unusable of [null, '', undefined]) {
      assert.equal(
        withSchemaContext({ '@context': unusable, '@type': 'Dataset' })['@context'],
        'https://schema.org',
        `a ${JSON.stringify(unusable)} @context binds no vocabulary and must be replaced`,
      );
    }
    const deliberate = { '@context': 'https://example.invalid/vocab', '@type': 'Dataset' };
    assert.deepEqual(withSchemaContext(deliberate), deliberate);
    assert.equal(withSchemaContext(null), null);
  });

  it('accepts schema.org string, array, and @vocab contexts', () => {
    assert.doesNotThrow(() => assertJsonLdContexts(
      ldBlock({ '@context': 'https://schema.org', '@type': 'Dataset' })
      + ldBlock({ '@context': 'https://schema.org/', '@type': 'Dataset' })
      + ldBlock({ '@context': ['https://schema.org', { wm: 'https://www.worldmonitor.app/#' }], '@type': 'Dataset' })
      + ldBlock({ '@context': { '@vocab': 'https://schema.org/' }, '@type': 'Dataset' }),
      route,
    ));
  });
});

describe('crawlable corpus generator', () => {
  it('keeps decimal values inside one masked sentence', () => {
    assert.deepEqual(
      maskedSentences('Tuvalu reports 12.5% coverage. The inventory is partial.', ['Tuvalu']),
      ['<country> reports <number> coverage', 'the inventory is partial'],
    );
  });

  it('rejects a microstate coverage story when its cited source gap becomes observed', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const tuvalu = structuredClone(data.countries.find(({ code }) => code === 'TV'));
    const debtDimension = tuvalu.domains
      .flatMap(({ dimensions }) => dimensions)
      .find(({ id }) => id === 'externalDebtCoverage');
    assert.ok(debtDimension, 'Tuvalu must include the external debt dimension');
    debtDimension.coverage = 1;
    debtDimension.imputationClass = '';

    assert.throws(
      () => buildMicrostateCoverageStory({
        country: tuvalu,
        capturedAt: '2026-08-29',
        methodologyFormula: 'World Monitor CRI v3',
      }),
      /TV coverage story cites dimensions that are no longer coverage gaps: externalDebtCoverage/,
    );
  });

  it('rejects a below-floor microstate story when displayed coverage reaches the floor', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const tuvalu = structuredClone(data.countries.find(({ code }) => code === 'TV'));
    tuvalu.dimensionCoverage = 0.65;

    assert.throws(
      () => buildMicrostateCoverageStory({
        country: tuvalu,
        capturedAt: '2026-08-29',
        methodologyFormula: 'World Monitor CRI v3',
      }),
      /TV coverage story requires displayed coverage below the 65% publication floor/,
    );
  });

  it('rejects a microstate story when a cited gap changes imputation class', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const sanMarino = structuredClone(data.countries.find(({ code }) => code === 'SM'));
    const cohesionDimension = sanMarino.domains
      .flatMap(({ dimensions }) => dimensions)
      .find(({ id }) => id === 'socialCohesion');
    assert.ok(cohesionDimension, 'San Marino must include the social cohesion dimension');
    cohesionDimension.imputationClass = 'unmonitored';

    assert.throws(
      () => buildMicrostateCoverageStory({
        country: sanMarino,
        capturedAt: '2026-08-29',
        methodologyFormula: 'World Monitor CRI v3',
      }),
      /SM coverage story has stale source-gap claims: socialCohesion: imputation class "unmonitored" \(expected "source-failure"\)/,
    );
  });

  it('rejects a microstate story when a cited provider family changes', () => {
    assert.throws(
      () => buildMicrostateCoverageStoryContent({
        code: 'MO',
        coveragePercent: 61,
        coverageFloor: 65,
        gaps: [
          { id: 'healthPublicService', imputationClass: '', sources: ['WHO'] },
          { id: 'informationCognitive', imputationClass: '', sources: ['Different provider'] },
          { id: 'externalDebtCoverage', imputationClass: 'unmonitored', sources: ['World Bank'] },
        ],
      }),
      /MO coverage story has stale source-gap claims: informationCognitive: sources \["Different provider"\] \(expected \["Reporters Without Borders"\]\)/,
    );
  });

  it('derives the San Marino gap count while preserving cited-gap subset validation', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const baseline = data.countries.find(({ code }) => code === 'SM');
    const buildStory = (country) => buildMicrostateCoverageStory({
      country,
      capturedAt: '2026-08-29',
      methodologyFormula: 'World Monitor CRI v3',
    });
    const baselineGapCount = Number(
      buildStory(structuredClone(baseline)).introduction.match(/yet (\d+) dimension gaps/)?.[1],
    );
    assert.ok(
      Number.isInteger(baselineGapCount) && baselineGapCount > 0,
      'San Marino story must report its current gap count',
    );

    const sanMarino = structuredClone(baseline);
    const healthDimension = sanMarino.domains
      .flatMap(({ dimensions }) => dimensions)
      .find(({ id }) => id === 'healthPublicService');
    assert.ok(healthDimension, 'San Marino must include the health dimension');
    healthDimension.coverage = 0;

    assert.match(
      buildStory(sanMarino).introduction,
      new RegExp(`yet ${baselineGapCount + 1} dimension gaps`),
    );
  });

  it('rejects the Macau story when a cited observed dimension loses its reading', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const macau = structuredClone(data.countries.find(({ code }) => code === 'MO'));
    const tradeDimension = macau.domains
      .flatMap(({ dimensions }) => dimensions)
      .find(({ id }) => id === 'tradePolicy');
    assert.ok(tradeDimension, 'Macau must include the trade policy dimension');
    tradeDimension.coverage = 0;

    assert.throws(
      () => buildMicrostateCoverageStory({
        country: macau,
        capturedAt: '2026-08-29',
        methodologyFormula: 'World Monitor CRI v3',
      }),
      /MO coverage story cites dimensions that no longer have observed readings: tradePolicy/,
    );
  });

  it('uses current crisis membership in a microstate coverage story', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const tuvalu = structuredClone(data.countries.find(({ code }) => code === 'TV'));
    tuvalu.crisisMemberships = [{ slug: 'test-tracker', shortTitle: 'Test tracker' }];
    const story = buildMicrostateCoverageStory({
      country: tuvalu,
      capturedAt: '2026-08-29',
      methodologyFormula: 'World Monitor CRI v3',
    });

    const analysis = renderCountryAnalysis({
      country: tuvalu,
      capturedAt: '2026-08-29',
      methodologyFormula: 'World Monitor CRI v3',
      rankedCount: 0,
    });

    assert.match(story.crisis, /The crisis registry links Tuvalu to Test tracker/);
    assert.doesNotMatch(story.crisis, /No fixed crawlable crisis tracker has Tuvalu in scope/);
    assert.match(analysis.html, /The crisis registry links Tuvalu to <a href="\/crises\/test-tracker\/">Test tracker<\/a>/);
    assert.doesNotMatch(analysis.html, /No fixed crawlable crisis tracker has Tuvalu in scope/);
  });

  it('formats observed readings in a microstate coverage story', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const sanMarino = data.countries.find(({ code }) => code === 'SM');
    const story = buildMicrostateCoverageStory({
      country: sanMarino,
      capturedAt: '2026-08-29',
      methodologyFormula: 'World Monitor CRI v3',
    });

    assert.match(story.evidence, /Liquid-reserve adequacy \d+(?:\.\d+)? \(\d+%\)/);
  });

  it('rejects a similarity audit when a country page has no main content', () => {
    const corpusDir = mkdtempSync(join(tmpdir(), 'wm-microstate-audit-'));
    try {
      for (const slug of ['japan', 'germany', 'tuvalu', 'macau', 'san-marino']) {
        const countryDir = join(corpusDir, 'countries', slug);
        mkdirSync(countryDir, { recursive: true });
        const body = slug === 'tuvalu'
          ? '<article>Tuvalu content outside the main element.</article>'
          : `<main>${slug} has a complete country page for this audit fixture.</main>`;
        writeFileSync(join(countryDir, 'index.html'), `<!doctype html><html><body>${body}</body></html>`);
      }
      writeRankedAuditSnapshot(corpusDir, { code: 'JP', slug: 'japan' });
      writeRankedAuditSnapshot(corpusDir, { code: 'DE', slug: 'germany', rank: 2 });

      assert.throws(
        () => auditMicrostateCorpusSimilarity({ corpusDir }),
        /\/countries\/tuvalu\/ must contain non-empty <main> content/,
      );
      writeFileSync(
        join(corpusDir, 'countries/tuvalu/index.html'),
        '<!doctype html><html><body><main>Only four words here.</main></body></html>',
      );
      assert.throws(
        () => auditMicrostateCorpusSimilarity({ corpusDir }),
        /\/countries\/tuvalu\/ must contain enough <main> content for a 5-word shingle/,
      );
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  it('fails the similarity audit when the microstate pages converge', () => {
    const corpusDir = mkdtempSync(join(tmpdir(), 'wm-microstate-converge-'));
    try {
      const floorBodies = {
        japan: 'Japan publishes a complete ranked resilience profile with observed inputs across every dimension. The island economy reports fiscal, trade, energy and health series through standard providers each month.',
        germany: 'German federal statistics describe industrial output, border management and reserve adequacy in distinct vocabulary, so this ranked fixture shares almost no five-word phrases with its neighbour.',
      };
      for (const [slug, body] of Object.entries(floorBodies)) {
        const countryDir = join(corpusDir, 'countries', slug);
        mkdirSync(countryDir, { recursive: true });
        writeFileSync(join(countryDir, 'index.html'), `<!doctype html><html><body><main>${body}</main></body></html>`);
      }
      writeRankedAuditSnapshot(corpusDir, { code: 'JP', slug: 'japan' });
      writeRankedAuditSnapshot(corpusDir, { code: 'DE', slug: 'germany', rank: 2 });
      const cohort = [
        ['tuvalu', 'Tuvalu', 62],
        ['macau', 'Macau', 61],
        ['san-marino', 'San Marino', 64],
      ];
      for (const [slug, name, coverage] of cohort) {
        const countryDir = join(corpusDir, 'countries', slug);
        mkdirSync(countryDir, { recursive: true });
        writeFileSync(
          join(countryDir, 'index.html'),
          `<!doctype html><html><body><main>${name} resilience evidence. ${name} reaches ${coverage}% coverage and stays below the publication floor. The snapshot lists observed readings for ${name} without an overall score.</main></body></html>`,
        );
      }

      const result = auditMicrostateCorpusSimilarity({ corpusDir });
      assert.ok(result.floor.jaccard < 0.1, `ranked floor fixture must stay dissimilar, got ${result.floor.jaccard}`);
      assert.ok(
        result.pairs.every((pair) => pair.jaccard > result.threshold),
        'near-identical microstate pages must exceed the ranked-page floor threshold',
      );
      assert.ok(result.maskedSentenceSharing.share >= 0.4, 'templated pages must trip the masked-sentence limit');
      assert.equal(
        result.maskedSentenceSharing.sharedCount,
        result.maskedSentenceSharing.sentenceCounts.TV,
        'every masked Tuvalu sentence must count as shared when the pages are templated',
      );
    } finally {
      rmSync(corpusDir, { recursive: true, force: true });
    }
  });

  const invalidFloorSnapshots = [
    ['a mismatched country code', { code: 'FR' }],
    ['headlineEligible false', { headlineEligible: false }],
    ['a non-integer rank', { rank: 2.5 }],
    ['a rank below 1', { rank: 0 }],
    ['a non-finite overall score', { overallScore: null }],
  ];
  for (const [label, override] of invalidFloorSnapshots) {
    it(`rejects a similarity floor page with ${label}`, () => {
      const corpusDir = mkdtempSync(join(tmpdir(), 'wm-microstate-floor-'));
      try {
        for (const slug of ['japan', 'germany']) {
          const countryDir = join(corpusDir, 'countries', slug);
          mkdirSync(countryDir, { recursive: true });
          writeFileSync(
            join(countryDir, 'index.html'),
            `<!doctype html><html><body><main>${slug} has a complete ranked country page for the audit floor.</main></body></html>`,
          );
        }
        writeRankedAuditSnapshot(corpusDir, { code: 'JP', slug: 'japan' });
        writeRankedAuditSnapshot(corpusDir, { code: 'DE', slug: 'germany', rank: 2, ...override });

        assert.throws(
          () => auditMicrostateCorpusSimilarity({ corpusDir }),
          /\/countries\/germany\/ must be a headline-eligible ranked page with a published overall score/,
        );
      } finally {
        rmSync(corpusDir, { recursive: true, force: true });
      }
    });
  }

  it('requires the exact shared Tier-1 country set for CII publication', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const livePulse = structuredClone(data.livePulse);
    livePulse.countries.NO = { ...livePulse.countries.US };
    delete livePulse.countries.US;

    assert.throws(
      () => buildCiiRankingEntries(data.countries, livePulse),
      /missing US; unexpected NO/,
    );
  });

  it('rejects a chokepoint pulse key that is not in the registry', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    assert.doesNotThrow(
      () => buildChokepointHubRows(data.chokepoints, data.livePulse),
      'the committed pulse must match the registry exactly',
    );
    const livePulse = structuredClone(data.livePulse);
    const [firstChokepoint] = data.chokepoints;
    livePulse.chokepoints.obsolete_strait = { ...livePulse.chokepoints[firstChokepoint.id] };

    assert.throws(
      () => buildChokepointHubRows(data.chokepoints, livePulse),
      /unexpected obsolete_strait/,
    );
    const missingPulse = structuredClone(data.livePulse);
    delete missingPulse.chokepoints[firstChokepoint.id];
    assert.throws(
      () => buildChokepointHubRows(data.chokepoints, missingPulse),
      new RegExp(`missing ${firstChokepoint.id}`),
    );
  });

  it('emits temporalCoverage only from a committed observation interval', () => {
    assert.equal(datasetTemporalCoverage('2026-05-28'), '2026-05-28');
    assert.equal(datasetTemporalCoverage('2026-01-01/2026-01-31'), '2026-01-01/2026-01-31');
    assert.equal(datasetTemporalCoverage(undefined), undefined);
    assert.equal(datasetTemporalCoverage(''), undefined);
    assert.equal(datasetTemporalCoverage('2026-08-29T00:00:00Z'), undefined);
    assert.equal(datasetTemporalCoverage('schema-edit'), undefined);
  });

  it('uses one observed-value contract for every numeric page family', () => {
    const cases = [
      ['country zero coverage', 50, { coverage: 0 }, false],
      ['country not-applicable zero', 0, { coverage: 1, evidenceState: 'not-applicable' }, false],
      ['country fallback midpoint', 50, { coverage: 0.3, evidenceState: 'unmonitored' }, false],
      ['country source failure score', 61, { coverage: 0.21, evidenceState: 'source-failure' }, false],
      ['country stable-absence imputed score', 88, { coverage: 0.42, evidenceState: 'stable-absence' }, false],
      ['country observed zero', 0, { coverage: 1 }, true],
      ['chokepoint observed zero', '0', { coverage: true }, true],
      ['crisis observed zero', 0, { coverage: true }, true],
      ['tool observed score', 87, { coverage: true }, true],
    ];

    for (const [label, value, evidence, expected] of cases) {
      assert.equal(hasObservedValue(value, evidence), expected, label);
    }

    // The predicate must reject the WHOLE imputation vocabulary, not an enumerated
    // subset of it. proto/worldmonitor/resilience/v1/resilience.proto documents the
    // four-class union; a class is set only when observedWeight === 0, so every
    // non-empty class means "no observation" no matter what score accompanies it.
    for (const evidenceState of ['stable-absence', 'unmonitored', 'source-failure', 'not-applicable']) {
      assert.equal(
        hasObservedValue(50, { coverage: 1, evidenceState }),
        false,
        `${evidenceState} is fully imputed and must never publish as a measured score`,
      );
    }
    assert.equal(
      hasObservedValue(50, { coverage: 1, evidenceState: 'some-future-class' }),
      false,
      'an unrecognised imputation class must fail closed, not publish',
    );
  });

  it('never ranks a withheld pillar or domain as weakest or strongest', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const source = data.countries.find((entry) => Number.isInteger(entry.rank)
      && (entry.pillars?.length ?? 0) >= 3
      && (entry.domains?.length ?? 0) >= 6);
    assert.ok(source, 'need a ranked country with full pillar and domain detail');

    const render = (country) => renderCountryAnalysis({
      country,
      capturedAt: data.resilience.capturedAt,
      methodologyFormula: 'test-formula',
      rankedCount: 170,
    });

    // Baseline: with everything observed the published wording is unchanged.
    const baseline = render(structuredClone(source));
    assert.match(baseline.html, /is the weakest pillar at \d/);
    assert.match(baseline.html, /Top domain: /);

    // Now withhold the lowest-scoring pillar and blank out one whole domain.
    const degraded = structuredClone(source);
    const lowestPillar = [...degraded.pillars].sort((a, b) => a.score - b.score)[0];
    lowestPillar.coverage = 0;
    const lowestDomain = [...degraded.domains].sort((a, b) => a.score - b.score)[0];
    for (const dimension of lowestDomain.dimensions) dimension.imputationClass = 'unmonitored';
    const { html } = render(degraded);

    // The whole point: no claim may name an entry whose score renders as a dash.
    assert.doesNotMatch(html, /is the weakest pillar at —/, 'must not call a withheld pillar the weakest');
    assert.doesNotMatch(html, /is strongest at —/, 'must not call a withheld pillar the strongest');
    assert.doesNotMatch(html, /is the lowest of the six underlying domains at —/, 'must not call a withheld domain the lowest');
    assert.doesNotMatch(html, /Top domain: [^.]*, —\./, 'must not report a withheld domain as the top domain');
    // It still degrades to a statement, not silence.
    assert.match(html, /Pillars with an observed reading, weakest first:/);
  });

  it('dates chokepoint observations without git history', () => {
    const gitless = resolveChokepointObservation();
    assert.equal(gitless.capturedAt, '2026-04-09');
    assert.equal(gitless.volumeObservedAt, '2026-03-14');
    const newerRegistry = resolveChokepointObservation({
      registryGitLastmod: '2026-05-01',
    });
    assert.equal(newerRegistry.capturedAt, '2026-05-01');
    assert.equal(newerRegistry.volumeObservedAt, '2026-03-14');
  });

  it('rejects invalid chokepoint hub status and congestion before publication', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    const [firstChokepoint] = data.chokepoints;
    const validPulse = data.livePulse.chokepoints[firstChokepoint.id];
    assert.ok(validPulse, 'committed pulse must include the first registry chokepoint');
    assert.equal(
      buildChokepointHubRows(data.chokepoints, {
        ...data.livePulse,
        chokepoints: {
          ...data.livePulse.chokepoints,
          [firstChokepoint.id]: { ...validPulse, congestion: 'Elevated', aisSnapshotAvailable: true },
        },
      }).find((row) => row.chokepoint.id === firstChokepoint.id)?.congestion,
      'Elevated',
    );
    assert.equal(
      buildChokepointHubRows(data.chokepoints, {
        ...data.livePulse,
        chokepoints: {
          ...data.livePulse.chokepoints,
          [firstChokepoint.id]: { ...validPulse, congestion: 'Not reported', aisSnapshotAvailable: true },
        },
      }).find((row) => row.chokepoint.id === firstChokepoint.id)?.congestion,
      'Not reported',
    );
    assert.equal(
      buildChokepointHubRows(data.chokepoints, data.livePulse)
        .find((row) => row.chokepoint.id === firstChokepoint.id)?.congestion,
      'Not reported',
      'legacy pulses without the AIS availability flag must fail closed',
    );

    for (const [label, pulse] of [
      ['object status', { ...validPulse, status: { label: 'Yellow' } }],
      ['numeric status', { ...validPulse, status: 42 }],
      ['unknown status', { ...validPulse, status: 'Orange' }],
      ['lowercase status', { ...validPulse, status: 'yellow' }],
      ['status below score band', { ...validPulse, disruptionScore: '70', status: 'Green' }],
      ['status above score band', { ...validPulse, disruptionScore: '5', status: 'Red' }],
      ['status in adjacent score band', { ...validPulse, disruptionScore: '19', status: 'Yellow' }],
      ['object congestion', { ...validPulse, congestion: { level: 'Normal' }, aisSnapshotAvailable: true }],
      ['numeric congestion', { ...validPulse, congestion: 3, aisSnapshotAvailable: true }],
      ['unknown congestion', { ...validPulse, congestion: 'Severe', aisSnapshotAvailable: true }],
      ['lowercase congestion', { ...validPulse, congestion: 'normal', aisSnapshotAvailable: true }],
    ]) {
      const invalidLivePulse = {
        ...data.livePulse,
        chokepoints: {
          ...data.livePulse.chokepoints,
          [firstChokepoint.id]: pulse,
        },
      };
      assert.throws(
        () => buildChokepointHubRows(data.chokepoints, invalidLivePulse),
        new RegExp(`Chokepoint hub pulse is invalid for ${firstChokepoint.id}`),
        `${label} must fail the chokepoint hub build`,
      );
    }
  });

  it('tracks every material chokepoint page input in its lastmod clock', () => {
    assert.deepEqual(CHOKEPOINT_PAGE_LASTMOD_PATHS, [
      'src/config/chokepoint-registry.ts',
      'src/config/trade-routes.ts',
      'scripts/chokepoint-page-content.mjs',
      'scripts/chokepoint-eia-baselines.mjs',
    ]);
  });

  // laterDate is imported rather than re-implemented, so the family-clock
  // assertions below share one implementation with the builder. These literal
  // cases are what keeps that from being circular: a regression in laterDate
  // itself fails here, before it can agree with itself elsewhere.
  it('folds a set of dates to the latest valid one', () => {
    assert.equal(laterDate('2026-01-02', '2026-03-04', '2026-02-03'), '2026-03-04');
    assert.equal(laterDate('2026-03-04', '2026-01-02'), '2026-03-04');
    assert.equal(laterDate('2026-01-02', null, undefined), '2026-01-02');
    assert.equal(laterDate('2026-01-02', 'not-a-date', '2026-01-02T05:00:00Z'), '2026-01-02');
    assert.equal(laterDate('2026-01-02', '2026-01-02'), '2026-01-02');
    assert.equal(laterDate(null, undefined, ''), null);
    assert.equal(laterDate(), null);
  });

  it('picks the newest live-pulse snapshot among several candidates', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'wm-pulse-resolve-'));
    try {
      const snapshotDir = join(fixtureRoot, 'docs', 'snapshots');
      mkdirSync(snapshotDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const sections = {
        countries: [], chokepoints: [], crises: [], signalConvergence: { capturedAt: today },
      };
      for (const capturedAt of ['2026-01-05', today, '2026-01-09']) {
        writeFileSync(
          join(snapshotDir, `crawlable-live-pulse-${capturedAt}.json`),
          JSON.stringify({ capturedAt, ...sections }),
        );
      }
      assert.equal(
        resolveLatestLivePulseSnapshotPath(fixtureRoot),
        join('docs', 'snapshots', `crawlable-live-pulse-${today}.json`),
        'the resolver must pick the highest-dated snapshot, not the first or last written',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // The refresh cron and the staleness ceiling are one contract. The ceiling
  // was 45 days against a monthly cron, which let pages headed "Approx.
  // 24-hour movement" ship on data up to six weeks old (#7530). Assert the two
  // still agree so relaxing one alone cannot silently reopen that gap, and that
  // the branch key advances as fast as the schedule does — a month-keyed branch
  // under a weekly cron would find week 1's PR and skip weeks 2-4.
  it('keeps the pulse staleness ceiling within reach of the refresh cron', () => {
    const workflow = readFileSync(
      resolve(repoRoot, '.github/workflows/crawlable-pulse-refresh.yml'),
      'utf8',
    );
    const cron = workflow.match(/^\s*- cron: '([^']+)'/m)?.[1];
    assert.ok(cron, 'the pulse refresh workflow must declare a cron schedule');

    const [, , dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
    let cadenceDays;
    if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') cadenceDays = 7;
    else if (dayOfMonth !== '*' && month === '*') cadenceDays = 31;
    else if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') cadenceDays = 1;
    else assert.fail(`unrecognised pulse refresh cadence: ${cron}`);

    assert.ok(
      MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS > cadenceDays,
      `the ${MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS}-day ceiling must exceed the ${cadenceDays}-day refresh cadence, or a healthy refresh cycle reds the build`,
    );
    // No upper bound asserted yet: the ceiling is deliberately still 45 while
    // the chokepoint upstream that every freeze depends on is down, so a
    // `<= cadence * 2` assertion would red the suite for a documented reason.
    // Tighten this alongside the constant once a refresh has landed.

    if (cadenceDays <= 7) {
      assert.match(
        workflow,
        /period=\$\(date -u \+%G-W%V\)/,
        'a weekly-or-faster cron needs a branch key that advances weekly; a %Y-%m key makes runs 2-4 of a month no-op',
      );
    }
  });

  // The corpus fixture has no untruncated unranked country, so the "omit the
  // note when nothing is omitted" branch is unobservable end-to-end. Pin it
  // directly: a note that appears when nothing is hidden would tell a reader
  // evidence is missing when it is not.
  it('describes the inventory scope only when rows are actually omitted', () => {
    const dimension = (id, coverage) => ({ id, coverage });
    const country = (coverages) => ({
      domains: [{ id: 'd', dimensions: coverages.map((c, i) => dimension(`dim${i}`, c)) }],
    });

    assert.equal(describeInventoryScope(country([0.2, 0.4, 1]), 3), null, 'nothing omitted');
    assert.equal(describeInventoryScope(country([0.2, 0.4, 1]), 4), null, 'shown exceeds total');
    assert.equal(
      describeInventoryScope(country([0.2, 0.4, 1, 1]), 2),
      'Showing 2 of 4 active dimensions, lowest coverage first; 2 more at full coverage.',
    );
    assert.equal(
      describeInventoryScope(country([0.2, 0.4, 0.9]), 2),
      'Showing 2 of 3 active dimensions, lowest coverage first.',
      'no full-coverage clause when there is nothing at full coverage',
    );
  });

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
            lowConfidence: true,
          }),
        },
        {
          name: 'D'.repeat(length),
          description: countryMetaDescription({
            name: 'D'.repeat(length),
            rank: null,
            rankedCount: 999_999,
            lowConfidence: false,
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
      const clock = await loadCorpusData({ rootDir: repoRoot });
      const countriesLastmod = clock.lastmod.countries;
      const ciiCountriesLastmod = clock.lastmod.ciiCountries;
      const ciiIndexLastmod = clock.lastmod.countryInstabilityIndex;
      const manifest = await buildCorpus({
        rootDir: repoRoot,
        outDir,
        baseUrl: 'https://www.worldmonitor.app',
      });

      assert.equal(manifest.sections.countries.count, 196);
      assert.equal(manifest.sections.countryInstabilityIndex.count, 1);
      assert.equal(manifest.sections.chokepoints.count, 13);
      assert.equal(manifest.sections.crises.count, 4);
      assert.equal(manifest.sections.tools.count, 3);
      assert.equal(manifest.sections.research.count, 1);
      assert.equal(manifest.sections.useCases.count, 3);
      assert.equal(manifest.sections.sources.count, 1);
      assert.equal(manifest.generatorContentVersion, '2026-09-01');
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
        manifest.sections.countryInstabilityIndex.index,
        ...manifest.sections.countryInstabilityIndex.routes,
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
      assert.equal(
        manifest.sections.changelog.routes.length,
        1,
        'sitemap changelog inventory must only include the index',
      );
      assert.ok(
        manifest.sections.changelog.paginationRoutes.length >= 1,
        'generator must still emit changelog pagination routes',
      );
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

      // Chokepoint pages carry a "Template revision <date>" stamp that
      // self-describes as a methodology-revision stamp, yet pointed nowhere:
      // the #7503 withdrawal of three derived fields across all 13 pages was a
      // material revision no reader could trace (#7530). Both families that
      // publish a revision stamp must link the log.
      for (const route of [
        ...manifest.sections.countries.routes,
        ...manifest.sections.chokepoints.routes,
      ]) {
        const html = read(outDir, `${route.slice(1)}index.html`);
        assert.match(
          html,
          /href="\/docs\/corrections"/,
          `${route} must link the corrections log`,
        );
        assert.doesNotMatch(
          html,
          /Post-P1-1/,
          `${route} must not publish ticket jargon`,
        );
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
        manifest.sections.countryInstabilityIndex.index,
        ...manifest.sections.countries.routes,
        ...manifest.sections.chokepoints.routes,
        ...manifest.sections.crises.routes,
        ...manifest.sections.research.routes,
      ]);
      const catalogLinkedRoutes = new Set([
        manifest.sections.countryInstabilityIndex.index,
        ...manifest.sections.countries.routes,
        ...manifest.sections.chokepoints.routes,
        ...manifest.sections.crises.routes,
        ...manifest.sections.research.routes,
      ]);
      // The hub asserted four scoring inputs flatly — "combines active
      // navigational warnings, AIS signal disruptions, congestion, and transit
      // counts" — while the detail pages it indexes withheld three of them, so
      // the entry point contradicted the corpus (#7530). The answer must state
      // the coverage this snapshot actually has.
      {
        const hub = read(outDir, 'chokepoints/index.html');
        const congestionPublished = clock.chokepoints
          .filter((chokepoint) => (
            clock.livePulse.chokepoints?.[chokepoint.id]?.aisSnapshotAvailable === true
          )).length;
        const total = clock.chokepoints.length;
        const expected = congestionPublished === total
          ? `all ${total} waterways publish an AIS congestion reading`
          : congestionPublished === 0
            ? `none of the ${total} waterways publish an AIS congestion reading`
            : `${congestionPublished} of ${total} waterways publish an AIS congestion reading`;
        assert.ok(
          hub.includes(expected),
          `the chokepoint hub must state its real AIS congestion coverage; expected "${expected}"`,
        );
        assert.match(
          hub,
          /withheld rather than published as a measured zero or a calm reading/,
          'the hub must state the withholding rule it shares with the detail pages',
        );
      }

      // The unranked inventory is weakest-first and capped at 12, so a country
      // like Tuvalu showed its 12 worst dimensions out of 23 with no note —
      // the 7 at full coverage never enter the pool and 2 more are dropped by
      // the cap, so the page read as uniformly poor coverage (#7530). Whenever
      // rows are omitted the page must say so, and the numbers must be the
      // page's own, not a restatement of the cap.
      {
        let checkedTruncated = 0;
        for (const route of manifest.sections.countries.routes) {
          const html = read(outDir, `${route.slice(1)}index.html`);
          const section = html.match(
            /<h3>Dimension evidence inventory<\/h3>([\s\S]*?)<\/ul>/,
          );
          if (!section) continue;
          const shown = (section[1].match(/<li>/g) || []).length;
          const note = section[1].match(
            /data-inventory-scope>Showing (\d+) of (\d+) active dimensions, lowest coverage first/,
          );
          if (!note) continue;
          checkedTruncated += 1;
          assert.equal(
            Number(note[1]),
            shown,
            `${route} inventory note claims ${note[1]} rows but renders ${shown}`,
          );
          assert.ok(
            Number(note[2]) > shown,
            `${route} claims to omit dimensions but its total (${note[2]}) is not greater than the ${shown} shown`,
          );
        }
        assert.ok(
          checkedTruncated > 0,
          'expected at least one country page whose dimension inventory is truncated',
        );
      }

      // No page may describe an absence in prose. "No additional status note
      // was supplied." was frozen into the snapshot for chokepoints whose
      // upstream sent no note and rendered as real body text in <main> on 7 of
      // 13 pages — often the only sentence the live section contributed
      // (#7530). Absence now has no page representation: the paragraph is
      // emitted `hidden` and empty.
      for (const route of manifest.sections.chokepoints.routes) {
        const html = read(outDir, `${route.slice(1)}index.html`);
        assert.doesNotMatch(
          html,
          /No additional status note was supplied/,
          `${route} must not publish a placeholder sentence in place of an absent status note`,
        );
        const paragraph = html.match(/<p data-chokepoint-description[^>]*>([\s\S]*?)<\/p>/);
        assert.ok(paragraph, `${route} must carry the status-note paragraph`);
        if (!paragraph[1].trim()) {
          assert.match(
            paragraph[0],
            /<p data-chokepoint-description[^>]*\bhidden\b/,
            `${route} has no status note, so its paragraph must be hidden rather than an empty <p>`,
          );
        }
      }

      const countryObservationRoutes = new Set(manifest.sections.countries.routes);
      const liveObservationRoutes = new Set(manifest.sections.chokepoints.routes);
      const crisisObservationRoutes = new Set(manifest.sections.crises.routes);
      // #7502: sweep every page the build wrote, including the paginated
      // changelog pages the manifest's route list omits.
      const writtenRoutes = generatedPageRoutes(outDir);
      // Membership, not count: a walk that returned the right NUMBER of wrong
      // pages would satisfy a `>=` comparison while leaving real routes unswept.
      const sweptRoutes = new Set(writtenRoutes);
      const missedRoutes = [...generatedRoutes].filter((route) => !sweptRoutes.has(route));
      assert.deepEqual(
        missedRoutes,
        [],
        `the @context sweep skipped manifest routes: ${missedRoutes.join(', ')}`,
      );
      let sweptPages = 0;
      let sweptBlocks = 0;
      for (const route of writtenRoutes) {
        sweptBlocks += assertJsonLdContexts(read(outDir, `${route.slice(1)}index.html`), route);
        sweptPages += 1;
      }
      // Without this the sweep is an absence assertion that also passes when it
      // is unwired: delete the loop above and every per-page check silently
      // stops running. Tallying makes the wiring itself falsifiable.
      assert.equal(
        sweptPages,
        writtenRoutes.length,
        `the @context sweep must inspect every written page (swept ${sweptPages} of ${writtenRoutes.length})`,
      );
      assert.ok(
        sweptBlocks >= sweptPages * 3,
        `every corpus page carries at least a page node, DataCatalog and BreadcrumbList (swept ${sweptBlocks} blocks across ${sweptPages} pages)`,
      );

      for (const route of generatedRoutes) {
        const html = read(outDir, `${route.slice(1)}index.html`);
        assertDatasetGoogleProperties(
          html,
          route,
          {
            requireDataset: datasetRequiredRoutes.has(route),
            requireCatalogLinkage: catalogLinkedRoutes.has(route),
          },
        );
        if (catalogLinkedRoutes.has(route)) {
          assertDataCatalogPresent(html, route);
        }
        if (countryObservationRoutes.has(route)) {
          const datasets = jsonLdObjects(html).flatMap((entry) => collectDatasets(entry));
          for (const [index, dataset] of datasets.entries()) {
            const isCiiDataset = dataset['@id']?.endsWith('#cii-dataset');
            assertSourceDerivedTemporalCoverage(dataset, {
              route,
              observationInterval: isCiiDataset
                ? manifest.sections.countryInstabilityIndex.sourceCapturedAt
                : manifest.sections.countries.sourceCapturedAt,
              lastmod: pageLastmod(html),
              index: index + 1,
            });
          }
        }
        if (liveObservationRoutes.has(route)) {
          const reference = JSON.parse(read(outDir, `${route.slice(1)}reference.json`));
          const datasets = jsonLdObjects(html).flatMap((entry) => collectDatasets(entry));
          for (const [index, dataset] of datasets.entries()) {
            assertSourceDerivedTemporalCoverage(dataset, {
              route,
              observationInterval: reference.capturedAt,
              lastmod: pageLastmod(html),
              index: index + 1,
            });
          }
        }
        if (crisisObservationRoutes.has(route)) {
          const tracker = JSON.parse(read(outDir, `${route.slice(1)}tracker.json`));
          const datasets = jsonLdObjects(html).flatMap((entry) => collectDatasets(entry));
          for (const [index, dataset] of datasets.entries()) {
            assertSourceDerivedTemporalCoverage(dataset, {
              route,
              observationInterval: tracker.maintainedPulse?.referencePeriod,
              publishedDate: manifest.sections.crises.sourceCapturedAt,
              lastmod: pageLastmod(html),
              index: index + 1,
            });
          }
        }
        assertDatasetDownloadsAreGenerated(html, outDir, route);
      }
      assertDataCatalogPresent(read(outDir, 'countries/index.html'), '/countries/');
      assertDataCatalogPresent(
        read(outDir, 'country-instability-index/index.html'),
        '/country-instability-index/',
      );
      assertDataCatalogPresent(read(outDir, 'chokepoints/index.html'), '/chokepoints/');
      assertDataCatalogPresent(read(outDir, 'crises/index.html'), '/crises/');
      assertDataCatalogPresent(read(outDir, 'research/index.html'), '/research/');

      for (const path of [
        'countries/index.html',
        'country-instability-index/index.html',
        'countries/norway/index.html',
        'countries/norway/resilience.json',
        'chokepoints/index.html',
        'chokepoints/strait-of-hormuz/index.html',
        'chokepoints/strait-of-hormuz/reference.json',
        'crises/index.html',
        'crises/red-sea-security/index.html',
        'crises/red-sea-security/tracker.json',
        'tools/index.html',
        'tools/live-tools.js',
        'tools/natural-hazard-pulse/index.html',
        'tools/airspace-disruption-checker/index.html',
        'tools/signal-convergence/index.html',
        'tools/signal-convergence/reference.json',
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
      assert.match(norway, /<link rel="alternate" hreflang="x-default" href="https:\/\/www\.worldmonitor\.app\/countries\/norway\/">/);
      assert.match(norway, /<link rel="alternate" hreflang="en" href="https:\/\/www\.worldmonitor\.app\/countries\/norway\/">/);
      assert.doesNotMatch(norway, /hreflang="zh/, 'English crawlable corpus pages must not advertise zh alternates');
      assert.match(norway, new RegExp(`<meta name="lastmod" content="${countriesLastmod}">`));
      assert.ok(norway.includes(`Source: ${manifest.sources.resilienceSnapshot}`));
      assert.match(
        norway,
        /<span>Overall score<\/span><strong>75\.4<\/strong>/,
        'headline-eligible countries must retain their published score',
      );
      assert.doesNotMatch(norway, /id="app"/, 'country page must be raw static HTML, not the SPA shell');
      assert.match(norway, /data-live-country-risk data-country-code="NO" data-country-name="Norway"/);
      assert.match(norway, /data-published-pulse/);
      assert.match(norway, /Instability combines current information/);
      assert.match(norway, /do not combine the scores/);
      // #7376: no-JS HTML ships published pulse values, never Connecting…/Loading placeholders.
      assert.doesNotMatch(norway, /Connecting…/);
      assert.doesNotMatch(norway, /data-live-band>Loading/);
      assert.doesNotMatch(norway, /Requesting the latest available result/);
      assert.match(norway, /data-live-advisory>[^<]+/);
      assert.match(norway, /data-live-sanctions>[^<]+/);
      // Norway is a partial record: advisory and sanctions publish, but the
      // upstream supplied no computedAt, so the tile must carry an UNDATED
      // <span> rather than a <time datetime> fabricated from the freeze clock.
      assert.match(norway, /<span data-live-updated>/);
      assert.doesNotMatch(
        norway,
        /<time data-live-updated/,
        'a partial country pulse must not publish a machine-readable retrieval timestamp',
      );
      assert.match(norway, /data-live-score>—/);
      assert.match(norway, /data-live-band>No current score/);
      assert.match(norway, /data-live-trend>Unavailable/);
      const ukraine = read(outDir, 'countries/ukraine/index.html');
      assert.match(ukraine, new RegExp(`<meta name="lastmod" content="${ciiCountriesLastmod}">`));
      assert.match(ukraine, /<title>Ukraine Instability Index &amp; Country Risk \| World Monitor<\/title>/);
      assert.match(ukraine, /<h1>Ukraine Country Instability Index<\/h1>/);
      assert.match(ukraine, /Ukraine's Country Instability Index is <strong>\d+\/100 &middot; [^<]+<\/strong>/);
      assert.match(ukraine, /<summary>What is Ukraine&#39;s Country Instability Index\?<\/summary>/);
      const ukraineFaq = jsonLdObjects(ukraine).find((entry) => entry['@type'] === 'FAQPage');
      assert.match(ukraineFaq?.mainEntity?.[0]?.name || '', /Country Instability Index/);
      assert.match(ukraine, /data-live-score>\d/);
      assert.doesNotMatch(ukraine, /data-live-score>—/);
      assert.doesNotMatch(ukraine, /Connecting…/);
      // A scored country carries a real upstream timestamp, so it does get <time>.
      assert.match(ukraine, /<time data-live-updated datetime="20\d{2}-\d{2}-\d{2}T/);
      // Ukraine and Norway are individually asserted above, but neither would
      // notice a freeze that degraded published scores across the corpus. Pin a
      // floor on how many country pages actually ship a numeric score.
      const scoredCountryPages = manifest.sections.countries.routes.filter((route) => (
        /data-live-score>\d/.test(read(outDir, `${route.slice(1)}index.html`))
      )).length;
      assert.ok(
        scoredCountryPages >= 25,
        `expected at least 25 country pages to publish a numeric instability score, got ${scoredCountryPages}`,
      );
      const ciiTargetedCountryPages = manifest.sections.countries.routes.filter((route) => (
        /<h1>[^<]+ Country Instability Index<\/h1>/.test(read(outDir, `${route.slice(1)}index.html`))
      ));
      assert.equal(ciiTargetedCountryPages.length, 31);
      assert.equal(
        ciiTargetedCountryPages.every((route) => (
          /data-live-score>\d/.test(read(outDir, `${route.slice(1)}index.html`))
        )),
        true,
        'only country pages with a published CII score may target Country Instability Index',
      );
      // Compare against the live country clock, not a calendar date:
      // freeze:crawlable-live-pulse advances capturedAt every run.
      assert.equal(
        manifest.sections.countries.routes.every((route) => (
          new RegExp(`<meta name="lastmod" content="${countriesLastmod}">`).test(
            read(outDir, `${route.slice(1)}index.html`),
          )
        )),
        true,
        'all country pages must use the current country content clock',
      );

      const ciiIndex = read(outDir, 'country-instability-index/index.html');
      const ciiDocument = htmlDocument(
        ciiIndex,
        'https://www.worldmonitor.app/country-instability-index/',
      );
      const methodologyDoc = readFileSync(
        join(repoRoot, 'docs/methodology/cii-risk-scores.mdx'),
        'utf8',
      );
      assert.match(
        methodologyDoc,
        /^description: "Editorial methodology behind the Country Instability Index\b/m,
      );
      assert.match(
        methodologyDoc,
        /^The Country Instability Index answers one operational question:$/m,
      );
      assert.match(ciiIndex, /<title>Country Instability Index: Live Rankings \| World Monitor<\/title>/);
      assert.match(ciiIndex, /<h1>Country Instability Index<\/h1>/);
      assert.match(ciiIndex, new RegExp(`<meta name="lastmod" content="${ciiIndexLastmod}">`));
      assert.match(ciiIndex, /data-cii-methodology-version="v8"/);
      assert.match(
        ciiIndex,
        /CII v8 currently monitors 31 countries and reports approximate 24-hour movement when available\./,
      );
      const ciiQuestion = 'Which countries are most unstable right now?';
      const ciiQuestionHeading = [...ciiDocument.querySelectorAll('h2')]
        .find((heading) => heading.textContent.trim() === ciiQuestion);
      assert.ok(ciiQuestionHeading, `CII hub needs the exact H2 "${ciiQuestion}"`);
      const ciiAnswer = ciiQuestionHeading.nextElementSibling?.textContent.trim() || '';
      assert.ok(
        proseWordCount(ciiAnswer) >= 40 && proseWordCount(ciiAnswer) <= 60,
        `CII hub answer is ${proseWordCount(ciiAnswer)} words, need 40-60`,
      );
      assert.ok(
        ciiQuestionHeading.compareDocumentPosition(
          ciiDocument.querySelector('table[data-cii-ranking]'),
        ) & 4,
        'CII hub FAQ answer must appear before the ranking table',
      );
      assert.equal(ciiDocument.querySelectorAll('[data-cii-country]').length, 31);
      assert.equal(
        ciiDocument.querySelectorAll('[data-cii-country] [data-cii-score]').length,
        31,
      );
      assert.equal(
        [...ciiDocument.querySelectorAll('[data-cii-country]')].every((row) => (
          /^\d+(?:\.\d+)?$/.test(row.querySelector('[data-cii-score]')?.textContent || '')
          && Boolean(row.querySelector('time[data-cii-updated][datetime]'))
        )),
        true,
        'every CII ranking row must publish a numeric score and authoritative timestamp',
      );
      const ciiLd = jsonLdObjects(ciiIndex);
      const ciiCollection = ciiLd.find((entry) => entry['@type'] === 'CollectionPage');
      const ciiDataset = ciiLd.find((entry) => entry['@type'] === 'Dataset');
      const ciiItemList = ciiLd.find((entry) => entry['@type'] === 'ItemList');
      const ciiFaq = ciiLd.find((entry) => entry['@type'] === 'FAQPage');
      assert.equal(ciiFaq?.mainEntity?.[0]?.name, ciiQuestion);
      assert.equal(ciiFaq?.mainEntity?.[0]?.acceptedAnswer?.text, ciiAnswer);
      for (const entry of ciiItemList.itemListElement.slice(0, 3)) {
        assert.match(ciiAnswer, new RegExp(`\\b${entry.name}\\b`));
      }
      const ciiUpdatedText = ciiDocument
        .querySelector('time[data-cii-ranking-updated][datetime]')
        ?.textContent.trim()
        .replace(/^Latest published score /, '');
      assert.ok(ciiUpdatedText && ciiAnswer.includes(ciiUpdatedText));
      assert.doesNotMatch(ciiAnswer, /\btoday\b/i);
      assert.deepEqual(ciiCollection?.mainEntity, {
        '@id': 'https://www.worldmonitor.app/country-instability-index/#dataset',
      });
      assert.equal(ciiDataset?.measurementTechnique, 'World Monitor CII v8');
      assert.deepEqual(ciiDataset?.mainEntity, {
        '@id': 'https://www.worldmonitor.app/country-instability-index/#ranking',
      });
      assert.equal(ciiItemList?.numberOfItems, 31);
      assert.equal(ciiItemList?.itemListElement?.length, 31);
      const aeRankingItem = ciiItemList.itemListElement.find(
        (entry) => entry.item?.name === 'United Arab Emirates',
      );
      const afRankingItem = ciiItemList.itemListElement.find(
        (entry) => entry.item?.name === 'Afghanistan',
      );
      assert.equal(
        aeRankingItem.item.additionalProperty.find(
          (property) => property.name === 'Approximate 24-hour movement',
        ),
        undefined,
        'ambiguous stable movement must not publish a numeric JSON-LD value',
      );
      assert.equal(
        afRankingItem.item.additionalProperty.find(
          (property) => property.name === 'Approximate 24-hour movement',
        )?.value,
        2,
      );

      const unitedArabEmirates = read(outDir, 'countries/united-arab-emirates/index.html');
      assert.match(unitedArabEmirates, /stable or unavailable over approximately 24 hours/);
      assert.match(unitedArabEmirates, /data-live-trend>Stable or unavailable<\/strong>/);
      const aeCiiDataset = jsonLdObjects(unitedArabEmirates)
        .flatMap((entry) => collectDatasets(entry))
        .find((entry) => entry['@id']?.endsWith('#cii-dataset'));
      assert.equal(
        aeCiiDataset.variableMeasured.find(
          (property) => property.name === 'Approximate 24-hour movement',
        ),
        undefined,
      );

      const ukraineLd = jsonLdObjects(ukraine);
      const ukrainePage = ukraineLd.find((entry) => entry['@type'] === 'WebPage');
      const ukraineDatasets = ukraineLd.flatMap((entry) => collectDatasets(entry));
      const ukraineCiiDataset = ukraineDatasets.find((entry) => entry['@id']?.endsWith('#cii-dataset'));
      const ukraineResilienceDataset = ukraineDatasets.find((entry) => entry['@id']?.endsWith('#resilience-dataset'));
      assert.deepEqual(ukrainePage?.mainEntity, {
        '@id': 'https://www.worldmonitor.app/countries/ukraine/#cii-dataset',
      });
      assert.equal(ukraineCiiDataset?.measurementTechnique, 'World Monitor CII v8');
      assert.equal(ukraineCiiDataset?.spatialCoverage?.['@type'], 'Place');
      assert.ok(ukraineResilienceDataset, 'CII country pages must retain the CRI Dataset');
      assert.ok(norway.includes(liveScriptTag), 'country live script must match the production CSP nonce');
      // Deep-link CTA into the live map (opens the maximized country brief). `&` is HTML-escaped.
      // Carries utm_source (NOT ref= — that would be captured as an affiliate referral code).
      assert.match(norway, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?country=NO&amp;expanded=1&amp;utm_source=seo-country">Open Norway on the live map/);
      assert.doesNotMatch(norway, /[?&]ref=/, 'corpus CTAs must never use the affiliate ref= param');
      // Social preview + trust-link contracts.
      assert.match(norway, /<meta property="og:image" content="https:\/\/www\.worldmonitor\.app\/favico\/og-image\.png">/);
      assert.match(norway, /<meta name="twitter:card" content="summary_large_image">/);
      assert.match(norway, /href="\/docs\/methodology\/country-resilience-index"/);
      assert.match(
        norway,
        /<img src="https:\/\/www\.worldmonitor\.app\/favico\/og-image\.png" alt="[^"]+" width="120" height="63"/,
        'corpus pages must expose a real image for multimodal retrieval (#7382)',
      );

      const corpusData = await loadCorpusData({ rootDir: repoRoot });
      const countryByCode = new Map(corpusData.countries.map((country) => [country.code, country]));
      const microstateCohort = JSON.parse(readFileSync(
        join(repoRoot, 'server/worldmonitor/resilience/v1/cohorts/microstate-territories.json'),
        'utf8',
      ));
      const microstateCodes = new Set((microstateCohort.iso2 || []).map((code) => String(code).toUpperCase()));
      for (const country of corpusData.countries) {
        assert.equal(
          country.microstateTerritory,
          microstateCodes.has(country.code),
          `${country.code} must match microstate cohort membership`,
        );
      }
      const vercelConfig = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8'));
      const redirectPairs = new Set(
        vercelConfig.redirects.map((redirect) => `${redirect.source} -> ${redirect.destination}`),
      );

      for (const country of corpusData.countries) {
        assert.equal(country.name, country.identity.commonName, `${country.code} must use its common name`);
        assert.match(country.identity.sameAs, /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/);
        assert.ok(country.identity.officialName, `${country.code} must retain an official name`);
        for (const legacySlug of country.legacySlugs) {
          assert.ok(
            redirectPairs.has(`/countries/${legacySlug} -> /countries/${country.slug}/`),
            `${legacySlug} must permanently redirect to ${country.slug}`,
          );
          assert.ok(
            redirectPairs.has(`/countries/${legacySlug}/ -> /countries/${country.slug}/`),
            `${legacySlug}/ must permanently redirect to ${country.slug}/`,
          );
        }
        const route = `/countries/${country.slug}/`;
        const countryHtml = read(outDir, `${route.slice(1)}index.html`);
        const countryDocument = htmlDocument(countryHtml, `https://www.worldmonitor.app${route}`);
        if (country.rank == null) {
          assert.match(countryHtml, /Nearest ranked comparators:/);
          assert.doesNotMatch(
            countryHtml,
            /\b[A-Z]{2} · /,
            `${route} must not prefix unpublished copy with ISO scaffolding`,
          );
          const comparisonHeading = [...countryDocument.querySelectorAll('[data-country-analysis] h3')]
            .find((heading) => heading.textContent === 'Nearest ranked comparators');
          const comparisonText = comparisonHeading?.nextElementSibling?.textContent ?? '';
          assert.ok(country.peers.length > 0, `${route} must name ranked comparators`);
          for (const peer of country.peers) {
            assert.notEqual(peer.rank, null, `${route} comparator ${peer.name} must be ranked`);
            assert.ok(comparisonText.includes(peer.name), `${route} must include ${peer.name} as a ranked comparator`);
            assert.ok(
              !comparisonText.includes(`${peer.name} (`),
              `${route} must not reveal ${peer.name}'s score in an ineligible comparison set`,
            );
          }
        } else {
          const peerDistances = country.peers.map((peer) => Math.abs(peer.rank - country.rank));
          assert.deepEqual(
            peerDistances,
            [...peerDistances].sort((left, right) => left - right),
            `${route} must order its comparison peers by rank distance`,
          );
          assert.match(countryHtml, /Nearest ranked peers:/);
        }
        const articleWordCount = words(
          countryDocument.querySelector('[data-country-analysis]')?.textContent,
        ).length;
        assert.ok(
          articleWordCount >= 400,
          `${route} analysis must contain at least 400 country-specific words, got ${articleWordCount}`,
        );
        const pageWordCount = words(countryDocument.querySelector('main')?.textContent).length;
        // Upper bound leaves room for the published live-pulse tiles (#7376)
        // on top of the #7371 country-analysis prose target.
        assert.ok(
          pageWordCount >= 600 && pageWordCount <= 900,
          `${route} main content must contain 600-900 words, got ${pageWordCount}`,
        );
      }

      const macau = countryByCode.get('MO');
      assert.equal(macau.name, 'Macau');
      assert.equal(macau.slug, 'macau');
      assert.ok(existsSync(join(outDir, 'countries/macau/index.html')));
      assert.ok(!existsSync(join(outDir, 'countries/macao-s-a-r/index.html')));
      const macauPage = jsonLdObjects(read(outDir, 'countries/macau/index.html'))
        .find((entry) => entry['@type'] === 'WebPage');
      assert.deepEqual(macauPage?.about?.alternateName, ['Macao SAR']);
      assert.doesNotMatch(JSON.stringify(macauPage), /Macao S A R/);

      const countriesIndex = read(outDir, 'countries/index.html');
      const countriesDocument = htmlDocument(countriesIndex, 'https://www.worldmonitor.app/countries/');
      const rankingRows = countriesDocument.querySelectorAll('table[data-country-ranking] tbody tr');
      assert.equal(rankingRows.length, corpusData.countries.length);
      assert.equal(
        countriesDocument.querySelector('table[data-country-ranking] thead')?.textContent.includes('Score'),
        true,
      );
      const countriesLd = jsonLdObjects(countriesIndex);
      const countryCollection = countriesLd.find((entry) => entry['@type'] === 'CollectionPage');
      const countryItemList = countriesLd.find((entry) => entry['@type'] === 'ItemList');
      const countryDataset = countriesLd.find((entry) => entry['@type'] === 'Dataset');
      const countryFaq = countriesLd.find((entry) => entry['@type'] === 'FAQPage');
      assert.equal(countryCollection?.name, 'Country risk, instability and resilience by country');
      assert.equal(countryCollection?.['@id'], 'https://www.worldmonitor.app/countries/#webpage');
      assertDefaultSpeakable(countryCollection, 'countries hub CollectionPage');
      assert.equal(countryDataset?.['@id'], 'https://www.worldmonitor.app/countries/#dataset');
      assert.deepEqual(countryCollection?.breadcrumb, {
        '@id': 'https://www.worldmonitor.app/countries/#breadcrumb',
      });
      assert.equal(countryItemList?.numberOfItems, corpusData.countries.length);
      assert.equal(countryItemList?.itemListElement?.length, corpusData.countries.length);
      assert.equal(countryDataset?.variableMeasured?.name, 'Country resilience score');
      const hubHeadings = [...countriesDocument.querySelectorAll('h2')].map((node) => node.textContent.trim());
      assert.deepEqual(hubHeadings, [
        `Which countries are most resilient in ${corpusData.resilience.capturedAt.slice(0, 4)}?`,
        'How is the Country Resilience Index calculated?',
      ]);
      assert.equal(countryFaq?.mainEntity?.length, 2);
      for (const question of hubHeadings) {
        const qa = countryFaq.mainEntity.find((entity) => entity.name === question);
        assert.ok(qa, `countries hub FAQPage is missing ${question}`);
        const answer = qa.acceptedAnswer.text;
        const answerWords = proseWordCount(answer);
        assert.ok(
          answerWords >= 40 && answerWords <= 60,
          `${question} answer is ${answerWords} words, need 40-60`,
        );
        assert.ok(
          countriesIndex.includes(answer),
          `countries hub FAQ answer for ${question} must match visible copy`,
        );
      }
      const rankedCountries = corpusData.countries
        .filter((country) => Number.isInteger(country.rank))
        .sort((a, b) => a.rank - b.rank);
      const resilienceAnswer = countryFaq.mainEntity[0].acceptedAnswer.text;
      const snapshotDateLabel = countriesDocument
        .querySelector('table[data-country-ranking] caption')
        ?.textContent.trim()
        .replace(/ Country Resilience Index snapshot$/, '');
      assert.ok(snapshotDateLabel, 'countries hub ranking caption needs a snapshot date');
      assert.ok(
        resilienceAnswer.includes(
          `${snapshotDateLabel} Country Resilience Index snapshot ranks ${rankedCountries.length} of ${corpusData.countries.length} countries`,
        ),
      );
      for (const country of rankedCountries.slice(0, 3)) {
        assert.match(resilienceAnswer, new RegExp(`\\b${country.name}\\b`));
      }
      assert.doesNotMatch(resilienceAnswer, /\btoday\b/i);
      const rankedListItem = countryItemList.itemListElement.find((entry) => entry.item?.additionalProperty);
      assert.ok(rankedListItem, 'ranked hub ItemList entries need a Country node with a score PropertyValue');
      assert.equal(rankedListItem.item['@type'], 'Country');
      assert.equal(rankedListItem.item.additionalProperty['@type'], 'PropertyValue');
      assert.equal(rankedListItem.item.additionalProperty.name, 'Country Resilience Index score');
      assert.equal(typeof rankedListItem.item.additionalProperty.value, 'number');
      const unpublishedListItem = countryItemList.itemListElement.find((entry, index) => (
        corpusData.countries[index]?.headlineEligible === false
      ));
      assert.ok(unpublishedListItem, 'unpublished countries must remain in the hub ItemList');
      assert.equal(unpublishedListItem.item?.additionalProperty, undefined);

      const sampleCodes = ['AD', 'CD', 'IR', 'JP', 'KP', 'MO', 'NO', 'NR', 'UA', 'US'];
      const sampleArticles = [];
      for (const code of sampleCodes) {
        const country = countryByCode.get(code);
        assert.ok(country, `missing corpus country ${code}`);
        const route = `/countries/${country.slug}/`;
        const html = read(outDir, `${route.slice(1)}index.html`);
        const document = htmlDocument(html, `https://www.worldmonitor.app${route}`);
        const article = document.querySelector('[data-country-analysis]');
        assert.ok(article, `${route} must render a country analysis block`);
        const mainText = document.querySelector('main')?.textContent || '';
        sampleArticles.push({ route, text: mainText });

        const faqEntries = [...document.querySelectorAll('[data-country-faq]')];
        const ciiTargeted = /<h1>[^<]+ Country Instability Index<\/h1>/.test(html);
        assert.ok(
          faqEntries.length >= 2 && faqEntries.length <= (ciiTargeted ? 4 : 3),
          `${route} must show 2-3 CRI FAQs, plus one CII FAQ when retargeted`,
        );
        if (ciiTargeted) {
          assert.match(faqEntries[0]?.textContent || '', /Country Instability Index/);
        }
        const pageLd = jsonLdObjects(html);
        const faqPage = pageLd.find((entry) => entry['@type'] === 'FAQPage');
        assert.equal(faqPage?.mainEntity?.length, faqEntries.length);
        const dataset = pageLd
          .flatMap((entry) => collectDatasets(entry))
          .find((entry) => entry['@id']?.endsWith('#resilience-dataset'));
        assert.ok(dataset, `${route} must retain its Country Resilience Index dataset`);
        const measurements = new Map(
          dataset.variableMeasured.map((measurement) => [measurement.name, measurement.value]),
        );
        if (country.headlineEligible === false) {
          assert.equal(measurements.has('Overall resilience score'), false);
          assert.equal(measurements.has('Rank'), false);
          assert.equal(measurements.has('30-day score change'), false);
          assert.equal(
            [...measurements.keys()].some((name) => /pillar|score/i.test(name)),
            false,
          );
        } else {
          assert.equal(measurements.get('Overall resilience score'), country.overallScore);
        }
        assert.equal(measurements.get('Dimension coverage'), country.dimensionCoverage);
        assert.equal(dataset.identifier, code);
        assert.equal(dataset.url, `https://www.worldmonitor.app${route}`);
      }

      for (let left = 0; left < sampleArticles.length; left += 1) {
        for (let right = left + 1; right < sampleArticles.length; right += 1) {
          const share = pairwiseUniqueShare(sampleArticles[left].text, sampleArticles[right].text);
          assert.ok(
            share >= 0.4,
            `${sampleArticles[left].route} and ${sampleArticles[right].route} must be at least 40% unique, got ${(share * 100).toFixed(1)}%`,
          );
        }
      }

      const uk = read(outDir, 'countries/united-kingdom/index.html');
      assert.match(uk, /<h1>United Kingdom Country Instability Index<\/h1>/);
      assert.doesNotMatch(uk, /<h1>Uk /);
      const dprk = read(outDir, 'countries/north-korea/index.html');
      assert.match(
        dprk,
        /<title>North Korea Instability Index &amp; Country Risk \| World Monitor<\/title>/,
      );

      // The expectation is derived from the snapshot, NOT from a copy of the
      // generator's own withheld-state list -- an oracle that enumerates the same
      // strings as the code under test cannot detect a missing class.
      // A dimension carries an imputationClass only when observedWeight === 0.
      const isObservedDimension = (dimension) => String(dimension.imputationClass || '') === ''
        && Number(dimension.coverage) > 0
        && Number.isFinite(Number(dimension.score));

      let withheldDimensionRows = 0;
      let observedZeroDimensionRows = 0;
      let expectedWithheldTotal = 0;
      let expectedObservedZeroTotal = 0;
      for (const country of rankedCountries) {
        const route = `/countries/${country.slug}/`;
        const html = read(outDir, `${route.slice(1)}index.html`);
        const document = htmlDocument(html, `https://www.worldmonitor.app${route}`);
        const rows = [...document.querySelectorAll('[data-country-analysis] table tbody tr')];
        const dimensions = (country.domains || []).flatMap((domain) => domain.dimensions || []);
        expectedWithheldTotal += dimensions.filter((d) => !isObservedDimension(d)).length;
        expectedObservedZeroTotal += dimensions
          .filter((d) => isObservedDimension(d) && Number(d.score) === 0).length;

        let reachedWithheldRows = false;
        let previousObservedScore = Number.NEGATIVE_INFINITY;
        let withheldOnThisPage = 0;
        for (const row of rows) {
          const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim());
          const [dimension, , score, , evidenceState] = cells;
          if (score === '—') {
            withheldDimensionRows++;
            withheldOnThisPage++;
            reachedWithheldRows = true;
            assert.doesNotMatch(
              evidenceState,
              /^(?:Fresh|Stale)$/i,
              `${route} must not label ${dimension} fresh or stale without coverage`,
            );
            assert.doesNotMatch(
              html,
              new RegExp(`\\blow ${dimension.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} \\d`),
              `${route} prose must not rank withheld dimension ${dimension}`,
            );
            continue;
          }
          assert.equal(reachedWithheldRows, false, `${route} must sort all observed dimensions before withheld rows`);
          const numericScore = Number(score);
          assert.ok(Number.isFinite(numericScore), `${route} observed dimension ${dimension} needs a numeric score`);
          if (numericScore === 0) observedZeroDimensionRows++;
          assert.ok(
            numericScore >= previousObservedScore,
            `${route} observed dimensions must remain sorted weakest first`,
          );
          previousObservedScore = numericScore;
        }
        assert.equal(
          withheldOnThisPage,
          dimensions.filter((d) => !isObservedDimension(d)).length,
          `${route} must withhold exactly the dimensions the snapshot reports as unobserved`,
        );
      }
      assert.ok(withheldDimensionRows > 0, 'the resilience snapshot must exercise withheld dimension rows');
      assert.equal(
        withheldDimensionRows,
        expectedWithheldTotal,
        'every unobserved dimension in the snapshot must render as withheld, and no observed one may',
      );
      // Positive control: genuine zeroes still publish. Selected from the snapshot so a
      // refresh moves the subject instead of reddening the suite.
      assert.ok(expectedObservedZeroTotal > 0, 'the snapshot must contain an observed dimension score of zero');
      assert.equal(
        observedZeroDimensionRows,
        expectedObservedZeroTotal,
        'an observed country dimension score of zero must remain publishable',
      );

      const zeroScoredChokepoint = corpusData.chokepoints
        .find((chokepoint) => Number(corpusData.livePulse.chokepoints?.[chokepoint.id]?.disruptionScore) === 0);
      assert.ok(zeroScoredChokepoint, 'the pulse must contain an observed chokepoint score of zero');
      assert.match(
        read(outDir, `chokepoints/${zeroScoredChokepoint.slug}/index.html`),
        /data-chokepoint-score>0<\/span>/,
        'an observed chokepoint score of zero must remain publishable',
      );

      const zeroCrisis = corpusData.crises
        .map((crisis) => ({
          crisis,
          row: (corpusData.livePulse.crises?.[crisis.slug]?.rows || [])
            .find((candidate) => Number(candidate.events) === 0 && Number(candidate.fatalities) === 0),
        }))
        .find((entry) => entry.row);
      assert.ok(zeroCrisis, 'the pulse must contain observed crisis counts of zero');
      const crisisDocument = htmlDocument(
        read(outDir, `crises/${zeroCrisis.crisis.slug}/index.html`),
        `https://www.worldmonitor.app/crises/${zeroCrisis.crisis.slug}/`,
      );
      // Scoped to the country's own element: an unanchored regex can slide past this
      // row and match an identical sibling, which would hide over-withholding here.
      const zeroCrisisValue = crisisDocument.querySelector(
        `[data-crisis-country][data-country-code="${zeroCrisis.row.code}"] [data-crisis-country-value]`,
      );
      assert.ok(zeroCrisisValue, `${zeroCrisis.crisis.slug} must render a ${zeroCrisis.row.code} row`);
      assert.match(
        zeroCrisisValue.textContent.trim(),
        /^0 events · 0 fatalities · \d{4}-\d{2}-\d{2}$/,
        'observed crisis counts of zero must remain publishable',
      );

      const convergenceExample = corpusData.livePulse.signalConvergence?.referenceExamples?.[0];
      assert.ok(convergenceExample, 'signal convergence must publish an example');
      assert.match(
        read(outDir, 'tools/signal-convergence/index.html'),
        new RegExp(`<strong>${String(convergenceExample.score)}</strong>`),
        'an observed tool score must remain publishable',
      );

      const taiwan = read(outDir, 'countries/taiwan/index.html');
      assert.match(
        taiwan,
        /<span>Overall score<\/span><strong>—<\/strong>/,
        'headline-ineligible countries must not render a numeric score',
      );
      const taiwanDataset = JSON.parse(read(outDir, 'countries/taiwan/resilience.json'));
      assert.equal(taiwanDataset.rank, null);
      assert.equal(taiwanDataset.overallScore, null);
      assert.equal(taiwanDataset.level, 'unpublished');
      assert.equal(taiwanDataset.sourceStatus, 'low-confidence');
      assert.equal(taiwanDataset.confidence, 'low');
      assert.match(taiwan, /does not meet the published ranking eligibility criteria/);
      assert.match(taiwan, /Ranking requires coverage of at least 65%/);
      assert.match(taiwan, /population of at least 200,000/);
      assert.match(taiwan, /coverage falls below 55%/);
      assert.match(taiwan, /imputation share exceeds 40%/);
      const taiwanWhy = unpublishedHeadingParagraph(taiwan, 'Why Taiwan is unpublished');
      assert.match(taiwanWhy, /coverage is 38%/);
      assert.match(taiwanWhy, /imputation share is 42%/);
      assert.doesNotMatch(
        taiwanWhy,
        /Ranking requires coverage of at least 65%/,
        'eligibility thresholds in FAQ/JSON-LD must not be the Why-unpublished analysis reason',
      );
      const taiwanCovered = unpublishedHeadingParagraph(taiwan, 'What the snapshot does cover');
      assert.match(
        taiwanCovered,
        /Cyber and digital capacity \(100%\)|Macro-fiscal position \(95%\)/,
        'available-evidence copy must name a strongest observed dimension, not only weak usable rows',
      );
      assert.match(taiwan, /coverage is 38%/);
      assert.match(taiwan, /imputation share is 42%/);
      assert.match(taiwan, /World Bank/);
      assert.match(taiwan, /WHO/);
      assert.match(taiwan, /Nearest ranked comparators:/);
      assert.match(taiwan, /Taiwan is included separately in the rankable universe/);
      assert.doesNotMatch(taiwan, /special administrative region/);
      assert.match(taiwan, /Taiwan instability index scores 48\/100 \(Normal\)/);
      assert.doesNotMatch(taiwan, /\bTW · /);
      assert.doesNotMatch(
        taiwan,
        /below the threshold/,
        'ineligible country copy must not blame ranking exclusion on coverage alone',
      );
      const taiwanWebPage = jsonLdObjects(taiwan)
        .find((entry) => entry['@type'] === 'WebPage');
      const taiwanResilienceDataset = jsonLdObjects(taiwan)
        .flatMap((entry) => collectDatasets(entry))
        .find((entry) => entry['@id']?.endsWith('#resilience-dataset'));
      assertDefaultSpeakable(taiwanWebPage, 'taiwan country WebPage');
      assert.deepEqual(taiwanWebPage?.mainEntity, {
        '@id': 'https://www.worldmonitor.app/countries/taiwan/#cii-dataset',
      });
      assert.equal(taiwanWebPage?.mainEntity?.value, undefined);
      assert.equal(taiwanWebPage?.mainEntity?.overallScore, undefined);
      assert.match(
        taiwanResilienceDataset?.description ?? '',
        /does not meet the published ranking eligibility criteria/,
      );
      assert.doesNotMatch(
        taiwanResilienceDataset?.description ?? '',
        /below the ranking threshold|input coverage is below/i,
      );
      // #7502: on CII-covered pages both Datasets are siblings of the WebPage
      // rather than nested under it, so each must bind its own vocabulary or it
      // parses as nothing at all.
      for (const fragment of ['#cii-dataset', '#resilience-dataset']) {
        const block = jsonLdObjects(taiwan).find((entry) => entry['@id']?.endsWith(fragment));
        assert.ok(block, `taiwan must emit a top-level ${fragment} block`);
        assert.equal(block['@type'], 'Dataset', `taiwan ${fragment} must be a Dataset`);
        assert.ok(
          jsonLdContextIsResolvable(block['@context']),
          `taiwan ${fragment} must bind schema.org so it parses as a Dataset`,
        );
      }

      for (const slug of ['taiwan', 'palau', 'san-marino']) {
        const html = read(outDir, `countries/${slug}/index.html`);
        const sourceGaps = unpublishedHeadingParagraph(html, 'Source inventory gaps');
        assert.match(
          sourceGaps,
          /marked source unavailable in this snapshot/,
          `${slug} must describe upstream unavailability in the current snapshot`,
        );
        assert.doesNotMatch(
          sourceGaps,
          /source-universe limit/,
          `${slug} must not explain an upstream outage as structural exclusion`,
        );
      }

      const headlineIneligible = corpusData.countries
        .filter((country) => country.headlineEligible === false);
      assert.equal(headlineIneligible.length, corpusData.resilience.totals.greyedOutCount);
      for (const country of headlineIneligible) {
        const html = read(outDir, `countries/${country.slug}/index.html`);
        assert.doesNotMatch(
          html,
          /<span>Overall score<\/span><strong>\d/,
          `${country.name} must not render a numeric resilience score`,
        );
        assert.doesNotMatch(
          html,
          /below the threshold/,
          `${country.name} must not explain ranking exclusion as low coverage`,
        );
      }
      const coveredIneligible = headlineIneligible.find((country) => (
        Number(country.dimensionCoverage) >= 0.65
      ));
      assert.ok(
        coveredIneligible,
        'snapshot must include an ineligible country with coverage at or above 65%',
      );
      const coveredHtml = read(outDir, `countries/${coveredIneligible.slug}/index.html`);
      const coveredCoverage = `${Math.round(Number(coveredIneligible.dimensionCoverage) * 100)}%`;
      const coveredWhy = unpublishedHeadingParagraph(
        coveredHtml,
        `Why ${coveredIneligible.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is unpublished`,
      );
      assert.equal(
        coveredWhy,
        describeHeadlineIneligibilityReason(coveredIneligible),
        `${coveredIneligible.name} Why-unpublished paragraph must be the eligibility reason, not gap copy`,
      );
      assert.match(
        coveredHtml,
        /does not meet the published ranking eligibility criteria/,
      );
      assert.match(
        coveredHtml,
        new RegExp(`coverage is ${coveredCoverage}`),
        `${coveredIneligible.name} must keep coverage as a separate fact`,
      );
      assert.match(
        coveredHtml,
        /population of at least 200,000/,
        `${coveredIneligible.name} must quote the population-or-high-coverage ranking rule`,
      );
      assert.doesNotMatch(
        coveredHtml,
        /below the 65% ranking floor/,
        `${coveredIneligible.name} must not explain ranking exclusion as low coverage`,
      );
      assert.match(
        coveredHtml,
        /<h3>Source inventory gaps<\/h3>/,
        `${coveredIneligible.name} must keep source-gap copy on a separate heading`,
      );
      if (coveredIneligible.lowConfidence !== true) {
        assert.doesNotMatch(
          coveredHtml,
          /flagged low-confidence/,
          `${coveredIneligible.name} must not be described as low-confidence when the snapshot is not`,
        );
      }
      const coveredWebPage = jsonLdObjects(coveredHtml)
        .find((entry) => entry['@type'] === 'WebPage');
      const coveredResilienceDataset = jsonLdObjects(coveredHtml)
        .flatMap((entry) => collectDatasets(entry))
        .find((entry) => entry['@id']?.endsWith('#resilience-dataset'));
      assert.ok(coveredWebPage, `${coveredIneligible.name} must publish a WebPage`);
      assert.match(
        coveredResilienceDataset?.description ?? '',
        /does not meet the published ranking eligibility criteria/,
      );
      assert.match(
        coveredResilienceDataset?.description ?? '',
        /Ranking requires coverage of at least 65%/,
      );
      assert.doesNotMatch(
        coveredResilienceDataset?.description ?? '',
        /below the ranking threshold|input coverage is below/i,
      );

      const unrankedSampleCodes = ['AD', 'MO', 'SM', 'SY', 'TV', 'TW'];
      const unrankedArticles = [];
      const rankedNames = new Set(
        corpusData.countries.filter((country) => country.rank != null).map((country) => country.name),
      );
      for (const code of unrankedSampleCodes) {
        const country = countryByCode.get(code);
        assert.ok(country, `missing unranked corpus country ${code}`);
        const route = `/countries/${country.slug}/`;
        const html = read(outDir, `${route.slice(1)}index.html`);
        const document = htmlDocument(html, `https://www.worldmonitor.app${route}`);
        const analysis = document.querySelector('[data-country-analysis]');
        assert.ok(analysis, `${route} must render unpublished analysis`);
        const mainText = document.querySelector('main')?.textContent || '';
        if (['TV', 'SM', 'MO'].includes(code)) {
          const evidenceQuestion = `What evidence is available for ${country.name}?`;
          const evidenceFaq = [...document.querySelectorAll('[data-country-faq]')]
            .find((node) => node.querySelector('summary')?.textContent === evidenceQuestion);
          assert.ok(evidenceFaq, `${route} must show a microstate evidence FAQ`);
          assert.match(evidenceFaq.textContent || '', /observed dimension readings|dimensions have observed readings/);
          assert.doesNotMatch(evidenceFaq.textContent || '', /Observed feeds/);
          const faqLabel = {
            TV: 'State continuity',
            SM: 'Liquid-reserve adequacy',
            MO: 'Import concentration',
          }[code];
          assert.match(evidenceFaq.textContent || '', new RegExp(faqLabel));
          assert.doesNotMatch(evidenceFaq.textContent || '', /overall score[^.]*\d|country rank[^.]*\d/i);
          const faqPage = jsonLdObjects(html).find((entry) => entry['@type'] === 'FAQPage');
          const faqAnswer = faqPage?.mainEntity?.find((entry) => entry.name === evidenceQuestion);
          assert.match(faqAnswer?.acceptedAnswer?.text || '', /observed dimension readings|dimensions have observed readings/);
          assert.doesNotMatch(faqAnswer?.acceptedAnswer?.text || '', /Observed feeds/);
          assert.match(faqAnswer?.acceptedAnswer?.text || '', new RegExp(faqLabel));
          assert.doesNotMatch(faqAnswer?.acceptedAnswer?.text || '', /overall score[^.]*\d|country rank[^.]*\d/i);
          // Coverage-story pages replace the shared "How to read this page" block,
          // including the score-disclosure paragraph and the snapshot comparability
          // note, with a country-specific reading guide; issue #7527 named those
          // shared frames as the duplication to remove. Pin the swap so restoring
          // any of them is a deliberate change, re-measured against the gates below.
          assert.match(html, /<h2>How to use this evidence<\/h2>/);
          assert.doesNotMatch(html, /<h2>How to read this page<\/h2>/);
          assert.doesNotMatch(html, /does not publish a resilience score for/);
          assert.doesNotMatch(html, /class="snapshot-note"/);
          assert.match(html, /href="\/docs\/corrections"/);
        }
        analysis.querySelectorAll('[data-country-faq]').forEach((node) => node.remove());
        unrankedArticles.push({
          code,
          route,
          text: analysis.textContent || '',
          mainText,
        });
        assert.match(html, /Nearest ranked comparators:/);
        assert.doesNotMatch(html, new RegExp(`\\b${code} · `));
        for (const peer of country.peers) {
          assert.ok(rankedNames.has(peer.name), `${route} peer ${peer.name} must be ranked`);
        }
      }
      const syria = read(outDir, 'countries/syria/index.html');
      assert.match(syria, /Macro-fiscal position/);
      assert.match(syria, /IMF/);
      const expectedMicrostateReadings = {
        TV: { id: 'borderSecurity', label: 'Border security', source: 'UCDP' },
        SM: { id: 'liquidReserveAdequacy', label: 'Liquid-reserve adequacy', source: 'World Bank' },
        MO: { id: 'importConcentration', label: 'Import concentration', source: 'UN Comtrade' },
      };
      for (const code of ['TV', 'SM', 'MO']) {
        const country = countryByCode.get(code);
        const html = read(outDir, `countries/${country.slug}/index.html`);
        const evidence = unpublishedHeadingParagraph(html, 'What the snapshot does cover');
        const expected = expectedMicrostateReadings[code];
        const dimension = country.domains
          .flatMap((domain) => domain.dimensions || [])
          .find((candidate) => candidate.id === expected.id);
        assert.ok(dimension, `${code} fixture must retain ${expected.id}`);
        const expectedReading = `${expected.label} ${Number(dimension.score).toFixed(1).replace(/\.0$/, '')} (${Math.round(Number(dimension.coverage) * 100)}%)`;
        assert.ok(evidence.includes(expectedReading), `${code} must publish ${expectedReading}`);
        assert.match(
          evidence,
          /supported dimension readings|dimensions carry usable observed inputs|dimension measurements backed by observed data/,
        );
        assert.match(evidence, new RegExp(expected.source));
        assert.doesNotMatch(evidence, /Observed feeds/);
        assert.match(evidence, /none is an overall score or country rank|rather than a hidden composite result|publication rule blocks an overall number/);
      }
      const andorra = read(outDir, 'countries/andorra/index.html');
      assert.doesNotMatch(andorra, /<summary>What is Andorra&#39;s Country Instability Index\?<\/summary>/);
      assert.equal(countryByCode.get('AD')?.lowConfidence, false);
      const andorraDataset = JSON.parse(read(outDir, 'countries/andorra/resilience.json'));
      assert.equal(andorraDataset.confidence, 'standard');
      assert.equal(andorraDataset.sourceStatus, 'unpublished');
      assert.match(andorra, /coverage is 69%/);
      assert.match(andorra, /recorded population of at least 200,000/);
      assert.match(andorra, /<span>Confidence<\/span><strong>Standard<\/strong>/);
      assert.doesNotMatch(andorra, /flagged low-confidence/);
      assert.doesNotMatch(
        andorra,
        /a low-confidence listing/,
        'covered-ineligible meta description must not call a standard-confidence snapshot low-confidence',
      );
      assert.match(andorra, /an unpublished listing/);
      assert.match(andorra, /in the rankable universe as a UN member/);
      assert.match(
        andorra,
        /Sovereign fiscal buffer<\/strong>: 0% coverage; not applicable/,
      );
      assert.doesNotMatch(
        andorra,
        /sovereign-wealth records does not contribute/,
      );
      const iraq = countryByCode.get('IQ');
      assert.ok(iraq, 'snapshot must include unpublished Iraq');
      const iraqHtml = read(outDir, 'countries/iraq/index.html');
      const iraqWhy = unpublishedHeadingParagraph(iraqHtml, 'Why Iraq is unpublished');
      assert.equal(iraqWhy, describeHeadlineIneligibilityReason(iraq));
      assert.match(iraqWhy, /recorded population of at least 200,000/);
      assert.doesNotMatch(iraqWhy, /below the 65% ranking floor/);
      assert.doesNotMatch(
        iraqHtml,
        /Iraq.{0,120}(fewer than 200,000|microstate)|microstate.{0,80}Iraq/,
        'Iraq copy must not imply the country is below the 200,000 population gate',
      );
      for (let left = 0; left < unrankedArticles.length; left += 1) {
        for (let right = left + 1; right < unrankedArticles.length; right += 1) {
          const share = pairwiseUniqueShare(unrankedArticles[left].text, unrankedArticles[right].text);
          assert.ok(
            share >= 0.4,
            `${unrankedArticles[left].route} and ${unrankedArticles[right].route} unranked pair must be at least 40% unique, got ${(share * 100).toFixed(1)}%`,
          );
        }
      }
      const microstateMainPages = unrankedArticles.filter(({ code }) => ['TV', 'SM', 'MO'].includes(code));
      for (let left = 0; left < microstateMainPages.length; left += 1) {
        for (let right = left + 1; right < microstateMainPages.length; right += 1) {
          const share = pairwiseUniqueShare(
            microstateMainPages[left].mainText,
            microstateMainPages[right].mainText,
          );
          assert.ok(
            share >= 0.4,
            `${microstateMainPages[left].route} and ${microstateMainPages[right].route} main content must be at least 40% unique, got ${(share * 100).toFixed(1)}%`,
          );
        }
      }
      const coverageStoryExpectations = {
        TV: { source: /World Bank/, reason: /very small reporting population falls below the standalone reporting thresholds/ },
        MO: { source: /WHO and Reporters Without Borders/, reason: /included in China series in others/ },
        SM: { source: /UN Comtrade/, reason: /Very small sovereign states do not receive a complete standalone record/ },
      };
      for (const [code, expected] of Object.entries(coverageStoryExpectations)) {
        const country = countryByCode.get(code);
        const html = read(outDir, `countries/${country.slug}/index.html`);
        const document = htmlDocument(html, `https://www.worldmonitor.app/countries/${country.slug}/`);
        const story = document.querySelector('[data-country-coverage-story]')?.textContent || '';
        assert.match(story, expected.source, `${country.name} must name its excluding source`);
        assert.match(story, expected.reason, `${country.name} must explain its own source gap`);
      }
      const similarity = auditMicrostateCorpusSimilarity({ corpusDir: outDir });
      for (const pair of similarity.pairs) {
        assert.ok(
          pair.jaccard <= similarity.threshold,
          `${pair.codes.join(' / ')} 5-gram Jaccard ${(pair.jaccard * 100).toFixed(1)}% must be within five points of the ${(similarity.floor.jaccard * 100).toFixed(1)}% ranked-page floor`,
        );
      }
      assert.ok(
        similarity.maskedSentenceSharing.share < 0.4,
        `masked sentences shared across TV / MO / SM must be below 40%, got ${(similarity.maskedSentenceSharing.share * 100).toFixed(1)}%`,
      );

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
      assert.equal(norwayWebPage?.mainEntity?.['@type'], 'Dataset');
      assert.equal(
        norwayLd.some((entry) => entry['@type'] === 'Dataset'),
        false,
        'generic country JSON-LD must keep its resilience Dataset embedded in WebPage.mainEntity',
      );
      assert.equal(norwayWebPage?.primaryImageOfPage?.['@type'], 'ImageObject');
      assert.equal(
        norwayWebPage?.primaryImageOfPage?.contentUrl,
        'https://www.worldmonitor.app/favico/og-image.png',
      );
      assert.ok(norwayLd.some((entry) => entry['@type'] === 'BreadcrumbList'));
      const switzerland = read(outDir, 'countries/switzerland/index.html');
      assert.match(switzerland, /<strong>Official name:<\/strong> Swiss Confederation/);
      const switzerlandWebPage = jsonLdObjects(switzerland).find((entry) => entry['@type'] === 'WebPage');
      assert.ok(switzerlandWebPage?.about?.alternateName?.includes('Swiss Confederation'));
      assert.equal(switzerlandWebPage?.about?.sameAs, 'https://www.wikidata.org/wiki/Q39');
      const norwayDataset = norwayLd
        .flatMap((entry) => collectDatasets(entry))
        .find((entry) => entry['@id']?.endsWith('#resilience-dataset'));
      assert.ok(norwayDataset, 'country page must expose a Dataset mainEntity');
      assert.equal(
        norwayDataset.dateModified,
        '2026-08-29',
        'country Dataset dateModified must stay pinned to the published snapshot',
      );
      assertSourceDerivedTemporalCoverage(norwayDataset, {
        route: '/countries/norway/',
        observationInterval: manifest.sections.countries.sourceCapturedAt,
        lastmod: pageLastmod(norway),
      });
      assert.equal(norwayDataset.isAccessibleForFree, true);
      assert.ok(norwayDataset.includedInDataCatalog?.['@id']?.includes('#data-catalog'));
      assert.match(
        JSON.stringify(norwayDataset.distribution),
        /\/countries\/norway\/resilience\.json/,
      );
      assert.doesNotMatch(
        JSON.stringify(norwayDataset.distribution),
        /\/api\//,
        'country Dataset downloads must be static artifacts, not API routes',
      );
      const norwaySnapshot = JSON.parse(read(outDir, 'countries/norway/resilience.json'));
      assert.equal(norwaySnapshot.countryCode, 'NO');
      assert.equal(norwaySnapshot.dataset, 'country-resilience-snapshot');
      assert.match(norway, /href="\/countries\/norway\/resilience\.json"/);
      assert.equal(
        norwayDataset.spatialCoverage?.identifier,
        'NO',
        'country Dataset spatialCoverage must identify the country by code',
      );
      assert.equal(
        norwayDataset.spatialCoverage?.geo?.['@type'],
        'GeoShape',
        'country Dataset spatialCoverage must carry the bbox as a GeoShape',
      );
      assertDataCatalogPresent(norway, '/countries/norway/');

      const chokepointsIndex = read(outDir, 'chokepoints/index.html');
      const chokepointsDocument = htmlDocument(
        chokepointsIndex,
        'https://www.worldmonitor.app/chokepoints/',
      );
      const chokepointRows = [...chokepointsDocument.querySelectorAll(
        'table[data-chokepoint-status] tbody tr',
      )];
      assert.equal(chokepointRows.length, corpusData.chokepoints.length);
      for (const chokepoint of corpusData.chokepoints) {
        const pulse = corpusData.livePulse.chokepoints[chokepoint.id];
        const row = chokepointRows.find((candidate) => (
          candidate.querySelector('a')?.getAttribute('href') === `/chokepoints/${chokepoint.slug}/`
        ));
        assert.ok(row, `chokepoint hub is missing ${chokepoint.displayName}`);
        assert.ok(row.querySelector('[data-hub-region]')?.textContent.trim());
        assert.equal(Number(row.querySelector('[data-hub-score]')?.textContent), Number(pulse.disruptionScore));
        assert.equal(row.querySelector('[data-hub-status]')?.textContent.trim(), pulse.status);
        assert.equal(
          row.querySelector('[data-hub-congestion]')?.textContent.trim(),
          pulse.aisSnapshotAvailable === true ? pulse.congestion : 'Not reported',
        );
        assert.equal(row.querySelector('time[data-hub-updated]')?.getAttribute('datetime'), pulse.asOf);
      }
      assert.ok(
        chokepointRows.some((row) => row.querySelector('[data-hub-score]')?.textContent.trim() === '0'),
        'chokepoint hub must publish a numeric zero score',
      );
      assert.match(chokepointsIndex, /Persian Gulf ↔ Gulf of Oman/);
      assert.ok(chokepointsIndex.includes(corpusData.sources.livePulseSnapshot));
      assert.ok(chokepointsIndex.includes(corpusData.sources.chokepointRegistry));
      assert.doesNotMatch(chokepointsIndex, /\b\d+ routes?\b/i, 'chokepoint index must not expose raw "N routes" counts');
      for (const chokepoint of corpusData.chokepoints.filter((entry) => entry.id.includes('_'))) {
        assert.ok(!chokepointsIndex.includes(chokepoint.id), `chokepoint hub must not expose raw id ${chokepoint.id}`);
      }
      const chokepointsLd = jsonLdObjects(chokepointsIndex);
      const chokepointCollection = chokepointsLd.find((entry) => entry['@type'] === 'CollectionPage');
      const chokepointDataset = chokepointsLd.find((entry) => entry['@type'] === 'Dataset');
      const chokepointItemList = chokepointsLd.find((entry) => entry['@type'] === 'ItemList');
      const chokepointFaq = chokepointsLd.find((entry) => entry['@type'] === 'FAQPage');
      const chokepointCatalog = chokepointsLd.find((entry) => entry['@type'] === 'DataCatalog');
      assert.ok(chokepointDataset && chokepointItemList && chokepointFaq && chokepointCatalog);
      assertDefaultSpeakable(chokepointCollection, 'chokepoints hub CollectionPage');
      assert.deepEqual(chokepointCollection.mainEntity, {
        '@id': 'https://www.worldmonitor.app/chokepoints/#status-dataset',
      });
      assert.deepEqual(chokepointDataset.mainEntity, {
        '@id': 'https://www.worldmonitor.app/chokepoints/#status-list',
      });
      assert.equal(chokepointItemList['@id'], 'https://www.worldmonitor.app/chokepoints/#status-list');
      assert.equal(chokepointItemList.numberOfItems, corpusData.chokepoints.length);
      assert.equal(chokepointItemList.itemListElement.length, corpusData.chokepoints.length);
      assert.equal(chokepointItemList.itemListOrder, 'https://schema.org/ItemListUnordered');
      assert.deepEqual(chokepointDataset.creator, {
        '@id': 'https://www.worldmonitor.app/#organization',
        '@type': 'Organization',
        name: 'World Monitor',
        url: 'https://www.worldmonitor.app/',
      });
      assert.ok(chokepointDataset.license);
      assert.equal(chokepointDataset.datePublished, corpusData.livePulse.capturedAt);
      const latestChokepointUpdate = Object.values(corpusData.livePulse.chokepoints)
        .map((pulse) => pulse.asOf)
        .sort()
        .at(-1);
      assert.equal(chokepointDataset.dateModified, latestChokepointUpdate);
      assert.equal(chokepointDataset.temporalCoverage, corpusData.livePulse.capturedAt);
      assert.ok(chokepointDataset.measurementTechnique);
      assert.ok(chokepointDataset.variableMeasured.length >= 3);
      assert.equal(chokepointDataset.distribution['@type'], 'DataDownload');
      assert.equal(chokepointDataset.includedInDataCatalog['@id'], chokepointCatalog['@id']);
      for (const [index, listEntry] of chokepointItemList.itemListElement.entries()) {
        const visibleRow = chokepointRows[index];
        assert.equal(listEntry.url, visibleRow.querySelector('a').href);
        assert.equal(listEntry.item.url, visibleRow.querySelector('a').href);
        const properties = Object.fromEntries(
          listEntry.item.additionalProperty.map((property) => [property.name, property.value]),
        );
        assert.equal(properties['Disruption score'], Number(visibleRow.querySelector('[data-hub-score]').textContent));
        assert.equal(properties.Status, visibleRow.querySelector('[data-hub-status]').textContent.trim());
        const itemPulse = corpusData.livePulse.chokepoints[corpusData.chokepoints[index].id];
        if (itemPulse?.aisSnapshotAvailable === true) {
          assert.equal(properties['AIS congestion'], visibleRow.querySelector('[data-hub-congestion]').textContent.trim());
        } else {
          assert.equal(properties['AIS congestion'], undefined);
        }
      }
      const chokepointFaqHeadings = [...chokepointsDocument.querySelectorAll('h2[data-chokepoint-hub-faq]')];
      const chokepointQuestions = chokepointFaqHeadings
        .map((heading) => heading.textContent.trim());
      assert.ok(chokepointQuestions.length >= 2 && chokepointQuestions.every((question) => question.endsWith('?')));
      assert.equal(chokepointFaq.mainEntity.length, chokepointQuestions.length);
      for (const question of chokepointQuestions) {
        const heading = chokepointFaqHeadings
          .find((candidate) => candidate.textContent.trim() === question);
        const visibleAnswer = heading.nextElementSibling?.textContent.trim();
        const schemaQuestion = chokepointFaq.mainEntity.find((entry) => entry.name === question);
        assert.equal(schemaQuestion?.acceptedAnswer?.text, visibleAnswer);
      }

      const [firstChokepoint] = corpusData.chokepoints;
      const validPulse = corpusData.livePulse.chokepoints[firstChokepoint.id];
      for (const [label, pulse] of [
        ['null score', { ...validPulse, disruptionScore: null }],
        ['empty score', { ...validPulse, disruptionScore: '' }],
        ['non-decimal score', { ...validPulse, disruptionScore: '40 points' }],
        ['negative score', { ...validPulse, disruptionScore: -1 }],
        ['score above 100', { ...validPulse, disruptionScore: 101 }],
        ['missing status', { ...validPulse, status: '' }],
        ['missing observed AIS congestion', { ...validPulse, congestion: '', aisSnapshotAvailable: true }],
        ['impossible timestamp', { ...validPulse, asOf: '2026-02-31T13:37:22.049Z' }],
      ]) {
        const invalidLivePulse = {
          ...corpusData.livePulse,
          chokepoints: {
            ...corpusData.livePulse.chokepoints,
            [firstChokepoint.id]: pulse,
          },
        };
        assert.throws(
          () => buildChokepointHubRows(corpusData.chokepoints, invalidLivePulse),
          new RegExp(`Chokepoint hub pulse is invalid for ${firstChokepoint.id}`),
          `${label} must fail the chokepoint hub build`,
        );
      }
      const missingPulse = {
        ...corpusData.livePulse,
        chokepoints: { ...corpusData.livePulse.chokepoints },
      };
      delete missingPulse.chokepoints[firstChokepoint.id];
      assert.throws(
        () => buildChokepointHubRows(corpusData.chokepoints, missingPulse),
        new RegExp(`missing ${firstChokepoint.id}`),
        'a missing registry member must fail the chokepoint hub build',
      );
      const extraPulse = {
        ...corpusData.livePulse,
        chokepoints: {
          ...corpusData.livePulse.chokepoints,
          obsolete_strait: validPulse,
        },
      };
      assert.throws(
        () => buildChokepointHubRows(corpusData.chokepoints, extraPulse),
        /unexpected obsolete_strait/,
        'an extra pulse key must fail the chokepoint hub build',
      );

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
      assert.match(hormuz, /about 20% of the world.s seaborne crude oil/);
      assert.doesNotMatch(hormuz, /a very large share of the world.s seaborne crude oil/);
      // Deep-link CTA into the live map (pans to + opens the waterway popup).
      assert.match(hormuz, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?chokepoint=hormuz_strait&amp;utm_source=seo-chokepoint">Open Strait of Hormuz on the live map/);
      assert.match(hormuz, /href="\/docs\/methodology\/chokepoints"/);
      // Human trade-route names replace the old raw route-id dump.
      assert.match(hormuz, /Persian Gulf → Europe \(Oil\)/);
      assert.doesNotMatch(hormuz, /Canonical ID|Energy baseline|Route IDs:/, 'chokepoint page must not dump raw registry fields');
      // Cross-link to the matching glossary term.
      assert.match(hormuz, /href="\/blog\/glossary\/strait-of-hormuz\/"/);
      assert.match(hormuz, /data-live-chokepoint data-chokepoint-id="hormuz_strait"/);
      assert.match(hormuz, /data-published-pulse/);
      assert.match(hormuz, /traffic-light badge is a disruption score, not an operational closure declaration/i);
      assert.ok(hormuz.includes(liveScriptTag), 'chokepoint live script must match the production CSP nonce');
      assert.doesNotMatch(hormuz, /id="app"/, 'chokepoint page must be raw static HTML, not the SPA shell');
      assert.doesNotMatch(hormuz, /Connecting…/);
      assert.doesNotMatch(hormuz, /data-chokepoint-score>—/);
      assert.doesNotMatch(hormuz, /data-chokepoint-band>Loading/);
      assert.match(hormuz, /<time data-live-updated datetime="20\d{2}-\d{2}-\d{2}T/);
      assert.match(hormuz, /data-chokepoint-score>\d/);
      // #7457: the frozen pulse stores todayTransits "0" with a non-zero WoW
      // for Hormuz. That 0 is an AIS-window zero-fill, not a measurement.
      assert.match(hormuz, /data-chokepoint-transits>—/);
      assert.doesNotMatch(
        hormuz,
        /data-chokepoint-transits>0</,
        'absent-feed chokepoint must not render a numeric 0 transit count',
      );
      assert.match(
        hormuz,
        /World Monitor is not currently publishing a transit count for Strait of Hormuz for this period/,
      );
      const hormuzDocument = htmlDocument(
        hormuz,
        'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/',
      );
      for (const selector of [
        '[data-chokepoint-warnings]',
        '[data-chokepoint-ais-disruptions]',
        '[data-chokepoint-congestion]',
      ]) {
        const metric = hormuzDocument.querySelector(selector)?.closest('.metric');
        assert.ok(metric, `${selector} must remain in SSR for hydration recovery`);
        assert.equal(metric.hidden, true, `${selector} must be hidden when its legacy flag is absent`);
      }
      assert.match(hormuz, /<span>Navigational warnings<\/span>/);
      assert.match(hormuz, /<span>AIS disruptions<\/span>/);
      assert.match(hormuz, /<span>AIS congestion<\/span>/);
      assert.match(hormuz, /data-chokepoint-movement>\+12\.9% vs prior week</);
      assert.doesNotMatch(
        hormuz,
        /AIS-derived feed has no data/,
        'the withhold note must not name AIS -- dataAvailable is PortWatch presence, so the count can be withheld while AIS is healthy',
      );
      assert.doesNotMatch(
        hormuz,
        /data-chokepoint-transits>0[\s\S]{0,400}data-chokepoint-movement>\+12\.9%/,
        'a page cannot show 0 transits and a non-zero WoW change together',
      );
      // Operator-facing review-hygiene text must never reach crawlable HTML.
      assert.doesNotMatch(
        hormuz,
        /review recommended/i,
        'internal threat-baseline review notes must not be published to crawlers',
      );

      const hormuzLd = jsonLdObjects(hormuz);
      const hormuzPage = hormuzLd.find((entry) => entry['@type'] === 'WebPage');
      assertDefaultSpeakable(hormuzPage, 'hormuz chokepoint WebPage');
      assert.ok(hormuzPage?.about?.['@type'] === 'Place' && hormuzPage.about?.name === 'Strait of Hormuz');
      const hormuzGeos = Array.isArray(hormuzPage.about.geo)
        ? hormuzPage.about.geo
        : [hormuzPage.about.geo].filter(Boolean);
      assert.ok(
        hormuzGeos.some((geo) => geo?.['@type'] === 'GeoCoordinates'),
        'chokepoint Place must keep GeoCoordinates',
      );
      const hormuzDataset = collectDatasets(hormuzPage)[0];
      assert.ok(hormuzDataset, 'chokepoint page must expose a Dataset mainEntity');
      assert.equal(
        hormuzDataset.dateModified,
        laterDate(corpusData.lastmod.chokepoints, DATASET_SCHEMA_CONTENT_VERSION.chokepoint),
        'chokepoint page template change must advance Dataset dateModified with page lastmod',
      );
      assert.equal(
        pageLastmod(hormuz),
        corpusData.lastmod.chokepoints,
        'chokepoint transit-withhold template change must advance page lastmod',
      );
      assertSourceDerivedTemporalCoverage(hormuzDataset, {
        route: '/chokepoints/strait-of-hormuz/',
        observationInterval: JSON.parse(read(outDir, 'chokepoints/strait-of-hormuz/reference.json')).capturedAt,
        lastmod: pageLastmod(hormuz),
      });
      const hormuzShapes = [
        ...hormuzGeos,
        hormuzDataset?.spatialCoverage?.geo,
      ].filter((geo) => geo?.['@type'] === 'GeoShape');
      assert.ok(hormuzShapes.length > 0, 'chokepoint Place/Dataset must include GeoShape corridor extent');
      assert.ok(
        typeof hormuzShapes[0].box === 'string' || typeof hormuzShapes[0].line === 'string',
        'chokepoint GeoShape must declare box or line coordinates',
      );
      assert.match(
        JSON.stringify(hormuzDataset.distribution),
        /\/chokepoints\/strait-of-hormuz\/reference\.json/,
      );
      assert.doesNotMatch(
        JSON.stringify(hormuzDataset.distribution),
        /\/api\//,
        'chokepoint Dataset downloads must be static artifacts, not API routes',
      );
      const hormuzReference = JSON.parse(read(outDir, 'chokepoints/strait-of-hormuz/reference.json'));
      assert.equal(hormuzReference.dataset, 'chokepoint-reference');
      assert.equal(hormuzReference.id, 'hormuz_strait');
      assert.ok(hormuzReference.capturedAt);
      assert.ok(hormuzReference.modelledTradeRoutes.length > 0);
      assert.equal(hormuzDataset.url, 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/');
      assert.equal(hormuzDataset.identifier, 'hormuz_strait');
      assert.equal(hormuzDataset.temporalCoverage, hormuzReference.capturedAt);
      const hormuzMeasurements = new Map(
        hormuzDataset.variableMeasured.map((measurement) => [measurement.name, measurement.value]),
      );
      assert.equal(hormuzMeasurements.get('Geographic coordinates'), '26.5°N, 56.5°E');
      assert.equal(hormuzMeasurements.get('Connected waters'), 'Persian Gulf ↔ Gulf of Oman');
      assert.equal(hormuzMeasurements.get('Energy shock model support'), 'Yes');
      assert.equal(hormuzMeasurements.get('Modelled trade routes'), hormuzReference.modelledTradeRoutes.length);
      assert.ok(
        hormuzDataset.variableMeasured.every((measurement) => measurement['@type'] === 'PropertyValue' && measurement.value != null && measurement.value !== ''),
        'chokepoint variableMeasured must be valued PropertyValue entries',
      );
      assert.doesNotMatch(
        JSON.stringify(hormuzDataset),
        /Disruption score|Congestion|AIS disruptions|Daily vessel transits/,
        'chokepoint Dataset metadata must describe the generated reference artifact, not live API fields',
      );
      // The deepEqual above already pins variableMeasured exactly, so an
      // object-shaped `{name: 'Transit count', value: 0}` entry cannot slip in.
      // This adds the case-insensitive bare-string form the alternation above
      // misses (it only names "Daily vessel transits").
      assert.doesNotMatch(
        JSON.stringify(hormuzDataset),
        /transit/i,
        'chokepoint Dataset must not carry a transit count in any casing -- the AIS window is not part of this reference artifact',
      );
      const additionalProps = Array.isArray(hormuzPage.about.additionalProperty)
        ? hormuzPage.about.additionalProperty
        : [hormuzPage.about.additionalProperty].filter(Boolean);
      assert.ok(
        additionalProps.some((prop) => prop.name === 'Connects'),
        'chokepoint Place must expose connects/routes as additionalProperty',
      );
      assertDataCatalogPresent(hormuz, '/chokepoints/strait-of-hormuz/');

      // A chokepoint with no modelled trade routes must degrade gracefully — never "0 routes".
      const dover = read(outDir, 'chokepoints/dover-strait/index.html');
      assert.doesNotMatch(dover, /0 routes?|none configured/);
      assert.match(dover, /tracked as a strategic waterway reference/);
      assert.match(dover, /<table data-chokepoint-routes>/);

      const corpus = await loadCorpusData({ rootDir: repoRoot });
      const chokepointArticles = [];
      for (const cp of corpus.chokepoints) {
        const route = `/chokepoints/${cp.slug}/`;
        const html = read(outDir, `chokepoints/${cp.slug}/index.html`);
        const document = htmlDocument(html, `https://www.worldmonitor.app${route}`);
        const analysis = document.querySelector('[data-chokepoint-analysis]');
        assert.ok(analysis, `${route} must render a chokepoint analysis block`);
        const faqEntries = [...document.querySelectorAll('[data-chokepoint-faq]')];
        assert.ok(
          faqEntries.length >= 2 && faqEntries.length <= 3,
          `${route} must show 2-3 FAQs`,
        );
        const pageLd = jsonLdObjects(html);
        const faqPage = pageLd.find((entry) => entry['@type'] === 'FAQPage');
        assert.equal(faqPage?.mainEntity?.length, faqEntries.length, `${route} FAQPage must match visible FAQs`);
        assert.match(
          analysis.querySelector('h2')?.textContent ?? '',
          /\?$/,
          `${route} analysis heading must be question-shaped`,
        );
        const table = document.querySelector('table[data-chokepoint-routes]');
        assert.ok(table, `${route} must publish a trade-route table`);
        assert.ok(
          table.querySelector('time[datetime]'),
          `${route} trade-route table must stamp figures with time datetime`,
        );
        assert.doesNotMatch(
          analysis.textContent,
          /no (corridor|trade-route) table/i,
          `${route} must not say the rendered corridor table is absent`,
        );
        assert.doesNotMatch(
          analysis.textContent,
          /(already in the|in the same) (trade-route )?table/i,
          `${route} must not claim off-page alternatives live in this page’s table`,
        );
        const articleWordCount = words(analysis.textContent).length;
        assert.ok(
          articleWordCount >= 400,
          `${route} analysis must contain at least 400 waterway-specific words, got ${articleWordCount}`,
        );
        const pageWordCount = words(document.querySelector('main')?.textContent).length;
        assert.ok(
          pageWordCount >= 600 && pageWordCount <= 1400,
          `${route} main content must contain 600-1400 words, got ${pageWordCount}`,
        );
        const dataset = pageLd.flatMap((entry) => collectDatasets(entry))[0];
        const reference = JSON.parse(read(outDir, `chokepoints/${cp.slug}/reference.json`));
        assert.equal(dataset.url, `https://www.worldmonitor.app${route}`);
        assert.equal(dataset.identifier, cp.id);
        assert.equal(dataset.temporalCoverage, reference.capturedAt);
        assert.ok(
          Array.isArray(dataset.variableMeasured)
            && dataset.variableMeasured.every((measurement) => (
              measurement['@type'] === 'PropertyValue'
              && measurement.value != null
              && measurement.value !== ''
            )),
          `${route} Dataset variableMeasured must be valued PropertyValue entries`,
        );
        const pageGeo = pageLd.find((entry) => entry['@type'] === 'WebPage')?.about?.geo;
        const geos = [pageGeo, dataset.spatialCoverage?.geo].flat().filter(Boolean);
        assert.ok(
          geos.some((geo) => geo?.['@type'] === 'GeoShape'),
          `${route} Place/Dataset must include GeoShape`,
        );
        chokepointArticles.push({ route, text: analysis.textContent });
      }
      const uniquenessSample = chokepointArticles.filter((entry) => (
        /strait-of-hormuz|suez-canal|panama-canal|dover-strait|taiwan-strait/.test(entry.route)
      ));
      assert.equal(uniquenessSample.length, 5, 'country-standard uniqueness sample must resolve five chokepoints');
      for (let left = 0; left < uniquenessSample.length; left += 1) {
        for (let right = left + 1; right < uniquenessSample.length; right += 1) {
          const share = pairwiseUniqueShare(uniquenessSample[left].text, uniquenessSample[right].text);
          assert.ok(
            share >= 0.4,
            `${uniquenessSample[left].route} and ${uniquenessSample[right].route} must be at least 40% unique, got ${(share * 100).toFixed(1)}%`,
          );
        }
      }

      // Drive the withhold expectation off the SNAPSHOT rather than off whichever
      // chokepoint happened to have AIS traffic on the freeze date.
      const pulseSnapshot = JSON.parse(
        readFileSync(resolve(repoRoot, corpus.sources.livePulseSnapshot), 'utf8'),
      );
      const chokepointSlugs = new Map(
        corpus.chokepoints.map((cp) => [cp.id, { slug: cp.slug, name: cp.displayName }]),
      );
      let publishedCounts = 0;
      let withheldCounts = 0;
      for (const [cpId, pulse] of Object.entries(pulseSnapshot.chokepoints ?? {})) {
        const meta = chokepointSlugs.get(cpId);
        if (!meta) continue;
        const page = read(outDir, `chokepoints/${meta.slug}/index.html`);
        const raw = Number(String(pulse.todayTransits ?? '').replace(/,/g, ''));
        const noteRe = new RegExp(
          `World Monitor is not currently publishing a transit count for ${meta.name} for this period`,
        );
        const countsAvailable = pulse.todayCountsAvailable ?? (Number.isFinite(raw) && raw >= 1);
        if (countsAvailable && (raw === 0 || raw >= 1)) {
          publishedCounts++;
          assert.match(
            page,
            new RegExp(`data-chokepoint-transits>${pulse.todayTransits}<`),
            `${meta.name} has a supplied count of ${pulse.todayTransits} and must publish it`,
          );
          assert.doesNotMatch(page, noteRe, `${meta.name} publishes a count and must not carry the withhold note`);
          assert.ok(
            page.includes(`data-chokepoint-movement>${pulse.weekMovement ?? 'Unavailable'}<`),
            `${meta.name} has a supplied count and must keep week movement visible`,
          );
        } else {
          withheldCounts++;
          assert.match(page, /data-chokepoint-transits>—/);
          assert.doesNotMatch(
            page,
            /data-chokepoint-transits>0</,
            `${meta.name} must not render a numeric 0 for an unsupplied transit count`,
          );
          assert.ok(
            page.includes(`data-chokepoint-movement>${pulse.weekMovement ?? '—'}<`),
            `${meta.name} must keep week movement independent from today's count`,
          );
          assert.match(page, noteRe);
        }
        const pageDocument = htmlDocument(page, `https://www.worldmonitor.app/chokepoints/${meta.slug}/`);
        for (const selector of [
          '[data-chokepoint-warnings]',
          '[data-chokepoint-ais-disruptions]',
          '[data-chokepoint-congestion]',
        ]) {
          assert.equal(
            pageDocument.querySelector(selector)?.closest('.metric')?.hidden,
            true,
            `${meta.name} legacy source flag must fail closed for ${selector}`,
          );
        }
      }
      assert.equal(
        publishedCounts + withheldCounts,
        Object.keys(pulseSnapshot.chokepoints ?? {}).length,
        'every frozen chokepoint pulse must map to a generated page',
      );
      assert.ok(withheldCounts > 0, 'the freeze must exercise the withhold path');

      const crisesIndex = read(outDir, 'crises/index.html');
      assert.match(crisesIndex, /<h1>Current crisis trackers<\/h1>/);
      assert.match(crisesIndex, /href="\/crises\/red-sea-security\/"/);
      assertDataCatalogPresent(crisesIndex, '/crises/');
      assertDefaultSpeakable(
        jsonLdObjects(crisesIndex).find((entry) => entry['@type'] === 'CollectionPage'),
        'crises hub CollectionPage',
      );

      const redSea = read(outDir, 'crises/red-sea-security/index.html');
      assert.match(redSea, /data-live-crisis/);
      assert.match(redSea, /data-country-code="YE" data-country-name="Yemen"/);
      assert.match(redSea, /Missing countries are unavailable, not zero/);
      assert.match(redSea, /HAPI\/HDX humanitarian conflict summaries/);
      assert.ok(redSea.includes(liveScriptTag), 'crisis live script must match the production CSP nonce');
      assert.doesNotMatch(redSea, /id="app"/);
      assert.doesNotMatch(redSea, /Connecting…/);
      assert.doesNotMatch(redSea, /data-crisis-events>—/);
      assert.doesNotMatch(redSea, /data-crisis-period>Loading/);
      // The pulse stores these as already-formatted display strings, so the withholding
      // guard must not round-trip them through Number() and drop the separators.
      for (const crisis of corpus.crises) {
        const pulse = corpus.livePulse.crises?.[crisis.slug];
        if (!pulse) continue;
        const html = read(outDir, `crises/${crisis.slug}/index.html`);
        for (const [key, attribute] of [
          ['eventsTotal', 'data-crisis-events'],
          ['fatalities', 'data-crisis-fatalities'],
          ['politicalViolenceEvents', 'data-crisis-political'],
        ]) {
          if (pulse[key] == null) continue;
          assert.match(
            html,
            new RegExp(`${attribute}>${String(pulse[key]).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}<`),
            `${crisis.slug} must render ${key} exactly as the pulse formatted it`,
          );
        }
      }
      assert.match(redSea, /<time data-live-updated datetime="20\d{2}-\d{2}-\d{2}T/);
      assert.match(redSea, /Maintained month snapshot/);
      assert.match(redSea, /data-crisis-period>20\d{2}-\d{2}-\d{2}/);
      const redSeaLd = jsonLdObjects(redSea);
      const redSeaPage = redSeaLd.find((entry) => entry['@type'] === 'WebPage');
      assertDefaultSpeakable(redSeaPage, 'red-sea crisis WebPage');
      const redSeaDataset = collectDatasets(redSeaPage)[0];
      assert.ok(redSeaDataset, 'crisis page must expose a Dataset mainEntity');
      const redSeaReference = JSON.parse(read(outDir, 'crises/red-sea-security/tracker.json'));
      assertSourceDerivedTemporalCoverage(redSeaDataset, {
        route: '/crises/red-sea-security/',
        observationInterval: redSeaReference.maintainedPulse?.referencePeriod,
        publishedDate: corpus.livePulse.capturedAt,
        lastmod: pageLastmod(redSea),
      });
      assert.equal(
        redSeaDataset.dateModified,
        laterDate(corpus.lastmod.crises, DATASET_SCHEMA_CONTENT_VERSION.crisis),
        'changed crisis Dataset schema must advance only the crisis family stamp',
      );
      assert.equal(
        pageLastmod(redSea),
        corpus.lastmod.crises,
        'crisis page lastmod must advance with its changed Dataset schema',
      );
      assert.equal(
        sitemapEntries.find((entry) => (
          new URL(entry.loc).pathname === '/crises/red-sea-security/'
        ))?.lastmod,
        corpus.lastmod.crises,
        'crisis sitemap lastmod must advance with its changed Dataset schema',
      );
      assert.equal(redSeaDataset.isAccessibleForFree, true);
      assert.match(
        JSON.stringify(redSeaDataset.distribution),
        /\/crises\/red-sea-security\/tracker\.json/,
      );
      assert.doesNotMatch(
        JSON.stringify(redSeaDataset.distribution),
        /\/api\//,
        'crisis Dataset downloads must be static artifacts, not API routes',
      );
      assert.equal(redSeaReference.dataset, 'crisis-tracker');
      assert.ok(redSeaReference.coverage.some((country) => country.code === 'YE'));
      assert.ok(redSeaReference.maintainedPulse?.referencePeriod);
      // The download is a machine-readable artifact: totals must be numbers, not
      // Intl-formatted display strings like "9,824".
      for (const key of ['eventsTotal', 'fatalities', 'politicalViolenceEvents']) {
        const value = redSeaReference.maintainedPulse[key];
        assert.equal(
          typeof value,
          'number',
          `maintainedPulse.${key} must be a raw number, got ${JSON.stringify(value)}`,
        );
      }
      assert.equal(
        redSeaReference.maintainedPulse.eventsTotal,
        redSeaReference.maintainedPulse.rows.reduce((total, row) => total + row.events, 0),
        'maintainedPulse.eventsTotal must equal the sum of its published rows',
      );
      assert.deepEqual(redSeaDataset.variableMeasured, [
        { '@type': 'PropertyValue', name: 'Tracker scope', value: 'Red Sea security' },
        { '@type': 'PropertyValue', name: 'Covered countries', value: 4, unitText: 'countries' },
        { '@type': 'PropertyValue', name: 'Recorded conflict events', value: redSeaReference.maintainedPulse.eventsTotal, unitText: 'events' },
        { '@type': 'PropertyValue', name: 'Recorded fatalities', value: redSeaReference.maintainedPulse.fatalities, unitText: 'fatalities' },
        { '@type': 'PropertyValue', name: 'Political violence events', value: redSeaReference.maintainedPulse.politicalViolenceEvents, unitText: 'events' },
        { '@type': 'PropertyValue', name: 'Humanitarian reference period', value: redSeaReference.maintainedPulse.referencePeriod },
      ]);
      assert.equal(redSeaDataset['@id'], 'https://www.worldmonitor.app/crises/red-sea-security/#crisis-dataset');
      assert.equal(redSeaDataset.url, 'https://www.worldmonitor.app/crises/red-sea-security/');
      assert.equal(redSeaDataset.identifier, 'crisis-tracker-red-sea-security');
      assert.equal(redSeaDataset.datePublished, corpus.livePulse.capturedAt);
      assert.match(redSeaDataset.measurementTechnique, /HAPI\/HDX/);
      assertDataCatalogPresent(redSea, '/crises/red-sea-security/');

      const toolsIndex = read(outDir, 'tools/index.html');
      assert.match(toolsIndex, /<h1>Check a current operational signal<\/h1>/);
      assertDefaultSpeakable(
        jsonLdObjects(toolsIndex).find((entry) => entry['@type'] === 'CollectionPage'),
        'tools hub CollectionPage',
      );
      const useCasesIndex = read(outDir, 'use-cases/index.html');
      assertDefaultSpeakable(
        jsonLdObjects(useCasesIndex).find((entry) => entry['@type'] === 'CollectionPage'),
        'use-cases hub CollectionPage',
      );
      const breakingNews = read(outDir, 'use-cases/verify-breaking-news/index.html');
      const breakingNewsLd = jsonLdObjects(breakingNews);
      assertDefaultSpeakable(
        breakingNewsLd.find((entry) => entry['@type'] === 'WebPage'),
        'breaking-news WebPage',
      );
      assert.ok(
        breakingNewsLd.some((entry) => entry['@type'] === 'HowTo'),
        'HowTo-shaped use-case pages must emit HowTo JSON-LD (#7462)',
      );
      assert.match(toolsIndex, /href="\/tools\/natural-hazard-pulse\/"/);
      assert.match(toolsIndex, /href="\/tools\/airspace-disruption-checker\/"/);
      assert.match(toolsIndex, /href="\/tools\/signal-convergence\/"/);

      const convergence = read(outDir, 'tools/signal-convergence/index.html');
      assert.match(convergence, /Geographic Convergence Score/);
      assert.match(convergence, /type_score = event_types × 25/);
      assert.match(convergence, /Taiwan Strait Buildup/);
      assert.match(convergence, /<strong>87<\/strong>/);
      assert.match(convergence, /href="\/docs\/geographic-convergence"/);
      assert.doesNotMatch(convergence, /id="app"/);
      const convergencePage = jsonLdObjects(convergence).find((entry) => entry['@type'] === 'WebPage');
      const convergenceDataset = collectDatasets(convergencePage)[0];
      assert.equal(convergenceDataset['@id'], 'https://www.worldmonitor.app/tools/signal-convergence/#signal-convergence-dataset');
      assert.equal(convergenceDataset.url, 'https://www.worldmonitor.app/tools/signal-convergence/');
      const convergenceCapturedAt = corpus.livePulse.signalConvergence.capturedAt;
      assert.equal(convergenceDataset.identifier, `signal-convergence-${convergenceCapturedAt}`);
      assert.equal(convergenceDataset.datePublished, convergenceCapturedAt);
      assert.equal(convergenceDataset.spatialCoverage, 'Worldwide');
      assert.equal(convergenceDataset.variableMeasured[1].value, 3);
      assert.equal(convergenceDataset.variableMeasured[2].value, 3);

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
      assert.match(
        changelogIndex,
        /name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"/,
      );
      assert.match(changelogPage2, /<link rel="prev" href="https:\/\/www\.worldmonitor\.app\/reference\/changelog\/">/);
      assert.match(changelogPage2, /name="robots" content="noindex, follow"/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('uses the same chokepoint timestamp window as the freeze producer', async () => {
    const corpusData = await loadCorpusData({ rootDir: repoRoot });
    const [firstChokepoint] = corpusData.chokepoints;
    const validPulse = corpusData.livePulse.chokepoints[firstChokepoint.id];
    const capturedAtMs = corpusData.livePulse.capturedAtMs;
    const isoFromCapture = (offsetMs) => new Date(capturedAtMs + offsetMs).toISOString();
    const withAsOf = (asOf) => ({
      ...corpusData.livePulse,
      chokepoints: {
        ...corpusData.livePulse.chokepoints,
        [firstChokepoint.id]: { ...validPulse, asOf },
      },
    });
    const invalidFor = (asOf, label) => {
      assert.throws(
        () => buildChokepointHubRows(corpusData.chokepoints, withAsOf(asOf)),
        new RegExp(`Chokepoint hub pulse is invalid for ${firstChokepoint.id}`),
        label,
      );
    };

    assert.doesNotThrow(
      () => buildChokepointHubRows(corpusData.chokepoints, withAsOf(isoFromCapture(-47 * 60 * 60 * 1000))),
      'a fetchedAt 47 hours before capturedAtMs must remain accepted',
    );
    invalidFor(
      isoFromCapture(-MAX_LIVE_SNAPSHOT_AGE_MS - 1),
      'a fetchedAt older than 48 hours before capturedAtMs must fail',
    );
    invalidFor(
      isoFromCapture(MAX_FUTURE_SKEW_MS + 1),
      'a fetchedAt beyond the 5-minute future-skew limit must fail',
    );
    assert.doesNotThrow(
      () => buildChokepointHubRows(corpusData.chokepoints, corpusData.livePulse),
      'committed same-day asOf values must remain accepted',
    );
  });

  it('loads deterministic source data without network access', async () => {
    const data = await loadCorpusData({ rootDir: repoRoot });
    assert.match(
      data.sources.resilienceSnapshot,
      /^docs\/snapshots\/resilience-ranking-\d{4}-\d{2}-\d{2}\.json$/,
    );
    assert.match(
      data.sources.livePulseSnapshot,
      /^docs\/snapshots\/crawlable-live-pulse-\d{4}-\d{2}-\d{2}\.json$/,
    );
    assert.equal(data.sources.liveToolsScript, 'scripts/crawlable-live-tools.mjs');
    assert.equal(data.sources.countryBboxes, 'shared/country-bboxes.js');
    assert.equal(data.sources.crisisRegistry, 'shared/crawlable-crises.json');
    assert.equal(data.sources.sourcePageRenderer, 'scripts/crawlable-sources-page.mjs');
    assert.equal(data.sources.sourceOrigin, 'scripts/source-origin.mjs');
    assert.deepEqual(data.sources.sourceCatalogInputs, SOURCE_CATALOG_LASTMOD_PATHS);
    assert.equal(data.sources.sharedPageTemplate, 'scripts/build-crawlable-corpus.mjs');
    assert.match(data.resilience.capturedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(data.sources.resilienceSnapshot.includes(data.resilience.capturedAt));
    // Family lastmods use material + page versions + pulse where the HTML
    // publishes pulse values. CORPUS_GENERATOR_CONTENT_VERSION stays out
    // (#7463). Research lastmod is the report dateModified, not a rebuild stamp.
    // Do not pin a calendar date: freeze:crawlable-live-pulse advances capturedAt.
    assert.equal(
      data.lastmod.countries,
      laterDate(
        data.resilience.capturedAt,
        data.livePulse.capturedAt,
        gitFileLastmod(repoRoot, data.sources.countryRegions),
        COUNTRY_PAGE_CONTENT_VERSION,
      ),
      'countries lastmod must fold snapshot, pulse, regions and the page content version',
    );
    // #7518 set COUNTRY_PAGE_CONTENT_VERSION and CII_COUNTRY_PAGE_CONTENT_VERSION
    // to the same date, so the two clocks coincide by value. Pin the DERIVATION
    // instead, which stays falsifiable if either constant moves.
    assert.equal(
      data.lastmod.ciiCountries,
      laterDate(data.lastmod.countries, CII_COUNTRY_PAGE_CONTENT_VERSION),
      'the CII country clock must derive from the generic country clock',
    );
    assert.equal(data.lastmod.research, '2026-07-27');
    assert.equal(
      data.lastmod.chokepoints,
      laterDate(
        ...CHOKEPOINT_PAGE_LASTMOD_PATHS.map((path) => gitFileLastmod(repoRoot, path)),
        data.livePulse.capturedAt,
        CHOKEPOINT_PAGE_CONTENT_VERSION,
      ),
      'chokepoints lastmod must fold every material page input, the pulse and the content version',
    );
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
    assert.ok(data.countries.some((country) => country.slug === 'norway' && Number.isInteger(country.rank)));
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
