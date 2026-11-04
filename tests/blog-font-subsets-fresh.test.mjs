// The blog's web fonts are subset by hand (`npm run fonts:subset` in blog-site/) to the
// characters, weights and features the blog renders. This test says when that has to be
// rerun: content gained a character a font would draw but no subset contains, or the font
// CSS or page languages changed since the subsets were cut.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { blogFontInputs } from '../blog-site/scripts/fonts/subset/inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blogRoot = path.join(root, 'blog-site');
const manifest = JSON.parse(fs.readFileSync(path.join(blogRoot, 'src/fonts/manifest.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(blogRoot, 'scripts/fonts/subset/google-fonts-snapshot.json'), 'utf8'));
const generatedCss = fs.readFileSync(path.join(blogRoot, 'src/styles/fonts.generated.css'), 'utf8');
const current = blogFontInputs(blogRoot);
const RERUN = 'Run `npm run fonts:subset` in blog-site/ and commit src/fonts and src/styles/fonts.generated.css.';

function parseRanges(list) {
  const cps = new Set();
  for (const part of list.split(',')) {
    const [a, b = a] = part.trim().replace(/^U\+/i, '').split('-');
    for (let cp = parseInt(a, 16); cp <= parseInt(b, 16); cp += 1) cps.add(cp);
  }
  return cps;
}

describe('blog font subsets', () => {
  it('cover every character the blog sources add that a web font would draw', () => {
    const seen = new Set([...manifest.inputs.chars].map((c) => c.codePointAt(0)));
    const missing = [];
    for (const [family, google] of Object.entries(snapshot.families)) {
      const googleDraws = new Set(Object.values(google.subsets).flatMap((s) => [...parseRanges(s.renders)]));
      const files = manifest.families[family].files;
      const ours = new Set([...parseRanges(files.core.unicode_range), ...parseRanges(files.ext.unicode_range)]);
      for (const ch of current.chars) {
        const cp = ch.codePointAt(0);
        if (!seen.has(cp) && googleDraws.has(cp) && !ours.has(cp)) missing.push(`${family}: ${ch} U+${cp.toString(16).toUpperCase()}`);
      }
    }
    assert.deepEqual(missing, [], `New characters would fall back to a system font. ${RERUN}`);
  });

  it('were cut for the current font CSS', () => {
    // Each entry is "file | selector or tag | declaration", so moving, changing or removing a
    // declaration all count: any of them can change which weights and faces are needed.
    const added = current.declarations.filter((d) => !manifest.inputs.declarations.includes(d));
    const removed = manifest.inputs.declarations.filter((d) => !current.declarations.includes(d));
    assert.deepEqual({ added, removed }, { added: [], removed: [] }, `Font-related CSS changed since the subsets were generated (weights, features and faces may differ). ${RERUN}`);
  });

  it('were checked against the Google-served files', () => {
    const unchecked = Object.entries(manifest.families).filter(([, f]) => f.google_parity_checked !== true).map(([name]) => name);
    assert.deepEqual(unchecked, [], `Generated with --skip-google-parity. ${RERUN}`);
  });

  it('were cut for the current page languages', () => {
    const added = current.langs.filter((l) => !manifest.inputs.langs.includes(l));
    assert.deepEqual(added, [], `New lang attributes can need the fonts' locl feature. ${RERUN}`);
  });

  it('declare each manifest weight once, with a unicode-range that matches its file exactly', () => {
    for (const [family, entry] of Object.entries(manifest.families)) {
      for (const part of ['core', 'ext']) {
        const file = entry.files[part];
        const faces = [...generatedCss.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]).filter((body) => body.includes(`'${family}'`) && body.includes(`/${file.file}'`));
        const weights = faces.map((body) => Number(body.match(/font-weight: (\d+);/)?.[1])).sort((a, b) => a - b);
        assert.deepEqual(weights, entry.faces, `${family} ${part}: one @font-face per manifest weight`);
        for (const body of faces) assert.match(body, new RegExp(`unicode-range: ${file.unicode_range.replace(/[+]/g, '\\+')};`));
        assert.ok(fs.existsSync(path.join(blogRoot, 'src/fonts', file.file)), `${file.file} is committed`);
        assert.equal(fs.statSync(path.join(blogRoot, 'src/fonts', file.file)).size, file.bytes, `${file.file} matches the manifest`);
      }
    }
  });

  it('ship no Google Fonts request and preload only the core files', () => {
    const globalCss = fs.readFileSync(path.join(blogRoot, 'src/styles/global.css'), 'utf8');
    assert.doesNotMatch(globalCss, /fonts\.googleapis\.com/);
    const base = fs.readFileSync(path.join(blogRoot, 'src/layouts/Base.astro'), 'utf8');
    const preloads = [...base.matchAll(/<link rel="preload" href=\{(\w+)\} as="font" type="font\/woff2" crossorigin \/>/g)].map((m) => m[1]);
    const imported = Object.fromEntries([...base.matchAll(/import (\w+) from '\.\.\/fonts\/([\w-]+)\.woff2\?url';/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(preloads.map((v) => imported[v]).sort(), ['inter-core', 'jetbrains-mono-core', 'space-grotesk-core']);
  });
});
