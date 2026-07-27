import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
  buildCorpus,
  gitFileLastmod,
  loadCorpusData,
} from '../scripts/build-crawlable-corpus.mjs';
import { buildSitemapEntries } from '../scripts/build-sitemap.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(outDir, path) {
  return readFileSync(join(outDir, path), 'utf8');
}

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
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
      assert.equal(manifest.generatorContentVersion, '2026-07-27');
      const sitemapEntries = buildSitemapEntries({
        repoRoot,
        publicDir: outDir,
        existingSitemapSource: '',
        resolveMaterialLastmod: () => '2026-07-27',
        today: '2026-07-27',
      });
      const corpusLocations = new Set(
        sitemapEntries
          .filter((entry) => entry.family === 'content-corpus')
          .map((entry) => new URL(entry.loc).pathname),
      );
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
        manifest.sections.changelog.index,
        ...manifest.sections.changelog.routes,
      ]);
      assert.deepEqual(corpusLocations, manifestLocations);
      const liveScriptTag = `<script type="module" nonce="${productionScriptNonce()}" src="/tools/live-tools.js"></script>`;
      assert.ok(manifest.sections.changelog.count >= 2, `expected paginated changelog pages, got ${manifest.sections.changelog.count}`);
      assert.ok(manifest.sections.glossary.count >= 15, `expected existing glossary manifest entries, got ${manifest.sections.glossary.count}`);

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
      assert.match(norway, /<meta name="lastmod" content="2026-07-27">/);
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
    assert.equal(data.resilience.capturedAt, '2026-05-28');
    assert.equal(data.lastmod.countries, '2026-07-27');
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
    assert.ok(data.changelog[0].bullets[0].includes('server scorer read non-existent'));
    assert.ok(data.changelog[0].bullets[0].includes('methodology_version is now v8'));
    assert.match(data.lastmod.chokepoints, /^\d{4}-\d{2}-\d{2}$/);
  });
});
