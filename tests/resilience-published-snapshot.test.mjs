import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import YAML from 'yaml';

import * as crawlableCorpus from '../scripts/build-crawlable-corpus.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

describe('published resilience snapshot freshness', () => {
  it('selects the newest dated canonical snapshot and rejects filename drift', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-resilience-snapshot-selection-'));
    const snapshotDir = join(tempRoot, 'docs', 'snapshots');
    try {
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(
        join(snapshotDir, 'resilience-ranking-2026-06-01.json'),
        JSON.stringify({ capturedAt: '2026-06-01' }),
      );
      writeFileSync(
        join(snapshotDir, 'resilience-ranking-2026-08-01.json'),
        JSON.stringify({ capturedAt: '2026-08-01' }),
      );
      writeFileSync(
        join(snapshotDir, 'resilience-ranking-live-post-pr1-2026-09-01.json'),
        JSON.stringify({ capturedAt: '2026-09-01' }),
      );

      assert.equal(
        crawlableCorpus.resolveLatestResilienceSnapshotPath(tempRoot),
        'docs/snapshots/resilience-ranking-2026-08-01.json',
      );

      writeFileSync(
        join(snapshotDir, 'resilience-ranking-2026-09-01.json'),
        JSON.stringify({ capturedAt: '2026-08-31' }),
      );
      assert.throws(
        () => crawlableCorpus.resolveLatestResilienceSnapshotPath(tempRoot),
        /filename date 2026-09-01 does not match capturedAt 2026-08-31/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('publishes one truthful freshness contract on every country page', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'wm-resilience-published-corpus-'));
    try {
      const data = await crawlableCorpus.loadCorpusData({ rootDir: repoRoot });
      await crawlableCorpus.buildCorpus({ rootDir: repoRoot, outDir });
      const norway = readFileSync(join(outDir, 'countries', 'norway', 'index.html'), 'utf8');
      const webPage = jsonLdObjects(norway).find((entry) => entry['@type'] === 'WebPage');
      const dataset = webPage?.mainEntity;

      assert.equal(dataset?.datePublished, data.resilience.capturedAt);
      assert.equal(dataset?.dateModified, data.resilience.capturedAt);
      assert.equal(dataset?.temporalCoverage, data.resilience.capturedAt);
      assert.ok(data.resilience.snapshotNote, 'canonical snapshots must explain their publication state');
      assert.ok(norway.includes(data.resilience.snapshotNote), 'country page must surface snapshotNote verbatim');
      assert.match(
        norway,
        new RegExp(`<meta name="lastmod" content="${data.lastmod.countries}">`),
      );
      assert.ok(
        norway.includes(`Source: ${data.sources.resilienceSnapshot}.`),
        'country page must identify the selected dated snapshot',
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('documents the monthly publication cadence and the first methodology correction', () => {
    const methodology = readFileSync(
      join(repoRoot, 'docs', 'methodology', 'country-resilience-index.mdx'),
      'utf8',
    );
    const revisions = readFileSync(join(repoRoot, 'docs', 'corrections.mdx'), 'utf8');

    assert.match(methodology, /Live API scores refresh every 6 hours/);
    assert.match(methodology, /crawlable country snapshot is published monthly/);
    assert.match(revisions, /title: "Revision and Corrections Log"/);
    assert.match(revisions, /2026-06-01/);
    assert.match(revisions, /P1-1/);
    assert.match(revisions, /coverage-only member aggregation/);
  });

  it('runs a credentialed monthly capture and opens an idempotent review PR', () => {
    const workflow = readFileSync(
      join(repoRoot, '.github', 'workflows', 'resilience-snapshot-refresh.yml'),
      'utf8',
    );

    assert.match(workflow, /cron: '17 5 1 \* \*'/);
    assert.match(workflow, /secrets\.WORLDMONITOR_API_KEY/);
    assert.match(workflow, /node scripts\/freeze-resilience-ranking\.mjs/);
    assert.match(workflow, /npm run build:crawlable-corpus/);
    assert.match(workflow, /npm run build:sitemap/);
    assert.match(workflow, /gh pr list --state all/);
    assert.match(workflow, /gh pr create/);
    assert.doesNotMatch(workflow, /push --force/);

    const parsed = YAML.parse(workflow);
    const checkout = parsed.jobs.refresh.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(
      checkout?.with?.ref,
      'refs/heads/main',
      'publication checkout must pin main so workflow_dispatch cannot snapshot a feature branch',
    );
  });
});
