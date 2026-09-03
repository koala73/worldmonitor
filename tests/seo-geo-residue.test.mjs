// GEO re-audit residue from issue #7463. Cross-host Sitemap, llms-full corpus,
// well-known MCP server.json, corrections-log wiring, snapshot jargon, cadence,
// lastmod-as-change-date, and homepage as-of dates. CCBot and msvalidate.01 are
// captain calls — this file locks them as untouched rather than guessed.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLlmsFullText, redactInternalApiOrigins } from '../scripts/build-llms-full.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

describe('GEO residue #7463', () => {
  it('variant robots.txt authorises the www sitemap for cross-host submission', () => {
    const body = read('public/robots.variant.txt');
    assert.match(body, /^Sitemap: https:\/\/www\.worldmonitor\.app\/sitemap\.xml$/m);
    assert.match(body, /^Sitemap: https:\/\/www\.worldmonitor\.app\/blog\/sitemap-index\.xml$/m);
    assert.match(body, /^Sitemap: https:\/\/www\.worldmonitor\.app\/docs\/sitemap\.xml$/m);
  });

  it('does not reverse CCBot Disallow:/ and does not invent msvalidate.01', () => {
    for (const file of ['public/robots.www.txt', 'public/robots.variant.txt', 'public/robots.api.txt']) {
      const body = read(file);
      assert.match(body, /^User-agent: CCBot$/m, `${file} must keep the CCBot group`);
      assert.match(body, /^Disallow: \/$/m, `${file} must keep Disallow:/`);
    }

    const homepageSources = [
      'pro-test/welcome.html',
      'pro-test/index.html',
      'pro-test/src/welcome/Hero.tsx',
      'public/home.md',
    ];
    for (const file of homepageSources) {
      assert.doesNotMatch(
        read(file),
        /msvalidate\.01/i,
        `${file} must not invent a Bing verification token`,
      );
    }
  });

  it('llms-full.txt is a 150–400 KB corpus, not a near-duplicate index', () => {
    const generated = buildLlmsFullText({ rootDir: repoRoot });
    const committed = read('public/llms-full.txt');
    assert.equal(
      committed,
      generated,
      'public/llms-full.txt is stale — run npm run build:llms-full',
    );

    const bytes = Buffer.byteLength(committed, 'utf8');
    const briefBytes = Buffer.byteLength(read('public/llms.txt'), 'utf8');
    assert.ok(
      bytes >= 150_000 && bytes <= 400_000,
      `llms-full.txt must be 150–400 KB, got ${bytes} bytes`,
    );
    assert.ok(
      bytes > briefBytes * 2,
      `llms-full.txt (${bytes} B) must be substantially larger than llms.txt (${briefBytes} B)`,
    );
    assert.match(committed, /Country Resilience Index/);
    assert.match(committed, /Strait of Hormuz/);
    assert.match(committed, /Suez Canal/);
    assert.match(committed, /## Generated corpus/);
    assert.match(committed, /72 indicators across 21 active dimensions, 6 domains/);
    assert.match(committed, /product-facts\.json.*capabilities\.localeCodes/);
  });

  it('keeps the public runtime-manifest link usable in llms-full', () => {
    const generated = buildLlmsFullText({ rootDir: repoRoot });
    const publicHost = ['api', 'worldmonitor.app'].join('.');
    const manifestPath = '/resilience/v1/get-runtime-manifest';
    const publicManifestUrl = `https://${publicHost}${manifestPath}`;
    const escaped = publicManifestUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      generated,
      new RegExp(`\\[runtime manifest\\]\\(${escaped}\\)`),
      'generated corpus must keep the canonical public runtime-manifest URL',
    );
    assert.doesNotMatch(
      generated,
      /\[runtime manifest\]\(\[REDACTED\]\/resilience\/v1\/get-runtime-manifest\)/,
    );
    assert.match(
      generated,
      new RegExp(`${escaped}[)\\s].*pragma: allowlist secret`),
    );

    const mixed = redactInternalApiOrigins([
      `see https://api.preview.example${manifestPath}`,
      `and ${publicManifestUrl}`,
    ].join(' '));
    assert.match(mixed, /\[REDACTED\]\/resilience\/v1\/get-runtime-manifest/);
    assert.match(mixed, new RegExp(escaped));
  });

  it('serves the MCP server card at the newer well-known server.json name', () => {
    const vercel = readJson('vercel.json');
    const rewrite = vercel.rewrites.find((entry) => entry.source === '/.well-known/mcp/server.json');
    assert.ok(rewrite, 'vercel.json must rewrite the newer well-known name');
    assert.equal(rewrite.destination, '/.well-known/mcp/server-card.json');
    assert.notEqual(
      readJson('server.json').name,
      readJson('public/.well-known/mcp/server-card.json').name,
      'do not publish the MCP registry server.json at the well-known path',
    );
  });

  it('published snapshot note warns about formula change without ticket jargon', () => {
    const current = readJson('docs/snapshots/resilience-ranking-2026-08-29.json');
    assert.doesNotMatch(current.snapshotNote, /Post-P1-1/);
    assert.match(current.snapshotNote, /different formula|not directly comparable/i);
    assert.match(current.snapshotNote, /domain design weights/i);
    assert.match(read('scripts/freeze-resilience-ranking.mjs'), /Earlier published CRI numbers used coverage-only member aggregation/);
    assert.doesNotMatch(read('scripts/freeze-resilience-ranking.mjs'), /Post-P1-1/);
  });

  it('corrections log distinguishes the first-of-month schedule from the 2026-08-29 artifact', () => {
    const en = read('docs/corrections.mdx');
    const zh = read('docs/zh/corrections.mdx');
    assert.match(en, /first day of each month/);
    assert.match(en, /resilience-ranking-2026-08-29/);
    assert.match(en, /[Oo]ff-cycle/);
    assert.doesNotMatch(
      en,
      /runs on the first day of each month\. It captures/,
      'must not imply the published 2026-08-29 artifact was a first-of-month run',
    );
    assert.match(zh, /每月第一天/);
    assert.match(zh, /resilience-ranking-2026-08-29/);
    assert.match(zh, /计划外/);
  });

  it('country lastmod includes livePulse and ignores the shared corpus generator stamp', () => {
    const source = read('scripts/build-crawlable-corpus.mjs');
    const match = source.match(/const countriesLastmod = laterDate\(([\s\S]*?)\);/);
    assert.ok(match, 'countriesLastmod assignment must exist');
    assert.match(match[1], /livePulse\.capturedAt/);
    assert.doesNotMatch(match[1], /CORPUS_GENERATOR_CONTENT_VERSION/);
    assert.match(match[1], /resilience\.capturedAt/);
    assert.match(match[1], /COUNTRY_PAGE_CONTENT_VERSION/);

    const chokepoints = source.match(/const chokepointsLastmod = laterDate\(([\s\S]*?)\);/);
    assert.ok(chokepoints);
    assert.match(chokepoints[1], /livePulse\.capturedAt/);
    assert.doesNotMatch(chokepoints[1], /CORPUS_GENERATOR_CONTENT_VERSION/);

    const research = source.match(/const researchLastmod = laterDate\(([\s\S]*?)\);/);
    assert.ok(research);
    assert.doesNotMatch(research[1], /CORPUS_GENERATOR_CONTENT_VERSION/);
    assert.doesNotMatch(research[1], /livePulse/);

    const useCases = source.match(/const useCasesLastmod = laterDate\(([\s\S]*?)\);/);
    assert.ok(useCases);
    assert.doesNotMatch(useCases[1], /CORPUS_GENERATOR_CONTENT_VERSION/);
    assert.doesNotMatch(useCases[1], /livePulse/);
  });

  it('homepage source has a YYYY-MM-DD as-of date in JSON-LD and visible copy', () => {
    const welcome = read('pro-test/welcome.html');
    const index = read('pro-test/index.html');
    const hero = read('pro-test/src/welcome/Hero.tsx');
    const home = read('public/home.md');
    const en = readJson('pro-test/src/locales/en.json');

    assert.match(welcome, /"dateModified": "2026-08-31"/);
    assert.match(index, /"dateModified": "2026-08-31"/);
    assert.match(hero, /dateTime="2026-08-31"/);
    assert.match(home, /2026-08-31/);
    assert.match(String(en.welcome?.hero?.asOf || ''), /2026-08-31|31 August 2026/);
  });

  it('does not add well-known server.json to the MCP registry publish path filter', () => {
    const workflow = read('.github/workflows/publish-mcp-registry.yml');
    assert.doesNotMatch(
      workflow,
      /public\/\.well-known\/mcp\/server\.json/,
      'well-known server.json is a discovery alias, not a registry publish input',
    );
  });

  it('regenerates llms-full when the monthly resilience snapshot refreshes', () => {
    const workflow = read('.github/workflows/resilience-snapshot-refresh.yml');
    assert.match(workflow, /npm run build:llms-full/);
    assert.match(workflow, /git add "\$snapshot_path" public\/sitemap\.xml public\/llms-full\.txt/);
  });
});

describe('GEO residue #7616 (U1 agent surfaces)', () => {
  function latestRankedCount() {
    const snapshots = readdirSync(join(repoRoot, 'docs/snapshots'))
      .filter((name) => /^resilience-ranking-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort();
    assert.ok(snapshots.length > 0, 'a published resilience snapshot must exist');
    const snapshot = JSON.parse(read(`docs/snapshots/${snapshots[ snapshots.length - 1]}`));
    assert.ok(Array.isArray(snapshot.items) && snapshot.items.length > 0);
    return snapshot.items.length;
  }

  it('links the real documentation file, not the dead DOCUMENTATION.md blob path', () => {
    const generated = buildLlmsFullText({ rootDir: repoRoot });
    for (const [label, body] of [['public/llms.txt', read('public/llms.txt')], ['generated llms-full', generated]]) {
      assert.doesNotMatch(
        body,
        /docs\/DOCUMENTATION\.md/,
        `${label} must not reference the dead DOCUMENTATION.md blob path`,
      );
      assert.match(
        body,
        /\(https:\/\/github\.com\/koala73\/worldmonitor\/blob\/main\/docs\/documentation\.mdx\)/,
        `${label} must link the real documentation.mdx location`,
      );
    }
  });

  it('states coverage with the two-part definition pinned to the live snapshot', () => {
    const ranked = latestRankedCount();
    const standard = new RegExp(`live in 190\\+ countries[^.]*structural resilience ranked for ${ranked}`);
    for (const file of ['public/llms.txt', 'index.html', 'docs/about.mdx']) {
      assert.match(read(file), standard, `${file} must carry the standard coverage definition`);
    }
    for (const file of ['public/llms.txt', 'public/llms-full.txt', 'index.html', 'docs/about.mdx']) {
      assert.doesNotMatch(read(file), /across 190\+ countries/, `${file} must not use the legacy reach phrasing`);
      assert.doesNotMatch(read(file), /used in 190\+ countries/, `${file} must not use the legacy reach phrasing`);
    }
  });
});

describe('GEO residue #7463 filesystem', () => {
  it('does not duplicate the MCP registry server.json under well-known', () => {
    const names = readdirSync(join(repoRoot, 'public/.well-known/mcp'));
    assert.ok(names.includes('server-card.json'));
    assert.equal(
      names.includes('server.json'),
      false,
      'well-known server.json must be a rewrite alias, not a second copy of the card',
    );
  });
});
