import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

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
const panelLayout = readFileSync(join(root, 'src', 'app', 'panel-layout.ts'), 'utf-8');

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

function mobileBreakpoint() {
  const bp = utils.match(/MOBILE_BREAKPOINT_PX\s*=\s*(\d+)/);
  assert.ok(bp, 'Expected MOBILE_BREAKPOINT_PX in src/utils/index.ts');
  return bp[1];
}

function matchingBraceIndex(source, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function maxWidthMediaBlocks(source) {
  const blocks = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  for (const m of source.matchAll(re)) {
    const openBrace = source.indexOf('{', m.index);
    const closeBrace = matchingBraceIndex(source, openBrace);
    assert.notEqual(closeBrace, -1, `Expected @media (max-width:${m[1]}px) block to close`);
    blocks.push({
      breakpoint: m[1],
      body: source.slice(openBrace + 1, closeBrace),
    });
  }
  return blocks;
}

function mediaRule(source, selectorRe, must) {
  for (const block of maxWidthMediaBlocks(source)) {
    const body = ruleBody(block.body, selectorRe, must);
    if (body) return { breakpoint: block.breakpoint, body };
  }
  return null;
}

function mediaRuleAtBreakpoint(source, breakpoint, selectorRe, must) {
  for (const block of maxWidthMediaBlocks(source)) {
    if (block.breakpoint !== breakpoint) continue;
    const body = ruleBody(block.body, selectorRe, must);
    if (body) return body;
  }
  return null;
}

function classMethodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Expected ${signature} in panel-layout.ts`);
  const openBrace = source.indexOf('{', start);
  const closeBrace = matchingBraceIndex(source, openBrace);
  assert.notEqual(closeBrace, -1, `Expected ${signature} to close`);
  return source.slice(openBrace + 1, closeBrace);
}

function runPrepaintBootScript(mapCollapsed) {
  const script = html.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/);
  assert.ok(script, 'Expected the explicitly marked inline pre-paint boot script in index.html');

  const classes = new Set();
  const storage = new Map([['mobile-map-collapsed', String(mapCollapsed)]]);
  const window = {};
  window.self = window;
  window.top = window;

  runInNewContext(script[1], {
    document: {
      documentElement: {
        dataset: {},
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
        },
        removeAttribute: () => {},
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
    },
    location: { hostname: 'www.worldmonitor.app' },
    window,
  });

  return classes;
}

describe('#4580 boot skeleton <-> app footprint parity', () => {
  it('mobile skeleton map reserves the same height as the real .map-section', () => {
    // Source of truth: the full-viewport mobile map rule in main.css.
    const realMap = mediaRule(css, '\\.map-section', '100dvh');
    assert.ok(realMap, 'Expected a mobile .map-section rule using 100dvh in main.css');
    // The skeleton mirror (the only .skeleton-map rule carrying 100dvh).
    const skelMap = mediaRule(html, '\\.skeleton-map', '100dvh');
    assert.ok(
      skelMap,
      'index.html .skeleton-map must mirror the real mobile map height (calc(100dvh - 48px ...)). ' +
        'It currently does not reserve a 100dvh height — the skeleton->app swap will shove #panelsGrid on mobile.',
    );

    assert.equal(
      skelMap.breakpoint,
      realMap.breakpoint,
      'skeleton .skeleton-map and real .map-section must live under the same mobile breakpoint',
    );

    for (const prop of ['height', 'min-height', 'max-height']) {
      assert.deepEqual(
        declarations(skelMap.body, prop),
        declarations(realMap.body, prop),
        `skeleton .skeleton-map "${prop}" must match real .map-section "${prop}" (#4580 mobile CLS parity)`,
      );
    }
  });

  it('collapsed mobile skeleton map mirrors the stored collapsed-map footprint', () => {
    const realCollapsedMap = mediaRule(css, '\\.main-content \\.map-section\\.collapsed', 'height: auto');
    assert.ok(
      realCollapsedMap,
      'Expected the mobile .map-section.collapsed rule to define the collapsed map footprint in main.css',
    );

    const collapsedSkeletonMap = mediaRule(html, 'html\\.wm-map-collapsed \\.skeleton-map', 'height:auto');
    assert.ok(
      collapsedSkeletonMap,
      'index.html must override the mobile skeleton footprint when mobile-map-collapsed is stored before paint',
    );
    assert.equal(
      collapsedSkeletonMap.breakpoint,
      realCollapsedMap.breakpoint,
      'collapsed skeleton and real map must use the same mobile breakpoint',
    );

    for (const prop of ['height', 'min-height', 'max-height']) {
      assert.deepEqual(
        declarations(collapsedSkeletonMap.body, prop),
        declarations(realCollapsedMap.body, prop),
        `collapsed skeleton .skeleton-map "${prop}" must match real .map-section.collapsed`,
      );
    }

    const collapsedSkeletonBody = mediaRule(html, 'html\\.wm-map-collapsed \\.skeleton-map-body', 'display:none');
    assert.ok(
      collapsedSkeletonBody,
      'collapsed skeleton must hide the loading card so it cannot contribute intrinsic height',
    );
    assert.deepEqual(declarations(collapsedSkeletonBody.body, 'display'), ['none']);

    assert.ok(
      runPrepaintBootScript(true).has('wm-map-collapsed'),
      'the inline pre-paint script must stamp the matching html class for a persisted collapsed map',
    );
    assert.ok(
      !runPrepaintBootScript(false).has('wm-map-collapsed'),
      'the inline pre-paint script must leave the expanded-map cohort unchanged',
    );

    const mobileMapToggle = classMethodBody(panelLayout, 'private setupMobileMapToggle()');
    assert.match(
      mobileMapToggle,
      /document\.documentElement\.classList\.remove\('wm-map-collapsed'\)/,
      'hydration must clear the boot-only html class after the skeleton is replaced',
    );
  });

  it('mobile skeleton header height matches the real .header height', () => {
    const breakpoint = mobileBreakpoint();
    const baseHeader = ruleBody(css, '(?:^|\\n)\\.header');
    assert.ok(baseHeader, 'Expected a base .header rule in main.css');
    const mobileHeader = mediaRuleAtBreakpoint(css, breakpoint, '\\.header');
    const effectiveRealHeader =
      mobileHeader && declarations(mobileHeader, 'height').length > 0 ? mobileHeader : baseHeader;
    const skelHeaderMobile = mediaRuleAtBreakpoint(html, breakpoint, '\\.skeleton-header');
    assert.ok(
      skelHeaderMobile,
      `Expected a .skeleton-header rule inside the @media (max-width:${breakpoint}px) skeleton block`,
    );
    assert.deepEqual(
      declarations(skelHeaderMobile, 'height'),
      declarations(effectiveRealHeader, 'height'),
      'skeleton mobile header height must match the real .header height (#4580 header parity)',
    );
  });

  it('skeleton mobile breakpoint matches the app mobile breakpoint (MOBILE_BREAKPOINT_PX)', () => {
    const breakpoint = mobileBreakpoint();
    const realMap = mediaRule(css, '\\.map-section', '100dvh');
    assert.ok(realMap, 'Expected a mobile .map-section rule using 100dvh in main.css');

    // main.css switches the map to full-viewport at exactly this breakpoint...
    assert.equal(
      realMap.breakpoint,
      breakpoint,
      `main.css .map-section should gate mobile rules at MOBILE_BREAKPOINT_PX (${breakpoint}px)`,
    );
    // ...so the skeleton mobile block must use the SAME breakpoint. A 767/768 seam
    // fully de-syncs the skeleton on iPad portrait (exactly 768px CSS width): the app
    // renders the 100dvh map while the skeleton stays on the desktop 50vh map.
    assert.ok(
      mediaRuleAtBreakpoint(html, breakpoint, '\\.skeleton-header'),
      `The skeleton mobile block must gate at MOBILE_BREAKPOINT_PX (${breakpoint}px), not a 1px-off seam`,
    );
  });

  it('collapsed cohort: #mapSection is CREATED with .collapsed when the pref is set (#5159)', () => {
    // The pre-paint html.wm-map-collapsed critical CSS can only cover the boot
    // SKELETON: main.css sets the expanded mobile .map-section height with
    // !important inside a cascade layer, and for !important declarations
    // LAYERED beats UNLAYERED — the inverse of the normal-declaration rule the
    // critical CSS relies on. So the REAL section must be born collapsed: the
    // renderLayout template seeds .collapsed from the same localStorage key the
    // toggle persists. Without this, #mapSection paints expanded (~796px) and
    // snaps up 698px when setupMobileMapToggle runs (~150ms later; CLS 0.617,
    // reproduced 3/3 for the mobile-map-collapsed cohort).
    assert.match(
      panelLayout,
      /const mapStartsCollapsed = this\.ctx\.isMobile && PanelLayoutManager\.isMobileMapCollapsedPreferred\(\);/,
      'renderLayout must read the collapse pref (via the guarded helper) before building the shell template',
    );
    // #5205 review P1: this read runs BEFORE the shell installs — a bare
    // localStorage access throws under blocked storage (SecurityError) and
    // would strand users on the boot skeleton. The helper must route through
    // the try/catch-guarded loadFromStorage with an expanded default.
    assert.match(
      panelLayout,
      /private static isMobileMapCollapsedPreferred\(\): boolean \{\s*return loadFromStorage<boolean>\('mobile-map-collapsed', false\) === true;/,
      'the collapse-pref read must use guarded loadFromStorage, defaulting to expanded',
    );
    assert.doesNotMatch(
      panelLayout,
      /localStorage\.getItem\('mobile-map-collapsed'\)/,
      'no bare localStorage read of the collapse pref may remain (boot-critical path)',
    );
    assert.match(
      panelLayout,
      /<div class="map-section\$\{mapStartsCollapsed \? ' collapsed' : ''\}" id="mapSection">/,
      '#mapSection must be created with .collapsed for the collapsed cohort — adding it later shifts #panelsGrid',
    );
    // The critical CSS must keep the do-not-retry note so nobody re-attempts an
    // unlayered !important pre-paint override of the layered expanded height.
    assert.match(
      html,
      /do NOT try to pre-paint-collapse the REAL \.map-section/,
      'index.html must document why the real section is not styled from critical CSS (#5159 layered-!important inversion)',
    );
  });
});
