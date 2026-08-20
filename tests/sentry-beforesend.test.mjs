import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDebugBearRumScriptFrame } from '../src/bootstrap/debugbear-rum.ts';
import { isIosLikeUserAgent } from '../src/bootstrap/platform-ua.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract the beforeSend function body from src/bootstrap/sentry-init.ts.
// Sentry.init({...}) was moved out of main.ts when init was deferred off the
// critical path (#3994 / PR-4005); the beforeSend closure now lives inside
// the dynamically imported build factory in sentry-init.ts. We parse it as a
// standalone function to avoid importing Sentry/App bootstrap.
const mainSrc = readFileSync(resolve(__dirname, '../src/bootstrap/sentry-init.ts'), 'utf-8');

// Extract everything between `beforeSend(event) {` and the matching closing `},`
const bsStart = mainSrc.indexOf('beforeSend(event) {');
assert.ok(bsStart !== -1, 'beforeSend must exist in src/bootstrap/sentry-init.ts');
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

// Extract the THIRD_PARTY_FETCH_HOST_ALLOWLIST Set so the test harness can evaluate
// beforeSend with the same allowlist the real module has.
const tpMatch = mainSrc.match(/const THIRD_PARTY_FETCH_HOST_ALLOWLIST = new Set\(\[[^\]]*\]\);/);
assert.ok(tpMatch, 'THIRD_PARTY_FETCH_HOST_ALLOWLIST must be defined in src/bootstrap/sentry-init.ts');

// Build a callable version. Input: a Sentry-shaped event object. Returns event or null.
// eslint-disable-next-line no-new-func
const rawBeforeSend = new Function(
  'event', 'isDebugBearRumScriptFrame', 'isIosLikeUserAgent', 'navigator',
  `${tpMatch[0]}\n${fnBody}`,
);

// User-Agent strings, because beforeSend's platform gates read `navigator.userAgent`
// — NOT `event.contexts.os`, which the browser SDK never populates (see
// src/bootstrap/platform-ua.ts). `navigator` is passed as a Function parameter so it
// shadows Node's global and each test can state the platform explicitly.
const MAC_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const IOS_GOOGLE_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/432.9.954074404 Mobile/15E148 Safari/604.1';
const DESKTOP_NAVIGATOR = { userAgent: MAC_DESKTOP_UA, maxTouchPoints: 0 };
const IOS_NAVIGATOR = { userAgent: IOS_GOOGLE_APP_UA, maxTouchPoints: 5 };
/** iPadOS 13+ desktop mode: Macintosh UA, but touch-capable. */
const IPADOS_NAVIGATOR = { userAgent: MAC_DESKTOP_UA, maxTouchPoints: 5 };

function beforeSend(event, navigatorStub = DESKTOP_NAVIGATOR) {
  return rawBeforeSend(event, isDebugBearRumScriptFrame, isIosLikeUserAgent, navigatorStub);
}

// Extract the `ignoreErrors` array literal so tests can assert which messages
// Sentry's built-in (pre-beforeSend) filter drops. The array body contains
// regex/string literals and `//` comments — all valid inside a JS array literal,
// so it eval's directly. Closing token is the deferred builder's `\n    ],`.
const ieStart = mainSrc.indexOf('ignoreErrors: [');
assert.ok(ieStart !== -1, 'ignoreErrors array must exist in src/bootstrap/sentry-init.ts');
const ieEnd = mainSrc.indexOf('\n    ],', ieStart);
assert.ok(ieEnd > ieStart, 'Failed to find ignoreErrors closing bracket');
const ieBody = mainSrc.slice(ieStart + 'ignoreErrors: ['.length, ieEnd);
// The body's final entry ends in a `//` comment with no trailing newline, so the
// closing bracket must go on its own line or it gets swallowed by that comment.
// eslint-disable-next-line no-new-func
const ignoreErrors = new Function(`return [${ieBody}\n]`)();

/** Mirror Sentry's ignoreErrors semantics: RegExp → test, string → substring. */
function isIgnored(msg) {
  return ignoreErrors.some(p =>
    p instanceof RegExp ? p.test(msg) : typeof p === 'string' ? msg.includes(p) : false);
}

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

// ─── ignoreErrors message matches ────────────────────────────────────────

describe('ignoreErrors filters', () => {
  it('suppresses Clerk SDK UI chunk load failure', () => {
    assert.ok(
      isIgnored('[clerk] failed to load https://clerk.worldmonitor.app/npm/@clerk/ui@1/dist/ui.browser.js'),
      'Clerk SDK load-failure message must be ignored',
    );
  });

  it('does NOT suppress a generic "failed to load" error from our code', () => {
    assert.ok(
      !isIgnored('Failed to load dashboard config'),
      'Generic first-party load-failure messages must NOT be ignored',
    );
  });

  // WORLDMONITOR-ZC: Kaspersky-style content script double-injected, redeclaring
  // its own top-level `SENDER` const. Cannot come from our bundle — esbuild fails
  // the build on a duplicate top-level declaration.
  it('suppresses the extension double-injection SENDER redeclaration', () => {
    assert.ok(
      isIgnored("Identifier 'SENDER' has already been declared"),
      'SENDER duplicate-declaration must be ignored',
    );
  });

  it('does NOT suppress a duplicate-declaration for an unlisted identifier', () => {
    assert.ok(
      !isIgnored("Identifier 'mapLayers' has already been declared"),
      'Only the enumerated extension identifiers may be ignored',
    );
  });
});

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
  // Note: dynamic-module-import failures are intentionally suppressed even with empty
  // stacks — that exact phrase is emitted only by the runtime on stale-chunk-after-
  // deploy, which the chunk-reload guard already auto-recovers. See the dedicated
  // suite below for that case (WORLDMONITOR-Q / WORLDMONITOR-15).
  // Note: Firefox's `NetworkError when attempting to fetch resource.` USED to
  // live here (preserved with empty stacks on a "could be our code" caution),
  // but that predated the `Failed to fetch` provenance refinement. It now lives
  // in the zero-frame suppression suite below — it is the engine-equivalent of
  // Chrome's bare `Failed to fetch` and is suppressed the same way (zero frames
  // → background/SW/extension; a real first-party failure keeps a .ts frame).
  // WORLDMONITOR-RK / WORLDMONITOR-KM.
  const networkErrors = [
    'Could not connect to the server',
    'Operation timed out',
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

// ─── Stale-chunk-after-deploy: dynamic-module-import failures ────────────
//
// Modulepreload / dynamic-import failures arrive with no stack trace because the
// browser fires them as synthetic TypeErrors at fetch time, not at any first-party
// call site. The chunk-reload guard auto-reloads the page, so the user is unaffected
// — but the Sentry event is still captured. We suppress these even with empty stacks
// because the exact phrase is only emitted by the runtime, never by our shipped code
// (WORLDMONITOR-Q / WORLDMONITOR-15).

describe('dynamic-module-import failures (stale chunk after deploy)', () => {
  // URL-bearing FETCH-failure phrasings whose message names one of our own
  // hashed `/assets/*.js` chunks are deploy-skew / transient-network — never a
  // first-party logic bug. The `import()` call site is ALWAYS first-party
  // (MapContainer.initDeck, lazy panel/video loaders), so these ride a
  // first-party frame; matching the asset URL suppresses them regardless of
  // stack (WORLDMONITOR-TN: Map chunk, WORLDMONITOR-S1: hls chunk — both leaked
  // because the old `!hasFirstParty`-only gate let first-party-framed ones
  // through).
  const assetUrlImportErrors = [
    'Failed to fetch dynamically imported module: https://worldmonitor.app/assets/panels-abc.js',
    'Failed to fetch dynamically imported module: https://www.worldmonitor.app/assets/index-DSkSc57y.js',
    'error loading dynamically imported module: https://www.worldmonitor.app/assets/Map-eKJvyIxN.js',
    'error loading dynamically imported module: https://www.worldmonitor.app/assets/hls-jw_vZdHi.js',
  ];

  for (const msg of assetUrlImportErrors) {
    for (const [label, frames] of [
      ['empty stack', []],
      ['confirmed third-party stack', [extensionFrame()]],
      ['first-party stack', [firstPartyFrame()]],
    ]) {
      it(`suppresses "${msg.slice(0, 55)}..." with ${label}`, () => {
        const event = makeEvent(msg, 'TypeError', frames);
        assert.equal(beforeSend(event), null, `asset-URL chunk-load failure should be suppressed regardless of stack (${label})`);
      });
    }
  }

  it('lets through off-origin /assets dynamic-import failures even with first-party stack', () => {
    const event = makeEvent(
      'Failed to fetch dynamically imported module: https://cdn.example.com/assets/vendor-abc.js',
      'TypeError',
      [firstPartyFrame()],
    );
    assert.ok(beforeSend(event) !== null, 'off-origin asset URL must not be treated as WorldMonitor deploy skew');
  });

  it('lets through non-hashed /assets dynamic-import failures even on owned origins', () => {
    const event = makeEvent(
      'Failed to fetch dynamically imported module: https://worldmonitor.app/assets/runtime.js',
      'TypeError',
      [firstPartyFrame()],
    );
    assert.ok(beforeSend(event) !== null, 'non-hashed asset URL must not be treated as a stale Vite chunk');
  });

  // No-URL phrasings (Safari `Importing a module script failed.`, bare Firefox
  // `error loading dynamically imported module`, and the module-LINK export
  // mismatch `Importing binding name '<x>' is not found.` — WORLDMONITOR-TM)
  // throw at fetch/link time with no first-party call site, so they're gated on
  // `!hasFirstParty`: suppressed with an empty or third-party stack, preserved
  // when a genuine first-party frame is present.
  const noUrlImportErrors = [
    'Importing a module script failed.',
    'TypeError: Importing a module script failed.',
    'error loading dynamically imported module',
    "Importing binding name 'f' is not found.",
  ];

  for (const msg of noUrlImportErrors) {
    const type = msg.startsWith('Importing binding name') ? 'SyntaxError' : 'TypeError';
    it(`suppresses "${msg.slice(0, 55)}..." with empty stack`, () => {
      const event = makeEvent(msg, type, []);
      assert.equal(beforeSend(event), null, `"${msg}" with empty stack should be suppressed (chunk-reload guard / deploy-skew)`);
    });

    it(`suppresses "${msg.slice(0, 55)}..." with confirmed third-party stack`, () => {
      const event = makeEvent(msg, type, [extensionFrame()]);
      assert.equal(beforeSend(event), null);
    });

    it(`lets through "${msg.slice(0, 55)}..." with first-party stack`, () => {
      const event = makeEvent(msg, type, [firstPartyFrame()]);
      assert.ok(beforeSend(event) !== null, `"${msg}" with first-party stack should NOT be suppressed`);
    });
  }
});

// ─── Zero-frame async-rejection patterns: AbortSignal timeouts + DOMException(NotSupportedError) ───
//
// AbortSignal.timeout() rejections and DOMException(NotSupportedError) bubble
// up via onunhandledrejection without first-party frames captured (browser
// fires them from internal infra at the timer boundary). Both phrases are
// runtime-emitted only — our shipped code cannot synthesize them
// (WORLDMONITOR-66 / WORLDMONITOR-62).

describe('zero-frame async-rejection patterns (timeout / DOMException / OOM / DOM-walker / wrapper-injected timeout)', () => {
  const zeroFrameErrors = [
    ['signal timed out', 'TimeoutError'],
    ['NotSupportedError: The operation is not supported.', 'Error'],
    // Firefox setInterval mechanism, no captured frames (WORLDMONITOR-KE)
    ['out of memory', 'Error'],
    // Apple Mail privacy proxy DOM walker (WORLDMONITOR-P2). Frames in
    // production are [sentry-chunk, [native code]] which fully filter out
    // of `nonInfraFrames` so empty-stack semantics apply.
    [".toLowerCase is not a function. (In 'el.className.toLowerCase()', 'el.className.toLowerCase' is undefined)", 'TypeError'],
    ['.trim is not a function', 'TypeError'],
    ['.indexOf is not a function', 'TypeError'],
    ['.findIndex is not a function', 'TypeError'],
    // Third-party Electron wrapper polling endpoints we don't serve
    // (WORLDMONITOR-PW: /api/setIsSelect from Electron 39.2.7).
    ['Request timeout: /api/setIsSelect', 'Error'],
    ['Error: Request timeout: /api/whatever', 'Error'],
    // Bare `Failed to fetch` with zero frames = service worker /
    // extension / in-app webview / stale pre-deploy bundle. First-party
    // fetch failures surface with a source-mapped frame on the awaiting
    // site (WORLDMONITOR-KM 10ev/8u). The host-suffixed variant
    // `Failed to fetch (<host>)` has its own first-party allowlist
    // earlier in beforeSend (isHostScopedFetchFailure), so doesn't go
    // through this gate.
    ['Failed to fetch', 'TypeError'],
    ['TypeError: Failed to fetch', 'TypeError'],
    // Safari module-loader abort / streaming-fetch interruption
    // (WORLDMONITOR-RF). iOS Safari fires `SyntaxError: Unexpected EOF`
    // via `onunhandledrejection` with no captured frames when a dynamic
    // `import()` or service-worker-mediated fetch is truncated mid-stream
    // during PWA lifecycle transitions. Our own `JSON.parse` produces
    // engine-prefixed phrasings (V8: `Unexpected end of JSON input`;
    // Safari: `JSON Parse error: Unexpected EOF`) — bare `Unexpected EOF`
    // is engine-emitted only.
    ['Unexpected EOF', 'SyntaxError'],
    ['SyntaxError: Unexpected EOF', 'SyntaxError'],
    // Ancient Android WebView (Chrome 98) parse failures from injected
    // bridge/extension scripts — zero captured frames, bare keyword token.
    // Our compiled bundle cannot emit runtime SyntaxErrors without a source-
    // mapped .ts frame or an owned hashed-chunk URL (handled above).
    ["Unexpected token 'else'", 'SyntaxError'],
    ["Unexpected token 'for'", 'SyntaxError'],
    ['SyntaxError: Unexpected token \'else\'', 'SyntaxError'],
    ['SyntaxError: Unexpected token \'for\'', 'SyntaxError'],
    // Firefox's wording for a failed `fetch()` (WORLDMONITOR-RK) — the
    // engine-equivalent of Chrome's bare `Failed to fetch` above. Zero frames
    // via `onunhandledrejection` = background / service-worker / extension /
    // stale-pre-deploy-bundle fetch. A genuine first-party fetch failure keeps
    // a source-mapped .ts frame on the awaiting site (asserted "lets through"
    // by the first-party-stack loop below). Both the bare and type-prefixed
    // value shapes are matched.
    ['NetworkError when attempting to fetch resource.', 'TypeError'],
    ['TypeError: NetworkError when attempting to fetch resource.', 'TypeError'],
    // Injected page script inserting its own unparseable source
    // (WORLDMONITOR-YW). Chrome prefixes the parse error with the DOM API that
    // triggered it. Our own script-appending call sites (analytics, DebugBear,
    // Clerk, news embeds) keep a source-mapped .ts frame, so the first-party
    // case is asserted "lets through" by this same loop — the coverage the
    // superseded ungated ignoreErrors entry could not provide.
    ["Failed to execute 'appendChild' on 'Node': Unexpected identifier 'x'", 'SyntaxError'],
    ["Failed to execute 'appendChild' on 'Node': Unexpected token '}'", 'SyntaxError'],
    ["SyntaxError: Failed to execute 'appendChild' on 'Node': Unexpected end of input", 'SyntaxError'],
  ];

  for (const [msg, type] of zeroFrameErrors) {
    it(`suppresses "${msg.slice(0, 60)}..." with empty stack`, () => {
      const event = makeEvent(msg, type, []);
      assert.equal(beforeSend(event), null, `"${msg}" with empty stack should be suppressed`);
    });

    it(`suppresses "${msg.slice(0, 60)}..." with confirmed third-party stack`, () => {
      const event = makeEvent(msg, type, [extensionFrame()]);
      assert.equal(beforeSend(event), null);
    });

    it(`lets through "${msg.slice(0, 60)}..." with first-party stack`, () => {
      const event = makeEvent(msg, type, [firstPartyFrame()]);
      assert.ok(beforeSend(event) !== null, `"${msg}" with first-party stack should NOT be suppressed`);
    });
  }

  // The shape WORLDMONITOR-YW actually arrived in: an injected script's parse
  // failure carries only `<anonymous>` frames, which nonInfraFrames strips —
  // so neither the empty-stack nor the extension-URL case above reproduces it.
  it("suppresses the injected-script appendChild parse failure with only <anonymous> frames", () => {
    const event = makeEvent(
      "Failed to execute 'appendChild' on 'Node': Unexpected identifier 'x'",
      'SyntaxError',
      [{ filename: '<anonymous>', lineno: 1 }, { filename: '<anonymous>', lineno: 1 }],
    );
    assert.equal(beforeSend(event), null);
  });

  it('lets through an appendChild parse failure attributed to a first-party script loader', () => {
    // analytics.ts / debugbear-rum.ts / clerk.ts / LiveNewsPanel.ts all append a
    // third-party <script>; if one of those inserts unparseable source the frame
    // is ours and the event must still reach the dashboard. The superseded
    // ignoreErrors entry had no frames to check and dropped this case.
    const event = makeEvent(
      "Failed to execute 'appendChild' on 'Node': Unexpected identifier 'x'",
      'SyntaxError',
      [{ filename: 'src/services/analytics.ts', lineno: 494, function: 'loadUmamiScript' },
        { filename: '<anonymous>', lineno: 1 }],
    );
    assert.ok(beforeSend(event) !== null);
  });
});

// ─── All ambiguous errors require confirmed third-party stack ────────────

describe('ambiguous runtime errors', () => {
  const ambiguousErrors = [
    'Maximum call stack size exceeded',
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

  it('suppresses OrbitControls setPointerCapture NotFoundError when frame context matches three.js signature', () => {
    // Verbatim frame context slice from WORLDMONITOR-NC: minified three.js OrbitControls
    // onPointerDown body. The `_pointers` + `setPointerCapture` adjacency is a three.js-only
    // pattern (our own code doesn't use `_pointers` naming).
    const event = makeEvent(
      "Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.",
      'NotFoundError',
      [
        { filename: '/assets/sentry-CRhtdLad.js', lineno: 15, function: 'HTMLCanvasElement.r' },
        {
          filename: '/assets/main-rDi7PwxJ.js',
          lineno: 6757,
          function: 'xge._ge',
          context: [
            [6757, '.enabled!==!1&&(this._pointers.length===0&&(this.domElement.setPointerCapture(i.pointerId),this.domElement.ownerDocument.addEventListener("p'],
          ],
        },
      ],
    );
    assert.equal(beforeSend(event), null, 'OrbitControls setPointerCapture race should be suppressed');
  });

  it('does NOT suppress setPointerCapture NotFoundError from unsymbolicated first-party bundle frames (no three.js signature)', () => {
    // Production-realistic regression: first-party code calling setPointerCapture, stack
    // lands in /assets/main-*.js (unsymbolicated), but frame context does NOT carry the
    // three.js `_pointers` adjacency. Must reach Sentry.
    const event = makeEvent(
      "Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.",
      'NotFoundError',
      [
        {
          filename: '/assets/main-rDi7PwxJ.js',
          lineno: 1200,
          function: 'MyCanvas.onPointerDown',
          context: [
            [1200, 'this.activePointerId=e.pointerId;this.el.setPointerCapture(e.pointerId);this.emit("pointerdown",e)'],
          ],
        },
      ],
    );
    assert.ok(beforeSend(event) !== null, 'First-party setPointerCapture regression must reach Sentry even when unsymbolicated');
  });

  it('suppresses MapLibre AJAXError "Failed to fetch (<hostname>)" with a maplibre vendor frame', () => {
    const event = makeEvent('Failed to fetch (tilecache.rainviewer.com)', 'TypeError', [
      { filename: '/assets/maplibre-A8Ca0ysS.js', lineno: 4, function: 'ajaxFetch' },
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 24, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'MapLibre tile AJAX failure should be suppressed');
  });

  it('suppresses MapLibre AJAXError for allowlisted host even with an all-maplibre stack', () => {
    // Proves the allowlist path fires on all-vendor stacks too: the AJAX carve-out
    // above bypasses the broad "all-maplibre TypeError" filter and routes into the
    // host-allowlist check, which still suppresses allowlisted third-party hosts.
    const event = makeEvent('Failed to fetch (tilecache.rainviewer.com)', 'TypeError', [
      { filename: '/assets/maplibre-A8Ca0ysS.js', lineno: 4, function: 'ajaxFetch' },
    ]);
    assert.equal(beforeSend(event), null, 'Allowlisted AJAX host should be suppressed regardless of stack shape');
  });

  it('suppresses Clerk SDK "Failed to fetch (clerk.worldmonitor.app)" even with a clerk first-party frame', () => {
    // WORLDMONITOR-SA/SB: the bundled Clerk SDK fetches its Frontend API
    // (clerk.worldmonitor.app, a CNAME to Clerk's auth infra) for token
    // refresh and retries transient failures itself. A leaked
    // `Failed to fetch (clerk.worldmonitor.app)` is a Clerk-SDK-internal
    // network blip, not our code — same disposition as `/ClerkJS: Network
    // error/`. The clerk-*.js chunk reads as first-party (not in the vendor
    // list), so the host allowlist — not hasFirstParty — must decide.
    const event = makeEvent('Failed to fetch (clerk.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/clerk-DC7Q2aDh.js', lineno: 848, function: 'i' },
      { filename: 'chrome-extension://ebeglcfoffnnadgncmppkkohfcigngkj/js/injected/hook.js', lineno: 1, function: 'Object.apply' },
      { filename: '/assets/panels-CYSIkWVK.js', lineno: 45, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'Clerk Frontend API fetch failure should be suppressed');
  });

  it('does NOT suppress plain "Failed to fetch" from first-party code without maplibre frames', () => {
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
    ]);
    assert.ok(beforeSend(event) !== null, 'Plain first-party fetch failure should surface');
  });

  it('suppresses bare "Failed to fetch" when an extension monkeypatched window.fetch (WORLDMONITOR-SG)', () => {
    // Real WORLDMONITOR-SG stack: our runtime fetch interceptor + country-geometry
    // loader are first-party frames, but the leaked rejection comes from an
    // extension (Adjust SDK injectScriptAdjust.js / page-inspector) that wrapped
    // window.fetch and chained an uncaught `.then()`. hasFirstParty is true, so
    // the generic !hasFirstParty gate misses it; the extension `window.fetch`
    // frame is what proves third-party interference.
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/main-BHkAr2lX.js', lineno: 1394, function: 'rS.init' },
      { filename: '/assets/panels-B8qWCRUs.js', lineno: 63, function: 'd1' },
      { filename: '/assets/panels-B8qWCRUs.js', lineno: 61, function: 'DY.window.fetch' },
      { filename: 'chrome-extension://dbjbempljhcmhlfpfacalomonjpalpko/scripts/inspector.js', lineno: 7, function: 'window.fetch' },
      { filename: 'chrome-extension://bkkbcggnhapdmkeljlodobbkopceiche/injectScriptAdjust.js', lineno: 1, function: 'doDefault' },
    ]);
    assert.equal(beforeSend(event), null, 'Extension-wrapped window.fetch network blip should be suppressed');
  });

  it('suppresses bare "Failed to fetch" when extension frame function chains to window.fetch', () => {
    // Real 2026-07-16 stack: extension `frame_ant/frame_ant.js` wraps fetch and the
    // leaked rejection frame function is `r.class.c.value.window.fetch`. The original
    // SG regex only matched `window.fetch` or `Object.apply`; broaden it to any chain
    // ending in `.window.fetch` while still rejecting `prefetch`/`fetchContent`.
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/main-B1YHLdCi.js', lineno: 401, function: 'h' },
      { filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js', lineno: 2, function: 'r.class.c.value.window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'Extension chain-ending-in-window.fetch fetch failure should be suppressed');
  });

  it('suppresses bare "Failed to fetch" when the extension fetch frame carries an alias annotation (WORLDMONITOR-Y8)', () => {
    // Real WORLDMONITOR-Y8 stack (Adjust SDK injectScriptAdjust.js, the same
    // extension already named in the SG gate): Sentry renders the frame whose
    // function was reached through an alias as `<name> [<annotation>]`, so the
    // wrapper surfaces as `window.fetch [<annotation>]`. The SG function match
    // is anchored, so the trailing annotation made it miss and the identical
    // wrapper class re-surfaced as a new issue.
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/panel-storage-RVfx_Amx.js', lineno: 2, function: 'Ln' },
      { filename: 'chrome-extension://bkkbcggnhapdmkeljlodobbkopceiche/injectScriptAdjust.js', lineno: 1, function: 'window.fetch [as originalFetch]' },
      { filename: '/assets/widget-store-B60Ai24W.js', lineno: 2, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'alias-annotated extension window.fetch frame should be suppressed');
  });

  it('does NOT suppress when only the ALIAS half of an extension frame looks like fetch', () => {
    // Precision guard for the annotation strip above: the meaningful name is the
    // one BEFORE the bracket. An extension frame whose own function is unrelated
    // must not qualify just because it was stored under a fetch-ish property.
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
      { filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/inject.js', lineno: 1, function: 'trackEvent [as fetch]' },
    ]);
    assert.ok(beforeSend(event) !== null, 'alias-only fetch resemblance must not trigger SG suppression');
  });

  it('does NOT suppress bare "Failed to fetch" with a first-party frame and a NON-fetch extension frame', () => {
    // Precision guard for WORLDMONITOR-SG: an extension frame whose function is
    // not a fetch wrapper is NOT evidence the extension owns the orphan fetch
    // promise, so a genuine first-party fetch failure must still surface.
    const event = makeEvent('Failed to fetch', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
      { filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js', lineno: 1, function: 'inject' },
    ]);
    assert.ok(beforeSend(event) !== null, 'First-party fetch failure with a non-fetch extension frame must surface');
  });

  it('does NOT suppress when the extension frame function merely CONTAINS "fetch" (prefetch/fetchContent)', () => {
    // The function match is anchored to exactly `window.fetch`/`fetch`, not a
    // loose `/fetch/`, so an extension frame named `prefetch` or `fetchContent`
    // is not treated as a monkeypatched window.fetch — a real bare "Failed to
    // fetch" from our own code must still surface (Greptile review on #4157).
    for (const fn of ['prefetch', 'fetchContent', 'fetchUserData']) {
      const event = makeEvent('Failed to fetch', 'TypeError', [
        { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
        { filename: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/inject.js', lineno: 1, function: fn },
      ]);
      assert.ok(beforeSend(event) !== null, `extension frame function "${fn}" must not trigger SG suppression`);
    }
  });

  it('does NOT suppress "Failed to fetch (<hostname>)" when no maplibre frame is present', () => {
    // Guards against broad message-only suppression hiding a real first-party fetch
    // regression that happens to wrap host into the message.
    const event = makeEvent('Failed to fetch (api.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
    ]);
    assert.ok(beforeSend(event) !== null, 'Non-maplibre Failed-to-fetch must reach Sentry');
  });

  it('does NOT suppress MapLibre AJAXError for a non-allowlisted host (mixed stack)', () => {
    // Mirrors WORLDMONITOR-NE/NF real-world stack: maplibre + first-party fetch wrapper.
    const event = makeEvent('Failed to fetch (pmtiles.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/maplibre-A8Ca0ysS.js', lineno: 4, function: 'ajaxFetch' },
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 24, function: 'window.fetch' },
    ]);
    assert.ok(beforeSend(event) !== null, 'Self-hosted tile fetch failure must reach Sentry');
  });

  it('does NOT suppress MapLibre AJAXError for a non-allowlisted host when stack is entirely maplibre', () => {
    // Critical edge case: the pre-existing "all non-infra frames are maplibre internals"
    // filter would normally drop TypeErrors with an all-maplibre stack. `Failed to fetch`
    // AJAX errors must bypass that generic filter so the host allowlist is what decides,
    // otherwise a self-hosted R2 basemap regression whose stack happens to be vendor-only
    // would be silently dropped.
    const event = makeEvent('Failed to fetch (pmtiles.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/maplibre-A8Ca0ysS.js', lineno: 4, function: 'ajaxFetch' },
    ]);
    assert.ok(beforeSend(event) !== null, 'All-maplibre first-party tile fetch failure must still reach Sentry');
  });

  it('suppresses "Failed to fetch (<host>)" when stack is extension-only (covered by generic extension rule)', () => {
    // WORLDMONITOR-P5: AdBlock-class extensions wrap window.fetch and their
    // replacement can fail unrelated to our backend. The generic extension rule
    // (`!hasFirstParty && extension frame`) already drops this; the test locks
    // that property in for the `Failed to fetch (<host>)` message shape.
    const event = makeEvent('Failed to fetch (abacus.worldmonitor.app)', 'TypeError', [
      { filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js', lineno: 2, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'Extension-only fetch failure should be suppressed');
  });

  it('does NOT suppress "Failed to fetch (<host>)" when stack has both first-party and extension frames', () => {
    // Safety property: a first-party panels-*.js frame means our code initiated
    // the fetch — must surface even if an extension also wrapped it, so a real
    // api.worldmonitor.app outage isn't silenced for users who happen to run
    // fetch-wrapping extensions.
    const event = makeEvent('Failed to fetch (api.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 24, function: 'window.fetch' },
      { filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js', lineno: 2, function: 'window.fetch' },
    ]);
    assert.ok(beforeSend(event) !== null, 'First-party + extension Failed-to-fetch must reach Sentry');
  });

  it('suppresses Firefox "NetworkError ... (data.debugbear.com)" — embedded RUM beacon, zero frames (WORLDMONITOR-RP)', () => {
    // Firefox's host-suffixed phrasing for a failed fetch. The DebugBear RUM
    // script (src/bootstrap/debugbear-rum.ts) POSTs field metrics to
    // data.debugbear.com; a dropped beacon surfaces via onunhandledrejection
    // with no captured frames. Routed through the same host allowlist as the
    // Chrome `Failed to fetch (<host>)` shape, so an allowlisted host is
    // suppressed regardless of stack.
    const event = makeEvent('NetworkError when attempting to fetch resource. (data.debugbear.com)', 'TypeError', []);
    assert.equal(beforeSend(event), null, 'DebugBear RUM beacon network failure should be suppressed');
  });

  it('suppresses Firefox "NetworkError ... (data.debugbear.com)" even with the DebugBear RUM script frame', () => {
    // The DebugBear collector monkeypatches window.fetch, so the leaked
    // rejection can carry its own CDN script frame. That chunk is not
    // first-party (not under /assets/, not .ts), so the host allowlist — not
    // hasFirstParty — must decide.
    const event = makeEvent('NetworkError when attempting to fetch resource. (data.debugbear.com)', 'TypeError', [
      { filename: '/lpMwA9KpC6pf.js', lineno: 1, function: 'window.fetch' },
    ]);
    assert.equal(beforeSend(event), null, 'DebugBear-framed beacon failure should be suppressed');
  });

  it('does NOT suppress Firefox "NetworkError ... (<host>)" for a NON-allowlisted first-party host', () => {
    // Safety mirror of the Chrome `Failed to fetch (api.worldmonitor.app)`
    // guard: the Firefox host-suffixed shape must still surface for our own
    // API so a real outage isn't silenced just because Firefox phrases the
    // network error differently.
    const event = makeEvent('NetworkError when attempting to fetch resource. (api.worldmonitor.app)', 'TypeError', [
      { filename: '/assets/panels-wF5GXf0N.js', lineno: 100, function: 'MyApiCall' },
    ]);
    assert.ok(beforeSend(event) !== null, 'Non-allowlisted host Firefox NetworkError must reach Sentry');
  });

  it('suppresses iOS Safari WKWebView "Cannot inject key into script value" regardless of first-party frame', () => {
    // The native throw always lands in a first-party caller; the existing
    // !hasFirstParty gate missed it. `UnknownError` type name is WebKit-only
    // so scoping on excType is safe (WORLDMONITOR-NM).
    const event = makeEvent('Cannot inject key into script value', 'UnknownError', [
      { filename: '/assets/panels-Dt68xLlT.js', lineno: 20, function: 'bootstrap' },
    ]);
    assert.equal(beforeSend(event), null, 'iOS Safari WKWebView native bridge error should be suppressed');
  });

  it('does NOT suppress "Cannot inject key into script value" from non-UnknownError exc types', () => {
    // Guards against a future first-party TypeError happening to share the
    // message text — the UnknownError type is the only WebKit-native proof.
    const event = makeEvent('Cannot inject key into script value', 'TypeError', [
      { filename: '/assets/panels-Dt68xLlT.js', lineno: 20, function: 'bootstrap' },
    ]);
    assert.ok(beforeSend(event) !== null, 'Non-UnknownError must still reach Sentry');
  });

  it('suppresses Convex re-auth race on fetchToken (stack has tryToReauthenticate)', () => {
    // Convex SDK BaseConvexClient.tryToReauthenticate reads authState.config.fetchToken
    // during WebSocket reconnect when authState.config is still undefined. Known SDK
    // internal, not actionable in our code (WORLDMONITOR-NJ).
    const event = makeEvent(
      "Cannot read properties of undefined (reading 'fetchToken')",
      'TypeError',
      [
        { filename: '/assets/index-DSkSc57y.js', lineno: 2, function: 'ze.tryToReauthenticate' },
      ],
    );
    assert.equal(beforeSend(event), null, 'Convex re-auth race should be suppressed');
  });

  it('does NOT suppress "reading fetchToken" undefined when no tryToReauthenticate frame is present', () => {
    // A real first-party regression that happens to read a `.fetchToken` property
    // must still reach Sentry — only the Convex internal path is suppressed.
    const event = makeEvent(
      "Cannot read properties of undefined (reading 'fetchToken')",
      'TypeError',
      [
        { filename: '/assets/panels-DogeMxo_.js', lineno: 25, function: 'MyAuthBridge.load' },
      ],
    );
    assert.ok(beforeSend(event) !== null, 'First-party fetchToken regression must reach Sentry');
  });

  it('does NOT suppress setPointerCapture NotFoundError when no frame context is present', () => {
    // Defensive: if Sentry strips context, we err on the side of surfacing.
    const event = makeEvent(
      "Failed to execute 'setPointerCapture' on 'Element': No active pointer with the given id is found.",
      'NotFoundError',
      [
        { filename: '/assets/main-rDi7PwxJ.js', lineno: 6757, function: 'xge._ge' },
      ],
    );
    assert.ok(beforeSend(event) !== null, 'Context-less stacks must not be silently suppressed');
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

  // WORLDMONITOR-RA: SnapTube (Android video-downloader in-app WebView) JS bridge
  // parses its own `undefined` payload. `/SnapTube/` already sits in ignoreErrors,
  // but that layer matches the MESSAGE only — here the attribution lives purely in a
  // frame function, so it needs the stack-aware layer.
  it('suppresses SyntaxError "is not valid JSON" from the SnapTube WebView bridge', () => {
    const event = makeEvent('"undefined" is not valid JSON', 'SyntaxError', [
      { filename: '/assets/sentry-DMxp_zBn.js', lineno: 488, function: 'r' },
      { filename: '<anonymous>', lineno: 1, function: 'SnapTube.value' },
      { filename: '<anonymous>', lineno: 1, function: 'Object.jsReceiveMessages' },
      { filename: '<anonymous>', lineno: 1, function: 'JSON.parse' },
    ]);
    assert.equal(beforeSend(event), null);
  });

  it('does NOT suppress SnapTube-shaped JSON errors when a first-party frame is present', () => {
    const event = makeEvent('"undefined" is not valid JSON', 'SyntaxError', [
      firstPartyFrame('src/services/panel-storage.ts', 'readCached'),
      { filename: '<anonymous>', lineno: 1, function: 'SnapTube.value' },
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party JSON.parse regression must surface');
  });

  it('does NOT suppress "is not valid JSON" from an unnamed anonymous bridge', () => {
    const event = makeEvent('"undefined" is not valid JSON', 'SyntaxError', [
      { filename: '<anonymous>', lineno: 1, function: 'e.value' },
      { filename: '<anonymous>', lineno: 1, function: 'JSON.parse' },
    ]);
    assert.ok(
      beforeSend(event) !== null,
      'suppression must key off the named SnapTube bridge, not bare !hasFirstParty',
    );
  });

  // WORLDMONITOR-NR: deck.gl/maplibre internal null-access on Layer.isHidden
  // during render (Safari 26.4 beta, empty stacks preceded by DeckGLMap map-error
  // breadcrumbs). `\w{1,3}\.isHidden` is gated on !hasFirstParty so a genuine
  // SmartPollContext.isHidden regression in runtime.ts still surfaces.
  it('suppresses "evaluating \'Ue.isHidden\'" with empty stack (deck.gl/Safari internal)', () => {
    const event = makeEvent("undefined is not an object (evaluating 'Ue.isHidden')", 'TypeError', []);
    assert.equal(beforeSend(event), null, 'deck.gl isHidden null-access with empty stack should be suppressed');
  });

  it('suppresses Cannot-read-isHidden with only vendor frames', () => {
    const event = makeEvent("Cannot read properties of undefined (reading 'isHidden')", 'TypeError', [
      { filename: '/assets/deck-stack-x1y2z3.js', lineno: 1, function: 'Layer.render' },
    ]);
    assert.equal(beforeSend(event), null, 'deck.gl vendor-only isHidden crash should be suppressed');
  });

  it('does NOT suppress ".isHidden" crashes with first-party frames (SmartPollContext regression)', () => {
    // src/services/runtime.ts owns SmartPollContext.isHidden. A real regression
    // there would carry a first-party frame — must surface.
    const event = makeEvent("Cannot read properties of undefined (reading 'isHidden')", 'TypeError', [
      firstPartyFrame('src/services/runtime.ts', 'SmartPoller.tick'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party SmartPollContext.isHidden regression must reach Sentry');
  });

  it('does NOT suppress ".isHidden" errors on longer-name symbols (bounded char class)', () => {
    // Filter is scoped to `\w{1,3}` to match minified short names. A 4+ char
    // symbol like `myLayer.isHidden` should NOT match this filter (it'd hit
    // the broader !hasFirstParty network/runtime gate instead, which requires
    // specific shapes — isHidden isn't on that list).
    const event = makeEvent("undefined is not an object (evaluating 'myLayer.isHidden')", 'TypeError', []);
    assert.ok(beforeSend(event) !== null, '4+ char symbol accessing .isHidden must still surface');
  });

  // WORLDMONITOR-NQ: Safari short-var ReferenceError ("Can't find variable: ss")
  // from userscript/extension injection. Gated on empty stack + !hasFirstParty +
  // 1–2 char var name so a real "foo is not defined" from our code still surfaces.
  it("suppresses \"Can't find variable: ss\" with empty stack", () => {
    const event = makeEvent("Can't find variable: ss", 'Error', []);
    assert.equal(beforeSend(event), null, 'Short-var Safari ReferenceError with empty stack should be suppressed');
  });

  it("suppresses \"Can't find variable: x\" (single char)", () => {
    const event = makeEvent("Can't find variable: x", 'Error', []);
    assert.equal(beforeSend(event), null);
  });

  it("does NOT suppress \"Can't find variable: ss\" when first-party frames are present", () => {
    // A real minified first-party ReferenceError would carry frames. We never
    // want to silently drop that.
    const event = makeEvent("Can't find variable: ss", 'Error', [
      firstPartyFrame('/assets/panels-DzUv7BBV.js', 'loadTab'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party short-var ReferenceError must surface');
  });

  it("does NOT suppress longer variable names (3+ chars) — shape outside char class", () => {
    // Only `\w{1,2}` matches. `foo` is 3 chars, falls through — meaningful
    // first-party misses (e.g. helper name typo) still surface.
    const event = makeEvent("Can't find variable: foo", 'Error', []);
    assert.ok(beforeSend(event) !== null, '3+ char variable names must surface');
  });

});

// ─── WORLDMONITOR-SQ: ProgressEvent rejection ignoreErrors entry ──────────
//
// A raw DOM `ProgressEvent` (type=error) from a failed resource/XHR load that
// leaks via onunhandledrejection. Sentry synthesizes the message
// `Event `ProgressEvent` (type=error) captured as promise rejection`. No
// first-party path rejects a promise with a raw ProgressEvent (our IDB/worker/
// FileReader onerror handlers all reject wrapped Errors; the lone XHR caller is
// fire-and-forget + Tauri-only where Sentry is disabled), so it goes in
// ignoreErrors alongside the CustomEvent sibling.
describe('ignoreErrors — ProgressEvent promise rejection (WORLDMONITOR-SQ)', () => {
  const PROD_MSG = 'Event `ProgressEvent` (type=error) captured as promise rejection';
  const progressEventPattern = ignoreErrors.find(
    p => p instanceof RegExp && /ProgressEvent/.test(p.source));

  it('defines a ProgressEvent ignore pattern', () => {
    assert.ok(progressEventPattern, 'a /ProgressEvent/ ignoreErrors pattern must exist');
  });

  it('suppresses the exact production ProgressEvent rejection message', () => {
    assert.ok(isIgnored(PROD_MSG), `ignoreErrors must drop: ${PROD_MSG}`);
  });

  it('is scoped to the rejection phrase, not a bare ProgressEvent reference', () => {
    // Guards against an over-broad `/ProgressEvent/` that would mask a real
    // first-party error merely mentioning the word.
    assert.ok(!progressEventPattern.test('ProgressEvent fired during upload'),
      'pattern must require the "captured as promise rejection" phrase');
  });
});

// ─── WORLDMONITOR-SP: SyntaxError through the deck.gl/maplibre init path ───
//
// `SyntaxError: Invalid or unexpected token` (and the Unexpected token/EOF
// family) surfacing through deck.gl/maplibre WebGL init. Our compiled bundle
// can't emit a JS parse error at the first-party `MapContainer.initDeck` call
// site — the parse failure is in vendor-loaded content (a Worker script, a
// `new Function` shader builder, or a stale/corrupt lazy chunk). The pre-
// existing `!hasFirstParty` token-parse gate misses it because `initDeck` rides
// the stack as the caller, so this gate keys off a deck-stack/maplibre frame.
describe('SyntaxError via deck.gl/maplibre init path (WORLDMONITOR-SP)', () => {
  // Mirrors the real WORLDMONITOR-SP stack: deck-stack + maplibre vendor frames
  // plus the first-party MapContainer.initDeck caller.
  const mapInitStack = [
    { filename: '/assets/deck-stack-Dq2qX5Bt.js', lineno: 1606, function: 'Go._getViews' },
    { filename: '/assets/maplibre-BniwwzLw.js', lineno: 811, function: 'lo.addControl' },
    { filename: '/assets/MapContainer-C6imt_dN.js', lineno: 1632, function: 'os.initDeck' },
  ];

  it('suppresses "Invalid or unexpected token" through the map init path despite a first-party initDeck frame', () => {
    const event = makeEvent('Invalid or unexpected token', 'SyntaxError', mapInitStack);
    assert.equal(beforeSend(event), null,
      'deploy/asset parse failure through deck.gl/maplibre init must be suppressed');
  });

  it('suppresses the Safari "Unexpected EOF" variant through the same path', () => {
    assert.equal(beforeSend(makeEvent('Unexpected EOF', 'SyntaxError', mapInitStack)), null);
  });

  it('suppresses the type-prefixed value variant ("SyntaxError: Invalid or unexpected token")', () => {
    // Some engines embed the exception type in the value field — the gate must
    // tolerate the `SyntaxError: ` prefix like the sibling EOF/token gates do.
    assert.equal(
      beforeSend(makeEvent('SyntaxError: Invalid or unexpected token', 'SyntaxError', mapInitStack)),
      null,
    );
  });

  it('does NOT suppress the same SyntaxError when no deck/maplibre frame is present', () => {
    // A genuine first-party parse failure (no map vendor frame) must still surface.
    const event = makeEvent('Invalid or unexpected token', 'SyntaxError', [
      firstPartyFrame('/assets/panels-DzUv7BBV.js', 'loadTab'),
    ]);
    assert.ok(beforeSend(event) !== null,
      'first-party SyntaxError without a map frame must reach Sentry');
  });

  it('does NOT suppress a non-SyntaxError TypeError that merely has a map frame', () => {
    // Gate is scoped to excType === SyntaxError + the token-parse message family.
    const event = makeEvent('something broke', 'TypeError', mapInitStack);
    assert.ok(beforeSend(event) !== null,
      'non-SyntaxError with a map frame must not be swept up by the SP gate');
  });
});

// ─── WORLDMONITOR-ZS: HTML document parsed as JavaScript ──────────────────
//
// V8 `SyntaxError: Malformed arrow function parameter list` when an Electron /
// in-app wrapper loads the SPA document as a script. The only frame is the
// document path (or an injected third-party frame) — never a hashed /assets
// chunk. Same `hasAnyStack && !hasFirstParty` family as Unexpected token/keyword.
describe('HTML-as-JS SyntaxError (WORLDMONITOR-ZS)', () => {
  const MSG = 'Malformed arrow function parameter list';
  const documentFrame = { filename: '/dashboard', lineno: 13, function: '?' };

  it('suppresses the V8 HTML-as-JS parse error attributed to the document URL', () => {
    const event = makeEvent(MSG, 'SyntaxError', [documentFrame]);
    assert.equal(beforeSend(event), null,
      'document-URL SyntaxError must be suppressed as HTML-as-JS noise');
  });

  it('suppresses the type-prefixed value variant', () => {
    const event = makeEvent(`SyntaxError: ${MSG}`, 'SyntaxError', [documentFrame]);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses the same message with an extension-only stack', () => {
    const event = makeEvent(MSG, 'SyntaxError', [extensionFrame()]);
    assert.equal(beforeSend(event), null);
  });

  it('does NOT suppress the same SyntaxError with a first-party frame', () => {
    const event = makeEvent(MSG, 'SyntaxError', [firstPartyFrame()]);
    assert.ok(beforeSend(event) !== null,
      'first-party SyntaxError must still reach Sentry');
  });

  it('does NOT suppress the same SyntaxError with an empty stack', () => {
    const event = makeEvent(MSG, 'SyntaxError', []);
    assert.ok(beforeSend(event) !== null,
      'empty-stack parse error is not proven third-party and must surface');
  });
});

// ─── WORLDMONITOR-TG: mainWorldSdk extension-global ReferenceError ─────────
//
// A browser-extension SDK injected into the page's main world references its
// `mainWorldSdk` global before defining it (Edge 148 / Windows, anonymous-
// frames-only stack). `mainWorldSdk` is nowhere in our bundle, so the message
// can never originate from our own code — it goes in ignoreErrors alongside the
// other named extension/webview globals (crusoe, vc_request_action, nmhCrx).
describe('ignoreErrors — mainWorldSdk extension global (WORLDMONITOR-TG)', () => {
  const PROD_MSG = 'mainWorldSdk is not defined';
  const pattern = ignoreErrors.find(p => p instanceof RegExp && /mainWorldSdk/.test(p.source));

  it('defines a mainWorldSdk ignore pattern', () => {
    assert.ok(pattern, 'a /mainWorldSdk/ ignoreErrors pattern must exist');
  });

  it('suppresses the production "mainWorldSdk is not defined" message', () => {
    assert.ok(isIgnored(PROD_MSG), `ignoreErrors must drop: ${PROD_MSG}`);
  });

  it('is scoped so a longer first-party identifier still surfaces', () => {
    // The literal " is not defined" suffix must follow `mainWorldSdk` directly,
    // so a real "mainWorldSdkLoader is not defined" bug from our own code is not
    // swallowed by this pattern.
    assert.ok(!isIgnored('mainWorldSdkLoader is not defined'),
      'pattern must not swallow a longer identifier with the same prefix');
  });
});

// ─── WORLDMONITOR-VR/VV/VW/VX/VY/VS/VT/VZ: injected browser-automation harness ─
//
// An external browser-automation agent (Floot) drove the dashboard on 2026-07-09.
// Its injected selector-resolution helpers (helperGetStyle et al., <anonymous>
// script) throw generic `Error`s our bundle never emits: `Element not found:
// <sel>`, `No element found: <sel>`, `$pressKey(...) was called with no
// selector`, and references to its own `data-floot-id` attribute. Generic Error
// type (so the anonymous-script TypeError gate misses them) + <anonymous>-only
// frames (→ !hasFirstParty). Gated on !hasFirstParty; the `... found:` matches
// require the trailing colon so the colon-less ambiguous `Element not found`
// (which needs a confirmed third-party stack) is untouched.
describe('injected browser-automation harness errors (Floot)', () => {
  const automationMsgs = [
    'Element not found: [data-floot-id="307"]',
    'Element not found: header',
    'Element not found: null',
    'Element not found: .bg-orange-500\\/20',
    'No element found: button, hasText="×", within="[data-floot-id=\\"12\\"]"',
    'No element found: #intel-feed',
    '$pressKey("Escape") was called with no selector but no element is focused',
    'Floot helper failed near [data-floot-id="307"]',
  ];

  for (const msg of automationMsgs) {
    it(`suppresses "${msg.slice(0, 40)}..." from an <anonymous> injected script`, () => {
      // Real shape: generic Error, helperGetStyle in an <anonymous> eval frame.
      const event = makeEvent(msg, 'Error', [
        { filename: '<anonymous>', lineno: 91, function: null },
        { filename: '<anonymous>', lineno: 5, function: 'helperGetStyle' },
      ]);
      assert.equal(beforeSend(event), null, `Floot automation error should be suppressed: ${msg}`);
    });

    it(`suppresses "${msg.slice(0, 40)}..." with an empty stack too`, () => {
      assert.equal(beforeSend(makeEvent(msg, 'Error', [])), null);
    });
  }

  it('does NOT suppress the colon-less ambiguous "Element not found" with empty stack', () => {
    // Preserves the existing ambiguous-error contract: a bare "Element not found"
    // (no selector) could be our own code and must surface with an unknown origin.
    assert.ok(beforeSend(makeEvent('Element not found', 'Error', [])) !== null,
      'bare colon-less "Element not found" must still surface');
  });

  it('does NOT suppress a first-party error that happens to say "Element not found: X"', () => {
    // Defense-in-depth: a genuine first-party frame means our code threw it —
    // must surface even with the automation-shaped message.
    const event = makeEvent('Element not found: #someLegitSelector', 'Error', [
      firstPartyFrame('src/components/SomePanel.ts', 'requireEl'),
    ]);
    assert.ok(beforeSend(event) !== null, 'first-party "Element not found: X" must reach Sentry');
  });
});

// ─── WORLDMONITOR-WH/WJ: `Failed to fetch (abacus.worldmonitor.app)` ──────────
//
// abacus.worldmonitor.app is our SELF-HOSTED Umami analytics collector
// (src/services/analytics.ts → `https://abacus.worldmonitor.app/script.js`, which
// POSTs events to `/api/send`). A dropped analytics beacon is invisible to the
// user and unactionable — the same disposition as the `data.debugbear.com` RUM
// collector above. It reaches Sentry because the leaked rejection carries our
// Vite `window.fetch` trampolines (widget-store / panel-storage), which make
// hasFirstParty true and so defeat the extension-only gate.
describe('`Failed to fetch (abacus.worldmonitor.app)` — Umami beacon (WORLDMONITOR-WH/WJ)', () => {
  // Verbatim production stack from WORLDMONITOR-WH.
  const whStack = [
    { filename: '/script.js', lineno: 1, function: 'C' },
    { filename: '/assets/sentry-DMxp_zBn.js', lineno: 1, function: null },
    { filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js', lineno: 2, function: 'window.fetch' },
    { filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js', lineno: 2, function: 'o' },
    { filename: '/assets/widget-store-dMTCHpAl.js', lineno: 38, function: 'window.fetch' },
    { filename: '/assets/panel-storage-BWxNKlQM.js', lineno: 2, function: 'window.fetch' },
  ];

  it('suppresses the exact WH stack (Umami beacon through an extension fetch wrapper)', () => {
    assert.equal(beforeSend(makeEvent('Failed to fetch (abacus.worldmonitor.app)', 'TypeError', whStack)), null,
      'a dropped Umami analytics beacon is unactionable');
  });

  it('suppresses the Firefox host-suffixed phrasing for the same host', () => {
    const event = makeEvent('NetworkError when attempting to fetch resource. (abacus.worldmonitor.app)', 'TypeError', []);
    assert.equal(beforeSend(event), null, 'host allowlist decides regardless of engine phrasing');
  });

  it('still surfaces `Failed to fetch (api.worldmonitor.app)` with the same stack shape', () => {
    // The allowlist is host-scoped, so adding the beacon host must not widen the
    // gate for our data-serving API — a real outage still has to reach Sentry.
    const event = makeEvent('Failed to fetch (api.worldmonitor.app)', 'TypeError', whStack);
    assert.ok(beforeSend(event) !== null, 'API-outage canary must never be masked by the beacon allowlist');
  });
});

// ─── WORLDMONITOR-WK: zero-frame RangeError confined to iOS ───────────────────
//
// 23 events / 20 users, 100% iOS, 21 inside the Google app's in-app WebView.
// A blown stack is exactly when the SDK cannot collect frames, so zero frames
// alone proves nothing — the OS gate is the load-bearing half.
describe('sentry beforeSend — WK iOS zero-frame call-stack overflow', () => {
  it('suppresses the exact WK shape on iOS', () => {
    const event = makeEvent('Maximum call stack size exceeded.', 'RangeError', []);
    assert.equal(beforeSend(event, IOS_NAVIGATOR), null, 'iOS in-app WebView recursion is not our bundle');
  });

  it('suppresses the WK shape on iPadOS desktop-mode (Macintosh UA + touch)', () => {
    const event = makeEvent('Maximum call stack size exceeded.', 'RangeError', []);
    assert.equal(beforeSend(event, IPADOS_NAVIGATOR), null, 'iPadOS is the same WebView family');
  });

  it('does NOT suppress the same message on a desktop OS', () => {
    const event = makeEvent('Maximum call stack size exceeded.', 'RangeError', []);
    assert.ok(beforeSend(event, DESKTOP_NAVIGATOR) !== null, 'a real recursion regression must still reach Sentry');
  });

  it('does NOT suppress an iOS call-stack overflow that carries a first-party frame', () => {
    const event = makeEvent('Maximum call stack size exceeded.', 'RangeError', [firstPartyFrame()]);
    assert.ok(beforeSend(event, IOS_NAVIGATOR) !== null, 'an attributable recursion is signal, not noise');
  });

  it('does NOT suppress an unrelated zero-frame iOS RangeError', () => {
    const event = makeEvent('Invalid array length', 'RangeError', []);
    assert.ok(beforeSend(event, IOS_NAVIGATOR) !== null, 'the gate is scoped to the call-stack message');
  });

  // The regression that let WORLDMONITOR-WK run for 44 events across seven builds:
  // the gate read `event.contexts.os.name`, which the browser SDK never sets, and the
  // old fixtures fabricated it. Pin BOTH directions so no future gate can pass a test
  // via a field production does not supply.
  it('ignores event.contexts.os entirely — a fabricated iOS context cannot suppress', () => {
    const event = {
      ...makeEvent('Maximum call stack size exceeded.', 'RangeError', []),
      contexts: { os: { name: 'iOS', version: '18.0.0' } },
    };
    assert.ok(
      beforeSend(event, DESKTOP_NAVIGATOR) !== null,
      'contexts.os is ingest-derived and absent in beforeSend; it must not drive the gate',
    );
  });

  it('suppresses on an iOS UA even with no contexts at all (the real production shape)', () => {
    const event = makeEvent('Maximum call stack size exceeded.', 'RangeError', []);
    assert.equal(event.contexts, undefined, 'production events reach beforeSend without an os context');
    assert.equal(beforeSend(event, IOS_NAVIGATOR), null, 'the UA is the only platform signal available');
  });
});

// ─── WORLDMONITOR-ZG: host attribution replaces the chunk-name gate (#6746) ───
//
// The DebugBear trampoline gate is GONE. It tried to identify this class from
// the stack, which is impossible in principle: every frame in ZG's stack is a
// `window.fetch` wrapper (DebugBear -> wmSessionFetch -> runtime dispatch ->
// native fetch), because the rejection originates in native fetch and the async
// boundary drops the calling frame. The app caller is never present, so six
// rounds of chunk-name heuristics each broke on the next Vite repartition.
//
// `src/services/fetch-failure-attribution.ts` now appends the host at the
// bottom of the wrapper chain, so the SAME stack reaches a different verdict
// depending on WHO was being contacted — which is the only thing that ever
// distinguished a dropped analytics beacon from an origin outage.
//
// These tests are what license deleting the gate: they prove the allowlist, not
// the stack shape, is what decides.
describe('bare "Failed to fetch" is decided by host, not stack shape (WORLDMONITOR-ZG)', () => {
  // Verbatim production stack, identical across all 17 ZG events (2026-08-16),
  // including the four on builds that already contained #6747.
  const zgStack = [
    { filename: '/lpMwA9KpC6pf.js', lineno: 0, function: null },
    { filename: '/lpMwA9KpC6pf.js', lineno: 0, function: null },
    { filename: '/lpMwA9KpC6pf.js', lineno: 0, function: null },
    { filename: '/lpMwA9KpC6pf.js', lineno: 0, function: null },
    { filename: '/lpMwA9KpC6pf.js', lineno: 0, function: 't' },
    { filename: '/assets/widget-store-DbqgxtxV.js', lineno: 0, function: 'Pn.window.fetch' },
    { filename: '/assets/analytics-DdK2NArM.js', lineno: 0, function: null },
    { filename: '/assets/analytics-DdK2NArM.js', lineno: 0, function: 'c' },
  ];

  it('suppresses the annotated Umami beacon on the exact ZG stack', () => {
    const event = makeEvent('Failed to fetch (abacus.worldmonitor.app)', 'TypeError', zgStack);
    assert.equal(beforeSend(event), null, 'a dropped analytics beacon is unactionable');
  });

  it('SURFACES an annotated api.worldmonitor.app failure on the IDENTICAL stack', () => {
    // The whole point. Same frames, opposite verdict — decided by the host.
    const event = makeEvent('Failed to fetch (api.worldmonitor.app)', 'TypeError', zgStack);
    assert.ok(beforeSend(event) !== null, 'an origin outage must never be suppressed');
  });

  it('suppresses the annotated DebugBear RUM beacon', () => {
    const event = makeEvent('Failed to fetch (data.debugbear.com)', 'TypeError', zgStack);
    assert.equal(beforeSend(event), null);
  });

  it('suppresses the annotated Clerk SDK fetch', () => {
    const event = makeEvent('Failed to fetch (clerk.worldmonitor.app)', 'TypeError', zgStack);
    assert.equal(beforeSend(event), null);
  });

  it('SURFACES an annotated self-hosted PMTiles failure', () => {
    // The R2 basemap bucket is deliberately absent from the allowlist so a real
    // basemap regression is never silently dropped (WORLDMONITOR-NE/NF).
    const event = makeEvent('Failed to fetch (pub-8ace9f6a86d74cb2bd.r2.dev)', 'TypeError', zgStack);
    assert.ok(beforeSend(event) !== null, 'first-party basemap failures must surface');
  });

  it('SURFACES a still-bare "Failed to fetch" — the accepted cached-bundle cost (KTD4)', () => {
    // Browsers running a bundle cached from before the attribution deploy still
    // emit an un-annotated message. With the chunk gate deleted these surface
    // instead of being suppressed. That is a DELIBERATE, temporary trade-off:
    // an unattributable failure from a chunk carrying runtime.ts could be a real
    // origin outage, and suppressing it is exactly the blind spot #6746 refuses.
    const event = makeEvent('Failed to fetch', 'TypeError', zgStack);
    assert.ok(beforeSend(event) !== null, 'unattributable fetch failures must not be silently dropped');
  });

  it('pins the Safari blind spot: Load failed is dropped by ignoreErrors, annotated or not (KTD5)', () => {
    // /^TypeError: Load failed( \(.*\))?$/ allows the host parenthetical, so
    // BOTH forms are dropped before beforeSend runs — including for our own
    // origin. Annotating Safari therefore changes no verdict today. Pinned here
    // so that whoever narrows that entry sees exactly what changes.
    assert.ok(isIgnored('TypeError: Load failed'), 'bare Safari form is ignored');
    assert.ok(
      isIgnored('TypeError: Load failed (api.worldmonitor.app)'),
      'annotated Safari form is ALSO ignored — this is the blind spot',
    );
  });

  // ── The shape that hid a P0 ────────────────────────────────────────────────
  //
  // `linkedErrorsIntegration()` is a DEFAULT @sentry/browser integration
  // (build/npm/cjs/prod/sdk.js:32) that runs in preprocessEvent, BEFORE
  // beforeSend. When the thrown error carries `.cause`, it expands the chain
  // into `event.exception.values` with the ORIGINAL error LAST (@sentry/core
  // aggregate-errors.js:20) — so a bare cause occupies values[0], which is
  // exactly what beforeSend reads (sentry-init.ts:353).
  //
  // Every other fixture in this file builds a ONE-entry values array, so the
  // whole suite is structurally blind to that reordering. These two cases are
  // the only thing standing between us and silently shipping an inert filter.
  const twoValueEvent = (causeValue, outerValue, frames) => ({
    exception: {
      values: [
        { type: 'TypeError', value: causeValue, stacktrace: { frames } },
        { type: 'TypeError', value: outerValue, stacktrace: { frames } },
      ],
    },
  });

  it('a bare cause at values[0] defeats host suppression — why we never set `cause`', () => {
    // If the attribution module ever re-adds `annotated.cause = error`, THIS is
    // the event Sentry actually delivers, and the beacon stops being suppressed.
    const event = twoValueEvent(
      'Failed to fetch',
      'Failed to fetch (abacus.worldmonitor.app)',
      zgStack,
    );
    assert.ok(
      beforeSend(event) !== null,
      'values[0] is the bare cause, so the allowlist cannot fire — this is the '
      + 'regression that re-adding `cause` would reintroduce',
    );
  });

  it('the single-value shape we actually emit IS suppressed', () => {
    // Contrast case. Same message, same stack, one value — the shape produced
    // when no `cause` is set. This is what production must look like.
    const event = makeEvent('Failed to fetch (abacus.worldmonitor.app)', 'TypeError', zgStack);
    assert.equal(beforeSend(event), null, 'no cause -> annotated message at values[0] -> suppressed');
  });

  // ── Period-less Gecko, end to end ─────────────────────────────────────────
  //
  // `FETCH_FAILURE_MESSAGE` admits `resource\.?`, so the module annotates the
  // period-less Gecko phrasing too. Until #6762 review, `isHostScopedFetchFailure`
  // required the period literally — that message was annotated and then never
  // routed to the allowlist. Both sides now accept it; these two fixtures are
  // what make the widening observable, since every other Gecko fixture in this
  // file uses the period form.

  it('suppresses the annotated period-less Gecko phrasing for an allowlisted host', () => {
    const event = makeEvent(
      'NetworkError when attempting to fetch resource (abacus.worldmonitor.app)',
      'TypeError',
      zgStack,
    );
    assert.equal(beforeSend(event), null, 'period-less Gecko must route through the host allowlist');
  });

  it('SURFACES the annotated period-less Gecko phrasing for api.worldmonitor.app', () => {
    const event = makeEvent(
      'NetworkError when attempting to fetch resource (api.worldmonitor.app)',
      'TypeError',
      zgStack,
    );
    assert.ok(beforeSend(event) !== null, 'an origin outage must surface in the period-less shape too');
  });

  it('accepts the `TypeError: ` prefix on an annotated message', () => {
    // The file's sibling gates already tolerate this prefix, which means the
    // project has observed it in `exception.values[].value`. The host detector
    // must not be the one place that misses it.
    const event = makeEvent(
      'TypeError: Failed to fetch (abacus.worldmonitor.app)',
      'TypeError',
      zgStack,
    );
    assert.equal(beforeSend(event), null, 'prefixed annotated message must still reach the allowlist');
  });

  it('the producer and consumer regexes accept the same phrasing set', () => {
    // Belt-and-braces against the drift that caused the period-less gap. The
    // module PRODUCES annotated messages; sentry-init CONSUMES them. They are
    // separate literals in separate files (sentry-init's beforeSend body is
    // eval'd standalone by this harness, so it cannot import a shared one), so
    // assert equivalence behaviourally instead.
    const attributionSrc = readFileSync(
      resolve(__dirname, '../src/services/fetch-failure-attribution.ts'),
      'utf-8',
    );
    const producerMatch = attributionSrc.match(
      /const FETCH_FAILURE_MESSAGE =\s*(\/\^[\s\S]*?\/);/,
    );
    assert.ok(producerMatch, 'FETCH_FAILURE_MESSAGE must be a single regex literal');
    // eslint-disable-next-line no-new-func
    const producer = new Function(`return ${producerMatch[1]}`)();

    for (const phrase of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'NetworkError when attempting to fetch resource',
      'Load failed',
    ]) {
      assert.ok(producer.test(phrase), `producer must annotate: ${phrase}`);
      // Anything the producer annotates must be routable by the consumer once
      // the host suffix is appended — otherwise it is annotated-but-unsuppressable.
      const annotated = `${phrase} (abacus.worldmonitor.app)`;
      const verdict = beforeSend(makeEvent(annotated, 'TypeError', zgStack));
      const ignored = isIgnored(`TypeError: ${annotated}`);
      assert.ok(
        verdict === null || ignored,
        `consumer must be able to act on an annotated message the producer emits: ${annotated}`,
      );
    }
  });

  it('the attribution module does not set `cause`', () => {
    // Belt-and-braces: assert the source-level invariant too, so the reason is
    // discoverable from this file without reading the module.
    const attributionSrc = readFileSync(
      resolve(__dirname, '../src/services/fetch-failure-attribution.ts'),
      'utf-8',
    );
    // Strip comments first — the module explains the hazard in prose, and that
    // prose necessarily contains the very assignment we are banning.
    const code = attributionSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(
      !/\.cause\s*=/.test(code),
      'fetch-failure-attribution.ts must not assign .cause — it activates LinkedErrors '
      + 'and moves the bare message to values[0], defeating host attribution',
    );
  });

  it('no longer references Vite chunk names in the beforeSend policy', () => {
    // The deletion this whole block licenses. Chunk names are arbitrary build
    // output; a policy keyed on them cannot stay correct across repartitions.
    assert.ok(
      !/panel-storage|widget-store/.test(mainSrc),
      'sentry-init.ts must not key suppression on Vite chunk names',
    );
  });
});

// ─── WORLDMONITOR-105: extDomain extension-global ReferenceError ───────────
//
// A browser extension injected into the page's main world references its own
// `extDomain` global before defining it. The production event (Chrome 151 /
// Windows, 2026-08-19) carries three `<anonymous>:1` frames and nothing else.
// `extDomain` appears nowhere in src/, api/, public/ or index.html, so the
// message can never originate from our own bundle — same disposition as the
// `mainWorldSdk`, `hackLocationFailed` and `userScripts` entries above.
describe('ignoreErrors — extDomain extension global (WORLDMONITOR-105)', () => {
  const PROD_MSG = 'extDomain is not defined';
  const pattern = ignoreErrors.find(p => p instanceof RegExp && /extDomain/.test(p.source));

  it('defines an extDomain ignore pattern', () => {
    assert.ok(pattern, 'an /extDomain/ ignoreErrors pattern must exist');
  });

  it('suppresses the production "extDomain is not defined" message', () => {
    assert.ok(isIgnored(PROD_MSG), `ignoreErrors must drop: ${PROD_MSG}`);
  });

  it('is scoped so a longer first-party identifier still surfaces', () => {
    // The `\b...\b` anchors keep the pattern from swallowing a real
    // `extDomainResolver is not defined` bug in our own code.
    assert.ok(!isIgnored('extDomainResolver is not defined'),
      'pattern must not swallow a longer identifier with the same prefix');
    assert.ok(!isIgnored('myExtDomain is not defined'),
      'pattern must not swallow a longer identifier with the same suffix');
  });
});

// ─── WORLDMONITOR-106: Firefox `uncaught exception: undefined` ─────────────
//
// Firefox's window.onerror wording when a script throws a bare primitive
// (`throw undefined` / `throw null`). The production event (Firefox 153 /
// Windows, 2026-08-19) has one frame — the DOCUMENT url
// `https://www.worldmonitor.app/#moments` at line 0 — so there is no script
// file to attribute it to at all.
//
// Our bundle never throws a bare primitive: `throw undefined` / `throw null`
// appear nowhere in src/, shared/ or api/, and every rethrow (`throw err`)
// re-raises a caught value from a first-party frame, which would put that
// frame on the stack and fail the `!hasFirstParty` gate. So this goes in
// beforeSend with stack-gating rather than ignoreErrors: the wording is
// engine-generic enough that a first-party origin must still surface.
describe('beforeSend — Firefox bare-primitive throw (WORLDMONITOR-106)', () => {
  const docFrame = { filename: 'https://www.worldmonitor.app/#moments', lineno: 0 };

  it('suppresses "uncaught exception: undefined" with no first-party frame', () => {
    assert.equal(
      beforeSend(makeEvent('uncaught exception: undefined', 'Error', [docFrame])),
      null,
      'a bare-primitive throw with only a document-URL frame must be dropped',
    );
  });

  it('suppresses the null variant too', () => {
    assert.equal(
      beforeSend(makeEvent('uncaught exception: null', 'Error', [docFrame])),
      null,
      'Firefox emits the same wording for `throw null`',
    );
  });

  it('PRESERVES the same message when a first-party frame is present', () => {
    const event = makeEvent('uncaught exception: undefined', 'Error', [
      docFrame,
      firstPartyFrame(),
    ]);
    assert.ok(
      beforeSend(event) !== null,
      'a first-party frame means our code rethrew it — must surface',
    );
  });

  it('PRESERVES a thrown object, which names a real injector or a real bug', () => {
    assert.ok(
      beforeSend(makeEvent('uncaught exception: [object Object]', 'Error', [docFrame])) !== null,
      'only the bare undefined/null primitives are provably not ours',
    );
  });

  // The trailing `[^A-Za-z0-9_]|$` is what stops `throw nullValue` /
  // `throw undefinedThing` from matching, and accepting end-of-line there is what
  // catches an ASI-terminated `throw undefined` with no semicolon — requiring `;`
  // would let exactly the statement this invariant exists to forbid slip past.
  const BARE_PRIMITIVE_THROW = /throw\s+(?:undefined|null|void 0)(?:[^A-Za-z0-9_]|$)/m;

  /**
   * Source with comments removed. Load-bearing, not tidiness: the beforeSend
   * policy EXPLAINS this rule in prose, and that prose necessarily contains the
   * very statement being banned (`throw undefined` / `throw null`). Scanning raw
   * text makes the explanation trip its own rule. Same reason the `.cause`
   * invariant above strips comments before matching.
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  /** Every .ts/.mts/.tsx file under `dir`, recursively. */
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.(?:m?ts|tsx)$/.test(e.name) ? [full] : [];
  });

  it('the bundle never throws a bare primitive', () => {
    // The source-level invariant the suppression rests on, asserted here so it
    // cannot silently stop being true.
    const offenders = [];
    for (const rel of ['../src', '../shared', '../api']) {
      for (const file of walk(resolve(__dirname, rel))) {
        const code = stripComments(readFileSync(file, 'utf-8'));
        if (BARE_PRIMITIVE_THROW.test(code)) offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [],
      `bare-primitive throw found — the WORLDMONITOR-106 suppression is no longer safe:\n${offenders.join('\n')}`);
  });

  it('the invariant actually fires on the statements it forbids', () => {
    // A source scan that matches nothing is indistinguishable from a source scan
    // that is silently broken. Positive controls, so the test above is known to
    // have teeth — including the semicolon-less ASI form.
    for (const forbidden of ['throw undefined;', 'throw undefined', 'throw null;', 'throw null', 'throw void 0;']) {
      assert.ok(BARE_PRIMITIVE_THROW.test(forbidden), `pattern must catch: ${forbidden}`);
    }
    for (const allowed of ['throw nullValue;', 'throw undefinedThing;', 'throw err;', 'throw new Error("x");']) {
      assert.ok(!BARE_PRIMITIVE_THROW.test(allowed), `pattern must NOT catch: ${allowed}`);
    }
  });

  it('the scan reaches real files, and comment-stripping is what keeps it green', () => {
    // Two ways the invariant could pass vacuously, both closed here: a walk that
    // returns nothing, and a scan that would fail if it did NOT strip comments.
    const files = ['../src', '../shared', '../api'].flatMap(rel => walk(resolve(__dirname, rel)));
    assert.ok(files.length > 100, `walk must reach the real tree, got ${files.length} files`);
    assert.ok(files.some(f => f.endsWith('bootstrap/sentry-init.ts')), 'walk must include sentry-init.ts');

    const raw = readFileSync(resolve(__dirname, '../src/bootstrap/sentry-init.ts'), 'utf-8');
    assert.ok(BARE_PRIMITIVE_THROW.test(raw),
      'the policy comment is expected to contain the banned statement — if it stops doing so, '
      + 'this control no longer proves comment-stripping is load-bearing');
    assert.ok(!BARE_PRIMITIVE_THROW.test(stripComments(raw)),
      'stripping comments must clear it');
  });
});
