import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #4580 item (b): the connectivity "cached mode" banner (App.ts, inserted afterend of
// .header) is toggled during boot on slow connections (cached -> live). When it was
// in normal flow (display:flex, no position) that insert/remove reflowed the entire
// #panelTabsMount / #main / #panelsGrid column by ~83px, generating field CLS
// (#panelsGrid and #main were the top field offenders). Verified in-browser: an in-flow
// banner shifts #main.y +83px; a position:fixed banner shifts it 0px.
//
// This guard keeps the banner OUT OF FLOW so its toggling can never reflow the column
// again. CLS itself is field-only (not unit-testable), but "the banner is fixed-position"
// is a checkable structural contract.

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const css = readFileSync(join(root, 'src', 'styles', 'main.css'), 'utf-8');
const appTs = readFileSync(join(root, 'src', 'App.ts'), 'utf-8');

/**
 * First rule body for `selectorRe`. The `\s*\{` anchor means `.cached-mode-banner`
 * matches only the base rule, not `.cached-mode-banner--unavailable` /
 * `.cached-mode-banner__badge` (those have `--`/`__` before the brace).
 */
function ruleBody(source, selectorRe) {
  const re = new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`);
  const m = source.match(re);
  return m ? m[1] : null;
}

function declarationValue(body, property) {
  const re = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`);
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

function numericDeclaration(body, property) {
  const value = declarationValue(body, property);
  return value === null ? Number.NaN : Number.parseInt(value, 10);
}

describe('#4580 cached-mode banner stays out of flow', () => {
  it('the App still renders a .cached-mode-banner (guard is not dead)', () => {
    // If the banner element is ever renamed/removed, this test would silently pass on a
    // stale selector — anchor it to the source that creates the element.
    assert.match(
      appTs,
      /['"`]cached-mode-banner['"`]/,
      'App.ts should still create the .cached-mode-banner element (update this guard if renamed)',
    );
  });

  it('.cached-mode-banner is position:fixed so toggling it never reflows the column', () => {
    const body = ruleBody(css, '\\.cached-mode-banner');
    assert.ok(body, 'Expected a base .cached-mode-banner rule in main.css');
    assert.match(
      body,
      /position:\s*fixed/,
      'The cached-mode banner must be position:fixed (out of flow). In normal flow its ' +
        'insert/remove during boot reflows #panelsGrid/#main ~83px and regresses field CLS (#4580).',
    );
    // A fixed element must be pinned to the intended viewport edge, or it can drift
    // back toward its static insertion point while still passing a generic top/bottom
    // presence check.
    assert.equal(
      declarationValue(body, 'bottom'),
      '0',
      'A fixed .cached-mode-banner must stay pinned to the bottom viewport edge',
    );
    assert.equal(declarationValue(body, 'left'), '0', 'The fixed banner must span from the left edge');
    assert.equal(declarationValue(body, 'right'), '0', 'The fixed banner must span to the right edge');
  });

  it('.cached-mode-banner is layered above the mobile FAB but below search overlays', () => {
    const bannerBody = ruleBody(css, '\\.cached-mode-banner');
    const searchOverlayBody = ruleBody(css, '\\.search-overlay');
    assert.ok(bannerBody, 'Expected a base .cached-mode-banner rule in main.css');
    assert.ok(searchOverlayBody, 'Expected a base .search-overlay rule in main.css');

    const bannerZ = numericDeclaration(bannerBody, 'z-index');
    const searchOverlayZ = numericDeclaration(searchOverlayBody, 'z-index');
    assert.ok(Number.isFinite(bannerZ), 'Expected .cached-mode-banner to set a numeric z-index');
    assert.ok(Number.isFinite(searchOverlayZ), 'Expected .search-overlay to set a numeric z-index');
    assert.ok(
      bannerZ > 500,
      'The cached-mode banner must remain above the bottom-right search FAB (z-index 500)',
    );
    assert.ok(
      bannerZ < searchOverlayZ,
      'The cached-mode banner must stay below search overlays so it does not cover the search sheet/modal',
    );
  });
});
