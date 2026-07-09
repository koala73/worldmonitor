import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #4580 item (a): the inline boot skeleton in index.html must reserve the same
// above-the-fold footprint as the first hydrated dashboard frame, or the
// skeleton->app swap shoves #panelsGrid/#main and generates field CLS. The most
// severe offender was the mobile map: the real `.map-section` goes full-viewport
// on mobile (calc(100dvh - 48px), ~796-976px) while the skeleton reserved a flat
// 50vh (~422-512px) — a 374-464px under-reservation depending on device.
//
// The runtime warner (warnOnBootShellFootprintDrift in src/app/panel-layout.ts)
// catches this at boot, but only in DEV and only when someone is watching the
// console. This test encodes the same parity contract statically so CI catches
// drift: it treats main.css `.map-section` as the source of truth and asserts the
// index.html skeleton mirrors it. If the real mobile map dimensions change, this
// test fails until the skeleton is updated to match (and vice versa).

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf-8');
const css = readFileSync(join(root, 'src', 'styles', 'main.css'), 'utf-8');
const utils = readFileSync(join(root, 'src', 'utils', 'index.ts'), 'utf-8');

/** Collapse whitespace and drop `!important` so declarations compare structurally. */
const norm = (v) => v.replace(/!important/g, '').trim().replace(/\s+/g, ' ');

/**
 * Every value declared for `prop` inside a rule body, in source order.
 * The leading boundary (start | `;` | `{` | whitespace) prevents `height`
 * from also matching inside `min-height` / `max-height`.
 */
function declarations(block, prop) {
  // Terminate with a lookahead (not a consuming match) so the separating `;`
  // stays available as the leading boundary for the next declaration.
  const re = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?=;|$)`, 'g');
  return [...block.matchAll(re)].map((m) => norm(m[1]));
}

/** First rule body matching `selectorRe` (optionally required to contain `must`). */
function ruleBody(source, selectorRe, must) {
  const re = new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of source.matchAll(re)) {
    if (!must || m[1].includes(must)) return m[1];
  }
  return null;
}

describe('#4580 boot skeleton <-> app footprint parity', () => {
  it('mobile skeleton map reserves the same height as the real .map-section', () => {
    // Source of truth: the full-viewport mobile map rule in main.css.
    const realMap = ruleBody(css, '\\.map-section', '100dvh');
    assert.ok(realMap, 'Expected a mobile .map-section rule using 100dvh in main.css');
    // The skeleton mirror (the only .skeleton-map rule carrying 100dvh).
    const skelMap = ruleBody(html, '\\.skeleton-map', '100dvh');
    assert.ok(
      skelMap,
      'index.html .skeleton-map must mirror the real mobile map height (calc(100dvh - 48px ...)). ' +
        'It currently does not reserve a 100dvh height — the skeleton->app swap will shove #panelsGrid on mobile.',
    );

    for (const prop of ['height', 'min-height', 'max-height']) {
      assert.deepEqual(
        declarations(skelMap, prop),
        declarations(realMap, prop),
        `skeleton .skeleton-map "${prop}" must match real .map-section "${prop}" (#4580 mobile CLS parity)`,
      );
    }
  });

  it('mobile skeleton header height matches the real .header height', () => {
    // Source of truth is the BASE .header height; no rule under @media (max-width:768px)
    // overrides .header height today (the mobile blocks only touch its padding), so the
    // base value is the effective mobile height. If a mobile header-height override is
    // ever added, tighten this to read the effective mobile value instead.
    const realHeader = ruleBody(css, '(?:^|\\n)\\.header');
    assert.ok(realHeader, 'Expected a base .header rule in main.css');
    // The skeleton-header inside the mobile media block (first rule after the query open).
    // Whitespace-tolerant so a reformat of the (hand-authored, compact) inline CSS doesn't
    // spuriously fail — we assert the breakpoint value and the height, not the formatting.
    const skelHeaderMobile = html.match(/@media \(max-width:\s*768px\)\s*\{\s*\.skeleton-header\{([^}]*)\}/);
    assert.ok(
      skelHeaderMobile,
      'Expected a .skeleton-header rule inside the @media (max-width:768px) skeleton block',
    );
    assert.deepEqual(
      declarations(skelHeaderMobile[1], 'height'),
      declarations(realHeader, 'height'),
      'skeleton mobile header height must match the real .header height (#4580 header parity)',
    );
  });

  it('skeleton mobile breakpoint matches the app mobile breakpoint (MOBILE_BREAKPOINT_PX)', () => {
    const bp = utils.match(/MOBILE_BREAKPOINT_PX\s*=\s*(\d+)/);
    assert.ok(bp, 'Expected MOBILE_BREAKPOINT_PX in src/utils/index.ts');
    const breakpoint = bp[1];

    // main.css switches the map to full-viewport at exactly this breakpoint...
    assert.match(
      css,
      new RegExp(`@media \\(max-width:\\s*${breakpoint}px\\)`),
      `main.css should gate mobile rules at MOBILE_BREAKPOINT_PX (${breakpoint}px)`,
    );
    // ...so the skeleton mobile block must use the SAME breakpoint. A 767/768 seam
    // fully de-syncs the skeleton on iPad portrait (exactly 768px CSS width): the app
    // renders the 100dvh map while the skeleton stays on the desktop 50vh map.
    assert.match(
      html,
      new RegExp(`@media \\(max-width:\\s*${breakpoint}px\\)\\s*\\{\\s*\\.skeleton-header`),
      `The skeleton mobile block must gate at MOBILE_BREAKPOINT_PX (${breakpoint}px), not a 1px-off seam`,
    );
  });
});
