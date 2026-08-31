import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stylesSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

// #7267 mounted the digest coverage row into the site footer and collapsed the
// mobile footer around it. The mobile dashboard is a fixed-viewport shell with
// no document scroll, so that pinned the row inside the fold, where 139
// characters of wrapped 10px mono outgrew the shell skeleton and took over as
// the LCP element. Because the row's text is only written on the first digest
// load, LCP then waited on a network round trip: mobile /dashboard field p75
// went 1137ms (Aug 25) to 2357ms (Aug 30), and the throttled lab check measured
// a 13.3s render delay against a 271ms baseline.
function mediaBlocks(query: string): string[] {
  const blocks: string[] = [];
  const needle = `@media ${query}`;
  for (let at = stylesSrc.indexOf(needle); at >= 0; at = stylesSrc.indexOf(needle, at + 1)) {
    const open = stylesSrc.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < stylesSrc.length; i++) {
      if (stylesSrc[i] === '{') depth++;
      if (stylesSrc[i] === '}' && --depth === 0) {
        blocks.push(stylesSrc.slice(open + 1, i));
        break;
      }
    }
  }
  return blocks;
}

function rule(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  return css.slice(at, css.indexOf('}', at));
}

const MOBILE = '(max-width: 768px)';
const CONTAINER = '.site-footer .status-panel-container';

test('the mobile footer keeps the digest coverage row out of the paint path (LCP)', () => {
  const declarations = mediaBlocks(MOBILE)
    .map((block) => rule(block, CONTAINER))
    .filter((found): found is string => found !== null);

  assert.equal(
    declarations.length,
    1,
    `expected exactly one ${CONTAINER} rule under ${MOBILE}`,
  );
  const mobile = declarations[0];

  // Clipped to a 1px box, so the row contributes no LCP candidate area. Not
  // display:none and not visibility:hidden — PR #7267's review rejected both
  // for dropping the aria-live region out of the mobile accessibility tree.
  assert.match(mobile, /clip-path:\s*inset\(50%\)/);
  assert.match(mobile, /position:\s*absolute/);
  assert.match(mobile, /\bwidth:\s*1px/);
  assert.match(mobile, /\bheight:\s*1px/);
  assert.doesNotMatch(mobile, /display:\s*none/);
  assert.doesNotMatch(mobile, /visibility:\s*hidden/);

  // A clipped 1px box that still paints its own border is a stray hairline.
  assert.doesNotMatch(mobile, /border-top:\s*(?!none)/);
});

test('the desktop footer still shows the digest coverage row', () => {
  // Positive control: a blanket sr-only treatment on the shared rule would
  // satisfy the mobile assertion above while silently deleting the row from the
  // desktop footer, where it is a deliberate visible one-line disclosure.
  const shared = rule(stylesSrc, CONTAINER);
  assert.ok(shared, `expected a base ${CONTAINER} rule`);
  assert.doesNotMatch(shared, /clip-path:\s*inset\(50%\)/);
  assert.match(shared, /flex-basis:\s*100%/);
});
