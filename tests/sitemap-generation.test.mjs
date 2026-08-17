import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { XMLValidator } from 'fast-xml-parser';

import {
  SITE_ORIGIN,
  STATIC_ROUTE_MANIFEST,
  buildSitemapEntries,
  createMaterialLastmodResolver,
  generateSitemapXml,
  validateSitemapEntries,
} from '../scripts/build-sitemap.mjs';
import { gitFileLastmod } from '../scripts/build-crawlable-corpus.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitLocalEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
}).trim().split('\n');

function isolatedGitEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of gitLocalEnvVars) delete env[name];
  return env;
}

function writeCorpusPage(publicDir, relativePath, { canonical, lastmod, robots = 'index, follow' }) {
  const target = join(publicDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `<!doctype html><html><head><meta name="robots" content="${robots}">`
      + `<link rel="canonical" href="${canonical}">`
      + `<meta name="lastmod" content="${lastmod}"></head><body>fixture</body></html>`,
  );
}

describe('root sitemap generator', () => {
  it('declares owned material-content sources without copying blog or docs inventories', () => {
    assert.ok(STATIC_ROUTE_MANIFEST.length > 10);

    const locations = STATIC_ROUTE_MANIFEST.map((route) => route.loc);
    assert.ok(locations.includes(`${SITE_ORIGIN}/`));
    assert.ok(locations.includes(`${SITE_ORIGIN}/dashboard`));
    assert.ok(locations.includes(`${SITE_ORIGIN}/pro`));
    assert.ok(locations.includes('https://worldmonitor.app/mcp'));
    assert.ok(locations.includes(`${SITE_ORIGIN}/pricing.md`));
    assert.ok(locations.includes('https://tech.worldmonitor.app/dashboard'));
    assert.ok(locations.every((loc) => !new URL(loc).pathname.startsWith('/blog')));
    assert.ok(locations.every((loc) => !new URL(loc).pathname.startsWith('/docs')));

    for (const route of STATIC_ROUTE_MANIFEST) {
      assert.ok(route.family, `${route.loc} must declare a family`);
      assert.ok(route.materialSources.length > 0, `${route.loc} must declare material sources`);
      for (const sourcePath of route.materialSources) {
        assert.ok(!sourcePath.startsWith('/'), `${route.loc} source paths must be repository-relative`);
      }
    }
  });

  it('generates byte-identical canonical entries from static owners and corpus page metadata', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-sitemap-generator-'));
    const publicDir = join(tempRoot, 'public');
    try {
      writeCorpusPage(publicDir, 'countries/norway/index.html', {
        canonical: `${SITE_ORIGIN}/countries/norway/`,
        lastmod: '2026-05-28',
      });
      writeCorpusPage(publicDir, 'tools/natural-hazard-pulse/index.html', {
        canonical: `${SITE_ORIGIN}/tools/natural-hazard-pulse/`,
        lastmod: '2026-07-20',
      });

      const resolveMaterialLastmod = () => '2026-07-21';
      const firstEntries = buildSitemapEntries({
        repoRoot,
        publicDir,
        resolveMaterialLastmod,
        requireCompleteCorpus: false,
        today: '2026-07-27',
      });
      const secondEntries = buildSitemapEntries({
        repoRoot,
        publicDir,
        resolveMaterialLastmod,
        requireCompleteCorpus: false,
        today: '2026-07-27',
      });
      const first = generateSitemapXml(firstEntries);
      const second = generateSitemapXml(secondEntries);

      assert.equal(second, first);
      assert.equal(XMLValidator.validate(first), true);
      assert.match(first, /<loc>https:\/\/www\.worldmonitor\.app\/countries\/norway\/<\/loc>/);
      assert.match(first, /<loc>https:\/\/www\.worldmonitor\.app\/tools\/natural-hazard-pulse\/<\/loc>/);
      assert.match(first, /<lastmod>2026-05-28<\/lastmod>/);
      assert.match(first, /<lastmod>2026-07-20<\/lastmod>/);
      assert.doesNotMatch(first, /<changefreq>|<priority>/);
      assert.doesNotMatch(first, /worldmonitor\.app\/blog/);
      assert.doesNotMatch(first, /worldmonitor\.app\/docs/);

      const locations = firstEntries.map((entry) => entry.loc);
      assert.equal(new Set(locations).size, locations.length);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed, noncanonical, duplicate, missing, and future metadata', () => {
    const valid = {
      loc: `${SITE_ORIGIN}/dashboard`,
      lastmod: '2026-07-20',
      family: 'dashboard',
      owner: 'root',
    };

    assert.throws(
      () => validateSitemapEntries([valid, { ...valid }], { today: '2026-07-27' }),
      /duplicate/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, loc: 'http://www.worldmonitor.app/dashboard' }], { today: '2026-07-27' }),
      /https/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, loc: `${SITE_ORIGIN}/dashboard?lang=fr` }], { today: '2026-07-27' }),
      /query|canonical/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, loc: `${SITE_ORIGIN}/dashboard/` }], { today: '2026-07-27' }),
      /trailing slash|canonical/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, lastmod: null }], { today: '2026-07-27' }),
      /lastmod/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, lastmod: '27-07-2026' }], { today: '2026-07-27' }),
      /lastmod/i,
    );
    assert.throws(
      () => validateSitemapEntries([{ ...valid, lastmod: '2026-07-28' }], { today: '2026-07-27' }),
      /future/i,
    );
  });

  it('preserves committed freshness when Git history is shallow', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-sitemap-shallow-'));
    const sourceRoot = join(tempRoot, 'source');
    const shallowRoot = join(tempRoot, 'shallow');
    try {
      mkdirSync(sourceRoot);
      const gitEnv = isolatedGitEnv();
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['config', 'user.email', 'sitemap-test@worldmonitor.app'], {
        cwd: sourceRoot,
        env: gitEnv,
      });
      execFileSync('git', ['config', 'user.name', 'Sitemap Test'], {
        cwd: sourceRoot,
        env: gitEnv,
      });

      writeFileSync(join(sourceRoot, 'material.txt'), 'material version one\n');
      execFileSync('git', ['add', 'material.txt'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'add material'], {
        cwd: sourceRoot,
        env: isolatedGitEnv({
          GIT_AUTHOR_DATE: '2026-06-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-06-01T00:00:00Z',
        }),
      });

      writeFileSync(join(sourceRoot, 'unrelated.txt'), 'release-only change\n');
      execFileSync('git', ['add', 'unrelated.txt'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'release change'], {
        cwd: sourceRoot,
        env: isolatedGitEnv({
          GIT_AUTHOR_DATE: '2026-07-27T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-07-27T00:00:00Z',
        }),
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

      const loc = `${SITE_ORIGIN}/pro`;
      const resolveMaterialLastmod = createMaterialLastmodResolver({
        repoRoot: shallowRoot,
        existingSitemapSource: `<?xml version="1.0"?><urlset><url><loc>${loc}</loc>`
          + '<lastmod>2026-06-01</lastmod></url></urlset>',
      });

      assert.equal(
        resolveMaterialLastmod({ loc, materialSources: ['material.txt'] }),
        '2026-06-01',
      );
      assert.equal(
        gitFileLastmod(shallowRoot, 'material.txt'),
        null,
        'corpus source dates must not trust the shallow root commit',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // Regression (Vercel deploy failure, 2026-07-27): a commit recorded at
  // 01:21+04:00 has a %cs short date of "tomorrow" relative to a UTC build
  // clock, so the future-lastmod guard rejected a commit that is in the past.
  // Lastmod dates must be rendered in UTC regardless of the commit's own
  // recorded timezone. (Shallow-clone attribution is covered separately by
  // tests/crawlable-corpus.test.mjs.)
  it('renders git lastmod in UTC regardless of the commit timezone', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-sitemap-tz-'));
    const sourceRoot = join(tempRoot, 'source');
    try {
      const gitEnv = isolatedGitEnv();
      mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['config', 'user.email', 'sitemap-test@worldmonitor.app'], {
        cwd: sourceRoot,
        env: gitEnv,
      });
      execFileSync('git', ['config', 'user.name', 'Sitemap Test'], {
        cwd: sourceRoot,
        env: gitEnv,
      });

      // 2026-07-28T01:21:52+04:00 is 2026-07-27T21:21:52Z — the UTC date is
      // the truthful lastmod; the recorded-timezone date is in the future.
      writeFileSync(join(sourceRoot, 'material.txt'), 'evening merge\n');
      execFileSync('git', ['add', 'material.txt'], { cwd: sourceRoot, env: gitEnv });
      execFileSync('git', ['commit', '-m', 'evening merge'], {
        cwd: sourceRoot,
        env: isolatedGitEnv({
          GIT_AUTHOR_DATE: '2026-07-28T01:21:52+04:00',
          GIT_COMMITTER_DATE: '2026-07-28T01:21:52+04:00',
        }),
      });

      const resolveMaterialLastmod = createMaterialLastmodResolver({
        repoRoot: sourceRoot,
        existingSitemapSource: '',
      });
      assert.equal(
        resolveMaterialLastmod({ loc: `${SITE_ORIGIN}/pro`, materialSources: ['material.txt'] }),
        '2026-07-27',
        'material lastmod must be the UTC date, not the recorded-timezone date',
      );
      assert.equal(
        gitFileLastmod(sourceRoot, 'material.txt'),
        '2026-07-27',
        'corpus lastmod must be the UTC date, not the recorded-timezone date',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the committed artifact generated and robots ownership exact', () => {
    const sitemap = readFileSync(join(repoRoot, 'public/sitemap.xml'), 'utf8');
    const robots = readFileSync(join(repoRoot, 'public/robots.www.txt'), 'utf8');

    assert.match(sitemap, /Generated by npm run build:sitemap\. Do not edit by hand\./);
    assert.doesNotMatch(sitemap, /<changefreq>|<priority>/);
    assert.doesNotMatch(sitemap, /worldmonitor\.app\/blog/);
    assert.match(sitemap, /<loc>https:\/\/worldmonitor\.app\/mcp<\/loc>/);

    for (const url of [
      `${SITE_ORIGIN}/sitemap.xml`,
      `${SITE_ORIGIN}/blog/sitemap-index.xml`,
      `${SITE_ORIGIN}/docs/sitemap.xml`,
    ]) {
      const occurrences = robots.split(`Sitemap: ${url}`).length - 1;
      assert.equal(occurrences, 1, `${url} must be advertised exactly once`);
    }
  });
});
