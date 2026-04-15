import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract the beforeSend function body from main.ts source.
// We parse it as a standalone function to avoid importing Sentry/App bootstrap.
const mainSrc = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');

// Extract everything between `beforeSend(event) {` and the matching closing `},`
const bsStart = mainSrc.indexOf('beforeSend(event) {');
assert.ok(bsStart !== -1, 'beforeSend must exist in src/main.ts');
let braceDepth = 0;
let bsEnd = -1;
for (let i = bsStart + 'beforeSend(event) '.length; i < mainSrc.length; i++) {
  if (mainSrc[i] === '{') braceDepth++;
  if (mainSrc[i] === '}') {
    braceDepth--;
    if (braceDepth === 0) { bsEnd = i + 1; break; }
  }
}
assert.ok(bsEnd > bsStart, 'Failed to find beforeSend closing brace');
// Strip TypeScript type annotations so the body can be eval'd as plain JS.
const fnBody = mainSrc.slice(bsStart + 'beforeSend(event) '.length, bsEnd)
  .replace(/:\s*string\b/g, '')           // parameter type annotations
  .replace(/as\s+\w+(\[\])?/g, '')        // type assertions
  .replace(/<[A-Z]\w*>/g, '');            // generic type params

// Build a callable version. Input: a Sentry-shaped event object. Returns event or null.
// eslint-disable-next-line no-new-func
const beforeSend = new Function('event', fnBody);

/** Helper to build a minimal Sentry event. */
function makeEvent(value, type = 'Error', frames = []) {
  return {
    exception: {
      values: [{
        type,
        value,
        stacktrace: { frames },
      }],
    },
  };
}

/** Helper for a first-party frame (source-mapped .ts or /assets/ chunk). */
function firstPartyFrame(filename = '/assets/panels-DzUv7BBV.js', fn = 'loadTab') {
  return { filename, lineno: 42, function: fn };
}

/** Helper for a third-party/extension frame. */
function extensionFrame(filename = 'blob:https://example.com/ext-1234', fn = 'inject') {
  return { filename, lineno: 1, function: fn };
}

// ─── P2: firstPartyFile regex covers all Vite chunk patterns ─────────────

describe('first-party file detection', () => {
  // Note: deck-stack is a VENDOR chunk (@deck.gl/@luma.gl), not first-party app code.
  // It is correctly caught by the "entirely within maplibre/deck.gl internals" filter.
  const testPatterns = [
    ['/assets/main-AbC123.js', 'main chunk'],
    ['/assets/panels-DzUv7BBV.js', 'panels chunk'],
    ['/assets/settings-window-A1b2C3.js', 'settings-window chunk'],
    ['/assets/live-channels-window-X9.js', 'live-channels-window chunk'],
    ['/assets/locale-fr-abc123.js', 'locale chunk'],
    ['src/components/DeckGLMap.ts', 'source-mapped .ts'],
    ['src/App.tsx', 'source-mapped .tsx'],
  ];

  for (const [filename, label] of testPatterns) {
    it(`treats ${label} (${filename}) as first-party`, () => {
      // Use a generic ambiguous error that would be suppressed without first-party frames
      const event = makeEvent('.trim is not a function', 'TypeError', [
        { filename, lineno: 10, function: 'doStuff' },
      ]);
      const result = beforeSend(event);
      assert.ok(result !== null, `${filename} should be detected as first-party, event should NOT be suppressed`);
    });
  }

  const vendorChunks = [
    ['/assets/deck-stack-x1y2z3.js', 'deck-stack (vendor)'],
    ['/assets/maplibre-AbC123.js', 'maplibre (vendor)'],
    ['/assets/d3-xyz.js', 'd3 (vendor)'],
    ['/assets/transformers-xyz.js', 'transformers (vendor)'],
    ['/assets/onnxruntime-xyz.js', 'onnxruntime (vendor)'],
  ];

  for (const [filename, label] of vendorChunks) {
    it(`does NOT treat ${label} (${filename}) as first-party`, () => {
      const event = makeEvent('Maximum call stack size exceeded', 'RangeError', [
        { filename, lineno: 10, function: 'doStuff' },
      ]);
      assert.equal(beforeSend(event), null, `${filename} should NOT be treated as first-party`);
    });
  }

  it('filters sentry chunk frames as infrastructure (not even counted as third-party)', () => {
    // Sentry frames are excluded from nonInfraFrames entirely, so a sentry-only stack
    // is treated as empty (no confirming third-party frames, no first-party frames).
    // With the hasAnyStack requirement, the error surfaces.
    const event = makeEvent('Maximum call stack size exceeded', 'RangeError', [
      { filename: '/assets/sentry-AbC123.js', lineno: 10, function: 'captureException' },
    ]);
    const result = beforeSend(event);
    assert.ok(result !== null, 'sentry-only stack should be treated as empty (no suppression)');
  });

  it('does NOT treat blob: URLs as first-party', () => {
    const event = makeEvent('.trim is not a function', 'TypeError', [
      extensionFrame(),
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('does NOT treat anonymous frames as first-party', () => {
    const event = makeEvent('.trim is not a function', 'TypeError', [
      { filename: '<anonymous>', lineno: 1, function: 'eval' },
    ]);
    assert.equal(beforeSend(event), null);
  });
});

// ─── P1: empty-stack behavior for network/timeout errors ─────────────────

describe('empty-stack network/timeout errors are NOT suppressed', () => {
  const networkErrors = [
    'TypeError: Failed to fetch',
    'TypeError: NetworkError when attempting to fetch resource.',
    'Could not connect to the server',
    'Failed to fetch dynamically imported module: https://worldmonitor.app/assets/panels-abc.js',
    'Importing a module script failed.',
    'Operation timed out',
    'signal timed out',
    'Invalid or unexpected token',
  ];

  // SyntaxErrors split by Sentry: type='SyntaxError', value='Unexpected token <'
  const syntaxErrors = [
    ['Unexpected token <', 'SyntaxError'],
    ['Unexpected keyword \'const\'', 'SyntaxError'],
  ];

  for (const msg of networkErrors) {
    it(`lets through "${msg.slice(0, 60)}..." with empty stack`, () => {
      const event = makeEvent(msg, msg.startsWith('SyntaxError') ? 'SyntaxError' : 'TypeError', []);
      const result = beforeSend(event);
      assert.ok(result !== null, `"${msg}" with empty stack should NOT be suppressed (could be our code)`);
    });
  }

  for (const msg of networkErrors) {
    it(`suppresses "${msg.slice(0, 50)}..." with confirmed third-party stack`, () => {
      const event = makeEvent(msg, msg.startsWith('SyntaxError') ? 'SyntaxError' : 'TypeError', [
        extensionFrame(),
      ]);
      assert.equal(beforeSend(event), null, `"${msg}" with extension-only stack should be suppressed`);
    });
  }

  for (const msg of networkErrors) {
    it(`lets through "${msg.slice(0, 50)}..." with first-party stack`, () => {
      const event = makeEvent(msg, msg.startsWith('SyntaxError') ? 'SyntaxError' : 'TypeError', [
        firstPartyFrame(),
      ]);
      const result = beforeSend(event);
      assert.ok(result !== null, `"${msg}" with first-party stack should NOT be suppressed`);
    });
  }

  // Sentry splits SyntaxError into type='SyntaxError' + value='Unexpected token <'
  // The value field never contains the 'SyntaxError:' prefix.
  for (const [value, type] of syntaxErrors) {
    it(`suppresses SyntaxError (split: value="${value}") with third-party stack`, () => {
      const event = makeEvent(value, type, [extensionFrame()]);
      assert.equal(beforeSend(event), null);
    });

    it(`lets through SyntaxError (split: value="${value}") with empty stack`, () => {
      const event = makeEvent(value, type, []);
      assert.ok(beforeSend(event) !== null);
    });

    it(`lets through SyntaxError (split: value="${value}") with first-party stack`, () => {
      const event = makeEvent(value, type, [firstPartyFrame()]);
      assert.ok(beforeSend(event) !== null);
    });
  }
});

// ─── All ambiguous errors require confirmed third-party stack ────────────

describe('ambiguous runtime errors', () => {
  const ambiguousErrors = [
    '.trim is not a function',
    'e.toLowerCase is not a function',
    '.indexOf is not a function',
    'Maximum call stack size exceeded',
    'out of memory',
    'Cannot add property x, object is not extensible',
    'TypeError: Internal error',
    'Key not found',
    'Element not found',
  ];

  // Chrome V8 emits "xy is not a function" without Safari's "(In 'xy(...')" suffix
  it('suppresses Chrome-style "t is not a function" with third-party stack', () => {
    const event = makeEvent('t is not a function', 'TypeError', [extensionFrame()]);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses Safari-style "t is not a function. (In \'t(..." with third-party stack', () => {
    const event = makeEvent("t is not a function. (In 't(1,2)')", 'TypeError', [extensionFrame()]);
    assert.equal(beforeSend(event), null);
  });

  for (const msg of ambiguousErrors) {
    it(`lets through "${msg}" with empty stack (origin unknown)`, () => {
      const event = makeEvent(msg, 'TypeError', []);
      const result = beforeSend(event);
      assert.ok(result !== null, `"${msg}" with empty stack should NOT be suppressed (could be our code)`);
    });
  }

  for (const msg of ambiguousErrors) {
    it(`suppresses "${msg}" with confirmed third-party stack`, () => {
      const event = makeEvent(msg, 'TypeError', [extensionFrame()]);
      assert.equal(beforeSend(event), null, `"${msg}" with extension-only stack should be suppressed`);
    });
  }

  for (const msg of ambiguousErrors) {
    it(`lets through "${msg}" with first-party stack`, () => {
      const event = makeEvent(msg, 'TypeError', [firstPartyFrame()]);
      const result = beforeSend(event);
      assert.ok(result !== null, `"${msg}" with first-party stack should NOT be suppressed`);
    });
  }
});

// ─── Existing filters still work ─────────────────────────────────────────

describe('existing beforeSend filters', () => {
  it('suppresses OrbitControls touch crash even with first-party main chunk frames', () => {
    const event = makeEvent('Cannot read properties of undefined (reading \'x\')', 'TypeError', [
      { filename: '/assets/main-Dpr0EWW-.js', lineno: 6717, function: 'fme._handleTouchStartDollyPan' },
      { filename: '/assets/main-Dpr0EWW-.js', lineno: 6717, function: 'fme._handleTouchStartDolly' },
    ]);
    assert.equal(beforeSend(event), null, 'OrbitControls pinch-zoom crash in main chunk should be suppressed');
  });

  it('does NOT suppress "reading x" from first-party non-OrbitControls frames', () => {
    const event = makeEvent('Cannot read properties of undefined (reading \'x\')', 'TypeError', [
      { filename: '/assets/main-Dpr0EWW-.js', lineno: 100, function: 'MyMap.onPointerMove' },
    ]);
    assert.ok(beforeSend(event) !== null, 'First-party non-OrbitControls touch error should reach Sentry');
  });

  it('suppresses maplibre TypeError when all frames are maplibre', () => {
    const event = makeEvent('Cannot read properties of null', 'TypeError', [
      { filename: '/assets/maplibre-AbC123.js', lineno: 100, function: 'paint' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses blob-only errors', () => {
    const event = makeEvent('some error', 'Error', [
      { filename: 'blob:https://example.com/1234', lineno: 1, function: 'x' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses TransactionInactiveError without first-party frames', () => {
    const event = makeEvent('TransactionInactiveError: transaction is inactive', 'TransactionInactiveError', []);
    assert.equal(beforeSend(event), null);
  });

  it('lets through TransactionInactiveError WITH first-party frames', () => {
    const event = makeEvent('TransactionInactiveError: transaction is inactive', 'TransactionInactiveError', [
      firstPartyFrame('src/utils/storage.ts', 'writeToIDB'),
    ]);
    assert.ok(beforeSend(event) !== null);
  });

  // WORLDMONITOR-MK: Fireglass (Symantec/Broadcom CloudSOC) console-hook recursion.
  it('suppresses Fireglass RangeError with FireglassUtils frame', () => {
    const event = makeEvent('Maximum call stack size exceeded', 'RangeError', [
      { filename: '<anonymous>', lineno: 1, function: 'FireglassUtils.logInternal' },
      { filename: '<anonymous>', lineno: 1, function: 'Object.debug' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('does NOT suppress non-RangeError that happens to have a FireglassUtils frame', () => {
    const event = makeEvent('Something else entirely', 'TypeError', [
      firstPartyFrame(),
      { filename: '<anonymous>', lineno: 1, function: 'FireglassUtils.logInternal' },
    ]);
    assert.ok(beforeSend(event) !== null, 'RangeError gate must limit blast radius');
  });

  // WORLDMONITOR-MH: Chrome Mobile WebView 105+ duplex requirement, Dodo SDK path.
  it('suppresses duplex error ONLY when checkout-*.js chunk is in the stack', () => {
    const event = makeEvent(
      "Failed to construct 'Request': The `duplex` member must be specified for a request with a streaming body",
      'TypeError',
      [
        { filename: '/assets/panels-DvZJT691.js', lineno: 1, function: 'Mw.window.fetch' },
        { filename: '/assets/checkout-BZBMtluV.js', lineno: 1, function: 'Module.cn' },
      ],
    );
    assert.equal(beforeSend(event), null);
  });

  it('does NOT suppress duplex error when only first-party frames are present (runtime.ts regression must surface)', () => {
    const event = makeEvent(
      "Failed to construct 'Request': The `duplex` member must be specified for a request with a streaming body",
      'TypeError',
      [firstPartyFrame('src/services/runtime.ts', 'patchedFetch')],
    );
    assert.ok(beforeSend(event) !== null, 'first-party runtime regression must still surface');
  });

  // WORLDMONITOR-MP: Chrome extension intercepting maplibre fetch — suppress only when no first-party frames.
  it('suppresses chrome-extension-frame errors when no first-party frames are present', () => {
    const event = makeEvent('Failed to fetch (pub-x.r2.dev)', 'TypeError', [
      { filename: '/assets/maplibre-WH5fAPRo.js', lineno: 1, function: 'FetchSource.load' }, // vendor chunk → not first-party
      { filename: 'chrome-extension://abc/frame_ant.js', lineno: 1, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses moz/safari-extension-frame errors when no first-party frames are present', () => {
    for (const url of ['moz-extension://abc/inj.js', 'safari-web-extension://abc/inj.js']) {
      const event = makeEvent('whatever', 'TypeError', [
        { filename: url, lineno: 1, function: 'inject' },
      ]);
      assert.equal(beforeSend(event), null, `should suppress for ${url}`);
    }
  });

  it('does NOT suppress extension-frame errors when a first-party frame is also present', () => {
    const event = makeEvent('x is not defined', 'ReferenceError', [
      firstPartyFrame('/assets/panels-DzUv7BBV.js', 'loadTab'),
      { filename: 'chrome-extension://abc/inj.js', lineno: 1, function: 'inject' },
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party bug must surface even if an extension frame is on the stack');
  });

  // WORLDMONITOR-MQ: Sentry SDK DOM breadcrumb null.contains crash — suppress only when no first-party frames.
  it("suppresses null 'contains' read on a sentry-*.js frame with no first-party frames", () => {
    const event = makeEvent("Cannot read properties of null (reading 'contains')", 'TypeError', [
      { filename: '/assets/sentry-C2sjIlLb.js', lineno: 1, function: 'HTMLDocument.r' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it("does NOT suppress null 'contains' read when a first-party frame is also present (Sentry wraps handlers)", () => {
    const event = makeEvent("Cannot read properties of null (reading 'contains')", 'TypeError', [
      { filename: '/assets/sentry-C2sjIlLb.js', lineno: 1, function: 'HTMLDocument.r' },
      firstPartyFrame('/assets/main-MURvZ_wC.js', 'handleClick'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party el.contains bug must surface even with sentry frame on stack');
  });

  it("does NOT suppress null 'contains' read when no sentry-*.js frame is present", () => {
    const event = makeEvent("Cannot read properties of null (reading 'contains')", 'TypeError', [
      firstPartyFrame('src/components/SomePanel.ts', 'handleClick'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party null.contains must still surface');
  });

  // WORLDMONITOR-MV: Convex WS onmessage JSON.parse truncation — suppress only when stack has no first-party frames.
  it('suppresses SyntaxError "is not valid JSON" with onmessage frame and no first-party frames', () => {
    const event = makeEvent(
      'Unexpected token \'p\', "pdated","Ping"}" is not valid JSON',
      'SyntaxError',
      [
        { filename: '<anonymous>', lineno: 1, function: 'e.onmessage' },
        { filename: '<anonymous>', lineno: 1, function: 'JSON.parse' },
      ],
    );
    assert.equal(beforeSend(event), null);
  });

  it('does NOT suppress SyntaxError "is not valid JSON" when a first-party onmessage handler is present', () => {
    const event = makeEvent('Unexpected token in JSON at position 0 is not valid JSON', 'SyntaxError', [
      firstPartyFrame('src/services/stream.ts', 'onmessage'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party onmessage regression must surface');
  });
});
