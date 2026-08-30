/**
 * #7377 — GEO credibility leaks: blog audience persona in body copy,
 * contradictory reach figures, buried press cites, and an unlinked studio lockup.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  ABOUT_DOCS_PATH,
  COUNTRY_REACH_CLAIM,
  GITHUB_STARS_BADGE_URL,
  PRESS_LINKS,
  SILICON_CANALS_2M_URL,
  SOMEONE_CEO_URL,
  WIRED_FEATURE_URL,
} from '../shared/press.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`));
  assert.ok(match && match.index !== undefined, `missing ${selector} rule`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector} block`);
}

describe('issue #7377 GEO content credibility', () => {
  it('(a) keeps audience in frontmatter/JSON-LD but not visible body chrome', () => {
    const post = read('blog-site/src/layouts/BlogPost.astro');
    const index = read('blog-site/src/pages/index.astro');

    assert.match(post, /"@type": "Audience"/, 'audience stays in BlogPosting JSON-LD');
    assert.doesNotMatch(
      post,
      /\{audience && <span> &middot; \{audience\}<\/span>\}/,
      'audience must not render in the visible article meta line',
    );
    assert.match(
      post,
      /class="author-bio/,
      'byline must still render',
    );
    // Byline must appear before the layout-owned H1, not after the article body.
    const bylineIdx = post.indexOf('class="author-bio');
    const h1Idx = post.indexOf('<h1>{title}</h1>');
    assert.ok(bylineIdx !== -1 && h1Idx !== -1, 'byline and H1 must both exist');
    assert.ok(bylineIdx < h1Idx, 'byline must sit above the H1 (slot vacated by persona)');

    assert.doesNotMatch(
      index,
      /\{post\.data\.audience\}/,
      'blog index cards must not render the audience persona string',
    );
  });

  it('scopes the card-title top spacer to non-pinned cards so pinned tags do not double-pad', () => {
    const css = read('blog-site/src/styles/global.css');
    const index = read('blog-site/src/pages/index.astro');

    assert.match(
      index,
      /\{post\.data\.pinned && \([\s\S]*?class="tag"/,
      'pinned cards still render the .tag block that owns the top spacer',
    );

    const tagPad = cssRule(css, '.post-card .tag');
    assert.match(tagPad, /padding-top:\s*1\.25rem/, 'pinned .tag keeps the original 1.25rem top spacer');

    const allTitles = cssRule(css, '.post-card h2');
    assert.doesNotMatch(
      allTitles,
      /padding-top:\s*1\.25rem/,
      'unqualified .post-card h2 must not add a second top spacer on pinned cards',
    );

    const ordinaryTitles = cssRule(css, '.post-card:not(.pinned) h2');
    assert.match(
      ordinaryTitles,
      /padding-top:\s*1\.25rem/,
      'ordinary cards keep the former .tag top spacer on the title',
    );
  });

  it('(b) unifies country reach and renders GitHub stars from the API badge', () => {
    const about = read('docs/about.mdx');
    const aboutZh = read('docs/zh/about.mdx');
    const llms = read('public/llms.txt');

    assert.doesNotMatch(about, /81,?508/);
    assert.doesNotMatch(aboutZh, /81,?508/);
    assert.doesNotMatch(about, /more than 170 countries/);
    assert.doesNotMatch(aboutZh, /170 多个国家/);
    assert.match(about, new RegExp(COUNTRY_REACH_CLAIM.replace('+', '\\+')));
    assert.match(about, new RegExp(GITHUB_STARS_BADGE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(llms, /2M\+ people/);
    assert.match(llms, /190\+ countries/);
    assert.match(llms, new RegExp(SILICON_CANALS_2M_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('(c) surfaces press URLs, About, and the Silicon Canals 2M citation', () => {
    const llms = read('public/llms.txt');
    const hero = read('pro-test/src/welcome/Hero.tsx');
    const footer = read('pro-test/src/components/Footer.tsx');
    const pressNav = read('pro-test/src/components/PressFooterNav.tsx');
    const pressModule = read('shared/press.ts');

    assert.match(llms, new RegExp(WIRED_FEATURE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(llms, new RegExp(SILICON_CANALS_2M_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const link of PRESS_LINKS) {
      assert.ok(
        llms.includes(`](${link.url})`) || llms.includes(link.url),
        `llms.txt must include exact ${link.label} URL`,
      );
      assert.ok(pressModule.includes(link.url), `shared/press.ts must include ${link.label}`);
    }
    assert.equal(
      PRESS_LINKS.find((l) => l.label === "L'Orient Today")?.url,
      'https://today.lorientlejour.com/article/1496089/world-monitor-how-anghami-ceos-side-project-became-a-go-to-for-geopolitics-research.html',
    );

    assert.match(hero, /SILICON_CANALS_2M_URL|siliconcanals\.com/);
    assert.ok(
      footer.includes('ABOUT_DOCS_PATH') || footer.includes(ABOUT_DOCS_PATH),
      'welcome footer must link /docs/about',
    );
    assert.match(footer, /<PressFooterNav\s*\/>/);
    assert.match(pressNav, /PRESS_LINKS/);
    assert.match(pressNav, /In the press/);
  });

  it('(d) links the Someone.ceo studio lockup to a resolvable URL', () => {
    for (const path of [
      'pro-test/src/components/Logo.tsx',
      'pro-test/src/components/Footer.tsx',
      'blog-site/src/layouts/Base.astro',
    ]) {
      const source = read(path);
      assert.ok(
        source.includes('SOMEONE_CEO_URL') || source.includes(SOMEONE_CEO_URL),
        `${path} must link Someone.ceo via SOMEONE_CEO_URL`,
      );
      assert.match(source, /by Someone\.ceo/);
    }
  });
});
