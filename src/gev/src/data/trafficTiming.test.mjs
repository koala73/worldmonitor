import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getTrafficTimingDiagnostics } from './traffic.js';

const SOURCE = readFileSync(new URL('./traffic.js', import.meta.url), 'utf8');

function functionBody(name) {
  const declaration = `function ${name}(`;
  const start = SOURCE.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist`);
  const signatureStart = SOURCE.indexOf('(', start);
  let signatureDepth = 0;
  let signatureEnd = -1;
  for (let i = signatureStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '(') signatureDepth++;
    if (SOURCE[i] === ')' && --signatureDepth === 0) {
      signatureEnd = i;
      break;
    }
  }
  assert.notEqual(signatureEnd, -1, `${name} signature must terminate`);
  const open = SOURCE.indexOf('{', signatureEnd);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < SOURCE.length; i++) {
    const char = SOURCE[i];
    const next = SOURCE[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return SOURCE.slice(open + 1, i);
  }
  throw new Error(`unterminated ${name} body`);
}

function canonicalSemanticBody(body) {
  return body
    .replace(/\/\* TRACE_ONLY_BEGIN \*\/[\s\S]*?\/\* TRACE_ONLY_END \*\//g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
    .replace(
      'if(!overpassData||!overpassData.elements){return[];}',
      'if(!overpassData||!overpassData.elements)return[];',
    );
}

function traceOnlyBlocks(body) {
  return [...body.matchAll(
    /\/\* TRACE_ONLY_BEGIN \*\/([\s\S]*?)\/\* TRACE_ONLY_END \*\//g,
  )].map((match) => match[1]);
}

function eventChannel() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    removeEventListener(listener) {
      listeners.delete(listener);
    },
    raise() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

test('traffic timing stays inert when the DEV flag is off under bare Node', () => {
  assert.deepEqual(getTrafficTimingDiagnostics(), {
    enabled: false,
    marksInstalled: 0,
    traceObjectsCreated: 0,
    uncorrelatedTracesDropped: 0,
  });
  assert.equal(
    performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith('traffic:')).length,
    0,
  );
});

test('traffic timing pairs real ordering to the scheduling change and guards re-arms', async () => {
  const { createServer } = await import('vite');
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const timeouts = new Map();
  let timerId = 0;
  let server;
  let trafficLayer;
  let viewer;

  const pendingDebounce = () => {
    const matches = [...timeouts].filter(([, timer]) => timer.delay === 320);
    assert.equal(matches.length, 1, 'exactly one traffic debounce must be pending');
    return matches[0];
  };

  const runDebouncedLoad = async () => {
    const match = pendingDebounce();
    const [id, timer] = match;
    timeouts.delete(id);
    await timer.callback();
  };

  try {
    globalThis.window = {
      location: { search: '?trafficDebug=1' },
      addEventListener() {},
    };
    server = await createServer({
      root: fileURLToPath(new URL('../..', import.meta.url)),
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [{
        name: 'traffic-timing-test-hooks',
        transform(code, id) {
          if (!id.endsWith('/src/data/traffic.js')) return null;
          return `${code}\nexport const __trafficTimingTestHooks = {\n` +
            `  currentAnchor: () => _trafficTimingCurrentAnchor,\n};\n`;
        },
      }],
    });
    const traffic = await server.ssrLoadModule('/src/data/traffic.js');
    trafficLayer = traffic.default;

    globalThis.document = { documentElement: { dataset: {} } };
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (String(url).includes('/api/gev/tomtom/status')
        ? { hasKey: false }
        : { elements: [] }),
    });
    globalThis.setTimeout = (callback, delay) => {
      const id = ++timerId;
      timeouts.set(id, { callback, delay });
      return id;
    };
    globalThis.clearTimeout = (id) => timeouts.delete(id);
    globalThis.setInterval = () => ++timerId;
    globalThis.clearInterval = () => {};
    console.log = () => {};
    console.warn = () => {};

    const preRender = eventChannel();
    const postRender = eventChannel();
    const moveEnd = eventChannel();
    const changed = eventChannel();
    let longitude = -97.74;
    const camera = {
      moveEnd,
      changed,
      percentageChanged: 0.5,
      positionCartographic: { latitude: Math.PI / 6, longitude: 0, height: 5000 },
      computeViewRectangle() {
        const west = longitude * Math.PI / 180;
        return {
          south: 30 * Math.PI / 180,
          west,
          north: 30.02 * Math.PI / 180,
          east: west + 0.02 * Math.PI / 180,
        };
      },
    };
    const setLongitude = (next) => {
      longitude = next;
      camera.positionCartographic.longitude = next * Math.PI / 180;
    };
    setLongitude(longitude);
    viewer = {
      camera,
      scene: {
        canvas: { clientWidth: 0, clientHeight: 0, width: 0, height: 0 },
        preRender,
        postRender,
        primitives: { add: (primitive) => primitive, remove: () => true },
      },
    };

    performance.clearMarks();
    performance.clearMeasures();
    trafficLayer.init(viewer);
    performance.mark('traffic:stale:mark');
    performance.measure('traffic:stale:measure', {
      start: 'traffic:stale:mark',
      end: 'traffic:stale:mark',
    });
    trafficLayer.enable(viewer);
    assert.equal(traffic.getTrafficTimingDiagnostics().marksInstalled, 1);
    assert.equal(moveEnd.listenerCount(), 1, 'marksInstalled must represent a live listener');
    assert.equal(performance.getEntriesByName('traffic:stale:mark').length, 0);
    assert.equal(performance.getEntriesByName('traffic:stale:measure').length, 0);

    // Real Cesium ordering: changed arms the 320 ms debounce, its load fires,
    // and moveEnd arrives only after cameraEventWaitTime (~500 ms).
    setLongitude(-97.72);
    changed.raise();
    const anchorA = traffic.__trafficTimingTestHooks.currentAnchor();
    const anchorMarkA = performance.getEntriesByType('mark').find((entry) => (
      entry.detail?.segment === 'last-camera-change'
      && entry.detail?.interactionId === anchorA.interactionId
    ));
    assert.ok(anchorMarkA, 'the scheduling camera change must be marked');
    assert.equal(anchorMarkA.startTime, anchorA.timestamp);
    await runDebouncedLoad();
    assert.deepEqual(traffic.getTrafficTimingDiagnostics(), {
      enabled: true,
      marksInstalled: 1,
      traceObjectsCreated: 1,
      uncorrelatedTracesDropped: 0,
    });
    assert.equal(traffic.__trafficTimingTestHooks.currentAnchor(), null);
    const fetchFromA = performance.getEntriesByType('measure').find((entry) => (
      entry.detail?.segment === 'last-camera-change-to-fetch-start'
      && entry.detail?.interactionId === anchorA.interactionId
    ));
    assert.ok(fetchFromA, 'the load must pair to A without waiting for moveEnd');
    assert.equal(fetchFromA.startTime, anchorA.timestamp);
    assert.equal(fetchFromA.detail.cameraChangeTimestamp, anchorA.timestamp);

    moveEnd.raise();
    const diagnosticMoveEnd = performance.getEntriesByType('mark').find((entry) => (
      entry.detail?.segment === 'camera-move-end'
    ));
    assert.ok(diagnosticMoveEnd, 'the late moveEnd diagnostic mark must still be emitted');
    assert.equal(diagnosticMoveEnd.detail.diagnosticOnly, true);
    assert.equal(diagnosticMoveEnd.detail.fetchWaitsForMoveEnd, false);
    assert.ok(
      diagnosticMoveEnd.startTime >= fetchFromA.startTime + fetchFromA.duration,
      'the real-ordering pin requires fetch-start to precede late moveEnd',
    );

    // Re-arm B with C before B fires. clearTimeout cancels B in normal event-
    // loop ordering; invoking the saved callback models an already-queued race
    // and must count one drop without consuming C's current anchor.
    setLongitude(-97.70);
    changed.raise();
    const anchorB = traffic.__trafficTimingTestHooks.currentAnchor();
    const [timerBId, timerB] = pendingDebounce();
    setLongitude(-97.68);
    changed.raise();
    const anchorC = traffic.__trafficTimingTestHooks.currentAnchor();
    assert.notEqual(anchorC.interactionId, anchorB.interactionId);
    assert.equal(timeouts.has(timerBId), false, 'the ordinary debounce path must cancel B');
    await timerB.callback();
    assert.equal(
      traffic.__trafficTimingTestHooks.currentAnchor().interactionId,
      anchorC.interactionId,
      'a stale callback must not consume the newer C anchor',
    );
    await runDebouncedLoad();

    assert.deepEqual(traffic.getTrafficTimingDiagnostics(), {
      enabled: true,
      marksInstalled: 1,
      traceObjectsCreated: 2,
      uncorrelatedTracesDropped: 1,
    });
    assert.ok(performance.getEntriesByType('measure').some((entry) => (
      entry.detail?.interactionId === anchorC.interactionId
    )));
    assert.ok(performance.getEntriesByType('measure').every((entry) => (
      entry.detail?.interactionId !== anchorB.interactionId
    )), 'the canceled/stale B load must never emit a correlated trace');
  } finally {
    trafficLayer?.disable(viewer);
    await server?.close();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    console.log = originalLog;
    console.warn = originalWarn;
    performance.clearMarks();
    performance.clearMeasures();
  }
});

test('the timed parser stays source-equivalent to the production parser', () => {
  assert.equal(
    canonicalSemanticBody(functionBody('parseRoadsTimed')),
    canonicalSemanticBody(functionBody('parseRoads')),
    'parseRoadsTimed may add only TRACE_ONLY blocks; production operations and order must match',
  );

  const traceBlocks = traceOnlyBlocks(functionBody('parseRoadsTimed'));
  assert.ok(traceBlocks.length > 0, 'parseRoadsTimed must retain explicit trace-only blocks');
  const traceSource = traceBlocks.join('\n');
  // This is deliberately a reasonable lexical tripwire, not an AST proof: it
  // recognizes direct assignments and common mutator calls, but cannot prove
  // safety through aliases or computed properties. Source equivalence above
  // remains the independent operation-order backstop.
  const assignedIdentifiers = [...traceSource.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--|\+=|-=|\*=|\/=|%=|=(?!=|>))/g,
  )].map((match) => match[1]);
  const mutatedIdentifiers = [...traceSource.matchAll(
    /\b([A-Za-z_$][\w$]*)\.(?:add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse|copyWithin|fill)\s*\(/g,
  )].map((match) => match[1]);
  const unsafeWrites = [...assignedIdentifiers, ...mutatedIdentifiers]
    .filter((identifier) => identifier !== 'trace' && !identifier.startsWith('_trafficTiming'));
  assert.deepEqual(
    unsafeWrites,
    [],
    'TRACE_ONLY blocks may write only trace or _trafficTiming* instrumentation state',
  );
  assert.doesNotMatch(
    traceSource,
    /\b(?:roads|coords|waypoints|segmentDist)\s*(?:\.(?:add|delete|clear|set|push|pop|shift|unshift|splice|sort|reverse|copyWithin|fill)\s*\(|\+\+|--|\+=|-=|\*=|\/=|%=|=(?!=|>))/,
    'TRACE_ONLY blocks must not mutate parser production collections',
  );

  assert.doesNotMatch(SOURCE, /function fetchRoadsTimed\s*\(/);
  assert.doesNotMatch(SOURCE, /function renderRoadsForAltitudeTimed\s*\(/);
  const fetchBody = canonicalSemanticBody(functionBody('fetchRoads'));
  assert.equal(fetchBody.includes('response.text()'), false);
  assert.equal(fetchBody.includes('JSON.parse('), false);
  const okCheck = fetchBody.indexOf('if(!response.ok)');
  const responseJson = fetchBody.indexOf('response.json()');
  assert.notEqual(okCheck, -1);
  assert.notEqual(responseJson, -1);
  assert.ok(okCheck < responseJson);
});
