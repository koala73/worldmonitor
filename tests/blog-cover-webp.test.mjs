import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coverWebpSources } from '../blog-site/src/lib/cover-webp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = resolve(__dirname, '../blog-site/src/content/blog');
const PUBLIC_DIR = resolve(__dirname, '../blog-site/public');

const getHeroImages = () =>
  readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const source = readFileSync(resolve(CONTENT_DIR, name), 'utf-8');
      return { post: name, heroImage: source.match(/^heroImage:\s*"([^"]+)"/m)?.[1] ?? null };
    });

describe('blog cover WebP siblings', () => {
  it('every post uses a committed cover with .webp and -640.webp siblings', () => {
    // The <picture> markup in BlogPost.astro / index.astro serves the WebP
    // when coverWebpSources() finds both siblings. A committed cover without
    // them silently loses the optimization, so keep the pair in lockstep:
    // `cwebp -q 80 <cover> -o <cover>.webp` and
    // `cwebp -q 80 -resize 640 0 <cover> -o <cover>-640.webp`.
    const posts = getHeroImages();
    assert.ok(posts.length > 0, 'expected blog posts');
    for (const { post, heroImage } of posts) {
      assert.ok(heroImage, `${post}: heroImage is required`);
      assert.ok(
        heroImage.startsWith('/blog/images/blog/'),
        `${post}: heroImage must be a committed product cover, not a generated title card`
      );
      const local = resolve(PUBLIC_DIR, heroImage.replace('/blog/', ''));
      assert.ok(existsSync(local), `${post}: cover missing at ${heroImage}`);
      const sources = coverWebpSources(heroImage);
      assert.ok(
        sources,
        `${post}: missing .webp/-640.webp siblings for ${heroImage} — regenerate with cwebp`
      );
    }
  });

  it('never advertises WebP for covers without committed siblings', () => {
    // Deploy-generated OG covers (/blog/og/*.png) have no WebP siblings in
    // the repo. A <source> pointing at a missing file does NOT fall back to
    // the <img> src, so the helper must return null for them.
    assert.equal(coverWebpSources('/blog/og/some-deploy-generated-cover.png'), null);
    assert.equal(coverWebpSources('/blog/images/blog/does-not-exist.jpg'), null);
    assert.equal(coverWebpSources('https://example.com/external.jpg'), null);
    assert.equal(coverWebpSources(undefined), null);
  });

  it('templates render covers through coverWebpSources', () => {
    const blogPost = readFileSync(resolve(__dirname, '../blog-site/src/layouts/BlogPost.astro'), 'utf-8');
    const index = readFileSync(resolve(__dirname, '../blog-site/src/pages/index.astro'), 'utf-8');
    for (const [name, source] of [['BlogPost.astro', blogPost], ['index.astro', index]]) {
      assert.match(source, /coverWebpSources/, `${name} must resolve covers via coverWebpSources`);
      assert.match(source, /type="image\/webp"/, `${name} must emit a WebP <source>`);
    }
  });
});
