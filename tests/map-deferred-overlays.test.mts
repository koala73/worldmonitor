import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural guard for the mobile SVG-map first-paint deferral (#4429) + chunking (#4442).
// The full MapComponent is not instantiated in unit tests (heavy d3/topojson/canvas/DOM) —
// the repo verifies Map.ts behavior via source-structure assertions (see
// globe-default-map-mode.test.mts). Runtime/perf verification is the prod mobile Lighthouse
// re-read (Map-*.js boot scripting + TBT vs the ~1277 ms / ~1.5 s baselines).
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');

describe('mobile SVG map: defer + chunk dynamic overlays off first paint (#4429/#4442)', () => {
  it('declares the one-time + re-entrancy-token flags', () => {
    assert.match(mapSrc, /private initialDynamicRendered = false/);
    assert.match(mapSrc, /private initialDynamicScheduled = false/);
    assert.match(mapSrc, /private dynamicRenderToken = 0/, 'needs the re-entrancy token for the chunked pass');
  });

  it('gates the first dynamic pass behind scheduleAfterFirstPaint → renderInitialDynamicPass with an early return', () => {
    assert.match(
      mapSrc,
      /if \(!this\.initialDynamicRendered\) \{[\s\S]*?if \(!this\.initialDynamicScheduled\) \{[\s\S]*?this\.initialDynamicScheduled = true;[\s\S]*?scheduleAfterFirstPaint\(\(\) => \{ void this\.renderInitialDynamicPass\(\); \}\);[\s\S]*?\}[\s\S]*?return;[\s\S]*?\}/,
      'render() must schedule renderInitialDynamicPass once and return on first render',
    );
  });

  it('first-paint pass builds the dynamic layers CHUNKED (off critical path, sub-50ms tasks)', () => {
    assert.match(
      mapSrc,
      /private async renderInitialDynamicPass\(\): Promise<void> \{[\s\S]*?this\.initialDynamicRendered = true;[\s\S]*?await this\.renderDynamicLayers\(width, height, true\);/,
      'renderInitialDynamicPass must set the flag and await the chunked renderDynamicLayers',
    );
  });

  it('renderDynamicLayers yields between layers when chunking and bails when superseded', () => {
    assert.match(mapSrc, /private async renderDynamicLayers\(width: number, height: number, chunk = false\): Promise<void>/);
    assert.match(
      mapSrc,
      /for \(let i = 0; i < steps\.length; i\+\+\) \{[\s\S]*?if \(chunk && \(this\.destroyed \|\| token !== this\.dynamicRenderToken\)\) return;[\s\S]*?steps\[i\]\?\.\(\);[\s\S]*?if \(chunk && i < steps\.length - 1\) await yieldToMain\(\);/,
      'the layer loop must yield between steps when chunking, skip the final yield, and bail on token mismatch / destroy',
    );
  });

  it('steady-state render() builds the dynamic layers synchronously (no chunking on interactions)', () => {
    assert.match(
      mapSrc,
      /Steady state[\s\S]*?void this\.renderDynamicLayers\(width, height\);/,
      'post-first-paint render() must call renderDynamicLayers without the chunk flag (synchronous)',
    );
  });

  it('keeps the base layer (countries) synchronous — rendered BEFORE the defer gate (LCP-critical)', () => {
    const baseIdx = mapSrc.indexOf('this.renderCountries(this.baseLayerGroup');
    const gateIdx = mapSrc.indexOf('if (!this.initialDynamicRendered)');
    assert.ok(baseIdx > 0 && gateIdx > 0);
    assert.ok(baseIdx < gateIdx, 'renderCountries (base/LCP) must run before the dynamic-defer gate');
  });

  it('guards render() and the deferred pass against running on a destroyed instance', () => {
    assert.match(mapSrc, /private destroyed = false/);
    assert.match(mapSrc, /public render\(\): void \{\s*\n\s*if \(this\.destroyed\) return;/);
    assert.match(mapSrc, /private async renderInitialDynamicPass\(\): Promise<void> \{\s*\n\s*if \(this\.destroyed \|\| !this\.svg\) return;/);
  });

  it('uses layout batching for scheduled map renders and the post-load layout retry', () => {
    assert.match(mapSrc, /import { measure, mutate } from '@\/utils\/layout-batch';/);
    assert.equal(
      mapSrc.includes('requestAnimationFrame(() => requestAnimationFrame(() => this.render()))'),
      false,
      'post-load layout retry must not use an ad hoc double-rAF render',
    );

    const scheduleStart = mapSrc.indexOf('public scheduleRender(): void');
    const scheduleEnd = mapSrc.indexOf('  private readContainerSize', scheduleStart);
    assert.ok(scheduleStart > 0 && scheduleEnd > scheduleStart, 'scheduleRender block should be present');
    const scheduleBlock = mapSrc.slice(scheduleStart, scheduleEnd);
    assert.ok(scheduleBlock.includes('measure(() => {'), 'scheduled render must read inside measure()');
    assert.ok(scheduleBlock.includes('const { width, height } = this.readContainerSize();'));
    assert.ok(scheduleBlock.includes('mutate(() => {'), 'scheduled render must write/render inside mutate()');
    assert.ok(scheduleBlock.includes('this.renderWithSize(width, height);'));
    assert.ok(scheduleBlock.includes('this.renderScheduled = false;'));

    const renderWithSizeStart = mapSrc.indexOf('private renderWithSize(width: number, height: number): void');
    const renderWithSizeEnd = mapSrc.indexOf('  private renderGrid', renderWithSizeStart);
    assert.ok(renderWithSizeStart > 0 && renderWithSizeEnd > renderWithSizeStart, 'renderWithSize block should be present');
    const renderWithSizeBlock = mapSrc.slice(renderWithSizeStart, renderWithSizeEnd);
    assert.equal(
      renderWithSizeBlock.includes('if (this.renderScheduled) this.renderScheduled = false;'),
      false,
      'direct renders must not clear a pending scheduled render dedup flag',
    );
    const loadStart = mapSrc.indexOf('private async loadMapData(): Promise<void>');
    const loadEnd = mapSrc.indexOf('  private initClusterRenderer', loadStart);
    assert.ok(loadStart > 0 && loadEnd > loadStart, 'loadMapData block should be present');
    const loadBlock = mapSrc.slice(loadStart, loadEnd);
    assert.ok(loadBlock.includes('this.render();'));
    assert.ok(loadBlock.includes('this.scheduleRender();'));
    assert.ok(loadBlock.indexOf('this.render();') < loadBlock.indexOf('this.scheduleRender();'));
  });

  it('uses cached first-paint dynamic dimensions without an extra frame', () => {
    assert.equal(mapSrc.includes('private measureContainerSize(): Promise'), false);

    const initialPassStart = mapSrc.indexOf('private async renderInitialDynamicPass(): Promise<void>');
    const initialPassEnd = mapSrc.indexOf('  private renderGrid', initialPassStart);
    const initialPassBlock = mapSrc.slice(initialPassStart, initialPassEnd);
    assert.ok(initialPassBlock.includes('const { width, height } = this.getKnownContainerSize();'));
    assert.equal(initialPassBlock.includes('await this.measureContainerSize()'), false);
    assert.ok(initialPassBlock.includes('if (this.destroyed) return;'));
    assert.ok(initialPassBlock.includes('if (width === 0 || height === 0) return;'));
    assert.ok(
      initialPassBlock.indexOf('if (width === 0 || height === 0) return;') < initialPassBlock.indexOf('this.initialDynamicRendered = true;'),
      'initialDynamicRendered should flip only after size/destroyed checks',
    );
    assert.ok(initialPassBlock.includes('await this.renderDynamicLayers(width, height, true);'));
  });

  it('builds HTML overlays in a document fragment before appending once', () => {
    assert.match(mapSrc, /private overlayAppendTarget: ParentNode \| null = null/);
    const appendStart = mapSrc.indexOf('private appendOverlay(node: Node): void');
    const appendEnd = mapSrc.indexOf('  public render(): void', appendStart);
    const appendBlock = mapSrc.slice(appendStart, appendEnd);
    assert.ok(appendBlock.includes('(this.overlayAppendTarget ?? this.overlays).appendChild(node);'));

    const overlaysStart = mapSrc.indexOf('private renderOverlays(projection: d3.GeoProjection): void');
    const overlaysEnd = mapSrc.indexOf('  private renderConflictEventMarkers', overlaysStart);
    assert.ok(overlaysStart > 0 && overlaysEnd > overlaysStart, 'renderOverlays block should be present');
    const overlaysBlock = mapSrc.slice(overlaysStart, overlaysEnd);
    assert.ok(overlaysBlock.includes('this.labelVisibilityScheduled = false;'));
    assert.ok(
      overlaysBlock.indexOf('this.labelVisibilityScheduled = false;') < overlaysBlock.indexOf('const fragment = document.createDocumentFragment();'),
      'overlay rebuild should clear stale label visibility scheduling before new labels are appended',
    );
    assert.ok(overlaysBlock.includes('const fragment = document.createDocumentFragment();'));
    assert.ok(overlaysBlock.includes('this.overlayAppendTarget = fragment;'));
    assert.ok(overlaysBlock.includes('this.overlayAppendTarget = previousTarget;'));
    assert.ok(overlaysBlock.includes('this.overlays.appendChild(fragment);'));
    assert.ok(overlaysBlock.includes('try {'));
    assert.ok(overlaysBlock.includes('} finally {'));
  });


  it("reuses remembered container size for transform math", () => {
    assert.match(mapSrc, /private lastContainerSize = \{ width: 0, height: 0 \}/);
    const helperStart = mapSrc.indexOf("private getKnownContainerSize():");
    const helperEnd = mapSrc.indexOf("  private appendOverlay", helperStart);
    assert.ok(helperStart > 0 && helperEnd > helperStart, "container size cache helper should be present");
    const helperBlock = mapSrc.slice(helperStart, helperEnd);
    assert.ok(helperBlock.includes("this.lastContainerSize.width > 0"));
    assert.ok(helperBlock.includes("this.readContainerSize()"));

    const resizeStart = mapSrc.indexOf("private setupResizeObserver(): void");
    const resizeEnd = mapSrc.indexOf("  public setIsResizing", resizeStart);
    assert.ok(resizeStart > 0 && resizeEnd > resizeStart, "resize observer block should be present");
    const resizeBlock = mapSrc.slice(resizeStart, resizeEnd);
    assert.ok(resizeBlock.includes("this.rememberContainerSize({ width, height });"));
    assert.ok(
      resizeBlock.indexOf("this.rememberContainerSize({ width, height });") < resizeBlock.indexOf("this.scheduleRender();"),
      "ResizeObserver should refresh cached dimensions before scheduling render",
    );

    const transformStart = mapSrc.indexOf("private applyTransform(rebuildOnZoomVisibilityChange = true): void");
    const transformEnd = mapSrc.indexOf("  private updateLabelVisibility", transformStart);
    assert.ok(transformStart > 0 && transformEnd > transformStart, "applyTransform block should be present");
    const transformBlock = mapSrc.slice(transformStart, transformEnd);
    assert.ok(transformBlock.includes("const { width, height } = this.getKnownContainerSize();"));
    assert.ok(transformBlock.includes("this.clampPan(width, height);"));
    assert.equal(transformBlock.includes("this.container.clientWidth"), false);
    assert.equal(transformBlock.includes("this.container.clientHeight"), false);
  });

  it('splits label collision reads and opacity writes across layout batch phases', () => {
    assert.match(mapSrc, /private labelVisibilityScheduled = false/);
    const updateStart = mapSrc.indexOf('private updateLabelVisibility(zoom: number): void');
    const measureStart = mapSrc.indexOf('private measureLabelVisibility()', updateStart);
    const applyStart = mapSrc.indexOf('private applyLabelVisibility', measureStart);
    assert.ok(updateStart > 0 && measureStart > updateStart && applyStart > measureStart, 'label visibility helpers should be split');
    const updateBlock = mapSrc.slice(updateStart, measureStart);
    const measureBlock = mapSrc.slice(measureStart, applyStart);
    const applyBlock = mapSrc.slice(applyStart, mapSrc.indexOf('  public onHotspotClicked', applyStart));
    assert.ok(updateBlock.includes('measure(() => {'));
    assert.ok(updateBlock.includes('const labelRects = this.measureLabelVisibility();'));
    assert.ok(updateBlock.includes('mutate(() => {'));
    assert.ok(updateBlock.includes('this.applyLabelVisibility(labelRects, measuredZoom);'));
    assert.ok(measureBlock.includes('el.getBoundingClientRect()'));
    assert.equal(measureBlock.includes('style.opacity'), false, 'measurement phase must not write opacity');
    assert.ok(applyBlock.includes('el.style.opacity'));
  });
});
