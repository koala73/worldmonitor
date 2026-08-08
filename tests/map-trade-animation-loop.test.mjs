import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deckGlMapSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');

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
        (state === 'single-quote' && ch === "'") ||
        (state === 'double-quote' && ch === '"') ||
        (state === 'template' && ch === '`')
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
  if (end > braceStart) return deckGlMapSrc.slice(start, end);
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

function referenceStableTradeRoutePhase(routeId, cycle) {
  let hash = 2166136261;
  for (let i = 0; i < routeId.length; i++) {
    const codeUnit = routeId.charCodeAt(i);
    hash ^= codeUnit & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (codeUnit >> 8) & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0x100000000) * cycle;
}

describe('source extraction helper', () => {
  it('ignores braces inside comments, strings, templates, and regex literals', () => {
    const source = `
      function sample() {
        const a = '{';
        const b = "}";
        const c = \`template \${value} still has braces\`;
        const d = /[{}]/;
        /* } */
        // {
        if (a) { return d; }
      }
      function after() { return false; }
    `;
    const start = source.indexOf('function sample');
    const braceStart = source.indexOf('{', start);
    const end = findMatchingBrace(source, braceStart);
    const extracted = source.slice(start, end);

    assert.ok(extracted.includes('return d;'), 'must include the full target method body');
    assert.ok(!extracted.includes('function after'), 'must stop at the target method closing brace');
  });
});

describe('trade-route animation phase stability', () => {
  it('derives each dot phase deterministically from route id', () => {
    const { stableTradeRoutePhase, TRADE_ANIMATION_CYCLE } = extractStableTradeRoutePhase();
    const phaseA = stableTradeRoutePhase('asia-europe-container');
    const phaseB = stableTradeRoutePhase('asia-europe-container');
    const phaseC = stableTradeRoutePhase('gulf-energy-route');
    const unicodeRouteId = 'são-tomé-route';

    assert.equal(phaseA, phaseB, 'same route id must keep the same phase across rebuilds');
    assert.ok(phaseA >= 0 && phaseA < TRADE_ANIMATION_CYCLE, 'phase must stay inside the animation cycle');
    assert.notEqual(phaseA, phaseC, 'different route ids should not collapse to the same phase');
    assert.equal(
      stableTradeRoutePhase(unicodeRouteId),
      referenceStableTradeRoutePhase(unicodeRouteId, TRADE_ANIMATION_CYCLE),
      'route phase hash must process each UTF-16 code unit as bytes',
    );
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

  it('cancels the trade rAF inside the pause branch and restarts it only on resume', () => {
    const setRenderPaused = methodSource('public setRenderPaused');
    const pauseIdx = setRenderPaused.indexOf('if (paused)');
    assert.ok(pauseIdx >= 0, 'setRenderPaused must have an if (paused) branch');
    const pauseBraceStart = setRenderPaused.indexOf('{', pauseIdx);
    const pauseBlockEnd = findMatchingBrace(setRenderPaused, pauseBraceStart);
    const pauseBlock = setRenderPaused.slice(pauseBraceStart, pauseBlockEnd);
    const resumePath = setRenderPaused.slice(pauseBlockEnd);

    assert.ok(
      /this\.stopTradeAnimation\(\)/.test(pauseBlock),
      'pause branch must cancel trade animation frames',
    );
    assert.ok(
      !/this\.stopTradeAnimation\(\)/.test(resumePath),
      'stopTradeAnimation must live inside the pause branch, not the resume path',
    );
    assert.ok(
      !/this\.startTradeAnimation\(\)/.test(pauseBlock),
      'pause branch must not start the trade animation',
    );
    assert.match(
      resumePath,
      /if\s*\(this\.state\.layers\.tradeRoutes\)\s*this\.startTradeAnimation\(\)/,
      'resume path must restart trade animation only when the layer is enabled',
    );
  });

  it('guards startTradeAnimation against running while render is paused', () => {
    const startTradeAnimation = methodSource('private startTradeAnimation');
    assert.match(
      startTradeAnimation,
      /if\s*\(this\.renderPaused\s*\|\|\s*this\.prefersReducedTradeMotion\(\)\)\s*return/,
      'startTradeAnimation must bail when render is paused or reduced motion is preferred',
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

  it('resets the frame counter on stop so restart parity is deterministic', () => {
    const stopTradeAnimation = methodSource('private stopTradeAnimation');
    assert.match(
      stopTradeAnimation,
      /this\.tradeAnimationFrameCount\s*=\s*0/,
      'stopTradeAnimation must reset tradeAnimationFrameCount so the every-other-frame render gate restarts deterministically',
    );
  });

  it('bails out of an in-flight animation frame once the map is destroyed', () => {
    const startTradeAnimation = methodSource('private startTradeAnimation');
    assert.match(
      startTradeAnimation,
      /if\s*\(this\.destroyed\)\s*{\s*this\.tradeAnimationFrame\s*=\s*null;\s*return;/,
      'the animate loop must stop rescheduling once destroyed',
    );
  });

  it('reacts to live prefers-reduced-motion changes', () => {
    const handler = methodSource('private readonly handleTradeMotionPreferenceChange');
    assert.match(
      handler,
      /if\s*\(this\.prefersReducedTradeMotion\(\)\)\s*{\s*this\.stopTradeAnimation\(\)/,
      'handler must stop the animation when reduced motion becomes preferred',
    );
    assert.match(
      handler,
      /else if\s*\(this\.state\.layers\.tradeRoutes\s*&&\s*!this\.renderPaused\)\s*{\s*this\.startTradeAnimation\(\)/,
      'handler must restart the animation only when the layer is enabled and render is not paused',
    );
    assert.ok(
      /this\.render\(\)/.test(handler),
      'handler must re-render so the trips layer is added/removed for the new preference',
    );
  });

  it('removes the prefers-reduced-motion listener on destroy', () => {
    const destroy = methodSource('public destroy');
    assert.match(
      destroy,
      /this\.tradeReducedMotionMedia\?\.removeEventListener\(\s*'change'\s*,\s*this\.handleTradeMotionPreferenceChange\s*\)/,
      'destroy must remove the prefers-reduced-motion change listener to avoid a zombie handler',
    );
    assert.ok(
      /this\.tradeReducedMotionMedia\s*=\s*null/.test(destroy),
      'destroy must drop the cached MediaQueryList reference',
    );
  });
});
