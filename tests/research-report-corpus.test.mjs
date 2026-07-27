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
  buildCsvDownload,
  buildJsonDownload,
  computeReportMetrics,
  downloadFileNames,
  formatMetric,
  resolveMetricTokens,
} from '../scripts/build-research-reports.mjs';
import {
  enumerateMissingDates,
  serializeSnapshot,
} from '../scripts/build-chokepoint-transit-snapshot.mjs';
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
    assert.match(html, new RegExp(`<meta name="lastmod" content="${report.dateModified}">`));
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
    // Missing days fail closed: enumerated, never filled.
    for (const series of Object.values(dataJson.series)) {
      assert.ok(Array.isArray(series.missingDates), 'series must enumerate missing dates');
      assert.equal(series.history.length + series.missingDates.length >= series.rowCount, true);
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
    assert.throws(
      () => computeReportMetrics({ chokepoints: {} }, report),
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
      /No rows for metric/,
      'a snapshot missing the observation window must fail the build, not render empties',
    );
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
