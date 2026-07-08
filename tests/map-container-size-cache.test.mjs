import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapSrc = readFileSync(resolve(__dirname, '..', 'src', 'components', 'Map.ts'), 'utf8');

// #5017: the /dashboard "Avoid forced reflows" audit attributed 516ms (65% of
// the 797ms total) to Map-*.js. The cause was repeated LIVE reads of the
// container geometry (this.container.clientWidth / clientHeight) on the
// render/draw path — each read interleaved with the prior render tick's SVG
// writes forces a synchronous layout. The container size only changes on
// resize, which the ResizeObserver already tracks into lastContainerSize, so
// the boot/draw path must read the cached size via getKnownContainerSize()
// instead of hitting the DOM live.
describe('Map container-size cache (#5017 forced-reflow guard)', () => {
  it('render() reads the cached container size, not a live DOM read', () => {
    const render = mapSrc.match(/public render\(\): void \{[\s\S]*?\n {2}\}/);
    assert.ok(render, 'could not locate render() body');
    assert.match(
      render[0],
      /getKnownContainerSize\(\)/,
      'render() must read via getKnownContainerSize() (ResizeObserver-maintained cache), not a live clientWidth/clientHeight',
    );
    assert.doesNotMatch(
      render[0],
      /this\.container\.client(Width|Height)/,
      'render() must not read this.container.clientWidth/clientHeight directly',
    );
  });

  it('keeps direct container clientWidth/clientHeight reads confined to the two intended sites', () => {
    // Direct live reads are allowed ONLY in:
    //   1. readContainerSize() — the primitive that refreshes the cache.
    //   2. the pointer/click handler — needs live geometry paired with a live
    //      getBoundingClientRect() for scroll-accurate cursor→map mapping.
    // Any NEW direct read on the render/draw path reintroduces the #5017 reflow.
    const widthReads = (mapSrc.match(/this\.container\.clientWidth/g) || []).length;
    const heightReads = (mapSrc.match(/this\.container\.clientHeight/g) || []).length;
    assert.equal(
      widthReads,
      2,
      `expected exactly 2 direct this.container.clientWidth reads (readContainerSize + pointer handler); found ${widthReads}. New draw-path reads must use getKnownContainerSize().`,
    );
    assert.equal(
      heightReads,
      2,
      `expected exactly 2 direct this.container.clientHeight reads (readContainerSize + pointer handler); found ${heightReads}.`,
    );
  });

  it('still exposes the cache accessor and its resize-driven refresh', () => {
    assert.match(mapSrc, /private getKnownContainerSize\(\)/, 'getKnownContainerSize() accessor must exist');
    assert.match(mapSrc, /rememberContainerSize\(\{ width, height \}\)/, 'ResizeObserver must refresh the cache via rememberContainerSize()');
  });
});

// #5022 review: cached geometry is only safe on the render/draw hot path. One-shot
// viewport commands can run right after revealMobileMap() expands the map — before
// the ResizeObserver refreshes the cache — so they must read the CURRENT size or
// they center off stale dimensions. readContainerSize() reads live AND refreshes
// the cache, keeping the subsequent cached applyTransform() read consistent.
describe('Map one-shot viewport commands read current size (#5022 review)', () => {
  function methodSlice(name) {
    const start = mapSrc.search(new RegExp(String.raw`\n  (?:public|private) ${name}\(`));
    assert.ok(start >= 0, `could not locate ${name}()`);
    const rest = mapSrc.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}(?:public|private|protected) \w+\(/);
    return next >= 0 ? rest.slice(0, next + 1) : rest;
  }

  for (const name of ['setCenter', 'fitCountry', 'getCenter']) {
    it(`${name}() reads live via readContainerSize(), not the stale cache`, () => {
      const body = methodSlice(name);
      assert.match(body, /readContainerSize\(\)/, `${name}() must read the current size (correct after reveal/resize)`);
      assert.doesNotMatch(body, /getKnownContainerSize\(\)/, `${name}() must not read the cached size — it can run before the ResizeObserver refresh`);
    });
  }

  it('ResizeObserver records zero-size (hidden) transitions, gating only the render on visibility', () => {
    const ro = mapSrc.slice(mapSrc.indexOf('private setupResizeObserver('));
    const body = ro.slice(0, ro.slice(1).search(/\n {2}(?:public|private) \w+\(/) + 1);
    // scheduleRender is gated on a visible size...
    assert.match(body, /if \(width > 0 && height > 0\) this\.scheduleRender\(\)/, 'scheduleRender must fire only for a visible size');
    // ...but the cache update must run for ANY change (including -> 0), so the
    // old combined visible-only guard must be gone.
    assert.doesNotMatch(body, /width > 0 && height > 0 && \(width !== lastWidth/, 'must not gate the cache update behind the visible-size check (hidden state must be recorded so render() skips)');
    assert.match(body, /rememberContainerSize\(\{ width, height \}\)/, 'must record every observed size (including zero) into the cache');
  });

  it('render paths keep the zero-size skip so a hidden map does not render off stale dimensions', () => {
    assert.match(mapSrc, /if \(width === 0 \|\| height === 0\)/, 'renderWithSize must skip when the container has no dimensions');
  });
});
