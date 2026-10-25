import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';
import { describe, it } from 'node:test';
import { VARIANT_META } from '../src/config/variant-meta.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function assertDescription(label, description) {
  assert.equal(typeof description, 'string', `${label} must have a description`);
  assert.ok(
    description.length >= 150 && description.length <= 160,
    `${label} description must be 150-160 characters, got ${description.length}`,
  );
}

function assertTitle(label, title) {
  assert.equal(typeof title, 'string', `${label} must have a title`);
  assert.ok(title.length <= 60, `${label} title must be at most 60 characters, got ${title.length}`);
}

describe('reported landing-page SEO metadata', () => {
  guardProBuiltOutput();
  it('keeps blog landing metadata within search-friendly bounds', () => {
    const blogIndex = source('blog-site/src/pages/index.astro');
    const authorPage = source('blog-site/src/pages/authors/elie-habib.astro');
    const glossaryIndex = source('blog-site/src/pages/glossary/index.astro');
    const glossaryTerm = source('blog-site/src/pages/glossary/[slug].astro');

    const blogTitle = blogIndex.match(/metaTitle="([^"]+)"/)?.[1];
    const blogDescription = blogIndex.match(/<Base\s+[\s\S]*?description="([^"]+)"/)?.[1];
    const authorDescription = authorPage.match(/const description = '([^']+)'/)?.[1];
    const glossaryDescription = glossaryIndex.match(/<Base\s+[\s\S]*?description="([^"]+)"/)?.[1];

    assertTitle('blog index', blogTitle);
    assertDescription('blog index', blogDescription);
    assertDescription('Elie Habib author archive', authorDescription);
    assertDescription('glossary index', glossaryDescription);
    assert.match(
      glossaryTerm,
      /const metaTitle = term\.abbr[\s\S]*?\$\{term\.abbr\} Definition \| World Monitor/,
      'abbreviated glossary terms must use compact definition titles',
    );
  });

  // Reads the BUILT public/pro/index.html, produced by `npm run build:pro`
  // rather than committed (#6898); the rest of this suite reads committed
  // sources and stays unconditional.
  it('keeps the Pro shell and documentation sandbox descriptions bounded', { skip: shouldSkipProBuiltOutput() }, () => {
    const proHtml = source('pro-test/index.html');
    const builtProHtml = source('public/pro/index.html');
    const proLocale = JSON.parse(source('pro-test/src/locales/en.json'));
    const englishSandbox = source('docs/sandbox.mdx');
    const sandbox = source('docs/zh/sandbox.mdx');

    const proTitle = proHtml.match(/<title>([^<]+)<\/title>/)?.[1]?.replace('&amp;', '&');
    const proDescription = proHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    const builtProTitle = builtProHtml.match(/<title>([^<]+)<\/title>/)?.[1]?.replace('&amp;', '&');
    const builtProDescription = builtProHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    const englishSandboxDescription = englishSandbox.match(/^description:\s*"([^"]+)"$/m)?.[1];
    const sandboxDescription = sandbox.match(/^description:\s*"([^"]+)"$/m)?.[1];

    assertTitle('Pro', proTitle);
    assertDescription('Pro', proDescription);
    assertTitle('built Pro', builtProTitle);
    assertDescription('built Pro', builtProDescription);
    assert.equal(proLocale.meta.title, 'World Monitor Pro | AI Intelligence & MCP');
    assertDescription('Pro locale', proLocale.meta.description);
    assertDescription('English sandbox', englishSandboxDescription);
    assertDescription('Chinese sandbox', sandboxDescription);
  });

  it('keeps the homepage description product-led, canonical, and bounded', () => {
    const welcomeHtml = source('pro-test/welcome.html');
    const welcomeLocale = JSON.parse(source('pro-test/src/locales/en.json')).welcome.meta;
    const expectedDescription = 'World Monitor: real-time geopolitical intelligence dashboard. A free live map of conflicts, shipping, flights, markets and cyber, with an API and MCP server.';
    const expectedTitle = 'World Monitor: Free Geopolitical Intelligence Dashboard';

    assertTitle('homepage locale', welcomeLocale.title);
    assertDescription('homepage locale', welcomeLocale.description);
    assert.equal(welcomeLocale.title, expectedTitle);
    assert.equal(welcomeLocale.ogTitle, expectedTitle);
    assert.equal(welcomeLocale.description, expectedDescription);
    assert.equal(welcomeLocale.ogDescription, expectedDescription);

    const htmlTitle = welcomeHtml.match(/<title>([^<]+)<\/title>/)?.[1];
    const htmlDescription = welcomeHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    const ogDescription = welcomeHtml.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
    const twitterDescription = welcomeHtml.match(/<meta name="twitter:description" content="([^"]+)"/)?.[1];
    assert.equal(htmlTitle, expectedTitle);
    assert.equal(htmlDescription, expectedDescription);
    assert.equal(ogDescription, expectedDescription);
    assert.equal(twitterDescription, expectedDescription);

    // The paragraph after the H1 is the slogan, so speakable must name the
    // definition paragraph by class rather than by position.
    assert.match(welcomeHtml, /"cssSelector": \["h1", "\.welcome-seo-summary"\]/);
    assert.match(
      source('pro-test/src/welcome/Hero.tsx'),
      /<p className="welcome-seo-summary[^"]*">\{t\('welcome\.hero\.whatIsBody'/,
    );
  });

  // Every locale serves its own welcome title and description, so the search
  // snippet limits apply to each one, and a key left in English is a missed
  // translation the EN baseline would otherwise mark as current.
  it('keeps every localized homepage title and description translated and bounded', () => {
    const dir = resolve(root, 'pro-test/src/locales');
    const welcome = (file) => JSON.parse(readFileSync(resolve(dir, file), 'utf8')).welcome;
    const en = welcome('en.json');
    const translatedKeys = [
      ['meta', 'title'],
      ['meta', 'description'],
      ['hero', 'headline1'],
      ['hero', 'headline2'],
      ['hero', 'sub'],
      ['hero', 'whatIsBestFor'],
    ];
    const locales = readdirSync(dir).filter((file) => file.endsWith('.json') && file !== 'en.json');
    assert.ok(locales.length >= 20, 'expected the welcome locales');
    for (const file of locales) {
      const { meta, hero } = welcome(file);
      assertTitle(`${file} homepage`, meta.title);
      assert.ok(meta.description.length <= 160, `${file} description must be at most 160 characters, got ${meta.description.length}`);
      assert.equal(meta.ogTitle, meta.title, `${file} og:title must match the title`);
      assert.equal(meta.ogDescription, meta.description, `${file} og:description must match the description`);
      for (const [group, key] of translatedKeys) {
        const value = welcome(file)[group][key];
        assert.notEqual(value, en[group][key], `${file} welcome.${group}.${key} is still English`);
      }
      for (const value of [meta.title, meta.description, hero.headline1, hero.headline2, hero.sub]) {
        assert.doesNotMatch(value, /[，。、：；！？]\s/, `${file} has a space after full-width punctuation: ${value}`);
      }
    }
  });

  it('keeps full and variant dashboard descriptions bounded and synchronized', () => {
    const indexHtml = source('index.html');
    const variants = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'];

    for (const variant of variants) {
      assertDescription(`${variant} variant`, VARIANT_META[variant].description);
    }

    const fullDescription = indexHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert.equal(fullDescription, VARIANT_META.full.description, 'index.html must use the full variant description');
  });
});
