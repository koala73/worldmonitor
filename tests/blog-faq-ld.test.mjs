import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAYOUT_PATH = resolve(__dirname, '../blog-site/src/layouts/BlogPost.astro');
const BLOG_DIR = resolve(__dirname, '../blog-site/src/content/blog');

// extractFaqLd lives in the .astro frontmatter, which node can't import.
// Text-extract the function body and evaluate it (established pattern for
// guarding generators without importing them). If the function is renamed
// or moved, this fails loudly rather than silently guarding nothing.
function loadExtractFaqLd() {
  const source = readFileSync(LAYOUT_PATH, 'utf-8');
  const match = source.match(/function extractFaqLd\([\s\S]*?\n\}/);
  assert.ok(match, 'extractFaqLd function not found in BlogPost.astro');
  // Strip the TS annotations that would break plain-JS evaluation.
  const js = match[0]
    .replace('(body: string | undefined): object | null', '(body)')
    .replace(/const items: \{[\s\S]*?\}\[\] = \[\];/, 'const items = [];')
    .replace('let match: RegExpExecArray | null;', 'let match;');
  return new Function(`${js}\nreturn extractFaqLd;`)();
}

const extractFaqLd = loadExtractFaqLd();

describe('blog FAQPage JSON-LD extraction (#5001)', () => {
  it('extracts Q&A written in the corpus format (blank line between question and answer)', () => {
    const body = [
      '## Frequently Asked Questions',
      '',
      '**Is the free tier usable?**',
      '',
      'Yes — it ships [56 layers](https://www.worldmonitor.app/) with no signup.',
      '',
      '**When is paid worth it?**',
      '',
      'When missed events cost you money.',
      '',
      '---',
      '',
      '**Pick your variant and start exploring:**',
      '',
      '- [worldmonitor.app](https://worldmonitor.app) for geopolitics',
    ].join('\n');
    const ld = extractFaqLd(body);
    assert.ok(ld, 'FAQPage LD must be produced');
    assert.equal(ld['@type'], 'FAQPage');
    assert.equal(
      ld.mainEntity.length,
      2,
      'the bold CTA after the --- rule must NOT be extracted as a Question (corpus posts end FAQs with --- + CTA)',
    );
    assert.equal(ld.mainEntity[0].name, 'Is the free tier usable?');
    assert.equal(
      ld.mainEntity[0].acceptedAnswer.text,
      'Yes — it ships 56 layers with no signup.',
      'markdown links must be flattened to text',
    );
  });

  it('still extracts the tight format (answer on the very next line)', () => {
    const body = '## Frequently Asked Questions\n**Q one?**\nAnswer one.\n';
    const ld = extractFaqLd(body);
    assert.equal(ld.mainEntity.length, 1);
  });

  it('returns null when there is no FAQ section', () => {
    assert.equal(extractFaqLd('## Something else\n\n**bold** text'), null);
    assert.equal(extractFaqLd(undefined), null);
  });

  it('every published post with an FAQ section yields at least one Question (corpus sweep)', () => {
    const posts = readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(posts.length > 0, 'expected blog posts');
    let postsWithFaq = 0;
    for (const file of posts) {
      const body = readFileSync(join(BLOG_DIR, file), 'utf-8');
      if (!body.includes('## Frequently Asked Questions')) continue;
      postsWithFaq += 1;
      const ld = extractFaqLd(body);
      assert.ok(
        ld && ld.mainEntity.length > 0,
        `${file} has an FAQ section but extractFaqLd produced nothing — the regex regressed against the corpus format`,
      );
      for (const item of ld.mainEntity) {
        assert.ok(item.name.length > 0 && item.acceptedAnswer.text.length > 0, `${file}: empty Q or A extracted`);
        // Every real FAQ question in the corpus ends with '?'; the bold
        // takeaway/CTA paragraphs after the closing --- rule do not. If this
        // fires, the extractor is running past the FAQ terminator again.
        assert.ok(
          item.name.endsWith('?'),
          `${file}: extracted non-question "${item.name.slice(0, 60)}" — FAQ section terminator over-capture`,
        );
      }
    }
    assert.ok(postsWithFaq > 0, 'expected at least one post with an FAQ section — the sweep is guarding nothing');
  });
});
