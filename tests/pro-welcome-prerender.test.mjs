import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const welcomeHtml = () => readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
const prerenderSrc = () => readFileSync(new URL('../pro-test/prerender.mjs', import.meta.url), 'utf8');
const enLocale = () =>
  JSON.parse(readFileSync(new URL('../pro-test/src/locales/en.json', import.meta.url), 'utf8'));

// Pull the body of `const <name> = ` ... `` out of prerender.mjs source text.
// The SEO templates are plain HTML with no nested backticks, so the first
// backtick after the declaration opens and the next one closes the literal.
function extractTemplate(src, name) {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name} template literal not found in prerender.mjs`);
  const bodyStart = start + marker.length;
  const bodyEnd = src.indexOf('`', bodyStart);
  assert.ok(bodyEnd !== -1, `${name} template literal is unterminated`);
  return src.slice(bodyStart, bodyEnd);
}

// Isolate the crawler-visible <div id="seo-prerender">…</div> (no nested <div>s).
function seoBlock(html) {
  const start = html.indexOf('<div id="seo-prerender"');
  assert.ok(start !== -1, 'welcome.html should contain the #seo-prerender block');
  const end = html.indexOf('</div>', start);
  assert.ok(end !== -1, '#seo-prerender block should be closed');
  return html.slice(start, end + '</div>'.length);
}

// Drift guard: public/pro/welcome.html is a generated artifact injected verbatim
// from prerender.mjs (`html.replace('<div id="root"></div>', beforeRoot + …)`),
// but nothing re-runs the build in CI. Without this, editing the SEO copy in
// prerender.mjs and forgetting `npm run build:pro` silently ships stale HTML to
// crawlers. Assert every substantial static line of the source template — and
// every locale string it interpolates — is present in the committed output.
test('welcome.html #seo-prerender stays in sync with prerender.mjs (run npm run build:pro after edits)', () => {
  const html = welcomeHtml();
  const template = extractTemplate(prerenderSrc(), 'welcomeSeoPrerender');

  // Static chunks: drop ${…} interpolations, keep meaningful literal fragments.
  const staticChunks = template
    .replace(/\$\{[^}]*\}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 24);
  assert.ok(staticChunks.length > 40, 'expected the SEO template to yield many static chunks');
  const missing = staticChunks.filter((chunk) => !html.includes(chunk));
  assert.deepEqual(
    missing,
    [],
    `welcome.html is stale — rebuild with \`npm run build:pro\`. Missing source chunks: ${JSON.stringify(missing.slice(0, 3))}`,
  );

  // Interpolated prose + FAQ come from en.json and are injected raw (unescaped).
  const en = enLocale();
  for (const value of [en.welcome.hero.sub, en.welcome.moments.sub]) {
    assert.ok(html.includes(value), `welcome.html missing interpolated locale prose — rebuild: ${JSON.stringify(value.slice(0, 48))}`);
  }
  for (let n = 1; n <= 9; n += 1) {
    for (const key of [`q${n}`, `a${n}`]) {
      assert.ok(html.includes(en.welcome.faq[key]), `welcome.html missing FAQ ${key} — rebuild via npm run build:pro`);
    }
  }
});

// Guardrail for the residual SEO risk: the block is crawler-visible but hidden
// for JS users (off-screen + aria-hidden + inert). That hidden-text pattern is a
// deliberate AEO decision, but its cloaking-penalty risk scales with size, so
// cap it. Bump this budget only when a rescan confirms density still helps —
// don't let the block grow unbounded by accident.
test('welcome.html #seo-prerender stays within its size budget', () => {
  const MAX_BYTES = 32 * 1024;
  const bytes = Buffer.byteLength(seoBlock(welcomeHtml()), 'utf8');
  assert.ok(
    bytes <= MAX_BYTES,
    `#seo-prerender is ${bytes} bytes (budget ${MAX_BYTES}). Large hidden text blocks risk cloaking penalties — trim or deliberately raise MAX_BYTES.`,
  );
});

test('built welcome page ships the real hero in #root before JavaScript', () => {
  const html = readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8');
  const rootMatch = html.match(/<div id="root"(?<attrs>[^>]*)>(?<content>[\s\S]*?)<\/body>/);
  assert.ok(rootMatch?.groups, 'welcome page should contain #root before body close');

  const { attrs, content } = rootMatch.groups;
  const rootContent = content.split('<noscript>')[0];
  assert.match(attrs, /data-wm-prerendered="welcome"/);
  assert.match(attrs, /data-wm-prerender-lang="en"/);
  assert.doesNotMatch(rootContent, /id="seo-prerender"/);
  assert.match(rootContent, /<nav[\s>]/);
  assert.match(rootContent, /By the time it&#x27;s news,[\s\S]*you already knew\./);
  assert.match(rootContent, /Launch the dashboard/);
  assert.match(rootContent, /Open source · AGPL-3\.0/);
  assert.match(rootContent, /href="\/blog\/posts\/worldmonitor-is-not-palantir\/"/);
  assert.match(rootContent, /WorldMonitor is not an open-source Palantir/);
  assert.match(rootContent, /Map layers/);
  const headlineIndex = rootContent.indexOf('By the time it&#x27;s news,');
  assert.ok(headlineIndex > 0, 'welcome headline should be in the prerendered root');
  const heroSection = rootContent.slice(0, rootContent.indexOf('<section class="py-16'));
  assert.doesNotMatch(heroSection, /opacity:0/);
  assert.match(rootContent, /<img[^>]+src="\/pro\/assets\/worldmonitor-7-mar-2026-[^"]+\.jpg"[^>]+fetchPriority="high"/);
});
