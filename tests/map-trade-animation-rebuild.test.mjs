/**
 * Source characterization for #7781: decorative trade animation still rebuilds
 * the full layer stack every eligible frame. Isolation is conditional on a
 * measured budget miss; these tests pin the current path so the profile can
 * attribute that cost.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');
const harnessSrc = readFileSync(resolve(__dirname, '../src/e2e/map-harness.ts'), 'utf-8');

function previousSignificantChar(source, index) {
  for (let i = index - 1; i >= 0; i--) {
    const ch = source[i];
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

function canStartRegex(source, index) {
  return !/[)\]\w$]/.test(previousSignificantChar(source, index));
}

function findMatchingBrace(source, braceStart) {
  let depth = 0;
  let state = 'code';
  let regexCharClass = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (
        (state === 'single-quote' && ch === "'")
        || (state === 'double-quote' && ch === '"')
        || (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (state === 'regex') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '[') regexCharClass = true;
      else if (ch === ']') regexCharClass = false;
      else if (ch === '/' && !regexCharClass) state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line-comment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single-quote';
      continue;
    }
    if (ch === '"') {
      state = 'double-quote';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      continue;
    }
    if (ch === '/' && canStartRegex(source, i)) {
      state = 'regex';
      regexCharClass = false;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function methodSource(name) {
  const start = deckGlMapSrc.indexOf(name);
  assert.ok(start >= 0, `${name} must exist`);
  const braceStart = deckGlMapSrc.indexOf('{', start);
  assert.ok(braceStart > start, `${name} must have a body`);
  const end = findMatchingBrace(deckGlMapSrc, braceStart);
  assert.ok(end > braceStart, `${name} body must have balanced braces`);
  return deckGlMapSrc.slice(start, end);
}

describe('trade animation still full-rebuilds (#7781 characterization)', () => {
  it('calls render() from the animation tick, and render() always rebuilds via updateLayers', () => {
    const startTradeAnimation = methodSource('private startTradeAnimation');
    assert.match(
      startTradeAnimation,
      /shouldRenderTradeAnimationFrame[\s\S]*this\.render\(\)/,
      'animation ticks must still call the full render() path',
    );
    const render = methodSource('public render');
    assert.match(render, /this\.updateLayers\(\)/, 'render() must still schedule updateLayers()');
    const updateLayers = methodSource('private updateLayers');
    assert.match(updateLayers, /this\.buildLayers\(!deferred\)/, 'updateLayers must rebuild the full stack');
    assert.match(updateLayers, /this\.deckOverlay\?\.setProps\(\{\s*layers:\s*built\s*\}\)/, 'updateLayers must commit every layer array');
  });

  it('does not cache nuclear or data-center layer instances across animation frames', () => {
    const nuclear = methodSource('private createNuclearLayer');
    const datacenters = methodSource('private createDatacentersLayer');
    assert.match(nuclear, /return new IconLayer/);
    assert.match(datacenters, /return new IconLayer/);
    assert.equal(nuclear.includes('layerCache'), false, 'nuclear layer must not use layerCache');
    assert.equal(datacenters.includes('layerCache'), false, 'datacenter layer must not use layerCache');
  });

  it('keeps the Wave 1 hint-scan guard on the animation rebuild path', () => {
    const updateLayers = methodSource('private updateLayers');
    const updateZoomHints = methodSource('private updateZoomHints');
    assert.match(updateLayers, /this\.updateZoomHints\(\)/);
    assert.match(updateZoomHints, /this\.zoomHintGuard\.shouldScan/);
  });

  it('exposes a settled-harness profiler for the reproducible before/after command', () => {
    assert.match(harnessSrc, /runTradeAnimationProfile/);
    assert.match(harnessSrc, /TRADE_ANIMATION_PROFILE_LAYERS/);
    assert.match(harnessSrc, /nuclearIdentityChanged/);
    assert.match(harnessSrc, /deckCommitMs/);
    assert.match(
      harnessSrc,
      /layerManagerPrototype\.updateLayers/,
      'profiler must time LayerManager.updateLayers, not only overlay.setProps',
    );
  });
});

import ts from 'typescript';
import { runInNewContext } from 'node:vm';

it('profiles a sealed layer manager without consuming hint invalidation or counting flush frames', async () => {
  const source = ts.createSourceFile('harness.ts', harnessSrc, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((d) => d.name.getText(source) === 'runTradeAnimationProfile'));
  const js = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let clock = 0;
  let active = false;
  let invalidated = true;
  let controlUpdates = 0;
  let deckUpdates = 0;
  class Manager { updateLayers() { deckUpdates++; clock += 3; } }
  const manager = Object.seal(new Manager());
  const originalDeckUpdate = Manager.prototype.updateLayers;
  const guard = { shouldScan() { const result = invalidated; invalidated = false; return result; } };
  const originalGuard = guard.shouldScan;
  const map = {
    deckOverlay: { _deck: { layerManager: manager } }, zoomHintGuard: guard,
    tradeTrips: [], tradeRouteSegments: [],
    setProtests() {}, updateHotspotActivity() {}, setNewsLocations() {}, setRenderPaused() {},
    render() { active = true; }, stopTradeAnimation() { active = false; },
    buildLayers() { clock += 2; return [{ id: 'nuclear-layer' }, { id: 'trade-route-trips-layer' }]; },
    updateZoomHints() { if (guard.shouldScan({}, {})) controlUpdates++; },
    updateLayers() { this.buildLayers(); this.updateZoomHints(); clock += 1; },
  };
  const originalUpdate = map.updateLayers;
  const profile = runInNewContext(js + '; runTradeAnimationProfile', {
    map, internals: {}, performance: { now: () => clock },
    TRADE_ANIMATION_PROFILE_LAYERS: ['nuclear', 'tradeRoutes'], SEEDED_NEWS_LOCATIONS: [],
    setLayersForSnapshot() {}, setCamera() {}, makeNewsLocationsNonRecent() {},
    getDeckLayerSnapshot: () => [], getLayerDataCount: () => 0, readGlRenderer: () => 'Fixture GPU',
    waitAnimationFrames: async (count, callback) => {
      for (let i = 0; i < count; i++) {
        if (active) { invalidated = true; map.updateLayers(); manager.updateLayers(); }
        clock += 17;
        callback?.(clock);
      }
    },
  });
  const result = await profile({ warmupFrames: 2, displayFrames: 5 });
  assert.equal(result.buildCount, 5);
  assert.equal(result.samples.length, 5);
  assert.equal(result.hintScanCount, 5);
  assert.equal(controlUpdates, 7, 'one actual hint update per invalidation, including warmup');
  assert.equal(deckUpdates, 7, 'flush frames must not generate new animation updates');
  assert.equal(result.samples[0].jsBuildMs, 2);
  assert.equal(result.samples[0].updateLayersMs, 3);
  assert.equal(result.samples[0].deckCommitMs, 3);
  assert.equal(result.samples[0].totalMs, 6);
  assert.equal(Manager.prototype.updateLayers, originalDeckUpdate);
  assert.equal(guard.shouldScan, originalGuard);
  assert.equal(map.updateLayers, originalUpdate);
});
