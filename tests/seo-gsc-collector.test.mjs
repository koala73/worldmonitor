import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  describeDisagreement,
  buildInventory,
  pickIndexStatus,
  renderGscMarkdown,
  runCli,
  stratifiedSample,
  toScorecardSearchExport,
} from '../scripts/seo-gsc-collect.mjs';
import { normalizeSearchExport } from '../scripts/seo-ai-visibility-collector.mjs';

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
