import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');

function methodSource(name) {
  const start = deckGlMapSrc.indexOf(name);
  assert.ok(start >= 0, `${name} must exist`);
  const braceStart = deckGlMapSrc.indexOf('{', start);
  assert.ok(braceStart > start, `${name} must have a body`);
  let depth = 0;
  for (let i = braceStart; i < deckGlMapSrc.length; i++) {
    const ch = deckGlMapSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return deckGlMapSrc.slice(start, i + 1);
    }
  }
  assert.fail(`${name} body must have balanced braces`);
}

function extractStableTradeRoutePhase() {
  const constantsStart = deckGlMapSrc.indexOf('const TRADE_ANIMATION_CYCLE');
  assert.ok(constantsStart >= 0, 'TRADE_ANIMATION_CYCLE must exist');
  const constantsEnd = deckGlMapSrc.indexOf('const CHOKEPOINT_PULSE_FREQ', constantsStart);
  assert.ok(constantsEnd > constantsStart, 'trade animation constants must stay grouped before chokepoint constants');
  const helper = methodSource('function stableTradeRoutePhase');
  const js = `${deckGlMapSrc.slice(constantsStart, constantsEnd)}\n${helper}`
    .replace(/function stableTradeRoutePhase\(routeId: string\): number/, 'function stableTradeRoutePhase(routeId)');
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn { stableTradeRoutePhase, TRADE_ANIMATION_CYCLE };`)();
}

describe('trade-route animation phase stability', () => {
  it('derives each dot phase deterministically from route id', () => {
    const { stableTradeRoutePhase, TRADE_ANIMATION_CYCLE } = extractStableTradeRoutePhase();
    const phaseA = stableTradeRoutePhase('asia-europe-container');
    const phaseB = stableTradeRoutePhase('asia-europe-container');
    const phaseC = stableTradeRoutePhase('gulf-energy-route');

    assert.equal(phaseA, phaseB, 'same route id must keep the same phase across rebuilds');
    assert.ok(phaseA >= 0 && phaseA < TRADE_ANIMATION_CYCLE, 'phase must stay inside the animation cycle');
    assert.notEqual(phaseA, phaseC, 'different route ids should not collapse to the same phase');
  });

  it('does not recompute phase from route order or current group count', () => {
    const buildTradeTrips = methodSource('private buildTradeTrips');
    assert.ok(
      buildTradeTrips.includes('stableTradeRoutePhase(first.routeId)'),
      'buildTradeTrips must seed phase from the route id',
    );
    assert.ok(
      !/phase:\s*\(\s*routeIndex\s*\//.test(buildTradeTrips),
      'buildTradeTrips must not derive phase from routeIndex / routeGroups.size',
    );
  });
});

describe('trade-route animation loop lifecycle', () => {
  it('does not reset animation time when the rAF loop stops', () => {
    const stopTradeAnimation = methodSource('private stopTradeAnimation');
    assert.ok(
      !/tradeAnimationTime\s*=\s*0/.test(stopTradeAnimation),
      'stopping the rAF loop must preserve tradeAnimationTime so re-enable/resume does not jump',
    );
  });

  it('stops the trade rAF while render is paused and restarts it on resume when enabled', () => {
    const setRenderPaused = methodSource('public setRenderPaused');
    assert.match(
      setRenderPaused,
      /if\s*\(paused\)[\s\S]*this\.stopTradeAnimation\(\)/,
      'pause branch must cancel trade animation frames',
    );
    assert.match(
      setRenderPaused,
      /if\s*\(this\.state\.layers\.tradeRoutes\)\s*this\.startTradeAnimation\(\)/,
      'resume branch must restart trade animation only when the layer is enabled',
    );
  });

  it('clamps background-tab frame deltas before advancing animation time', () => {
    const startTradeAnimation = methodSource('private startTradeAnimation');
    assert.ok(
      deckGlMapSrc.includes('TRADE_ANIMATION_MAX_DELTA_MS'),
      'trade animation must define a maximum frame delta',
    );
    assert.match(
      startTradeAnimation,
      /Math\.min\(now - lastTime,\s*TRADE_ANIMATION_MAX_DELTA_MS\)/,
      'startTradeAnimation must clamp large frame deltas',
    );
  });

  it('invalidates the position accessor when animation time changes', () => {
    const createTradeRouteTripsLayer = methodSource('private createTradeRouteTripsLayer');
    assert.match(
      createTradeRouteTripsLayer,
      /updateTriggers:\s*{\s*getPosition:\s*\[\s*this\.tradeAnimationTime\s*\]\s*}/,
      'trade trip layer must keep getPosition live as deck.gl preserves state by layer id',
    );
  });
});
