import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  buildCorpus,
  loadCorpusData,
} from '../scripts/build-crawlable-corpus.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(outDir, path) {
  return readFileSync(join(outDir, path), 'utf8');
}

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

describe('crawlable corpus generator', () => {
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
      assert.ok(manifest.sections.changelog.count >= 2, `expected paginated changelog pages, got ${manifest.sections.changelog.count}`);
      assert.ok(manifest.sections.glossary.count >= 15, `expected existing glossary manifest entries, got ${manifest.sections.glossary.count}`);

      for (const path of [
        'countries/index.html',
        'countries/norway/index.html',
        'chokepoints/index.html',
        'chokepoints/strait-of-hormuz/index.html',
        'reference/changelog/index.html',
        'reference/changelog/page/2/index.html',
        'crawlable-corpus.json',
      ]) {
        assert.ok(existsSync(join(outDir, path)), `missing generated file ${path}`);
      }

      const norway = read(outDir, 'countries/norway/index.html');
      assert.match(norway, /<h1>Norway country risk and resilience<\/h1>/);
      assert.match(norway, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/countries\/norway\/">/);
      assert.match(norway, /<meta name="lastmod" content="2026-05-28">/);
      assert.match(norway, /Source: docs\/snapshots\/resilience-ranking-2026-05-28\.json/);
      assert.doesNotMatch(norway, /<script[^>]+type="module"|id="app"/, 'country page must be raw static HTML, not the SPA shell');
      // Deep-link CTA into the live map (opens the maximized country brief). `&` is HTML-escaped.
      assert.match(norway, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?country=NO&amp;expanded=1">Open Norway on the live map/);

      const norwayLd = jsonLdObjects(norway);
      assert.ok(norwayLd.some((entry) => entry['@type'] === 'WebPage' && entry.about?.['@type'] === 'Country' && entry.about?.name === 'Norway'));
      assert.ok(norwayLd.some((entry) => entry['@type'] === 'BreadcrumbList'));

      const chokepointsIndex = read(outDir, 'chokepoints/index.html');
      // The "N routes" / raw-id card subtitles are gone; cards now describe what each waterway connects.
      assert.doesNotMatch(chokepointsIndex, /\d+ routes?<\/span>/, 'chokepoint index must not expose raw "N routes" counts');
      assert.doesNotMatch(chokepointsIndex, /hormuz_strait &middot;/, 'chokepoint index must not expose raw canonical ids');
      assert.match(chokepointsIndex, /Persian Gulf ↔ Gulf of Oman/, 'chokepoint cards should show the human region');

      const hormuz = read(outDir, 'chokepoints/strait-of-hormuz/index.html');
      assert.match(hormuz, /<h1>Strait of Hormuz<\/h1>/);
      assert.match(hormuz, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/chokepoints\/strait-of-hormuz\/">/);
      // Deep-link CTA into the live map (pans to + opens the waterway popup).
      assert.match(hormuz, /<a class="cta" href="https:\/\/www\.worldmonitor\.app\/\?chokepoint=hormuz_strait">Open Strait of Hormuz on the live map/);
      // Human trade-route names replace the old raw route-id dump.
      assert.match(hormuz, /Persian Gulf → Europe \(Oil\)/);
      assert.doesNotMatch(hormuz, /Canonical ID|Energy baseline|Route IDs:/, 'chokepoint page must not dump raw registry fields');
      // Cross-link to the matching glossary term.
      assert.match(hormuz, /href="\/blog\/glossary\/strait-of-hormuz\/"/);
      assert.doesNotMatch(hormuz, /<script[^>]+type="module"|id="app"/, 'chokepoint page must be raw static HTML, not the SPA shell');

      const hormuzLd = jsonLdObjects(hormuz);
      assert.ok(hormuzLd.some((entry) => entry['@type'] === 'WebPage' && entry.about?.['@type'] === 'Place' && entry.about?.name === 'Strait of Hormuz'));

      // A chokepoint with no modelled trade routes must degrade gracefully — never "0 routes".
      const dover = read(outDir, 'chokepoints/dover-strait/index.html');
      assert.doesNotMatch(dover, /0 routes?|none configured/);
      assert.match(dover, /tracked as a strategic waterway reference/);

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
    assert.equal(data.resilience.capturedAt, '2026-05-28');
    assert.ok(data.countries.some((country) => country.slug === 'norway' && country.rank === 1));
    assert.ok(data.chokepoints.some((chokepoint) => chokepoint.slug === 'strait-of-hormuz' && chokepoint.id === 'hormuz_strait'));
    assert.ok(data.glossaryTerms.some((term) => term.slug === 'country-resilience-index'));
    assert.ok(data.changelog[0].bullets[0].includes('server scorer read non-existent'));
    assert.ok(data.changelog[0].bullets[0].includes('methodology_version is now v8'));
    assert.match(data.lastmod.chokepoints, /^\d{4}-\d{2}-\d{2}$/);
  });
});
