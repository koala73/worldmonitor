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
