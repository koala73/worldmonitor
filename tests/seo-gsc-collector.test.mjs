import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  assertNoSecrets,
  collectGscSnapshot,
  createFixtureTransport,
  createLiveTransport,
  createServiceAccountAssertion,
  decodeServiceAccount,
  buildNonBrandQueries,
  buildQueryPages,
  describeDisagreement,
  buildInventory,
  BRAND_QUERY_PATTERN,
  isBrandQuery,
  queryCell,
  pickIndexStatus,
  QuotaExhaustedError,
  weeklyTotals,
  renderGscMarkdown,
  runCli,
  stratifiedSample,
  toScorecardSearchExport,
} from '../scripts/seo-gsc-collect.mjs';
import { normalizeSearchExport } from '../scripts/seo-ai-visibility-collector.mjs';
import { computeQuerySetDigest } from '../scripts/seo-ai-visibility-scorecard.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;

const FIXTURES = 'tests/fixtures/gsc/';
const silent = () => {};

const collect = async (fixtures = FIXTURES) => {
  const { snapshot, markdown } = await runCli(
    ['--fixtures', fixtures, '--stdout'],
    { log: silent },
  );
  return { snapshot, markdown };
};

/**
 * The repository is public: a query's text needs one page with 20 impressions,
 * and a page is a bare www path that cannot carry a tracking parameter.
 */
const assertPublishableQueryPages = (list, label) => {
  for (const row of list.rows) {
    assert.ok(row.pages[0].impressions >= 20, `${label}: "${row.query}" is published below the floor`);
    assert.ok(row.pages.length <= 10, `${label}: "${row.query}" lists more than 10 pages`);
    for (const page of row.pages) {
      assert.match(page.path, /^\/[^?#]*$/, `${label}: "${row.query}" names ${page.path}, not a bare path`);
    }
  }
  assert.ok(list.rows.length <= 500, `${label}: more than 500 queries`);
};

const querySet = JSON.parse(
  readFileSync(repoPath('docs/research/seo-ai-visibility/query-set.json'), 'utf8'),
);

describe('Search Console collector', () => {
  it('produces the same snapshot from the same fixtures', async () => {
    const first = await collect();
    const second = await collect();
    assert.deepEqual(first.snapshot, second.snapshot);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.snapshot.observedAt, '2026-09-24T00:00:00Z');
    assert.equal(first.snapshot.snapshotId, 'gsc-2026-09-24');
  });

  it('writes a dated snapshot and a markdown summary', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-gsc-'));
    try {
      const { written } = await runCli(
        ['--fixtures', FIXTURES, '--out-dir', outDir],
        { log: silent },
      );
      assert.deepEqual(
        readdirSync(outDir).sort(),
        ['2026-09-24.json', '2026-09-24.md'],
      );
      for (const path of written) assert.ok(statSync(path).size > 0, path);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('pages past a row-limit boundary instead of stopping at the first page', async () => {
    const { snapshot } = await collect();
    const window28 = snapshot.performance.windows.find((entry) => entry.label === '28d');
    // Page 0 of the recording holds exactly rowLimit rows, so a collector that
    // does not paginate would report 3 and miss the rest.
    assert.equal(window28.rowCounts.page, 5);
    const countries = window28.byFamily.country_pages;
    assert.ok(countries, 'the second page contributed a family the first page did not');
    assert.equal(countries.impressions, 44);
    assert.equal(window28.status, 'available');
  });

  it('keeps the rows it collected when the quota runs out mid-pagination', async () => {
    const { snapshot } = await collect();
    const window90 = snapshot.performance.windows.find((entry) => entry.label === '90d');
    assert.equal(window90.status, 'partial');
    assert.match(window90.reason, /quota was exhausted/);
    // The rows already collected stay. A quota-exhausted run must not report
    // zero, because zero is a measurement and this is an absence of one.
    assert.equal(window90.rowCounts.query, 3);
    assert.ok(window90.totals.impressions > 0);
    assert.equal(snapshot.performance.status, 'partial');
    assert.ok(snapshot.samplingNotes.some((note) => note.includes('quota was exhausted')));
  });

  it('stops inspecting and says so when the urlInspection quota runs out', async () => {
    const { snapshot } = await collect(`${FIXTURES}quota/`);
    assert.equal(snapshot.indexation.status, 'partial');
    assert.match(snapshot.indexation.reason, /quota was exhausted/);
    assert.ok(snapshot.indexation.sample.inspected < snapshot.inventory.declared);
    assert.equal(snapshot.indexation.sample.complete, false);
    assert.equal(snapshot.indexation.sample.extrapolated, false);
  });

  it('records a googleCanonical that differs from the declared canonical', async () => {
    const { snapshot } = await collect();
    const mismatches = snapshot.indexation.canonicalMismatches;
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].url, 'https://www.worldmonitor.app/compare/worldmonitor-vs-acled/');
    assert.equal(mismatches[0].googleCanonical, 'https://www.worldmonitor.app/compare/');
    assert.notEqual(mismatches[0].googleCanonical, mismatches[0].userCanonical);
  });

  it('fails the run on a URL that maps to no family', async () => {
    await assert.rejects(
      () => collect(`${FIXTURES}unmapped/`),
      /does not map to a page family/,
    );
  });

  it('flags a live status that contradicts the recorded coverage state', async () => {
    const { snapshot } = await collect();
    const flagged = snapshot.indexation.liveStateDisagreements;
    const redirected = flagged.find(
      (row) => row.url === 'https://www.worldmonitor.app/crises/sudan-conflict/',
    );
    assert.ok(redirected, 'a recorded 404 that now redirects must be flagged');
    assert.equal(redirected.coverageState, 'Not found (404)');
    assert.equal(redirected.liveStatus, 301);
    assert.equal(redirected.disagreement, 'google-recorded-404-live-redirects');
    // Flagged, not resolved: the coverage state is still reported as Google
    // recorded it, so a reader sees both numbers rather than a silent fix.
    assert.equal(
      snapshot.indexation.byFamily.crises.coverageStates['Not found (404)'],
      1,
    );
  });

  it('carries a host dimension for the apex and the variant hosts', async () => {
    const { snapshot } = await collect();
    assert.deepEqual(
      Object.keys(snapshot.inventory.byHost).sort(),
      ['tech.worldmonitor.app', 'worldmonitor.app', 'www.worldmonitor.app'],
    );
    assert.equal(snapshot.indexation.byHost['worldmonitor.app'].declared, 1);
    assert.equal(snapshot.indexation.byHost['tech.worldmonitor.app'].indexed, 1);
    // Without the host dimension the www denominator would absorb both.
    assert.equal(snapshot.indexation.byHost['www.worldmonitor.app'].declared, 13);
  });

  it('reports HTML indexability apart from subresources and markdown twins', async () => {
    const { snapshot } = await collect();
    const { byKind, htmlPages } = snapshot.indexation;
    assert.equal(byKind.subresource.crawledNotIndexed, 1);
    assert.equal(byKind.subresource.servingNoindex, 1);
    assert.equal(byKind['markdown-twin'].crawledNotIndexed, 1);
    // The headline counts only HTML, and only the cell that warrants
    // attention: crawled, declined, no noindex, still answering as HTML.
    assert.equal(htmlPages.crawledNotIndexed, 1);
    assert.equal(htmlPages.actionable, 1);
    assert.equal(
      htmlPages.actionableUrls[0].url,
      'https://www.worldmonitor.app/countries/france/',
    );
    assert.equal(htmlPages.indexedShare.basis, 'inspected-html');
  });

  it('records a content-type that contradicts the URL extension', async () => {
    const { snapshot } = await collect();
    const disagreements = snapshot.indexation.kindDisagreements;
    assert.equal(disagreements.length, 1);
    assert.equal(disagreements[0].url, 'https://www.worldmonitor.app/pricing.md');
    assert.equal(disagreements[0].declaredKind, 'markdown-twin');
    assert.equal(disagreements[0].observedKind, 'html');
  });

  it('keeps an unmeasured value null with a reason rather than zero', async () => {
    const { snapshot } = await collect();
    // The blog post has no recorded inspection. Reporting it as not indexed
    // would invent a measurement.
    const blog = snapshot.indexation.byFamily.blog;
    assert.equal(blog.inspected, 1);
    assert.equal(blog.indexed, null);
    assert.match(blog.indexedReason, /no URL in this group returned an index status/);
    assert.equal(blog.indexedShare.value, null);
    const window28 = snapshot.performance.windows.find((entry) => entry.label === '28d');
    assert.equal(window28.byFamily.blog.ctr, null);
    assert.equal(window28.byFamily.blog.impressionsPerIndexedUrl, null);
    assert.match(
      window28.byFamily.blog.impressionsPerIndexedUrlReason,
      /no URL in this family was confirmed indexed/,
    );
  });

  it('labels a capped export and never projects its share onto the reported total', async () => {
    const { snapshot, markdown } = await collect();
    const capped = snapshot.samplingNotes.find((note) => note.includes('1486'));
    assert.ok(capped, 'a reported total larger than the rows seen must be labelled');
    assert.match(capped, /capped/);
    assert.match(capped, /Do not multiply a share/);
    const complete = snapshot.samplingNotes.find((note) => note.includes('Not found (404)'));
    assert.match(complete, /complete/);
    assert.match(markdown, /Do not multiply a share/);
    const shares = [
      snapshot.indexation.htmlPages.indexedShare,
      ...Object.values(snapshot.indexation.byFamily).map((entry) => entry.indexedShare),
      ...Object.values(snapshot.indexation.byKind).map((entry) => entry.indexedShare),
    ];
    for (const value of shares) {
      assert.equal(value.extrapolated, false);
      assert.ok(['inspected', 'inspected-html'].includes(value.basis), value.basis);
    }
  });

  it('samples every family before giving any family a second slot', () => {
    const urls = [
      ...Array.from({ length: 10 }, (_, index) => ({
        url: `https://www.worldmonitor.app/countries/c${index}/`,
        family: 'country_pages',
      })),
      { url: 'https://www.worldmonitor.app/tools/a/', family: 'tools' },
      { url: 'https://www.worldmonitor.app/compare/a/', family: 'compare' },
    ];
    const picked = stratifiedSample(urls, 3);
    assert.deepEqual(
      [...new Set(picked.map((entry) => entry.family))].sort(),
      ['compare', 'country_pages', 'tools'],
    );
    assert.equal(stratifiedSample(urls, 99).length, 12);
  });

  it('feeds the per-family numbers into the existing scorecard contract', async () => {
    const { snapshot } = await collect();
    const normalized = normalizeSearchExport(toScorecardSearchExport(snapshot), {
      querySet,
      observedAt: '2026-09-24T00:00:00Z',
      provider: 'Google Search Console',
      schemaVersion: 2,
    });
    assert.equal(normalized.property, null);
    assert.deepEqual(
      normalized.windows.map((window) => window.label).sort(),
      ['28d', '90d'],
    );
    const homepage = normalized.pageFamilyRows.find(
      (row) => row.windowLabel === '28d' && row.pageFamily === 'homepage',
    );
    assert.equal(homepage.metrics.impressions, 2100);
    assert.equal(homepage.metrics.indexedPages, 1);
  });
});

describe('Search Console collector secrecy', () => {
  const MARKERS = ['private_key', 'client_email', 'sc-domain:', 'inspectionResultLink', 'BEGIN PRIVATE KEY'];

  it('leaves the property identifier out of the picked index status', () => {
    const response = JSON.parse(
      readFileSync(repoPath('tests/fixtures/gsc/url-inspection.json'), 'utf8'),
    )['https://www.worldmonitor.app/'];
    // The recording deliberately carries the link that embeds the property id.
    // If it did not, this test could not fail and would prove nothing.
    assert.match(JSON.stringify(response), /sc-domain:/);
    assert.equal(JSON.stringify(pickIndexStatus(response)).includes('sc-domain:'), false);
    assert.equal(pickIndexStatus(response).coverageState, 'Submitted and indexed');
    assert.equal(pickIndexStatus({}), null);
  });

  it('greps the generated snapshot and summary for credential markers', async () => {
    const { snapshot, markdown } = await collect();
    const serialized = JSON.stringify(snapshot);
    for (const marker of MARKERS) {
      assert.equal(serialized.includes(marker), false, `snapshot leaked ${marker}`);
      assert.equal(markdown.includes(marker), false, `summary leaked ${marker}`);
    }
    assert.equal(snapshot.property, null);
    assert.equal(snapshot.propertyKind, 'domain');
  });

  it('refuses to write output that contains a marker or the property id', () => {
    for (const marker of MARKERS) {
      assert.throws(
        () => assertNoSecrets(`{"note":"${marker}"}`),
        /refusing to write output/,
      );
    }
    assert.throws(
      () => assertNoSecrets('{"note":"opaque-property-42"}', { property: 'opaque-property-42' }),
      /property identifier/,
    );
    assert.equal(assertNoSecrets('{"ok":true}', { property: 'sc-domain:example.test' }), '{"ok":true}');
  });

  it('publishes query pages only above the floor and as bare paths in every committed snapshot', () => {
    assert.throws(
      () => assertPublishableQueryPages({ rows: [{ query: 'rare', pages: [{ path: '/', impressions: 19 }] }] }, 'probe'),
      /below the floor/,
    );
    assert.throws(
      () => assertPublishableQueryPages({ rows: [{ query: 'q', pages: [{ path: 'https://www.worldmonitor.app/', impressions: 20 }] }] }, 'probe'),
      /not a bare path/,
    );
    const directory = repoPath('docs/research/seo-ai-visibility/gsc');
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
      const snapshot = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const list = snapshot.performance?.queryPages;
      if (list) assertPublishableQueryPages(list, name);
    }
  });

  it('keeps every committed research artifact free of credential markers', () => {
    const root = repoPath('docs/research/seo-ai-visibility');
    const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
    const files = walk(root);
    assert.ok(files.length > 0, 'the research directory must not be empty');
    for (const path of files) {
      const contents = readFileSync(path, 'utf8');
      for (const marker of MARKERS) {
        assert.equal(contents.includes(marker), false, `${path} contains ${marker}`);
      }
    }
  });
});

describe('Search Console service-account assertion', () => {
  it('signs a verifiable assertion without reading a credential from disk', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = {
      client_email: 'collector@example.iam.gserviceaccount.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    const encoded = Buffer.from(JSON.stringify(serviceAccount)).toString('base64');
    const decoded = decodeServiceAccount(encoded);
    assert.equal(decoded.client_email, serviceAccount.client_email);

    const assertion = createServiceAccountAssertion(decoded, { nowSeconds: 1_700_000_000 });
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(verified, true);
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
    assert.equal(payload.exp - payload.iat, 3600);
  });

  it('rejects a key that is not base64-encoded JSON', () => {
    assert.throws(() => decodeServiceAccount('not-a-key'), /not base64-encoded JSON/);
    assert.throws(() => decodeServiceAccount(''), /is empty/);
    assert.throws(
      () => decodeServiceAccount(Buffer.from('{"client_email":"a@b.test"}').toString('base64')),
      /missing private_key/,
    );
  });
});

describe('Search Console collector units', () => {
  it('counts a sitemap index by its children rather than as a page', () => {
    const inventory = buildInventory([
      {
        url: 'https://www.worldmonitor.app/sitemap.xml',
        xml: '<sitemapindex><sitemap><loc>https://www.worldmonitor.app/sitemap-main.xml</loc></sitemap></sitemapindex>',
      },
      {
        url: 'https://www.worldmonitor.app/sitemap-main.xml',
        xml: '<urlset><url><loc>https://www.worldmonitor.app/</loc></url></urlset>',
      },
    ]);
    assert.equal(inventory.urls.length, 1);
    assert.equal(inventory.sitemaps[0].kind, 'index');
    assert.equal(inventory.sitemaps[0].childCount, 1);
    assert.equal(inventory.sitemaps[1].urlCount, 1);
  });

  it('follows a sitemap index down to its children when fetching live', async () => {
    const documents = {
      'https://www.worldmonitor.app/blog/sitemap-index.xml':
        '<sitemapindex><sitemap><loc>https://www.worldmonitor.app/blog/sitemap-0.xml</loc></sitemap></sitemapindex>',
      'https://www.worldmonitor.app/blog/sitemap-0.xml':
        '<urlset><url><loc>https://www.worldmonitor.app/blog/a-post/</loc></url></urlset>',
    };
    const fetchImpl = async (url) => ({
      ok: documents[url] !== undefined,
      status: documents[url] === undefined ? 404 : 200,
      text: async () => documents[url],
    });
    const transport = createLiveTransport({ accessToken: 'unused', property: 'unused', fetchImpl });
    const fetched = await transport.sitemaps(['https://www.worldmonitor.app/blog/sitemap-index.xml']);
    assert.equal(fetched.length, 2);
    // Stopping at the index would report the blog family as undeclared while
    // it was earning impressions.
    const inventory = buildInventory(fetched);
    assert.deepEqual(inventory.urls.map((entry) => entry.family), ['blog']);
  });

  it('reports no disagreement when there is nothing to disagree about', () => {
    const indexed = { verdict: 'PASS', coverageState: 'Submitted and indexed' };
    assert.equal(
      describeDisagreement(indexed, { status: 200, xRobotsTag: null }),
      null,
    );
    assert.equal(describeDisagreement(null, { status: 200, xRobotsTag: null }), null);
    assert.equal(
      describeDisagreement(indexed, { status: null, xRobotsTag: null }),
      null,
    );
    assert.equal(
      describeDisagreement(indexed, { status: 503, xRobotsTag: null }),
      'google-recorded-indexed-live-errors',
    );
  });

  it('renders a summary that names the sampling basis', async () => {
    const { snapshot } = await collect();
    const markdown = renderGscMarkdown(snapshot);
    assert.match(markdown, /## By page family/);
    assert.match(markdown, /## By response kind/);
    assert.match(markdown, /## By host/);
    assert.match(markdown, /## Sampling/);
    assert.match(markdown, /Property identifier: withheld/);
  });

  it('rejects an empty inventory rather than reporting an empty snapshot', async () => {
    const transport = createFixtureTransport(repoPath(FIXTURES));
    await assert.rejects(
      () => collectGscSnapshot({
        transport,
        documents: [{ url: 'https://www.worldmonitor.app/sitemap-main.xml', xml: '<urlset></urlset>' }],
        observedAt: '2026-09-24T00:00:00Z',
        windows: [],
      }),
      /sitemap inventory is empty/,
    );
  });
});

const LIVE_RUN_DOCUMENTS = [{
  url: 'https://www.worldmonitor.app/sitemap-main.xml',
  xml: [
    '<urlset>',
    '<url><loc>https://www.worldmonitor.app/countries/iran/</loc></url>',
    '<url><loc>https://www.worldmonitor.app/countries/chad/</loc></url>',
    '<url><loc>https://www.worldmonitor.app/crises/sudan-conflict/</loc></url>',
    '<url><loc>https://www.worldmonitor.app/chokepoints/suez-canal/</loc></url>',
    '</urlset>',
  ].join(''),
}];
const LIVE_RUN_WINDOWS = [{ label: '28d', startDate: '2026-08-27', endDate: '2026-09-23' }];
const indexedResponse = { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } };

const memoryTransport = ({
  pageRows = [],
  searchAnalytics,
  inspect = async () => indexedResponse,
  probe = async () => ({ status: 200, contentType: 'text/html; charset=utf-8' }),
} = {}) => ({
  kind: 'test',
  rowLimit: 1000,
  searchAnalytics: searchAnalytics ?? (async ({ dimension, page }) => ({
    rows: dimension === 'page' && page === 0 ? pageRows : [],
  })),
  inspect,
  probe,
});

const collectFrom = (transport, extra = {}) => collectGscSnapshot({
  transport,
  documents: LIVE_RUN_DOCUMENTS,
  observedAt: '2026-09-24T00:00:00Z',
  windows: LIVE_RUN_WINDOWS,
  revision: 'test',
  ...extra,
});

const pageRow = (url, impressions) => ({ keys: [url], clicks: 1, impressions, position: 3 });

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('Search Console collector on live data', () => {
  it('reports Search Analytics rows outside every family instead of failing the run', async () => {
    const snapshot = await collectFrom(memoryTransport({
      pageRows: [
        pageRow('https://www.worldmonitor.app/countries/iran/', 10),
        pageRow('https://status.worldmonitor.app/', 5),
        pageRow('https://www.worldmonitor.app/download', 7),
      ],
    }));
    const [window] = snapshot.performance.windows;
    assert.equal(window.totals.impressions, 22, 'totals keep every row Google reported');
    assert.equal(window.byFamily.country_pages.impressions, 10);
    assert.equal(window.unmapped.urls, 2);
    assert.equal(window.unmapped.impressions, 12);
    assert.deepEqual(
      window.unmapped.topUrls.map((row) => row.url),
      ['https://www.worldmonitor.app/download', 'https://status.worldmonitor.app/'],
    );
    assert.ok(snapshot.samplingNotes.some((note) => /2 page rows map to no family/.test(note)));
    assert.match(renderGscMarkdown(snapshot), /## URLs outside every family \(28d\)[\s\S]*\/download/);
  });

  it('lists every unmapped URL by name, not only the top few', async () => {
    const legacy = Array.from({ length: 25 }, (_, index) => pageRow(`https://www.worldmonitor.app/legacy-${index}`, index + 1));
    const snapshot = await collectFrom(memoryTransport({ pageRows: legacy }));
    const [window] = snapshot.performance.windows;
    assert.equal(window.unmapped.urls, 25);
    assert.equal(window.unmapped.topUrls.length, 25);
    assert.match(renderGscMarkdown(snapshot), /legacy-0 \| 1 \|/);
  });

  it('queries Search Analytics before spending any inspection quota', async () => {
    let inspections = 0;
    await assert.rejects(
      () => collectFrom(memoryTransport({
        searchAnalytics: async () => { throw new Error('Search Console request failed with HTTP 403'); },
        inspect: async () => { inspections += 1; return indexedResponse; },
      })),
      /HTTP 403/,
    );
    assert.equal(inspections, 0);
  });

  it('inspects URLs concurrently and keeps records in sample order', async () => {
    let inFlight = 0;
    let peak = 0;
    const delays = { 'https://www.worldmonitor.app/countries/chad/': 30 };
    const { indexation } = await collectFrom(memoryTransport({
      inspect: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, delays[url] ?? 5));
        inFlight -= 1;
        return indexedResponse;
      },
    }), { concurrency: 3 });
    assert.equal(peak, 3);
    assert.equal(indexation.sample.inspected, 4);
    assert.equal(indexation.byFamily.country_pages.inspected, 2);
  });

  it('records one failed inspection and keeps inspecting the rest', async () => {
    const failing = 'https://www.worldmonitor.app/countries/chad/';
    const snapshot = await collectFrom(memoryTransport({
      inspect: async (url) => {
        if (url === failing) throw new Error('Search Console request failed with HTTP 503 after 4 attempts');
        return indexedResponse;
      },
    }));
    const { indexation } = snapshot;
    assert.equal(indexation.sample.inspected, 4);
    // A failed call is an absence of a measurement, so the sample is not
    // complete and the scorecard must not receive the count as a total.
    assert.equal(indexation.sample.complete, false);
    assert.equal(indexation.status, 'partial');
    assert.match(indexation.reason, /1 inspection failed/);
    const [exported] = toScorecardSearchExport(snapshot).windows;
    assert.equal(exported.indexedPages, null);
    const familyRow = (family) => exported.pageFamilyRows.find((row) => row.pageFamily === family);
    assert.equal(familyRow('country_pages').indexedPages, null, 'the family with the failed URL is not a count');
    assert.equal(familyRow('crises').indexedPages, 1, 'a fully measured family keeps its exact count');
    assert.equal(indexation.byFamily.country_pages.indexed, 1);
    assert.equal(indexation.inspectionErrors.length, 1);
    assert.equal(indexation.inspectionErrors[0].url, failing);
    assert.match(indexation.inspectionErrors[0].reason, /HTTP 503/);
  });

  it('treats an unknown or missing verdict as unmeasured', async () => {
    const unknown = { inspectionResult: { indexStatusResult: { verdict: 'VERDICT_UNSPECIFIED', coverageState: 'URL is unknown to Google' } } };
    assert.equal(pickIndexStatus(unknown), null);
    assert.equal(pickIndexStatus({ inspectionResult: { indexStatusResult: { coverageState: 'Submitted and indexed' } } }), null);
    assert.equal(
      pickIndexStatus({ inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' } } }).verdict,
      'NEUTRAL',
      'a known verdict that is not PASS is still a measurement',
    );

    const snapshot = await collectFrom(memoryTransport({
      inspect: async (url) => (url.endsWith('/crises/sudan-conflict/') ? unknown : indexedResponse),
    }));
    assert.equal(snapshot.indexation.sample.complete, false);
    const [exported] = toScorecardSearchExport(snapshot).windows;
    assert.equal(exported.indexedPages, null);
    assert.equal(exported.pageFamilyRows.find((row) => row.pageFamily === 'crises').indexedPages, null);
  });

  it('keeps crawled-and-declined apart from discovered-but-not-crawled', async () => {
    const withState = (coverageState) => ({
      inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState } },
    });
    const states = {
      'https://www.worldmonitor.app/countries/chad/': withState('Crawled - currently not indexed'),
      'https://www.worldmonitor.app/crises/sudan-conflict/': withState('Discovered - currently not indexed'),
    };
    const snapshot = await collectFrom(memoryTransport({
      inspect: async (url) => states[url] ?? indexedResponse,
    }));
    const { htmlPages, byFamily } = snapshot.indexation;
    assert.equal(htmlPages.crawledNotIndexed, 1, 'only the crawled URL was declined');
    assert.equal(htmlPages.discoveredNotCrawled, 1);
    assert.equal(htmlPages.actionable, 1, 'a URL Google never crawled is not a declined page');
    assert.equal(byFamily.crises.crawledNotIndexed, 0);
    assert.equal(byFamily.crises.discoveredNotCrawled, 1);
    const markdown = renderGscMarkdown(snapshot);
    assert.match(markdown, /HTML pages crawled and declined, serving no `noindex`: 1\n/);
    assert.match(markdown, /HTML pages discovered but not yet crawled: 1\n/);
  });

  it('records a probe that fails instead of aborting the run', async () => {
    const { indexation } = await collectFrom(memoryTransport({
      probe: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    }));
    assert.equal(indexation.sample.inspected, 4);
    assert.equal(indexation.byFamily.crises.indexed, 1);
  });

  it('exports sampled index counts to the scorecard only when the sample is complete', async () => {
    const capped = await collectFrom(memoryTransport(), { sampleCap: 2 });
    assert.equal(toScorecardSearchExport(capped).windows[0].indexedPages, null);

    const complete = await collectFrom(memoryTransport({
      pageRows: [pageRow('https://www.worldmonitor.app/countries/iran/', 10)],
    }));
    const [window] = toScorecardSearchExport(complete).windows;
    assert.equal(window.indexedPages, 4);
    const countries = window.pageFamilyRows.find((row) => row.pageFamily === 'country_pages');
    assert.equal(countries.indexedPages, 2);
  });
});

describe('Search Console site totals and brand split', () => {
  it('reports the by-property total apart from the sum of page rows', async () => {
    const { snapshot } = await collect();
    const window = snapshot.performance.windows.find((entry) => entry.label === '28d');
    assert.equal(window.totalsBasis, 'sum-of-page-rows');
    assert.equal(window.totals.impressions, 2830, 'one search counts once per URL shown');
    assert.equal(window.siteTotals.basis, 'by-property');
    assert.equal(window.siteTotals.status, 'available');
    assert.equal(window.siteTotals.all.impressions, 1500, 'the performance chart counts it once');
    assert.equal(window.siteTotals.brand.impressions, 900);
    assert.equal(window.siteTotals.nonBrand.impressions, 420);
    assert.deepEqual(
      window.siteTotals.anonymized,
      { clicks: 12, impressions: 180 },
      'a query filter drops anonymized queries, so the remainder is reported, not lost',
    );
    assert.equal(window.siteTotals.nonBrandShare.value, 0.28);
    assert.equal(window.siteTotals.nonBrandShare.basis, 'by-property-impressions');
    const { markdown } = await collect();
    assert.match(markdown, /## Search totals[\s\S]*\| 28d \(2026-08-27 to 2026-09-23\) \| 1500 \| 50 \| 900 \| 420 \| 8 \| 180 \| 28\.0% \| 2830 \|/);
    assert.match(markdown, /### Seven-day trend/);
    assert.match(markdown, /\| geopolitical risk dashboard \| no \| 260 \|/);
  });

  it('splits non-brand impressions by page family across paginated rows', async () => {
    const { snapshot } = await collect();
    const window = snapshot.performance.windows.find((entry) => entry.label === '28d');
    assert.equal(window.byFamily.homepage.nonBrandImpressions, 150);
    assert.equal(window.byFamily.chokepoints.nonBrandImpressions, 96, 'the second page of rows is read');
    assert.equal(window.byFamily.country_pages.nonBrandImpressions, 44);
    assert.equal(window.byFamily.homepage.nonBrandReason, null);
  });

  it('records a daily by-property series over the widest window, oldest first', async () => {
    const { snapshot } = await collect();
    const { daily } = snapshot.performance;
    assert.equal(daily.status, 'available');
    assert.equal(daily.basis, 'by-property');
    assert.equal(daily.startDate, snapshot.performance.windows.find((w) => w.label === '90d').startDate);
    assert.deepEqual(daily.rows.map((row) => row.date), ['2026-07-01', '2026-08-01', '2026-09-01']);
    assert.deepEqual(daily.rows.map((row) => row.impressions), [60, 55, 50]);
    assert.deepEqual(
      daily.rows.map((row) => row.nonBrandImpressions),
      [20, 0, 25],
      'a date the non-brand view answered without is a real zero',
    );
  });

  it('keeps every unrecorded view null with a reason rather than zero', async () => {
    const { snapshot } = await collect(`${FIXTURES}quota/`);
    const [window] = snapshot.performance.windows;
    assert.equal(window.siteTotals.status, 'unavailable');
    assert.equal(window.siteTotals.all, null);
    assert.equal(window.siteTotals.anonymized, null);
    assert.match(window.siteTotals.reason, /site view was not collected/);
    assert.equal(snapshot.performance.daily.status, 'unavailable');
    assert.deepEqual(snapshot.performance.daily.rows, []);
    for (const metrics of Object.values(window.byFamily)) {
      assert.equal(metrics.nonBrandImpressions, null);
      assert.match(metrics.nonBrandReason, /not collected/);
    }
  });

  it('buckets the daily series into seven-day periods even when Google omits a day', () => {
    const day = (date, impressions) => ({
      date, impressions, clicks: 1, nonBrandImpressions: 1, nonBrandClicks: 0,
    });
    const weeks = weeklyTotals([
      day('2026-09-01', 10),
      day('2026-09-09', 20),
      day('2026-09-10', 30),
      day('2026-09-16', 40),
    ]);
    assert.deepEqual(weeks.map((week) => [week.startDate, week.endDate, week.days, week.impressions]), [
      ['2026-08-27', '2026-09-02', 1, 10],
      ['2026-09-03', '2026-09-09', 1, 20],
      ['2026-09-10', '2026-09-16', 2, 70],
    ]);
    assert.deepEqual(weeklyTotals([]), []);
    const unmeasured = weeklyTotals([{ ...day('2026-09-16', 5), nonBrandImpressions: null }]);
    assert.equal(unmeasured[0].nonBrandImpressions, null, 'an unmeasured day keeps its week unmeasured');
  });

  it('reports non-brand family numbers as unmeasured when the quota cuts the view', async () => {
    const quotaOn = (failPage) => memoryTransport({
      pageRows: [pageRow('https://www.worldmonitor.app/countries/iran/', 10)],
      searchAnalytics: async ({ dimension, page }) => {
        if (dimension === 'pageNonBrand' && page === failPage) {
          throw new QuotaExhaustedError('Search Console daily quota is exhausted (HTTP 429)');
        }
        if (dimension === 'pageNonBrand') {
          return { rows: Array.from({ length: 1000 }, (_, index) => pageRow(`https://www.worldmonitor.app/countries/iran/?p=${index}`, 1)) };
        }
        return { rows: dimension === 'page' && page === 0 ? [pageRow('https://www.worldmonitor.app/countries/iran/', 10)] : [] };
      },
    });
    for (const failPage of [0, 1]) {
      const snapshot = await collectFrom(quotaOn(failPage));
      const [window] = snapshot.performance.windows;
      assert.equal(window.status, 'partial');
      const family = window.byFamily.country_pages;
      assert.equal(family.nonBrandImpressions, null, `quota on page ${failPage} must not publish a number`);
      assert.equal(family.nonBrandClicks, null);
      assert.match(family.nonBrandReason, /quota was exhausted after \d+ pageNonBrand rows/);
    }
  });

  it('joins non-brand queries to their page and desktop share across paginated rows', async () => {
    const { snapshot } = await collect();
    const list = snapshot.performance.nonBrandQueries;
    assert.equal(list.status, 'available');
    assert.equal(list.window, '28d');
    assert.deepEqual(list.rows.map((row) => row.query), [
      'kerch strait',
      'pizza index',
      'quiet desktop query',
    ]);
    const pizza = list.rows[1];
    assert.equal(pizza.page, 'https://www.worldmonitor.app/blog/glossary/pentagon-pizza-index/');
    assert.equal(pizza.impressions, 1000);
    assert.equal(pizza.clicks, 13);
    assert.equal(pizza.position, 7.2);
    assert.equal(pizza.desktopShare, 0.2);
    assert.equal(pizza.likelyAutomated, false);
  });

  it('flags only zero-click, nearly all-desktop queries with enough impressions', async () => {
    const { snapshot } = await collect();
    const list = snapshot.performance.nonBrandQueries;
    const flagged = list.rows.filter((row) => row.likelyAutomated).map((row) => row.query);
    assert.deepEqual(flagged, ['kerch strait']);
    assert.equal(list.rows.find((row) => row.query === 'quiet desktop query').desktopShare, 1);
    assert.deepEqual(list.summary, {
      queries: 4,
      nonBrandImpressions: 2155,
      likelyAutomatedQueries: 1,
      likelyAutomatedImpressions: 1000,
      nonBrandImpressionsExcludingLikelyAutomated: 1155,
    });
  });

  it('keeps rare queries out of the committed list but inside the summary', async () => {
    const { snapshot } = await collect();
    const list = snapshot.performance.nonBrandQueries;
    assert.equal(list.rows.some((row) => row.query === 'tiny query'), false);
    assert.equal(list.summary.queries, 4);
  });

  it('reports the query list as unavailable when its view was not collected', async () => {
    const { snapshot, markdown } = await collect(`${FIXTURES}quota/`);
    const list = snapshot.performance.nonBrandQueries;
    assert.equal(list.status, 'unavailable');
    assert.equal(list.summary, null);
    assert.deepEqual(list.rows, []);
    assert.match(list.reason, /queryNonBrandDevice view was not collected/);
    assert.match(markdown, /Non-brand queries: unavailable/);
  });

  it('summarizes low-click non-brand queries and names the automated ones', async () => {
    const { markdown } = await collect();
    assert.match(markdown, /### Non-brand queries with few clicks \(28d\)/);
    assert.match(markdown, /1 of 4 non-brand queries look automated, 1000 of 2155 impressions/);
    assert.match(markdown, /\| kerch strait \| \/chokepoints\/kerch-strait\/ \| 1000 \| 0 \| 0\.0% \| 9\.2 \| 98% \| yes \|/);
  });

  it('asks Google for the query rows by device and by page, without brand queries', async () => {
    const bodies = [];
    const transport = createLiveTransport({
      accessToken: 't',
      property: 'sc-domain:example.com',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return jsonResponse(200, { rows: [] });
      },
      sleep: async () => {},
    });
    const window = { startDate: '2026-08-27', endDate: '2026-09-23' };
    await transport.searchAnalytics({ dimension: 'queryNonBrandDevice', page: 0, ...window });
    await transport.searchAnalytics({ dimension: 'queryNonBrandPage', page: 0, ...window });
    assert.deepEqual(bodies[0].dimensions, ['query', 'device']);
    assert.deepEqual(bodies[1].dimensions, ['query', 'page']);
    for (const body of bodies) {
      assert.equal(body.dimensionFilterGroups[0].filters[0].operator, 'excludingRegex');
    }
  });

  it('compares the unrounded desktop share with the automated cutoff', () => {
    const row = (device, impressions) => ({ key: 'near cutoff', secondKey: device, clicks: 0, impressions, position: 5 });
    const list = buildNonBrandQueries({
      window: { label: '28d' },
      device: { rows: [row('DESKTOP', 8999), row('MOBILE', 1001)], truncationReason: null, recorded: true },
      page: { rows: [], truncationReason: null, recorded: true },
    });
    assert.equal(list.rows[0].desktopShare, 0.9);
    assert.equal(list.rows[0].likelyAutomated, false);
  });

  it('withholds top pages and says why when the page view is cut short', async () => {
    const { snapshot } = await collect();
    const list = buildNonBrandQueries({
      window: { label: '28d' },
      device: {
        rows: [{ key: 'pizza index', secondKey: 'MOBILE', clicks: 0, impressions: 500, position: 5 }],
        truncationReason: null,
        recorded: true,
      },
      page: {
        rows: [{ key: 'pizza index', secondKey: 'https://www.worldmonitor.app/', clicks: 0, impressions: 9, position: 5 }],
        truncationReason: 'searchanalytics quota was exhausted after 1 queryNonBrandPage rows: x',
        recorded: true,
      },
    });
    assert.equal(list.status, 'partial');
    assert.equal(list.rows[0].page, null);
    const copy = structuredClone(snapshot);
    copy.performance.nonBrandQueries = list;
    assert.match(renderGscMarkdown(copy), /Top pages are withheld: searchanalytics quota was exhausted/);
  });

  it('lists every www page each non-brand query showed over the widest window', async () => {
    const { snapshot } = await collect();
    const list = snapshot.performance.queryPages;
    assert.equal(list.status, 'available');
    assert.equal(list.window, '90d');
    assert.deepEqual(list.rows, [
      {
        query: 'kerch strait',
        impressions: 3040,
        likelyAutomated: true,
        pages: [
          { path: '/chokepoints/kerch-strait/', impressions: 3000, position: 9 },
          { path: '/blog/posts/black-sea-shipping/', impressions: 40, position: 12.5 },
        ],
      },
      {
        query: 'bab el mandeb',
        impressions: 25,
        likelyAutomated: false,
        pages: [{ path: '/chokepoints/bab-el-mandeb/', impressions: 25, position: 6 }],
      },
    ]);
    assertPublishableQueryPages(list, 'fixture snapshot');
  });

  it('keeps a query out of the query pages until one page alone has 20 impressions', async () => {
    const { snapshot } = await collect();
    // 15 + 10 page rows can be one search counted twice, so the sum is no floor.
    assert.equal(snapshot.performance.queryPages.rows.some((row) => row.query === 'split query'), false);
  });

  it('reports the query pages as unavailable when the view was not collected or was cut short', async () => {
    const { snapshot } = await collect(`${FIXTURES}quota/`);
    assert.equal(snapshot.performance.queryPages.status, 'unavailable');
    assert.match(snapshot.performance.queryPages.reason, /90d queryNonBrandPage view was not collected/);
    assert.deepEqual(snapshot.performance.queryPages.rows, []);

    const cut = buildQueryPages({
      window: { label: '90d' },
      page: {
        rows: [{ key: 'pizza index', secondKey: 'https://www.worldmonitor.app/', clicks: 0, impressions: 90, position: 5 }],
        truncationReason: 'stopped after 40 pages of queryNonBrandPage rows',
        recorded: true,
      },
    }, { status: 'available', window: '28d', rows: [] });
    assert.equal(cut.status, 'unavailable');
    assert.equal(cut.reason, 'stopped after 40 pages of queryNonBrandPage rows');
    assert.deepEqual(cut.rows, []);
  });

  it('caps the query pages at 500 queries of 10 pages and leaves automation unknown without the device view', () => {
    const rows = [];
    for (let query = 0; query < 501; query += 1) {
      rows.push({ key: `query ${query}`, secondKey: 'https://www.worldmonitor.app/', clicks: 0, impressions: 1000 - query, position: 4 });
    }
    for (let page = 0; page < 12; page += 1) {
      rows.push({ key: 'query 0', secondKey: `https://www.worldmonitor.app/p${page}/`, clicks: 0, impressions: 30, position: 8 });
    }
    const list = buildQueryPages(
      { window: { label: '90d' }, page: { rows, truncationReason: null, recorded: true } },
      { status: 'unavailable', window: '28d', rows: [] },
    );
    assert.equal(list.rows.length, 500);
    assert.equal(list.rows.at(-1).query, 'query 499');
    assert.equal(list.rows[0].pages.length, 10);
    assert.equal(list.rows[0].impressions, 1000 + 12 * 30);
    assert.equal(list.rows[0].likelyAutomated, null);
  });

  it('publishes a query only when one URL alone reaches the floor', () => {
    const page = (key, url, impressions) => ({ key, secondKey: `https://www.worldmonitor.app${url}`, clicks: 0, impressions, position: 6 });
    const list = buildQueryPages(
      {
        window: { label: '90d' },
        page: {
          rows: [
            page('merged variants', '/tools/', 15),
            page('merged variants', '/tools/#faq', 10),
            page('one url', '/crises/', 20),
            page('one url', '/crises/?x=1', 4),
          ],
          truncationReason: null,
          recorded: true,
        },
      },
      { status: 'available', window: '28d', rows: [] },
    );
    assert.deepEqual(list.rows.map((row) => row.query), ['one url']);
    assert.deepEqual(list.rows[0].pages, [{ path: '/crises/', impressions: 24, position: 6 }]);
  });

  it('keeps Markdown in a query cell from rendering as links, images or HTML', () => {
    const cell = queryCell('[x](https://a.example/) <img src=y> ![i](z) www.a.example `c` *b* _d_ ~e~');
    assert.doesNotMatch(cell, /(?<!\\)</);
    for (const live of ['[x](', '![i]', 'https://', 'www.a', '`c`', '*b*', '_d_', '~e~']) {
      assert.equal(cell.includes(live), false, `${live} stays live in ${cell}`);
    }
  });

  it('escapes backslashes and pipes in a query cell', async () => {
    const { snapshot } = await collect();
    const copy = structuredClone(snapshot);
    copy.performance.windows[0].topQueries = [
      { query: 'a|b\\|c\nd', brand: false, clicks: 1, impressions: 2, position: 3 },
    ];
    assert.match(renderGscMarkdown(copy), /^\| a\\\|b\\\\\\\|c d \| no \| 2 \| 1 \|/m);
  });

  it('flags each top query as brand or non-brand', async () => {
    const { snapshot } = await collect();
    const window = snapshot.performance.windows.find((entry) => entry.label === '90d');
    assert.deepEqual(
      window.topQueries.map((row) => [row.query, row.brand]),
      [['world monitor', true], ['suez canal traffic', false], ['acled alternative', false]],
    );
  });

  it('classifies the brand spellings seen in Search Console and Bing and nothing generic', () => {
    for (const query of ['world monitor', 'worldmonitor', 'World Monitor app', 'worldmonitor.ap',
      'word monitor', 'world-monitor github', 'ワールドモニター', 'worldmoniter', 'worldmoniter.app',
      'worl monitor', 'woldmonitor', 'world montior', 'wordl monitor', 'world montor', 'world monitar',
      'world monter', 'wordmonintor', 'world monotor', 'worldmoniteur', 'wordmonitro', 'worldmoniterapp',
      'worldmonitorapp', 'world monitoring', 'world_moniter_app', 'worl_monitor_github']) {
      assert.equal(isBrandQuery(query), true, query);
    }
    for (const query of ['war monitor', 'warmonitor', 'monitor the situation', 'ww3 monitor',
      'pentagon pizza index', 'osint world map', 'world news', 'world monetary fund', 'world montreal',
      'word montage', 'world mentor', 'world monuments', 'world monterrey', 'world monteria', 'world montería']) {
      assert.equal(isBrandQuery(query), false, query);
    }
  });

  it('asks Google for by-property totals and filters on the same brand pattern', async () => {
    const bodies = [];
    const transport = createLiveTransport({
      accessToken: 't',
      property: 'sc-domain:example.com',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return jsonResponse(200, { rows: [] });
      },
      sleep: async () => {},
    });
    const window = { startDate: '2026-08-27', endDate: '2026-09-23' };
    for (const dimension of ['site', 'siteNonBrand', 'siteBrand', 'dailyNonBrand', 'pageNonBrand']) {
      await transport.searchAnalytics({ dimension, page: 0, ...window });
    }
    const [site, siteNonBrand, siteBrand, dailyNonBrand, pageNonBrand] = bodies;
    assert.deepEqual(site.dimensions, []);
    assert.equal(site.dimensionFilterGroups, undefined);
    const filterOf = (body) => body.dimensionFilterGroups[0].filters[0];
    assert.deepEqual(filterOf(siteNonBrand), {
      dimension: 'query',
      operator: 'excludingRegex',
      expression: `(?i)${BRAND_QUERY_PATTERN}`,
    });
    assert.equal(filterOf(siteBrand).operator, 'includingRegex');
    assert.deepEqual(dailyNonBrand.dimensions, ['date']);
    assert.deepEqual(pageNonBrand.dimensions, ['page']);
    assert.equal(filterOf(pageNonBrand).operator, 'excludingRegex');
    await assert.rejects(
      () => transport.searchAnalytics({ dimension: 'nope', page: 0, ...window }),
      /unknown Search Analytics view nope/,
    );
  });
});

describe('Search Console live transport resilience', () => {
  const noSleep = async () => {};
  const liveTransport = (fetchImpl) => createLiveTransport({
    accessToken: 't',
    property: 'sc-domain:example.com',
    fetchImpl,
    sleep: noSleep,
  });

  it('retries a transient 503 and then succeeds', async () => {
    let calls = 0;
    const transport = liveTransport(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503, { error: { code: 503 } }) : jsonResponse(200, indexedResponse);
    });
    assert.deepEqual(await transport.inspect('https://www.worldmonitor.app/'), indexedResponse);
    assert.equal(calls, 3);
  });

  it('gives up on a persistent 5xx with the status in the error', async () => {
    let calls = 0;
    const transport = liveTransport(async () => { calls += 1; return jsonResponse(500, {}); });
    await assert.rejects(() => transport.inspect('https://www.worldmonitor.app/'), /HTTP 500 after 4 attempts/);
    assert.equal(calls, 4);
  });

  it('backs off on a per-minute 429 but stops at once on the daily quota', async () => {
    let calls = 0;
    const perMinute = liveTransport(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'" } })
        : jsonResponse(200, indexedResponse);
    });
    assert.deepEqual(await perMinute.inspect('https://www.worldmonitor.app/'), indexedResponse);
    assert.equal(calls, 2);

    let dailyCalls = 0;
    const daily = liveTransport(async () => {
      dailyCalls += 1;
      return jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" } });
    });
    await assert.rejects(
      () => daily.inspect('https://www.worldmonitor.app/'),
      (error) => error.name === 'QuotaExhaustedError',
    );
    assert.equal(dailyCalls, 1);
  });

  it('bounds every request with a deadline and cancels the probe body', async () => {
    const signals = [];
    let bodyCancelled = false;
    const transport = liveTransport(async (url, init = {}) => {
      signals.push(init.signal);
      if (url.endsWith('.xml')) return new Response('<urlset></urlset>', { status: 200 });
      if (init.method === 'GET') {
        return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return jsonResponse(200, indexedResponse);
    });
    await transport.sitemaps(['https://www.worldmonitor.app/sitemap-main.xml']);
    await transport.inspect('https://www.worldmonitor.app/');
    const probed = await transport.probe('https://www.worldmonitor.app/');
    assert.equal(probed.status, 200);
    assert.equal(signals.length, 3);
    for (const signal of signals) assert.ok(signal instanceof AbortSignal, 'every fetch carries a deadline');
    assert.equal(bodyCancelled, true);
  });

  it('keeps a URL-prefix property out of the output without rejecting its own URLs', () => {
    const serialized = JSON.stringify({ url: 'https://www.worldmonitor.app/countries/iran/' });
    assert.equal(assertNoSecrets(serialized, { property: 'https://www.worldmonitor.app/' }), serialized);
    assert.throws(
      () => assertNoSecrets(JSON.stringify({ property: 'sc-domain:worldmonitor.app' }), { property: 'sc-domain:worldmonitor.app' }),
      /refusing to write/,
    );
  });
});

describe('Search Console reviewed-query lookups', () => {
  const lookupOf = (snapshot, label, queryId) => snapshot.reviewedQueries.windows
    .find((window) => window.label === label)
    .lookups.find((lookup) => lookup.queryId === queryId);
  const exportedRow = (exported, label, queryId) => exported.windows
    .find((window) => window.label === label)
    .queryRows.find((row) => row.queryId === queryId);

  it('looks up every reviewed query in every window and records the query set identity', async () => {
    const { snapshot } = await collect();
    const section = snapshot.reviewedQueries;
    assert.equal(section.querySetId, querySet.querySetId);
    assert.equal(section.querySetDigest, computeQuerySetDigest(querySet));
    assert.equal(section.operator, 'equals');
    assert.deepEqual(section.windows.map((window) => window.label), ['28d', '90d']);
    for (const window of section.windows) {
      assert.deepEqual(
        window.lookups.map((lookup) => lookup.queryId),
        querySet.queries.map((query) => query.id),
      );
    }
  });

  it('matches a reviewed query on the lowercased, space-collapsed text Google stores', async () => {
    const { snapshot } = await collect();
    const pricing = lookupOf(snapshot, '28d', 'q23');
    assert.equal(pricing.query, 'World Monitor pricing');
    assert.equal(pricing.expression, 'world monitor pricing');
    assert.equal(pricing.status, 'reported');
    assert.equal(pricing.reason, null);
    assert.deepEqual(
      [pricing.clicks, pricing.impressions, pricing.position],
      [2, 40, 6.5],
    );
    const row = exportedRow(toScorecardSearchExport(snapshot, { querySet }), '28d', 'q23');
    assert.deepEqual(row, {
      queryId: 'q23',
      query: 'World Monitor pricing',
      clicks: 2,
      impressions: 40,
      ctr: 0.05,
      position: 6.5,
      reason: null,
    });

    const expressions = [];
    const spaced = {
      ...querySet,
      queries: [{ ...querySet.queries[22], query: '  World   Monitor PRICING ' }],
    };
    const section = (await collectFrom({
      ...memoryTransport(),
      lookupQuery: async ({ expression }) => { expressions.push(expression); return { rows: [] }; },
    }, { querySet: spaced })).reviewedQueries;
    assert.deepEqual(expressions, ['world monitor pricing']);
    assert.equal(section.windows[0].lookups[0].expression, 'world monitor pricing');
  });

  it('reports a query Google returns no row for as not reported, never as zero', async () => {
    const { snapshot } = await collect();
    const gdelt = lookupOf(snapshot, '28d', 'q18');
    assert.equal(gdelt.status, 'not-reported');
    assert.match(gdelt.reason, /not reported by Search Console/i);
    assert.deepEqual([gdelt.clicks, gdelt.impressions, gdelt.position], [null, null, null]);

    const exported = toScorecardSearchExport(snapshot, { querySet });
    const row = exportedRow(exported, '28d', 'q18');
    assert.deepEqual(
      [row.clicks, row.impressions, row.ctr, row.position],
      [null, null, null, null],
    );
    assert.match(row.reason, /privacy threshold/);

    const normalized = normalizeSearchExport(exported, {
      querySet,
      observedAt: '2026-09-24T00:00:00Z',
      provider: 'Google Search Console',
      schemaVersion: 2,
    });
    const normalizedRow = normalized.queryRows.find(
      (entry) => entry.windowLabel === '28d' && entry.queryId === 'q18',
    );
    assert.deepEqual(normalizedRow.metrics, {
      impressions: null, clicks: null, ctr: null, averagePosition: null,
    });
    assert.equal(normalizedRow.reason, row.reason);
    assert.equal(normalized.status, 'partial');
  });

  it('records a failed or unrecorded lookup as unavailable with its reason and keeps going', async () => {
    const { snapshot } = await collect();
    const failed = lookupOf(snapshot, '28d', 'q12');
    assert.equal(failed.status, 'unavailable');
    assert.match(failed.reason, /lookup failed: .*HTTP 500/);
    const unrecorded = lookupOf(snapshot, '28d', 'q01');
    assert.equal(unrecorded.status, 'unavailable');
    assert.match(unrecorded.reason, /no lookup was recorded/);
    assert.equal(lookupOf(snapshot, '90d', 'q23').status, 'reported');
    assert.equal(snapshot.reviewedQueries.status, 'partial');
    assert.match(snapshot.reviewedQueries.reason, /28d: 23 of 25 lookups unavailable/);

    const row = exportedRow(toScorecardSearchExport(snapshot, { querySet }), '28d', 'q12');
    assert.deepEqual([row.impressions, row.clicks], [null, null]);
    assert.match(row.reason, /HTTP 500/);
  });

  it('stops looking up once the quota runs out and says so for every remaining query', async () => {
    let calls = 0;
    const snapshot = await collectFrom({
      ...memoryTransport(),
      lookupQuery: async () => {
        calls += 1;
        if (calls === 2) throw new QuotaExhaustedError('Search Console daily quota is exhausted (HTTP 429)');
        return { rows: [] };
      },
    }, { querySet });
    assert.equal(calls, 2);
    const [window] = snapshot.reviewedQueries.windows;
    assert.equal(window.lookups[0].status, 'not-reported');
    for (const lookup of window.lookups.slice(1)) {
      assert.equal(lookup.status, 'unavailable');
      assert.match(lookup.reason, /quota was exhausted/);
    }
    assert.equal(snapshot.reviewedQueries.status, 'partial');
  });

  it('records a row with missing counts as unavailable instead of filling in a zero', async () => {
    const snapshot = await collectFrom({
      ...memoryTransport(),
      lookupQuery: async ({ expression }) => ({ rows: [{ keys: [expression], impressions: 12, position: 4 }] }),
    }, { querySet });
    const [lookup] = snapshot.reviewedQueries.windows[0].lookups;
    assert.equal(lookup.status, 'unavailable');
    assert.match(lookup.reason, /without clicks or impressions/);
    assert.deepEqual([lookup.clicks, lookup.impressions, lookup.position], [null, null, null]);
  });

  it('is unavailable with a reason when no query set is supplied', async () => {
    const snapshot = await collectFrom(memoryTransport());
    assert.equal(snapshot.reviewedQueries.status, 'unavailable');
    assert.match(snapshot.reviewedQueries.reason, /no reviewed query set was supplied/);
    assert.deepEqual(snapshot.reviewedQueries.windows, []);
  });

  it('refuses to map lookups that were made for a different query set', async () => {
    const { snapshot } = await collect();
    const edited = structuredClone(querySet);
    edited.queries[22].query = 'World Monitor price';
    const exported = toScorecardSearchExport(snapshot, { querySet: edited });
    for (const window of exported.windows) assert.deepEqual(window.queryRows, []);
    assert.match(exported.reason, /lookups were made for query set seo-ai-visibility-v1 \(sha256:[0-9a-f]{12}/);
    assert.match(exported.reason, /not the supplied/);
  });

  it('maps a snapshot that predates the lookups to no query rows, with the reason', () => {
    const committed = JSON.parse(readFileSync(
      repoPath('docs/research/seo-ai-visibility/gsc/2026-11-03.json'),
      'utf8',
    ));
    assert.equal(committed.reviewedQueries, undefined);
    const exported = toScorecardSearchExport(committed, { querySet });
    for (const window of exported.windows) assert.deepEqual(window.queryRows, []);
    assert.match(exported.reason, /predates reviewed-query lookups/);
    assert.doesNotMatch(exported.reason, /top 20/);
  });

  it('summarizes how many reviewed queries Google reported in the markdown', async () => {
    const { markdown } = await collect();
    assert.match(markdown, /### Reviewed queries/);
    assert.match(markdown, /\| 28d \| 25 \| 1 \| 1 \| 23 \|/);
    assert.match(markdown, /\| World Monitor pricing \| 40 \| 2 \| 5\.0% \| 6\.5 \|/);
  });

  it('asks Google for an exact match on the query dimension, retrying a 5xx', async () => {
    const bodies = [];
    let calls = 0;
    const transport = createLiveTransport({
      accessToken: 't',
      property: 'sc-domain:example.com',
      fetchImpl: async (_url, init) => {
        calls += 1;
        bodies.push(JSON.parse(init.body));
        return calls === 1 ? jsonResponse(503, {}) : jsonResponse(200, { responseAggregationType: 'byProperty' });
      },
      sleep: async () => {},
    });
    const response = await transport.lookupQuery({
      expression: 'world monitor pricing',
      startDate: '2026-08-27',
      endDate: '2026-09-23',
    });
    assert.deepEqual(response, { responseAggregationType: 'byProperty' });
    assert.equal(calls, 2);
    // Without a dimension Google answers an unknown query with a zero row;
    // grouped by query it answers with no row, which is the honest outcome.
    assert.deepEqual(bodies[1].dimensions, ['query']);
    assert.deepEqual(bodies[1].dimensionFilterGroups[0].filters, [
      { dimension: 'query', operator: 'equals', expression: 'world monitor pricing' },
    ]);
    assert.equal(bodies[1].dataState, 'final');
    assert.deepEqual([bodies[1].startDate, bodies[1].endDate], ['2026-08-27', '2026-09-23']);
  });
});
