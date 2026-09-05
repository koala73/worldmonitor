// GEO re-audit residue from issue #7463. Cross-host Sitemap, llms-full corpus,
// well-known MCP server.json, corrections-log wiring, snapshot jargon, cadence,
// lastmod-as-change-date, and homepage as-of dates. CCBot and msvalidate.01 are
// captain calls — this file locks them as untouched rather than guessed.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { comparisonDiscoveryEntries } from '../scripts/build-comparison-pages.mjs';
import { COMPARISONS_HEADING, buildLlmsFullText, redactInternalApiOrigins, withComparisonsSection } from '../scripts/build-llms-full.mjs';
import { resolveLatestLivePulseSnapshotPath } from '../scripts/build-crawlable-corpus.mjs';
import { parseSitemapDocument } from '../scripts/verify-sitemaps.mjs';

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

  // "Usable" was previously read as "not redacted", and the URL this pinned —
  // https://api.worldmonitor.app/resilience/v1/get-runtime-manifest — 404s: the
  // route is /api/resilience/v1/..., and the link had been published without the
  // /api prefix (#7660, confirmed against production 2026-09-04). It now asserts
  // the served path as well as the surviving host, so a link that resolves to
  // nothing cannot pass again.
  it('keeps the public runtime-manifest link usable in llms-full', () => {
    const generated = buildLlmsFullText({ rootDir: repoRoot });
    const manifestPath = '/api/resilience/v1/get-runtime-manifest';
    const manifestUrl = `https://www.worldmonitor.app${manifestPath}`;
    const escaped = manifestUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      generated,
      new RegExp(`\\[runtime manifest\\]\\(${escaped}\\)`),
      'generated corpus must link the runtime manifest at the path that actually serves it',
    );
    // Every citation of the route must carry the /api prefix. A bare
    // `/resilience/v1/...` is the 404 shape, and `[REDACTED]/...` is the
    // over-redaction this test was originally written to catch.
    for (const citation of generated.match(/\S*\/resilience\/v1\/get-runtime-manifest/g) ?? []) {
      assert.ok(
        citation.includes('/api/resilience/v1/get-runtime-manifest'),
        `runtime-manifest citation does not resolve: ${citation}`,
      );
      assert.ok(!citation.includes('[REDACTED]'), `runtime-manifest citation was redacted: ${citation}`);
    }

    // The redaction rule itself: internal/preview `api.*` hosts collapse to
    // [REDACTED], the public API origin survives. Asserted directly rather
    // than through whichever document happens to cite it.
    const publicApiOrigin = ['https://api', 'worldmonitor.app'].join('.');
    const mixed = redactInternalApiOrigins([
      `see https://api.preview.example${manifestPath}`,
      `and ${publicApiOrigin}${manifestPath}`,
    ].join(' '));
    assert.match(mixed, /\[REDACTED\]\/api\/resilience\/v1\/get-runtime-manifest/);
    assert.ok(mixed.includes(`${publicApiOrigin}${manifestPath}`), 'the public API origin must survive redaction');
    assert.match(mixed, /pragma: allowlist secret/);
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
    const index = read('pro-test/index.html');
    const hero = read('pro-test/src/welcome/Hero.tsx');
    const home = read('public/home.md');
    const en = readJson('pro-test/src/locales/en.json');

    assert.match(index, /"dateModified": "2026-09-04"/);
    assert.match(hero, /dateTime="2026-09-04"/);
    assert.match(home, /2026-09-04/);
    assert.match(String(en.welcome?.hero?.asOf || ''), /2026-09-04|4 September 2026/);
  });

  it('homepage welcome.html dates track the teaser strip snapshot (#7654)', () => {
    // The strip reads docs/snapshots/crawlable-live-pulse-*.json, so the host
    // page's crawler-facing dates come from the same freeze — refreshed by
    // `npm run teasers:welcome`, never hand-maintained.
    const snapshot = readJson(resolveLatestLivePulseSnapshotPath(repoRoot));
    const welcome = read('pro-test/welcome.html');
    assert.match(welcome, new RegExp(`<meta name="lastmod" content="${snapshot.capturedAt}"`));
    assert.match(welcome, new RegExp(`"dateModified": "${snapshot.capturedAt}"`));
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
    assert.match(workflow, /git add "\$snapshot_path" public\/sitemap\.xml public\/sitemap-main\.xml public\/llms-full\.txt/);
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
    for (const file of ['public/llms.txt', 'public/llms-full.txt', 'index.html', 'docs/about.mdx']) {
      assert.match(read(file), standard, `${file} must carry the standard coverage definition`);
    }
    for (const file of ['public/llms.txt', 'public/llms-full.txt', 'index.html', 'docs/about.mdx']) {
      assert.doesNotMatch(read(file), /across 190\+ countries/, `${file} must not use the legacy reach phrasing`);
      assert.doesNotMatch(read(file), /used in 190\+ countries/, `${file} must not use the legacy reach phrasing`);
    }
  });
});

describe('GEO residue #7616 (U3 sitemap index)', () => {
  it('serves a root sitemap index listing exactly the three robots-declared sitemaps', () => {
    const index = parseSitemapDocument(read('public/sitemap.xml'));
    assert.equal(index.type, 'index', 'public/sitemap.xml must be a sitemap index, not a URL set');
    assert.deepEqual(
      [...index.locations].sort(),
      [
        'https://www.worldmonitor.app/blog/sitemap-index.xml',
        'https://www.worldmonitor.app/docs/sitemap.xml',
        'https://www.worldmonitor.app/sitemap-main.xml',
      ],
      'the root index must expose the local, blog, and docs sitemaps and nothing else',
    );
  });

  it('keeps the local URL set in sitemap-main.xml without blog/docs overlap', () => {
    const urlset = parseSitemapDocument(read('public/sitemap-main.xml'));
    assert.equal(urlset.type, 'urlset');
    assert.ok(
      urlset.locations.includes('https://www.worldmonitor.app/dashboard'),
      'sitemap-main.xml must list the dashboard route',
    );
    assert.ok(
      urlset.locations.every((loc) => !loc.includes('/blog/') && !loc.includes('/docs/')),
      'sitemap-main.xml must not overlap the blog or docs inventories',
    );
  });

  it('measures the local member lastmod and never fabricates foreign lastmod', () => {
    const source = read('public/sitemap.xml');
    const local = source.match(/<sitemap>\s*<loc>https:\/\/www\.worldmonitor\.app\/sitemap-main\.xml<\/loc>\s*(<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>)?\s*<\/sitemap>/);
    assert.ok(local?.[2], 'the local index member must carry a measured lastmod date');
    assert.doesNotMatch(
      source,
      /blog\/sitemap-index\.xml<\/loc>\s*<lastmod>/,
      'the blog member must not carry a fabricated lastmod',
    );
    assert.doesNotMatch(
      source,
      /docs\/sitemap\.xml<\/loc>\s*<lastmod>/,
      'the docs member must not carry a fabricated lastmod',
    );
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

// The 13 /compare/ pages scored 85–92 on citability yet were referenced from
// none of the surfaces built to tell an assistant what the site offers: zero
// mentions in llms.txt, llms-full.txt, or the served homepage (#7746). The
// section is generated from COMPARISON_PAGES and spliced into llms.txt by the
// same script that emits llms-full.txt, so the two cannot drift from each
// other or from the pages; the sitemap cross-check catches a route family
// that ships without a discovery entry at all.
describe('GEO residue #7746 (compare discoverability)', () => {
  const llmsTxt = () => read('public/llms.txt');
  const sitemapCompareUrls = () =>
    parseSitemapDocument(read('public/sitemap-main.xml')).locations
      .filter((loc) => new URL(loc).pathname.startsWith('/compare/'))
      .sort();

  it('lists every sitemap /compare/ URL in llms.txt and the generated llms-full corpus', () => {
    const urls = sitemapCompareUrls();
    assert.ok(urls.length >= 13, `sitemap-main.xml should carry the 13-route compare family, got ${urls.length}`);
    const generated = buildLlmsFullText({ rootDir: repoRoot });
    for (const url of urls) {
      // Exactly once: the splice locates its section by heading, so a renamed
      // heading would leave a stale copy behind that the fixed-point check
      // cannot see. Counting the links catches that duplicate.
      assert.equal(llmsTxt().split(`](${url})`).length, 2, `public/llms.txt must link ${url} exactly once`);
      assert.ok(generated.includes(`](${url})`), `generated llms-full must link ${url}`);
    }
  });

  it('keeps the llms.txt Comparisons section in sync with the generator, between Answer Blocks and Live Instances', () => {
    const body = llmsTxt();
    assert.equal(
      withComparisonsSection(body),
      body,
      'public/llms.txt Comparisons section is stale — run npm run build:llms-full',
    );
    const answerBlocks = body.indexOf('\n## AI Search Answer Blocks\n');
    const comparisons = body.indexOf(`\n${COMPARISONS_HEADING}\n`);
    const liveInstances = body.indexOf('\n## Live Instances\n');
    assert.ok(answerBlocks !== -1 && comparisons !== -1 && liveInstances !== -1, 'all three headings must exist');
    assert.ok(
      answerBlocks < comparisons && comparisons < liveInstances,
      'Comparisons must sit between AI Search Answer Blocks and Live Instances',
    );
    assert.equal(
      (body.match(new RegExp(`^${COMPARISONS_HEADING}$`, 'mg')) ?? []).length,
      1,
      'llms.txt must carry exactly one Comparisons section',
    );
  });

  it('derives one query-led discovery entry per compare route, matching the sitemap set exactly', () => {
    const entries = comparisonDiscoveryEntries('https://www.worldmonitor.app');
    assert.deepEqual(entries.map((entry) => entry.url).sort(), sitemapCompareUrls());
    const descriptions = new Set();
    for (const entry of entries) {
      assert.ok(entry.title.length > 0, `${entry.url} needs a title`);
      assert.ok(
        entry.description.length >= 60 && entry.description.length <= 240,
        `${entry.url} summary must be 60–240 chars, got ${entry.description.length}`,
      );
      assert.ok(!descriptions.has(entry.description), `${entry.url} summary duplicates another entry`);
      descriptions.add(entry.description);
      assert.ok(
        llmsTxt().includes(`- [${entry.title}](${entry.url}): ${entry.description}`),
        `llms.txt must carry the exact entry for ${entry.url}`,
      );
    }
  });

  it('splices the section idempotently and fails loudly on malformed input', () => {
    const doc = '# X\n\n## AI Search Answer Blocks\n\nbody\n\n## Live Instances\n\n- a\n';
    const once = withComparisonsSection(doc);
    assert.ok(once.includes(`\n${COMPARISONS_HEADING}\n`), 'first run inserts the section');
    assert.ok(once.indexOf(COMPARISONS_HEADING) < once.indexOf('## Live Instances'), 'inserted ahead of Live Instances');
    assert.equal(withComparisonsSection(once), once, 'the inserted document is a fixed point');
    const edited = once.replace('- [Compare World Monitor]', '- [Stale]');
    assert.notEqual(edited, once);
    assert.equal(withComparisonsSection(edited), once, 'a hand-edited section is replaced in place');
    assert.throws(() => withComparisonsSection('# X\n\n## Documentation\n\n- a\n'), /Live Instances/);
    assert.throws(() => withComparisonsSection(`${once}\n${COMPARISONS_HEADING}\n\nextra\n`), /exactly one/);
  });

  it('links the Liveuamap FAQ answer to the comparison page on the homepage and its agent mirror', () => {
    const label = 'worldmonitor.app/compare/liveuamap-alternatives';
    const href = '/compare/liveuamap-alternatives/';
    const en = readJson('pro-test/src/locales/en.json');
    assert.equal(en.welcome.faq.q5, 'How is this different from a conflict map like Liveuamap?');
    // The destination rides inside the answer string, like the terms link in
    // a11, so the FAQPage JSON-LD keeps it and the translator pins the URL.
    assert.ok(en.welcome.faq.a5.endsWith(`: ${label}.`), 'en a5 must end with the comparison destination');
    assert.equal(en.welcome.faq.a5Link, undefined, 'the label lives in a5, not a separate key');
    for (const file of readdirSync(join(repoRoot, 'pro-test/src/locales'))) {
      const answer = readJson(`pro-test/src/locales/${file}`).welcome?.faq?.a5;
      assert.ok(typeof answer === 'string' && answer.includes(label), `${file} a5 must keep the comparison destination`);
    }
    assert.equal(readJson('scripts/locale-baselines/pro-test.json')['welcome.faq.a5'], en.welcome.faq.a5);
    // FAQ.tsx maps that label to the route, and the route must be one the
    // comparison registry actually emits, so a renamed slug cannot leave the
    // homepage on a 404 while every generated surface moves.
    const faqSource = read('pro-test/src/welcome/FAQ.tsx');
    const mapping = faqSource.match(/label: '([^']+)', href: '(\/compare\/[^']+)'/);
    assert.ok(mapping, 'FAQ.tsx must map a compare label to its route');
    assert.equal(mapping[1], label);
    assert.equal(mapping[2], href);
    assert.ok(
      comparisonDiscoveryEntries('https://www.worldmonitor.app').some((entry) => entry.url === `https://www.worldmonitor.app${href}`),
      'the FAQ route must be a registered comparison page',
    );
    assert.match(
      read('public/home.md'),
      /\]\(https:\/\/www\.worldmonitor\.app\/compare\/\)/,
      'home.md must link the comparison hub',
    );
    assert.match(
      read('public/ai-search.md'),
      /^- Competitor comparisons[^\n]*https:\/\/www\.worldmonitor\.app\/compare\/$/m,
      'ai-search.md Relevant Pages must list the comparison hub',
    );
    assert.match(
      read('.github/workflows/resilience-snapshot-refresh.yml'),
      /git add [^\n]*public\/llms\.txt/,
      'the monthly refresh must stage llms.txt now that build:llms-full owns it',
    );
  });
});
