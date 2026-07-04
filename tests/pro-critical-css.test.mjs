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
      assert.match(html, /\.rel='stylesheet'/);
      // The activation must recover the full sheet when the preload fails or is
      // ignored -- not only on `load` -- else JS users can be stranded on
      // critical CSS only. Require the error + timeout fallback arms.
      assert.match(html, /addEventListener\('load'/);
      assert.match(html, /addEventListener\('error'/);
      assert.match(html, /setTimeout\(/);
    });

    it(`${label} re-shows responsive nav/hero reveals so unlayered .hidden can't hide them at all widths`, () => {
      // Regression guard for #4603: the inline critical CSS is UNLAYERED and beats
      // the @layer-wrapped Tailwind sheet, so `nav .hidden{display:none}` /
      // `main .hidden{display:none}` permanently hide `hidden md:flex` desktop nav
      // rows and `hidden sm:block` unless the breakpoint reveal is ALSO inlined here.
      const html = builtSrc(relPath);
      const criticalCss = inlineStyleTags(html)
        .filter((tag) => html.indexOf(tag) < html.indexOf(deferredStylePreloadTags(html)[0]))
        .join('\n');

      const navHideIdx = criticalCss.indexOf('nav .hidden{display:none}');
      const mainHideIdx = criticalCss.indexOf('main .hidden{display:none}');
      const sm640Idx = criticalCss.indexOf('@media (min-width:640px){');
      const md768Idx = criticalCss.indexOf('@media (min-width:768px){');
      const navRevealIdx = criticalCss.indexOf('nav [class~="md:flex"]{display:flex}');
      const smBlockRevealIdx = criticalCss.indexOf('main [class~="sm:block"]{display:block}');

      assert.notEqual(navHideIdx, -1, `${relPath} critical CSS should hide plain .hidden nav elements`);
      assert.notEqual(mainHideIdx, -1, `${relPath} critical CSS should hide plain .hidden main elements`);
      assert.notEqual(navRevealIdx, -1, `${relPath} critical CSS must re-show hidden md:flex nav rows at >=768px`);
      assert.notEqual(smBlockRevealIdx, -1, `${relPath} critical CSS must re-show hidden sm:block at >=640px`);
      // Equal-specificity rules: each reveal must come AFTER its unlayered hide to win the cascade.
      assert.ok(navRevealIdx > navHideIdx, `${relPath} nav md:flex reveal must follow nav .hidden to win the cascade`);
      assert.ok(smBlockRevealIdx > mainHideIdx, `${relPath} main sm:block reveal must follow main .hidden to win the cascade`);
      // The nav reveal must sit inside the >=768px block (gated to desktop, not applied at all widths).
      assert.ok(md768Idx !== -1 && navRevealIdx > md768Idx, `${relPath} nav md:flex reveal must be inside the min-width:768px media block`);
      // The sm:block reveal must sit inside the >=640px block (between the 640 and 768 media opens).
      assert.ok(sm640Idx !== -1 && smBlockRevealIdx > sm640Idx && smBlockRevealIdx < md768Idx, `${relPath} sm:block reveal must be inside the min-width:640px media block`);
    });
  }

  it('/pro preserves crawler-visible prerendered content while JS browsers can hide it', () => {
    const html = builtSrc('public/pro/index.html');
    assert.match(html, /id="seo-prerender"/);
    assert.match(html, /World Monitor Pro/);
    assert.match(html, /document\.documentElement\.classList\.add\('js'\)/);
    assert.match(html, /html\.js #seo-prerender/);
  });

  it('/ welcome ships a crawler-visible SEO block kept OUT of the hydrated #root', () => {
    const html = builtSrc('public/pro/welcome.html');
    assert.match(html, /data-wm-prerendered="welcome"/);
    // welcome.html now ships a prose-dense #seo-prerender block for AEO/RAG
    // indexers (lifts the apex page's text-to-markup ratio), injected as a
    // SIBLING BEFORE #root so React hydration of the SSR'd shell is untouched.
    // Hidden for JS users via the .js class + html.js #seo-prerender rule,
    // mirroring /pro (above). pro-welcome-prerender.test.mjs enforces that the
    // hydrated #root CONTENT stays free of the block; here we guard placement
    // (block must PRECEDE #root) and the JS-hide mechanism.
    assert.match(html, /id="seo-prerender"/);
    assert.match(html, /document\.documentElement\.classList\.add\('js'\)/);
    assert.match(html, /html\.js #seo-prerender/);
    assert.ok(
      html.indexOf('id="seo-prerender"') < html.indexOf('<div id="root"'),
      'the #seo-prerender block must precede #root (sibling, not nested — nesting it inside the hydrated root breaks hydration)',
    );
    assert.match(html, /fetchPriority="high"/);
  });
});
