import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const PRO_PAGES = [
  { relPath: 'public/pro/index.html', label: '/pro' },
  { relPath: 'public/pro/welcome.html', label: '/' },
];

function src(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

function builtSrc(relPath) {
  const absPath = resolve(repoRoot, relPath);
  assert.ok(
    existsSync(absPath),
    `${relPath} must exist before running built-output CSS assertions. Run npm run build:pro first.`,
  );
  return readFileSync(absPath, 'utf8');
}

function tagAttributes(tag) {
  const attrs = new Map();
  for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function stripNoscript(html) {
  return html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function linkTags(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
}

function stylesheetLinkTags(html) {
  return linkTags(html).filter((tag) => {
    const attrs = tagAttributes(tag);
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    return attrs.get('href')?.endsWith('.css') && rels.includes('stylesheet');
  });
}

function renderBlockingStylesheetHrefs(html) {
  const hrefs = [];
  for (const tag of stylesheetLinkTags(stripNoscript(html))) {
    const attrs = tagAttributes(tag);
    const rawMedia = attrs.get('media');
    const media = rawMedia === undefined ? 'all' : rawMedia.trim().toLowerCase();
    if (media === 'all' || media === 'screen') hrefs.push(attrs.get('href'));
  }
  return hrefs;
}

function deferredStylePreloadTags(html) {
  return linkTags(stripNoscript(html)).filter((tag) => {
    const attrs = tagAttributes(tag);
    return attrs.get('rel') === 'preload' &&
      attrs.get('as') === 'style' &&
      attrs.has('data-wm-deferred-style') &&
      attrs.get('href')?.endsWith('.css');
  });
}

function noscriptStylesheetTags(html) {
  const tags = [];
  for (const block of html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)) {
    tags.push(...stylesheetLinkTags(block[1]));
  }
  return tags;
}

function inlineStyleTags(html) {
  return [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((match) => match[0]);
}

describe('pro critical CSS parser', () => {
  it('detects stylesheet links regardless of attribute order', () => {
    assert.deepEqual(
      stylesheetLinkTags(`
        <link rel="stylesheet" href="/assets/main.css">
        <link href="/assets/settings.css" rel="preload stylesheet">
        <link href="/assets/ignored.css" rel="preload">
      `).map((tag) => tagAttributes(tag).get('href')),
      ['/assets/main.css', '/assets/settings.css'],
    );
  });

  it('ignores noscript fallbacks when classifying render-blocking styles', () => {
    assert.deepEqual(
      renderBlockingStylesheetHrefs(`
        <link rel="stylesheet" href="/assets/main.css">
        <link rel="stylesheet" media="screen" href="/assets/screen.css">
        <link rel="preload" as="style" href="/assets/deferred.css" data-wm-deferred-style>
        <noscript><link rel="stylesheet" href="/assets/nojs.css"></noscript>
      `),
      ['/assets/main.css', '/assets/screen.css'],
    );
  });
});

describe('pro critical CSS source contract', () => {
  it('applies the shared critical CSS transform to every pro-test page', () => {
    const prerender = src('pro-test/prerender.mjs');
    assert.match(prerender, /html\.js #seo-prerender/);
    assert.match(prerender, /const PAGES = \[/);
    assert.match(prerender, /html = inlineCriticalCss\(html, file\);/);
    assert.doesNotMatch(prerender, /file === 'welcome\.html'/);
  });
});

describe('pro built HTML critical CSS contract', () => {
  for (const { relPath, label } of PRO_PAGES) {
    it(`${label} inlines critical CSS before the deferred stylesheet preload`, () => {
      const html = builtSrc(relPath);
      const preloads = deferredStylePreloadTags(html);
      assert.equal(preloads.length, 1, `${relPath} should include exactly one deferred stylesheet preload`);
      assert.equal(tagAttributes(preloads[0]).get('nonce'), 'wm-static-bootstrap');

      const firstPreloadIndex = html.indexOf(preloads[0]);
      const previousStyles = inlineStyleTags(html).filter((tag) => html.indexOf(tag) < firstPreloadIndex);
      assert.ok(previousStyles.length > 0, `${relPath} should inline critical CSS before the deferred preload`);
      const criticalCss = previousStyles.join('\n');
      assert.match(criticalCss, /#root,#root>div/);
      assert.match(criticalCss, /html\.js #seo-prerender/);
    });

    it(`${label} has no render-blocking stylesheet outside noscript`, () => {
      const html = builtSrc(relPath);
      assert.deepEqual(renderBlockingStylesheetHrefs(html), []);
    });

    it(`${label} keeps the full stylesheet reachable for JS and no-JS clients`, () => {
      const html = builtSrc(relPath);
      const [preload] = deferredStylePreloadTags(html);
      const href = tagAttributes(preload).get('href');
      const fallbackTags = noscriptStylesheetTags(html).filter((tag) => tagAttributes(tag).get('href') === href);

      assert.equal(fallbackTags.length, 1, `${href} should have exactly one noscript stylesheet fallback`);
      assert.match(html, /querySelectorAll\('link\[data-wm-deferred-style\]'\)/);
      assert.match(html, /this\.rel='stylesheet'/);
    });
  }

  it('/pro preserves crawler-visible prerendered content while JS browsers can hide it', () => {
    const html = builtSrc('public/pro/index.html');
    assert.match(html, /id="seo-prerender"/);
    assert.match(html, /World Monitor Pro/);
    assert.match(html, /document\.documentElement\.classList\.add\('js'\)/);
    assert.match(html, /html\.js #seo-prerender/);
  });

  it('/ welcome preserves the prerendered shell and stays separate from the SEO block', () => {
    const html = builtSrc('public/pro/welcome.html');
    assert.match(html, /data-wm-prerendered="welcome"/);
    assert.doesNotMatch(html, /id="seo-prerender"/);
    assert.match(html, /fetchPriority="high"/);
  });
});
