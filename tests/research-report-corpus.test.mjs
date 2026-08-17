// Content contract for the /research/ report family (issue #5668): source
// attribution, date ordering, metadata agreement across visible HTML /
// structured data / downloads, downloadable schema, internal linking,
// deterministic regeneration, and fail-closed handling of missing data.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  assertNoUnresolvedTokens,
  computeReportMetrics,
  downloadFileNames,
  formatMetric,
  mean,
  resolveMetricTokens,
} from '../scripts/build-research-reports.mjs';
import {
  enumerateMissingDates,
  fetchAllPages as snapshotFetchAllPages,
  serializeSnapshot,
} from '../scripts/build-chokepoint-transit-snapshot.mjs';
import { fetchAllPages as seederFetchAllPages } from '../scripts/seed-portwatch.mjs';
import { RESEARCH_REPORTS } from '../shared/research-reports/index.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const report = RESEARCH_REPORTS[0];
const snapshot = JSON.parse(readFileSync(join(repoRoot, report.snapshotPath), 'utf8'));
const files = downloadFileNames(report);

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

describe('research report corpus (#5668)', () => {
  let outDir;
  let html;
  let hubHtml;
  let csv;
  let dataJson;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-research-corpus-'));
    await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
    html = readFileSync(join(outDir, 'research', report.slug, 'index.html'), 'utf8');
    hubHtml = readFileSync(join(outDir, 'research', 'index.html'), 'utf8');
    csv = readFileSync(join(outDir, 'research', report.slug, files.csv), 'utf8');
    dataJson = JSON.parse(readFileSync(join(outDir, 'research', report.slug, files.json), 'utf8'));
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('resolves every metric token and pins prose values to recomputed data', () => {
    assert.doesNotMatch(html, /\{\{m:/, 'unresolved metric token leaked into published HTML');
    const metrics = computeReportMetrics(snapshot, report);
    const rendered = [...html.matchAll(/<data data-metric="([^"]+)" value="([^"]+)">/g)];
    assert.ok(rendered.length >= 15, `expected inline metric values, found ${rendered.length}`);
    for (const [, id, value] of rendered) {
      const metric = metrics.get(id);
      assert.ok(metric, `page renders unknown metric ${id}`);
      assert.equal(value, String(metric.value), `metric ${id} drifted from recomputed value`);
    }
    // Every inline metric must also appear in the provenance table with its
    // observation period and method.
    for (const [, id] of rendered) {
      assert.ok(
        html.includes(`data-metric-row="${id}"`),
        `metric ${id} missing from the provenance table`,
      );
    }
    assert.match(html, /Observation period<\/th>/);
    assert.match(html, /Method<\/th>/);
  });

  it('keeps dates ordered and consistent across surfaces', () => {
    const [reportLd] = jsonLdObjects(html);
    assert.equal(reportLd['@type'], 'Report');
    assert.ok(report.datePublished <= report.dateModified, 'published must not postdate modified');
    assert.equal(reportLd.datePublished, report.datePublished);
    assert.equal(reportLd.dateModified, report.dateModified);
    assert.equal(dataJson.datePublished, report.datePublished);
    assert.equal(dataJson.dateModified, report.dateModified);
    const focus = snapshot.chokepoints[report.focusChokepointId];
    assert.ok(
      focus.observationEnd <= String(snapshot.capturedAt).slice(0, 10),
      'observation period must end on or before the retrieval date',
    );
    assert.match(html, /<meta name="lastmod" content="2026-08-12">/);
    assert.match(
      html,
      new RegExp(`published <time datetime="${report.datePublished}">`),
      'visible publication date must match the metadata',
    );
  });

  it('agrees on title, author, and headline facts across page, structured data, and downloads', () => {
    const [reportLd] = jsonLdObjects(html);
    assert.match(html, new RegExp(`<h1>${report.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`));
    assert.equal(reportLd.name, report.title);
    assert.equal(dataJson.title, report.title);
    assert.equal(reportLd.author.name, report.author.name);
    assert.equal(dataJson.author, report.author.name);
    assert.equal(reportLd.version, report.version);
    assert.equal(dataJson.version, report.version);
    assert.equal(reportLd.url, `https://www.worldmonitor.app/research/${report.slug}/`);
    assert.equal(dataJson.canonicalUrl, reportLd.url);
    // Headline metric agreement: the decline percentage rendered on the page
    // matches the JSON download byte-for-value.
    const metrics = computeReportMetrics(snapshot, report);
    const decline = metrics.get('declinePct');
    assert.equal(dataJson.metrics.declinePct.value, decline.value);
    assert.ok(html.includes(`>−${formatMetric(decline)}<`), 'headline decline stat missing from page');
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)[1];
    assert.equal(canonical, reportLd.url);
    // The meta description resolves {{m:...}} tokens too: its headline numbers
    // are pinned to the same recomputed metrics as the page body.
    const metaDescription = html.match(/<meta name="description" content="([^"]+)">/)[1];
    for (const id of ['declinePct', 'disruptionDailyAvg', 'sameWindow2025DailyAvg']) {
      assert.ok(
        metaDescription.includes(formatMetric(metrics.get(id))),
        `meta description must carry the computed ${id}`,
      );
    }
    assert.equal(reportLd.description, metaDescription);
    // Date-kind tokens render as <time> with the recomputed value.
    assert.ok(
      html.includes(`<time datetime="${metrics.get('observationEnd').value}">`),
      'observationEnd must render as a <time> element with the computed date',
    );
    // The recommended citation is generated from report fields, never stored.
    assert.ok(
      html.includes(`version ${report.version}, published ${report.datePublished}`),
      'citation must carry the current version and publication date',
    );
  });

  it('documents the downloadable schema and keeps the CSV in sync with it', () => {
    const [header, ...rows] = csv.trim().split('\n');
    assert.equal(header, dataJson.csvSchema.map((column) => column.column).join(','));
    const focus = snapshot.chokepoints[report.focusChokepointId];
    assert.equal(rows.length, focus.rowCount, 'CSV row count must match the snapshot');
    assert.match(rows[0], /^\d{4}-\d{2}-\d{2},/);
    for (const required of ['units', 'license', 'snapshotId', 'source']) {
      assert.ok(dataJson[required], `JSON download missing ${required}`);
    }
    assert.equal(dataJson.snapshotId, snapshot.snapshotId);
    assert.match(dataJson.license, /IMF PortWatch/);
    for (const metric of Object.values(dataJson.metrics)) {
      assert.ok(metric.observationPeriod, 'every download metric needs an observation period');
      assert.ok(metric.method, 'every download metric needs a transformation method');
      assert.ok(metric.source, 'every download metric needs a source');
    }
    // Missing days fail closed: enumerated, never filled. The invariants are
    // recomputed independently of the producer's own bookkeeping — exact
    // calendar tiling, not a comparison against fields derived from the same
    // history array.
    for (const [id, series] of Object.entries(dataJson.series)) {
      assert.equal(series.rowCount, series.history.length, `${id}: rowCount must equal history length`);
      assert.equal(series.history[0].date, series.observationStart, `${id}: observationStart must match first row`);
      assert.equal(series.history.at(-1).date, series.observationEnd, `${id}: observationEnd must match last row`);
      assert.deepEqual(
        series.missingDates,
        enumerateMissingDates(series.history),
        `${id}: missingDates must be exactly the enumerated calendar gaps`,
      );
      const spanDays = Math.round(
        (Date.parse(`${series.observationEnd}T00:00:00Z`) - Date.parse(`${series.observationStart}T00:00:00Z`))
        / 86_400_000,
      ) + 1;
      assert.equal(
        series.history.length + series.missingDates.length,
        spanDays,
        `${id}: observed days plus gaps must tile the observation window exactly`,
      );
    }
  });

  it('links the hub, methodology, live surfaces, and distributions correctly', () => {
    assert.match(hubHtml, new RegExp(`href="/research/${report.slug}/"`));
    assert.match(html, /href="\/docs\/methodology\/chokepoints"/);
    assert.match(html, /href="\/chokepoints\/strait-of-hormuz\/"[^>]*data-umami-event-target="chokepoint-page"/);
    assert.match(html, /utm_source=research-report/);
    assert.doesNotMatch(html, /[?&]ref=/, 'research CTAs must never use the affiliate ref= param');
    const [reportLd] = jsonLdObjects(html);
    for (const distribution of reportLd.hasPart.distribution) {
      const filename = distribution.contentUrl.split('/').pop();
      assert.ok(
        existsSync(join(outDir, 'research', report.slug, filename)),
        `structured-data distribution ${filename} must exist beside the page`,
      );
    }
    // The focus chokepoint's static page links back to the report.
    const chokepointHtml = readFileSync(join(outDir, 'chokepoints', 'strait-of-hormuz', 'index.html'), 'utf8');
    assert.match(chokepointHtml, new RegExp(`href="/research/${report.slug}/"`));
    // OG image is the committed report-specific card, with meaningful alt text.
    assert.ok(
      existsSync(join(repoRoot, 'public', 'research-assets', `${report.slug}-og.png`)),
      'committed OG card missing',
    );
    assert.match(html, new RegExp(`og:image" content="https://www\\.worldmonitor\\.app/research-assets/${report.slug}-og\\.png"`));
    assert.doesNotMatch(
      html.match(/og:image:alt" content="([^"]+)"/)[1],
      /^World Monitor — real-time global intelligence dashboard/,
      'report OG alt must describe the report, not the generic site card',
    );
  });

  it('separates evidence layers and states failure modes in plain language', () => {
    for (const label of ['Observed transport data', 'Derived analysis', 'News context', 'Methodology']) {
      assert.ok(html.includes(label), `missing evidence-layer label: ${label}`);
    }
    assert.match(html, /What this edition does not cover/);
    assert.match(html, /partial/i, 'partial-month figures must be labelled');
    assert.match(html, /AIS/, 'AIS observation limitation must be stated');
    assert.match(html, /lower bound on total transit activity/, 'undercount framing must be present');
    // Distinct analytics targets for the report funnel.
    for (const target of ['download-csv', 'download-json', 'dashboard', 'chokepoint-page', 'developer', 'pricing']) {
      assert.ok(
        html.includes(`data-umami-event-target="${target}"`),
        `missing analytics funnel target: ${target}`,
      );
    }
    assert.match(html, /abacus\.worldmonitor\.app\/script\.js/, 'research pages must load analytics');
    assert.match(html, /nonce="wm-static-bootstrap"/);
  });

  it('regenerates byte-identically from the committed snapshot', async () => {
    const secondDir = mkdtempSync(join(tmpdir(), 'wm-research-corpus-again-'));
    try {
      await buildCorpus({ rootDir: repoRoot, outDir: secondDir, baseUrl: 'https://www.worldmonitor.app' });
      for (const path of [
        join('research', report.slug, 'index.html'),
        join('research', report.slug, files.csv),
        join('research', report.slug, files.json),
        join('research', 'index.html'),
      ]) {
        assert.equal(
          readFileSync(join(secondDir, path), 'utf8'),
          readFileSync(join(outDir, path), 'utf8'),
          `${path} is not deterministic`,
        );
      }
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('fails closed on unresolved tokens and missing snapshot series', () => {
    const escapeHtml = (value) => String(value);
    assert.throws(
      () => resolveMetricTokens('before {{m:doesNotExist}} after', new Map(), escapeHtml),
      /Unresolved metric token: doesNotExist/,
    );
    // Tokens the resolver regex does not recognize must still fail the build
    // via the document-level backstop, never ship literally.
    assert.throws(() => assertNoUnresolvedTokens('x {{m:snake_case}} y'), /Unresolved metric token/);
    assert.throws(() => assertNoUnresolvedTokens('x {{m: spaced}} y'), /Unresolved metric token/);
    // Averaging an empty window is a build failure, not a fabricated zero.
    assert.throws(() => mean([], 'total'), /refusing to fabricate/);
    // A wrong-edition report or snapshot trips the metric-window guard instead
    // of silently republishing the pilot's analysis under a new title.
    assert.throws(
      () => computeReportMetrics({ ...snapshot, edition: '2026-08' }, report),
      /edition/,
    );
    assert.throws(
      () => computeReportMetrics({ chokepoints: {} }, report),
      /edition/,
    );
    assert.throws(
      () => computeReportMetrics({ ...snapshot, chokepoints: {} }, report),
      /no focus chokepoint/,
    );
    const truncated = {
      ...snapshot,
      chokepoints: {
        ...snapshot.chokepoints,
        [report.focusChokepointId]: {
          ...snapshot.chokepoints[report.focusChokepointId],
          history: snapshot.chokepoints[report.focusChokepointId].history.filter(
            (row) => row.date < '2026-02-01',
          ),
        },
      },
    };
    assert.throws(
      () => computeReportMetrics(truncated, report),
      /incomplete daily coverage/,
      'a snapshot missing the observation window must fail the build, not render empties',
    );
  });

  it('fails closed when any published series has an interior calendar gap', () => {
    const missingDate = '2026-06-15';
    const publishedSeriesIds = [
      report.focusChokepointId,
      report.contextChokepointIds[0],
    ];

    for (const id of publishedSeriesIds) {
      const incomplete = structuredClone(snapshot);
      const series = incomplete.chokepoints[id];
      series.history = series.history.filter((row) => row.date !== missingDate);
      series.rowCount = series.history.length;

      assert.throws(
        () => computeReportMetrics(incomplete, report),
        new RegExp(`${id}.*incomplete daily coverage.*${missingDate}`, 'i'),
        `${id}: a missing interior day must fail the report build even when metadata omits the gap`,
      );
    }
  });

  it('fails closed when a published series contains an impossible calendar date', () => {
    const invalidDate = '2026-02-30';
    const invalid = structuredClone(snapshot);
    const series = invalid.chokepoints[report.focusChokepointId];
    const insertionIndex = series.history.findIndex((row) => row.date === '2026-03-01');
    series.history.splice(insertionIndex, 0, {
      ...series.history[insertionIndex - 1],
      date: invalidDate,
    });
    series.rowCount = series.history.length;

    assert.throws(
      () => computeReportMetrics(invalid, report),
      new RegExp(`${report.focusChokepointId}.*invalid observation date.*${invalidDate}`, 'i'),
    );
  });

  // Regression: the ArcGIS layer's server-side maxRecordCount (1000) is below
  // the requested page size, so advancing offset by PAGE_SIZE instead of the
  // rows actually returned silently skipped rows 1000-1999 (a contiguous
  // 1000-day hole) on any multi-page query. Both fetch loops must advance by
  // the returned row count.
  it('ArcGIS pagination advances by returned rows, not by requested page size', async () => {
    const makeFeature = (index) => ({ attributes: { date: 1714521600000 + index * 86_400_000 } });
    for (const fetchAllPages of [snapshotFetchAllPages, seederFetchAllPages]) {
      const offsets = [];
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const offset = Number(new URL(url).searchParams.get('resultOffset'));
        offsets.push(offset);
        const page = offset === 0
          ? { exceededTransferLimit: true, features: Array.from({ length: 1000 }, (_, i) => makeFeature(i)) }
          : { exceededTransferLimit: false, features: Array.from({ length: 757 }, (_, i) => makeFeature(offset + i)) };
        return { ok: true, json: async () => page };
      };
      try {
        const features = await fetchAllPages('Strait of Hormuz', fetchAllPages === seederFetchAllPages ? 0 : '2019-01-01');
        assert.deepEqual(offsets, [0, 1000], 'second request must start where the server actually stopped');
        assert.equal(features.length, 1757, 'no rows may be skipped across the page boundary');
      } finally {
        global.fetch = originalFetch;
      }
    }
  });

  it('snapshot producer helpers enumerate gaps and round-trip valid JSON', () => {
    const gaps = enumerateMissingDates([
      { date: '2026-01-01' },
      { date: '2026-01-02' },
      { date: '2026-01-05' },
    ]);
    assert.deepEqual(gaps, ['2026-01-03', '2026-01-04']);
    const roundTrip = JSON.parse(serializeSnapshot(snapshot));
    assert.deepEqual(roundTrip, snapshot);
  });
});
