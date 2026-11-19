import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  MAX_SEARCH_LINKS,
  SEARCH_LINK_FAMILIES,
  linkedPaths,
  mainOf,
  ownerOf,
  parseLedger,
  placeSearchLinks,
  readQueryPages,
  selectSearchLinks,
} from '../scripts/lib/search-links.mjs';
import { createTargetResolver, loadSearchLinks, runCli, searchLinksPath } from '../scripts/search-links.mjs';
import { buildQueryPages } from '../scripts/seo-gsc-collect.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const page = (path, impressions, position = 8) => ({ path, impressions, position });
const query = (text, pages, likelyAutomated = false) => ({ query: text, likelyAutomated, pages });
const everyTargetResolves = () => true;
const sourcesOf = (...paths) => new Map(paths.map((path) => [path, new Set()]));

describe('search-link shapes other modules own', () => {
  it('leaves structural and live-data links to the module that decides them', () => {
    assert.match(ownerOf('/countries/norway/', '/chokepoints/strait-of-hormuz/'), /chokepoint-countries/);
    assert.match(ownerOf('/countries/norway/', '/countries/sweden/'), /country-related-links/);
    assert.match(ownerOf('/countries/norway/', '/crises/ukraine-war/'), /formatCrisisContext/);
    assert.match(ownerOf('/chokepoints/suez-canal/', '/crises/red-sea-security/'), /crisisSlugs/);
    assert.match(ownerOf('/crises/red-sea-security/', '/chokepoints/bab-el-mandeb/'), /crisisSlugs/);
    assert.match(ownerOf('/crises/ukraine-war/', '/countries/ukraine/'), /crawlable-crises/);
    assert.match(ownerOf('/countries/france/', '/tools/treasury-yield-curve/'), /live-pages\/related-links/);
  });

  it('opens every other shape to search evidence', () => {
    assert.equal(ownerOf('/countries/norway/', '/blog/posts/x/'), null);
    assert.equal(ownerOf('/countries/norway/', '/tools/airspace-disruption-checker/'), null, 'not a live topic page');
    assert.equal(ownerOf('/chokepoints/suez-canal/', '/chokepoints/bab-el-mandeb/'), null);
    assert.equal(ownerOf('/use-cases/monitor-maritime-security/', '/countries/yemen/'), null);
    assert.equal(ownerOf('/tools/prediction-markets/', '/crises/ukraine-war/'), null);
    assert.equal(ownerOf('/countries/france/', '/countries/'), null, 'no owner decides links to a family hub');
    assert.equal(ownerOf('/countries/north-korea/', '/crises/'), null, 'no owner decides links to a family hub');
    assert.equal(ownerOf('/crises/', '/countries/ukraine/'), null, 'no owner decides links from a family hub');
  });
});

describe('search-link selection', () => {
  it('links every other landing page Google showed for a query to its top page, with the query as anchor', () => {
    const chosen = selectSearchLinks({
      queryPages: [query('bab el mandeb shipping', [
        page('/chokepoints/bab-el-mandeb/', 500, 6),
        page('/use-cases/monitor-maritime-security/', 40),
        page('/blog/posts/red-sea/', 30),
      ])],
      sources: sourcesOf('/chokepoints/bab-el-mandeb/', '/use-cases/monitor-maritime-security/'),
      resolves: everyTargetResolves,
    });
    assert.deepEqual(chosen.map(({ source, href, anchor }) => ({ source, href, anchor })), [
      { source: '/use-cases/monitor-maritime-security/', href: '/chokepoints/bab-el-mandeb/', anchor: 'Bab el mandeb shipping' },
    ]);
    assert.equal(chosen[0].targetPosition, 6);
  });

  it('keeps five links per page, targets ranking 4-15 first, then the busier target', () => {
    const source = '/tools/prediction-markets/';
    const queryPages = [
      ['a', '/blog/posts/a/', 900, 2],
      ['b', '/blog/posts/b/', 800, 20],
      ['c', '/blog/posts/c/', 100, 5],
      ['d', '/blog/posts/d/', 200, 14],
      ['e', '/blog/posts/e/', 50, 4],
      ['f', '/blog/posts/f/', 700, 1],
      ['g', '/blog/posts/g/', 60, 15],
    ].map(([text, path, impressions, position]) => query(text, [page(path, impressions, position), page(source, 10)]));
    const chosen = selectSearchLinks({ queryPages, sources: sourcesOf(source), resolves: everyTargetResolves });
    assert.equal(chosen.length, MAX_SEARCH_LINKS);
    assert.deepEqual(chosen.map((link) => link.href), [
      '/blog/posts/d/',
      '/blog/posts/c/',
      '/blog/posts/g/',
      '/blog/posts/e/',
      '/blog/posts/a/',
    ]);
  });

  it('links a target once per page however many queries it wins', () => {
    const source = '/tools/prediction-markets/';
    const chosen = selectSearchLinks({
      queryPages: [
        query('polymarket odds', [page('/blog/posts/markets/', 300), page(source, 20)]),
        query('prediction market odds', [page('/blog/posts/markets/', 200), page(source, 25)]),
      ],
      sources: sourcesOf(source),
      resolves: everyTargetResolves,
    });
    assert.deepEqual(chosen.map((link) => link.anchor), ['Polymarket odds']);
  });

  it('skips owned shapes, linked targets, struck pairs, dead targets, automated and long queries', () => {
    const source = '/countries/yemen/';
    const sources = new Map([[source, new Set(['/blog/posts/already/'])]]);
    const chosen = selectSearchLinks({
      queryPages: [
        query('owned', [page('/chokepoints/bab-el-mandeb/', 90), page(source, 9)]),
        query('already linked', [page('/blog/posts/already/', 90), page(source, 9)]),
        query('struck', [page('/blog/posts/struck/', 90), page(source, 9)]),
        query('dead', [page('/blog/posts/gone/', 90), page(source, 9)]),
        query('automated', [page('/blog/posts/bots/', 90), page(source, 9)], true),
        query('one two three four five six seven eight nine ten eleven', [page('/blog/posts/long/', 90), page(source, 9)]),
        query('kept', [page('/blog/posts/kept/', 90), page(source, 9)]),
      ],
      sources,
      exclusions: [{ source, href: '/blog/posts/struck/' }],
      resolves: (href) => href !== '/blog/posts/gone/',
    });
    assert.deepEqual(chosen.map((link) => link.href), ['/blog/posts/kept/']);
  });

  it('never makes a page that is not a built landing page a source', () => {
    const chosen = selectSearchLinks({
      queryPages: [query('red sea', [page('/crises/red-sea-security/', 90), page('/blog/posts/red-sea/', 40)])],
      sources: sourcesOf('/crises/red-sea-security/'),
      resolves: everyTargetResolves,
    });
    assert.deepEqual(chosen, []);
  });

  it('reads the snapshot query pages at the boundary and refuses what it cannot trust', () => {
    assert.throws(() => readQueryPages({ performance: {} }, 'old.json'), /old\.json has no performance\.queryPages/);
    assert.throws(
      () => readQueryPages({ performance: { queryPages: { status: 'unavailable', reason: 'quota', rows: [] } } }, 'cut.json'),
      /cut\.json queryPages is unavailable: quota/,
    );
    const repeated = { performance: { queryPages: { status: 'available', rows: [query('q', [page('/a/', 9), page('/a/', 8)])] } } };
    assert.throws(() => readQueryPages(repeated), /malformed or repeated page/);
    const unordered = { performance: { queryPages: { status: 'available', rows: [query('q', [page('/a/', 1), page('/b/', 8)])] } } };
    assert.throws(() => readQueryPages(unordered), /not ordered by impressions/);
    const unknownFlag = { performance: { queryPages: { status: 'available', rows: [query('q', [page('/a/', 9)], null)] } } };
    assert.throws(() => readQueryPages(unknownFlag), /"q" has no likelyAutomated flag/, 'an unknown flag is not "not automated"');
  });
});

describe('search-link ledger', () => {
  const ledger = (pages, extra = {}) => ({ snapshot: 'docs/research/seo-ai-visibility/gsc/2026-11-16.json', pages, exclusions: [], ...extra });
  const parse = (family, value, resolves = everyTargetResolves) => parseLedger(family, value, { resolves, label: 'ledger' });

  it('accepts an empty ledger and returns each source page with its links', () => {
    assert.equal(parse('countries', { snapshot: null, pages: {}, exclusions: [] }).size, 0);
    const links = parse('chokepoints', ledger({ '/chokepoints/suez-canal/': [{ href: '/blog/posts/suez/', anchor: 'Suez canal traffic' }] }));
    assert.deepEqual(links.get('/chokepoints/suez-canal/'), [{ href: '/blog/posts/suez/', anchor: 'Suez canal traffic' }]);
  });

  it('rejects every row the build would render wrong', () => {
    const source = '/chokepoints/suez-canal/';
    const row = (href, anchor = 'Anchor') => ({ href, anchor });
    const cases = [
      [ledger({ [source]: [row('/blog/posts/gone/')] }), /does not publish/, (href) => href !== '/blog/posts/gone/'],
      [ledger({ [source]: [row(source)] }), /links itself/],
      [ledger({ [source]: [row('/blog/posts/a/'), row('/blog/posts/a/')] }), /twice/],
      [ledger({ [source]: Array.from({ length: 6 }, (_, index) => row(`/blog/posts/${index}/`)) }), /1-5 links/],
      [ledger({ [source]: [] }), /1-5 links/],
      [ledger({ [source]: [row('/crises/red-sea-security/')] }), /decided by crisisSlugs/],
      [ledger({ [source]: [row('/blog/posts/a/?utm_source=x')] }), /not a bare path/],
      [ledger({ [source]: [row('https://www.worldmonitor.app/blog/posts/a/')] }), /not a bare path/],
      [ledger({ [source]: [row('/blog/posts/a/', ' ')] }), /needs an anchor/],
      [ledger({ [source]: [row('/blog/posts/a/', 'one two three four five six seven eight nine ten eleven')] }), /needs an anchor/],
      [ledger({ '/crises/red-sea-security/': [row('/blog/posts/a/')] }), /not a chokepoints page/],
      [ledger({ [source]: [row('/blog/posts/a/')] }, { exclusions: [{ source, href: '/blog/posts/a/' }] }), /struck/],
      [ledger({ [source]: [row('/blog/posts/a/')] }, { snapshot: null }), /must name its snapshot/],
      [{ snapshot: null, pages: [], exclusions: [] }, /pages must be an object/],
    ];
    for (const [value, message, resolves] of cases) {
      assert.throws(() => parse('chokepoints', value, resolves), message);
    }
  });
});

describe('search-link placement', () => {
  const rows = (...hrefs) => hrefs.map((href) => ({ href, anchor: `Anchor ${href}` }));

  it('renders the Related block at the end of main with only links the page lacks', () => {
    const main = '<p><a href="/blog/posts/a/#intro">A</a> <a href="https://www.worldmonitor.app/blog/posts/b/?ref=x">B</a></p>';
    const block = placeSearchLinks(main, '/countries/yemen/', rows('/blog/posts/a/', '/blog/posts/b/', '/countries/yemen/', '/blog/posts/c/'), escapeHtml);
    assert.equal(block, `      <section data-search-links>
      <h2>Related</h2>
      <ul class="related">
        <li><a href="/blog/posts/c/">Anchor /blog/posts/c/</a></li>
      </ul>
      </section>`);
  });

  it('renders nothing when no link survives and at most five when many do', () => {
    assert.equal(placeSearchLinks('<a href="/blog/posts/a/">A</a>', '/tools/', rows('/blog/posts/a/'), escapeHtml), '');
    assert.equal(placeSearchLinks('', '/tools/', [], escapeHtml), '');
    const many = placeSearchLinks('', '/tools/', rows(...Array.from({ length: 7 }, (_, index) => `/blog/posts/${index}/`)), escapeHtml);
    assert.equal((many.match(/<li>/g) ?? []).length, MAX_SEARCH_LINKS);
  });

  it('does not count a page\'s own search links as links it already has', () => {
    const html = '<a href="/docs/algorithms">M</a><section data-search-links><h2>Related</h2><ul><li><a href="/blog/posts/x/">X</a></li></ul></section>';
    assert.deepEqual([...linkedPaths(html)], ['/docs/algorithms']);
  });
});

describe('search links in the built corpus', () => {
  const SOURCE = '/chokepoints/bab-el-mandeb/';
  function ledgerRoot(links) {
    const dir = mkdtempSync(join(tmpdir(), 'wm-search-links-ledger-'));
    mkdirSync(join(dir, dirname(searchLinksPath('chokepoints'))), { recursive: true });
    writeFileSync(join(dir, searchLinksPath('chokepoints')), JSON.stringify({
      snapshot: 'docs/research/seo-ai-visibility/gsc/2026-11-03.json',
      pages: { [SOURCE]: links },
      exclusions: [],
    }));
    return dir;
  }

  it('ends <main> with only the links the composed page lacks', async () => {
    const searchLinksRootDir = ledgerRoot([
      // Rendered by renderContextualComparisons, after the page body.
      { href: '/compare/chokepoint-monitoring-tools/', anchor: 'Chokepoint monitoring tools' },
      { href: '/blog/posts/what-is-a-maritime-chokepoint/', anchor: 'What is a maritime chokepoint' },
      { href: '/chokepoints/', anchor: 'Chokepoint tracker' },
    ]);
    const outDir = mkdtempSync(join(tmpdir(), 'wm-search-links-corpus-'));
    try {
      await buildCorpus({ rootDir: repoRoot, outDir, searchLinksRootDir });
      const main = mainOf(readFileSync(join(outDir, SOURCE, 'index.html'), 'utf8'));
      const block = /<section data-search-links>[\s\S]*<\/section>/.exec(main)?.[0];
      assert.ok(block, 'the source page renders a search-links block');
      assert.ok(main.trimEnd().endsWith(block), 'the block is the last thing in <main>');
      assert.deepEqual([...block.matchAll(/href="([^"]*)"/g)].map((match) => match[1]), ['/chokepoints/']);
      for (const href of ['/compare/chokepoint-monitoring-tools/', '/blog/posts/what-is-a-maritime-chokepoint/']) {
        assert.equal(main.split(`href="${href}"`).length - 1, 1, href);
      }
      const other = readFileSync(join(outDir, 'chokepoints/kerch-strait/index.html'), 'utf8');
      assert.doesNotMatch(other, /data-search-links/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(searchLinksRootDir, { recursive: true, force: true });
    }
  });

  it('rejects a link the site does not publish before replacing generated pages', async () => {
    const searchLinksRootDir = ledgerRoot([{ href: '/blog/posts/no-such-post/', anchor: 'No such post' }]);
    const outDir = mkdtempSync(join(tmpdir(), 'wm-search-links-corpus-'));
    try {
      mkdirSync(join(outDir, 'chokepoints'), { recursive: true });
      writeFileSync(join(outDir, 'chokepoints/index.html'), 'Existing chokepoint hub');
      await assert.rejects(
        buildCorpus({ rootDir: repoRoot, outDir, searchLinksRootDir }),
        /no-such-post.*does not publish/,
      );
      assert.equal(readFileSync(join(outDir, 'chokepoints/index.html'), 'utf8'), 'Existing chokepoint hub');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(searchLinksRootDir, { recursive: true, force: true });
    }
  });
});

describe('search-links CLI', () => {
  const SNAPSHOT = 'docs/research/seo-ai-visibility/gsc/2026-11-16.json';
  const ROUTES = ['/chokepoints/', '/chokepoints/bab-el-mandeb/', '/use-cases/', '/use-cases/monitor-maritime-security/', '/countries/', '/countries/yemen/'];

  function fixtureRepo() {
    const root = mkdtempSync(join(tmpdir(), 'wm-search-links-'));
    const write = (path, contents) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    };
    const row = (key, url, impressions, position) => ({ key, secondKey: `https://www.worldmonitor.app${url}`, clicks: 0, impressions, position });
    const queryPages = buildQueryPages({
      window: { label: '90d' },
      page: {
        recorded: true,
        truncationReason: null,
        rows: [
          row('bab el mandeb', '/chokepoints/bab-el-mandeb/', 400, 6),
          row('bab el mandeb', '/use-cases/monitor-maritime-security/', 30, 18),
          row('bab el mandeb', '/countries/yemen/', 25, 22),
          row('maritime security monitoring', '/use-cases/monitor-maritime-security/', 120, 9),
          row('maritime security monitoring', '/chokepoints/bab-el-mandeb/', 15, 30),
          row('yemen houthi shipping', '/blog/posts/houthi-shipping/', 90, 11),
          row('yemen houthi shipping', '/countries/yemen/', 40, 13),
          row('yemen houthi shipping', '/use-cases/', 12, 40),
        ],
      },
    }, { status: 'available', window: '28d', rows: [] });
    write(SNAPSHOT, JSON.stringify({ performance: { queryPages } }));
    write('blog-site/src/content/blog/houthi-shipping.md', '---\ntitle: Houthi shipping\n---\n');
    write('public/crawlable-corpus.json', JSON.stringify({
      sections: {
        countries: { index: '/countries/', routes: ['/countries/yemen/'] },
        chokepoints: { index: '/chokepoints/', routes: ['/chokepoints/bab-el-mandeb/'] },
        useCases: { index: '/use-cases/', routes: ['/use-cases/monitor-maritime-security/'] },
      },
    }));
    for (const route of ROUTES) {
      const links = route === '/use-cases/' ? '<a href="/blog/posts/houthi-shipping/">Houthi</a>' : '';
      write(`public${route}index.html`, `<html><body><nav><a href="/chokepoints/bab-el-mandeb/">x</a></nav><main><h1>${route}</h1>${links}</main></body></html>`);
    }
    write(searchLinksPath('chokepoints'), JSON.stringify({
      snapshot: null,
      pages: {},
      exclusions: [{ source: '/chokepoints/bab-el-mandeb/', href: '/use-cases/monitor-maritime-security/' }],
    }));
    // A pre-push hook exports GIT_DIR, which would point these writes at the real repo.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', SNAPSHOT);
    git('commit', '-qm', 'snapshot');
    return root;
  }

  it('prints the proposal from the newest committed snapshot and writes nothing without --write', () => {
    const root = fixtureRepo();
    try {
      const lines = [];
      const result = runCli([], { rootDir: root, log: (line) => lines.push(line) });
      assert.deepEqual(result.chosen.map(({ source, href }) => `${source} -> ${href}`), [
        '/use-cases/monitor-maritime-security/ -> /chokepoints/bab-el-mandeb/',
        '/countries/yemen/ -> /blog/posts/houthi-shipping/',
      ], 'country -> chokepoint is owned, the struck pair stays struck and /use-cases/ already links the post');
      assert.match(lines.join('\n'), /\| \/countries\/yemen\/ \| Yemen houthi shipping \| \/blog\/posts\/houthi-shipping\/ \| 11 \| 90 \| 40 \|/);
      assert.deepEqual(result.written, []);
      assert.equal(JSON.parse(readFileSync(join(root, searchLinksPath('chokepoints')), 'utf8')).snapshot, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes only the ledgers whose links changed, keeps exclusions, and the build loads them', () => {
    const root = fixtureRepo();
    try {
      const result = runCli(['--write'], { rootDir: root, log: () => {} });
      assert.deepEqual(result.written, [searchLinksPath('countries'), searchLinksPath('use-cases')]);
      const useCases = JSON.parse(readFileSync(join(root, searchLinksPath('use-cases')), 'utf8'));
      assert.deepEqual(useCases, {
        snapshot: SNAPSHOT,
        pages: { '/use-cases/monitor-maritime-security/': [{ href: '/chokepoints/bab-el-mandeb/', anchor: 'Bab el mandeb' }] },
        exclusions: [],
      });
      assert.equal(JSON.parse(readFileSync(join(root, searchLinksPath('chokepoints')), 'utf8')).exclusions.length, 1);
      assert.deepEqual(runCli(['--write'], { rootDir: root, log: () => {} }).written, [], 'a rerun is a no-op');
      const links = loadSearchLinks({ rootDir: root, resolves: () => true });
      assert.deepEqual([...links.keys()].sort(), ['/countries/yemen/', '/use-cases/monitor-maritime-security/']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes no ledger for a family with nothing to hold, and removes one the proposal empties or that is already empty', () => {
    const root = fixtureRepo();
    try {
      writeFileSync(join(root, searchLinksPath('tools')), JSON.stringify({ snapshot: null, pages: {}, exclusions: [] }));
      writeFileSync(join(root, searchLinksPath('crises')), JSON.stringify({
        snapshot: 'docs/research/seo-ai-visibility/gsc/2026-11-09.json',
        pages: { '/crises/red-sea/': [{ href: '/countries/yemen/', anchor: 'Red sea crisis' }] },
        exclusions: [],
      }));
      const result = runCli(['--write'], { rootDir: root, log: () => {} });
      assert.deepEqual(result.written, [searchLinksPath('countries'), searchLinksPath('crises'), searchLinksPath('tools'), searchLinksPath('use-cases')]);
      assert.deepEqual(
        SEARCH_LINK_FAMILIES.filter((family) => existsSync(join(root, searchLinksPath(family)))),
        ['countries', 'chokepoints', 'use-cases'],
        'only ledgers holding links or exclusions exist',
      );
      assert.deepEqual(runCli(['--write'], { rootDir: root, log: () => {} }).written, [], 'a rerun is a no-op');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to propose links while a landing page is unbuilt', () => {
    const root = fixtureRepo();
    try {
      rmSync(join(root, 'public/countries/yemen/index.html'));
      assert.throws(() => runCli(['--write'], { rootDir: root, log: () => {} }), /public\/countries\/yemen\/index\.html is missing/);
      assert.equal(existsSync(join(root, searchLinksPath('countries'))), false, 'nothing was written');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a docs page only when docs/.mintignore leaves it published', () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-search-links-docs-'));
    try {
      for (const file of ['docs/public-page.mdx', 'docs/runbook.md', 'docs/research/notes.mdx', 'docs/research.mdx']) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), '# page\n');
      }
      writeFileSync(join(root, 'docs/.mintignore'), '# kept off the site\nrunbook.md\nresearch/\n');
      const resolves = createTargetResolver({ rootDir: root, manifest: { sections: {} }, blogPostPaths: new Set() });
      assert.equal(resolves('/docs/public-page'), true);
      assert.equal(resolves('/docs/runbook'), false, 'an exact path is ignored');
      assert.equal(resolves('/docs/research/notes'), false, 'a dir/ prefix is ignored');
      assert.equal(resolves('/docs/research'), true, 'a dir/ prefix leaves the same-named page published');
      assert.equal(resolves('/docs/missing'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads only a snapshot committed in this repository', () => {
    const root = fixtureRepo();
    try {
      writeFileSync(join(root, 'docs/research/seo-ai-visibility/gsc/2026-11-23.json'), readFileSync(join(root, SNAPSHOT)));
      assert.throws(
        () => runCli(['--snapshot', 'docs/research/seo-ai-visibility/gsc/2026-11-23.json'], { rootDir: root, log: () => {} }),
        /is not committed as it is on disk/,
      );
      assert.throws(() => runCli(['--snapshot', '../elsewhere.json'], { rootDir: root, log: () => {} }), /outside the repository/);
      const lines = [];
      runCli([], { rootDir: root, log: (line) => lines.push(line) });
      assert.match(lines[0], /from docs\/research\/seo-ai-visibility\/gsc\/2026-11-16\.json/, 'the uncommitted newer file is skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
