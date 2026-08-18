import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardProBuiltOutput, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';
import { describe, it } from 'node:test';

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

  it('keeps full and variant dashboard descriptions bounded and synchronized', () => {
    const variantMetaSource = source('src/config/variant-meta.ts');
    const middlewareSource = source('middleware.ts');
    const indexHtml = source('index.html');
    const variants = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'];

    for (const variant of variants) {
      const block = variantMetaSource.match(
        new RegExp(`${variant}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1];
      const description = block?.match(/^\s+description: '([^']+)'/m)?.[1];
      assertDescription(`${variant} variant`, description);

      if (variant === 'full') continue;
      const middlewareBlock = middlewareSource.match(
        new RegExp(`${variant}: \\{([\\s\\S]*?)\\n  \\},`),
      )?.[1];
      const middlewareDescription = middlewareBlock?.match(/^\s+description: '([^']+)'/m)?.[1];
      assert.equal(
        middlewareDescription,
        description,
        `${variant} crawler metadata must match src/config/variant-meta.ts`,
      );
    }

    const fullDescription = indexHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    const fullBlock = variantMetaSource.match(/full: \{([\s\S]*?)\n {2}\},/)?.[1];
    const expectedFullDescription = fullBlock?.match(/^\s+description: '([^']+)'/m)?.[1];
    assert.equal(fullDescription, expectedFullDescription, 'index.html must use the full variant description');
  });
});
