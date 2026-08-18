import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { guardProBuiltOutput, shouldSkipProBuiltOutput, withoutUnbuiltProPaths } from './_lib/pro-built-output.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// public/pro/ is built by `npm run build:pro`, not committed (#6898). Only the
// apex-HTML case reads a /pro page exclusively, so only it skips when unbuilt.
// The production-HTML sweep also covers three COMMITTED files, so it drops just
// the built paths from its population instead of skipping wholesale -- gating
// the whole case would have taken index.html and both pro-test sources with it.
// guardProBuiltOutput() still fails outright when WM_EXPECT_BUILT_OUTPUT=1.
const skip = shouldSkipProBuiltOutput();
guardProBuiltOutput();

const PRODUCTION_HTML = [
  'index.html',
  'pro-test/index.html',
  'pro-test/welcome.html',
  'public/pro/index.html',
  'public/pro/welcome.html',
];

function visibleWelcomeRoot(html) {
  const rootStart = html.indexOf('<div id="root"');
  const noScriptStart = html.lastIndexOf('<noscript>');
  assert.ok(rootStart >= 0, 'built welcome page should contain #root');
  assert.ok(noScriptStart > rootStart, 'built welcome page should retain its no-JavaScript fallback');
  return html.slice(rootStart, noScriptStart);
}

test('production HTML contains no crawler-only prerender block or off-screen hide contract', () => {
  const scanned = withoutUnbuiltProPaths(PRODUCTION_HTML);
  assert.ok(scanned.length > 0, 'production-HTML population is empty — this guard would pass vacuously');
  for (const path of scanned) {
    const html = read(path);
    assert.doesNotMatch(html, /id=["']seo-prerender["']/i, `${path} must not ship #seo-prerender`);
    assert.doesNotMatch(html, /html\.js\s+#seo-prerender/i, `${path} must not CSS-hide crawler copy`);
    assert.doesNotMatch(
      html,
      /getElementById\(["']seo-prerender["']\)[\s\S]{0,240}(?:aria-hidden|inert)/i,
      `${path} must not remove crawler copy from the accessibility tree for JavaScript users`,
    );
  }
});

test('apex HTML exposes one visible SSR content hierarchy and all primary reference links', { skip }, () => {
  const root = visibleWelcomeRoot(read('public/pro/welcome.html'));
  assert.equal([...root.matchAll(/<h1\b/gi)].length, 1, 'the visible welcome root should contain one H1');
  const hiddenContentNodes = [...root.matchAll(/<[a-z][a-z0-9:-]*\b[^>]*\bstyle="([^"]*)"[^>]*>/gi)]
    .filter(([tag, style]) =>
      !/\baria-hidden="true"/i.test(tag)
      && /(?:opacity:\s*0(?![\d.])|transform:\s*translate(?:3d|[xyz])?\()/i.test(style),
    )
    .map(([tag]) => tag);
  assert.deepEqual(
    hiddenContentNodes,
    [],
    'the visible welcome root must not hide or translate substantive SSR content before hydration',
  );
  assert.match(root, /By the time it&#x27;s news,[\s\S]*you already knew\./);
  assert.match(root, /ACLED/);
  assert.match(root, /NASA FIRMS/);
  assert.match(root, /Launch the dashboard/);

  for (const href of [
    '/countries/',
    '/chokepoints/',
    '/crises/',
    '/tools/',
    '/blog/',
    '/docs',
    '/pro#pricing',
    'https://github.com/koala73/worldmonitor',
  ]) {
    assert.ok(root.includes(href), `visible welcome content should link to ${href}`);
  }
});

test('dashboard retains a legitimate no-JavaScript fallback and visible reference navigation', () => {
  const dashboard = read('index.html');
  const noScriptBlocks = [...dashboard.matchAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi)]
    .map(([block]) => block);
  assert.equal(noScriptBlocks.length, 1, 'dashboard should contain exactly one no-JavaScript content surface');
  const [noScript] = noScriptBlocks;
  assert.match(
    noScript,
    /<noscript>\s*<main id="dashboard-noscript"[\s\S]*?<\/main>\s*<\/noscript>/i,
    'dashboard should contain a semantic #dashboard-noscript fallback',
  );
  assert.equal(
    [...dashboard.matchAll(/\bid=["']dashboard-noscript["']/gi)].length,
    1,
    'dashboard should identify exactly one semantic no-JavaScript fallback',
  );
  assert.match(noScript, /requires JavaScript/i);
  assert.doesNotMatch(noScript, /aria-hidden|inert|left:\s*-|clip(?:-path)?:/i);

  for (const href of [
    '/countries/',
    '/chokepoints/',
    '/crises/',
    '/tools/',
    '/blog/',
    '/docs',
    '/pro#pricing',
    'https://github.com/koala73/worldmonitor',
  ]) {
    assert.ok(noScript.includes(`href="${href}`), `no-JavaScript fallback should link to ${href}`);
  }
});
