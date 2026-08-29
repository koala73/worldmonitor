import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKETING_IGNORE_ERRORS,
  marketingBeforeSend,
  sanitizeMarketingRequestUrl,
  type PolicyEvent,
} from '../pro-test/src/sentry-filter-policy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const MARKETING_INLINE_SCRIPT_FILES = [
  'pro-test/welcome.html',
  'pro-test/index.html',
  'pro-test/prerender.mjs',
] as const;

let marketingSourceCache: { rel: string; code: string }[] | undefined;

/**
 * Every first-party source file the marketing bundle can execute.
 *
 * `pro-test/src` alone is NOT the bundle's boundary: `App.tsx` and `main.tsx`
 * import leaf modules out of the repo-root `shared/` tree, and the HTML and
 * prerender entrypoints contain inline scripts. The out-of-tree imports are
 * resolved from the source so a new one is covered when it is added.
 *
 * Third-party package code is deliberately out of scope: `node_modules` is
 * neither reviewable nor stable enough to assert on.
 */
function marketingFirstPartySources(): { rel: string; code: string }[] {
  if (marketingSourceCache) return marketingSourceCache;

  const seen = new Map<string, string>();
  for (const f of readdirSync(resolve(root, 'pro-test/src'), { recursive: true, encoding: 'utf-8' })) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const rel = `pro-test/src/${f}`;
    seen.set(rel, readFileSync(resolve(root, rel), 'utf-8'));
  }
  // `from '../../shared/<mod>'` → `shared/<mod>.ts`. The shared modules in use
  // today are import-free leaves, so one hop is the whole closure; the
  // reachability test below keeps that assumption visible.
  for (const code of [...seen.values()]) {
    for (const m of code.matchAll(/from '\.\.\/\.\.\/(shared\/[\w./-]+)'/g)) {
      const rel = `${m[1]}.ts`;
      if (!seen.has(rel)) seen.set(rel, readFileSync(resolve(root, rel), 'utf-8'));
    }
  }
  for (const rel of MARKETING_INLINE_SCRIPT_FILES) {
    seen.set(rel, readFileSync(resolve(root, rel), 'utf-8'));
  }

  marketingSourceCache = [...seen].map(([rel, code]) => ({ rel, code }));
  return marketingSourceCache;
}

/**
 * The marketing surface (`/` and `/pro`) runs its own `@sentry/react` client,
 * so none of `src/bootstrap/sentry-init.ts` applies to it. Every event below is
 * a real production event pulled from the 2026-08-19 triage; each `sdk` was
 * `sentry.javascript.react` with a null release, which is what distinguishes a
 * marketing-bundle event from a dashboard one.
 *
 * Both halves matter. The suppression cases prove the policy fires; the KEEP
 * cases are positive controls that prove each gate is load-bearing — delete the
 * length bound or the `!hasFirstParty` gate and a KEEP case goes red instead of
 * the suite staying green on absence alone.
 */

/**
 * Sentry's InboundFilters tests a pattern against the exception value AND the
 * combined `"<type>: <value>"` form — which is why entries like
 * `/^TypeError: Load failed/` can anchor on the type prefix.
 */
function isIgnored(type: string, value: string): boolean {
  return MARKETING_IGNORE_ERRORS.some((p) => p.test(value) || p.test(`${type}: ${value}`));
}

function event(value: string, filenames: string[] = []): PolicyEvent {
  return {
    exception: {
      values: [{
        value,
        stacktrace: { frames: filenames.map((filename) => ({ filename })) },
      }],
    },
  };
}

describe('marketing ignoreErrors', () => {
  it('drops the WKWebView host-bridge timeout (WORLDMONITOR-ZY)', () => {
    assert.equal(
      isIgnored('Error', 'WKWebView API client did not respond to this postMessage'),
      true,
    );
  });

  it('drops the extension runtime.sendMessage rejection (WORLDMONITOR-ZX)', () => {
    assert.equal(isIgnored('Error', 'Invalid call to runtime.sendMessage(). Tab not found.'), true);
  });

  it('drops the extension no-listener messaging rejection (WORLDMONITOR-10N)', () => {
    // Verbatim production value. Chrome emits this exact sentence when a
    // `chrome.runtime`/`chrome.tabs` sendMessage finds no receiver — the
    // no-listener half of the `runtime.sendMessage()` entry above, and a
    // different sentence, so that pattern does not cover it.
    assert.equal(
      isIgnored('Error', 'Could not establish connection. Receiving end does not exist.'),
      true,
    );
  });

  // Positive control: the match is substring-based, so phrasing that shares
  // only the opening clause must stay reportable.
  it('keeps near-miss connection errors lacking the no-listener sentence', () => {
    assert.equal(isIgnored('Error', 'Could not establish connection to Dodo'), false);
  });

  it('drops the Zalo in-app-browser bridge global (WORLDMONITOR-102)', () => {
    // Verbatim production value; Safari phrases a missing global this way.
    assert.equal(isIgnored('ReferenceError', "Can't find variable: zaloJSV2"), true);
    // Chrome/Edge phrasing for the same missing global.
    assert.equal(isIgnored('ReferenceError', 'zaloJSV2 is not defined'), true);
  });

  it('drops the iOS in-app WebView native bridge (WORLDMONITOR-108)', () => {
    // Verbatim production value: Safari phrases the missing bridge this way,
    // thrown from the host app's injected `sendDataToNative`.
    assert.equal(
      isIgnored('TypeError', "undefined is not an object (evaluating 'window.webkit.messageHandlers')"),
      true,
    );
    // Chrome/Android in-app views phrase the same dereference differently.
    assert.equal(
      isIgnored('TypeError', "Cannot read properties of undefined (reading 'messageHandlers')"),
      false,
      'the pattern keys on the webkit-qualified path, not a bare `messageHandlers` read',
    );
  });

  // Positive control for the `\b` bounds on the Zalo entry: the pattern must
  // key on the identifier, not on a substring that a longer word contains.
  it('keeps an error that merely mentions a similar word', () => {
    assert.equal(isIgnored('ReferenceError', "Can't find variable: zaloJSV2Extended"), false);
  });

  // Positive control: the array must not have grown a pattern broad enough to
  // swallow an ordinary marketing-bundle bug.
  it('keeps a genuine first-party error message', () => {
    assert.equal(
      isIgnored('TypeError', "Cannot read properties of undefined (reading 'entitlement')"),
      false,
    );
    assert.equal(isIgnored('Error', 'Dodo checkout session could not be created'), false);
  });
});

describe('marketing Sentry request URL privacy', () => {
  it('removes query strings and unsafe auth fragments from production event URLs', () => {
    assert.equal(
      sanitizeMarketingRequestUrl(
        'https://www.worldmonitor.app/pro?wm_referral=private#access_token=private',
      ),
      'https://www.worldmonitor.app/pro',
    );
  });

  it('retains only approved public marketing routes and section hashes', () => {
    assert.equal(
      sanitizeMarketingRequestUrl(
        'https://www.worldmonitor.app/pro/?checkout_session=private#pricing',
      ),
      'https://www.worldmonitor.app/pro#pricing',
    );
    assert.equal(
      sanitizeMarketingRequestUrl('https://www.worldmonitor.app/?ref=private#enterprise-contact'),
      'https://www.worldmonitor.app/#enterprise-contact',
    );
    assert.equal(
      sanitizeMarketingRequestUrl('https://www.worldmonitor.app/dashboard?token=private'),
      undefined,
    );
    assert.equal(sanitizeMarketingRequestUrl('not a URL?token=private'), undefined);
  });
});

describe('marketingBeforeSend — bare minified symbol', () => {
  it('drops a whole-message minified symbol (WORLDMONITOR-ZZ "ga", -ZW "Ba")', () => {
    // Real frames: the prerendered welcome document itself, from an iOS
    // Google-app in-app browser injecting its own script.
    assert.equal(marketingBeforeSend(event('ga', ['https://www.worldmonitor.app/'])), null);
    assert.equal(marketingBeforeSend(event('Ba', ['https://www.worldmonitor.app/'])), null);
  });

  // Positive control for the length bound. `plan` is 4 characters, so the gate
  // must let it through; without this, widening `<= 3` to `<= 8` would go
  // unnoticed and start hiding real errors.
  it('keeps a 4-character message', () => {
    const kept = event('plan');
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control for the "identifier only" shape.
  it('keeps a short message that is not a bare identifier', () => {
    for (const value of ['404', 'a b', '']) {
      const kept = event(value);
      assert.equal(marketingBeforeSend(kept), kept, `expected ${JSON.stringify(value)} kept`);
    }
  });
});

describe('marketingBeforeSend — stale chunk after deploy', () => {
  it('drops the zero-frame Safari phrasing (WORLDMONITOR-15)', () => {
    // The real event carried no stacktrace at all.
    assert.equal(marketingBeforeSend(event('Importing a module script failed.')), null);
  });

  it('drops the Chrome and Firefox phrasings and the link-time counterpart', () => {
    for (const value of [
      'Failed to fetch dynamically imported module: https://www.worldmonitor.app/pro/assets/index-a1b2c3.js',
      'error loading dynamically imported module',
      "Importing binding name 'WelcomeApp' is not found.",
    ]) {
      assert.equal(marketingBeforeSend(event(value)), null, `expected ${value} dropped`);
    }
  });

  it('ignores the Sentry SDK chunk when deciding first-partyness', () => {
    // Only frame is Sentry's own hashed chunk → still no first-party evidence.
    assert.equal(
      marketingBeforeSend(event('Importing a module script failed.', [
        '/pro/assets/sentry-DMxp_zBn.js',
      ])),
      null,
    );
  });

  // Positive control for the `!hasFirstParty` gate. A module-load failure that
  // DOES ride one of our own chunks is a real `import()` regression and must
  // survive; drop the gate and this goes red.
  it('keeps a module-load failure that carries a marketing-bundle frame', () => {
    const kept = event('Failed to fetch dynamically imported module', [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a module-load failure that carries a source-mapped frame', () => {
    const kept = event('Importing a module script failed.', ['pro-test/src/WelcomeApp.tsx']);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control: an ordinary crash must pass straight through.
  it('keeps an ordinary first-party crash', () => {
    const kept = event("Cannot read properties of undefined (reading 'plan')", [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('marketingBeforeSend — injected-script recursion', () => {
  it('drops the document-framed stack overflow (WORLDMONITOR-103)', () => {
    // Verbatim production event: Chrome Mobile iOS, every frame on the
    // prerendered document, whose reported lines sit inside inert JSON-LD.
    assert.equal(
      marketingBeforeSend(event('Maximum call stack size exceeded.', [
        'https://www.worldmonitor.app/',
        'https://www.worldmonitor.app/',
      ])),
      null,
    );
  });

  it('drops the Chrome and Firefox phrasings', () => {
    for (const value of ['Maximum call stack size exceeded', 'too much recursion']) {
      assert.equal(
        marketingBeforeSend(event(value, ['https://www.worldmonitor.app/'])),
        null,
        `expected ${value} dropped`,
      );
    }
  });

  // Positive control for the `!hasFirstParty` gate. A render loop inside our
  // own bundle is the realistic first-party cause of this exact message and
  // must still page; delete the gate and this goes red.
  it('keeps a stack overflow that carries a marketing-bundle frame', () => {
    const kept = event('Maximum call stack size exceeded.', [
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a stack overflow that carries a source-mapped frame', () => {
    const kept = event('too much recursion', ['pro-test/src/WelcomeApp.tsx']);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control that the recursion pattern is not broad enough to swallow
  // an ordinary frameless crash from this bundle.
  it('keeps an unrelated frameless error', () => {
    const kept = event('Dodo checkout session could not be created');
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('marketing ignoreErrors — in-app-browser injected globals (2026-08-27 triage)', () => {
  it("drops Twitter's in-app browser chrome script (WORLDMONITOR-10T, -10V)", () => {
    // Verbatim production values. The Twitter iOS in-app browser draws its own
    // toolbar over the page and its layout script (`init`,
    // `updateFooterPositions`, `updateGapFiller`) reads these before the host
    // defines them.
    assert.equal(isIgnored('ReferenceError', "Can't find variable: currentInset"), true);
    assert.equal(isIgnored('ReferenceError', "Can't find variable: CONFIG"), true);
  });

  // Positive control for the `\b` bound: the pattern must key on the whole
  // identifier, not a prefix a first-party name could share.
  it('keeps a longer identifier that merely starts with a suppressed name', () => {
    assert.equal(isIgnored('ReferenceError', "Can't find variable: CONFIGURATION"), false);
    assert.equal(isIgnored('ReferenceError', "Can't find variable: currentInsetTop"), false);
  });

  it("drops the Friendly app's media-player bridge (WORLDMONITOR-10Z)", () => {
    assert.equal(
      isIgnored(
        'TypeError',
        "undefined is not an object (evaluating 'window.__65829_Friendly.mediaPlayerBridge.resumePlayingInBackground')",
      ),
      true,
    );
    // The numeric infix rotates per install, so the pattern must match the
    // shape, not the one instance observed.
    assert.equal(
      isIgnored('TypeError', "undefined is not an object (evaluating 'window.__41_Friendly.x')"),
      true,
    );
  });

  it('keeps a Friendly-like name that is not the GUID-suffixed global', () => {
    assert.equal(isIgnored('ReferenceError', "Can't find variable: FriendlyHelper"), false);
  });

  it("drops Apple's WKWebView find-on-page bridge (WORLDMONITOR-10W)", () => {
    assert.equal(
      isIgnored('ReferenceError', "Can't find variable: WKWebView_RemoveAllHighlights"),
      true,
    );
    // Chrome/Android phrasing of the same missing global.
    assert.equal(isIgnored('ReferenceError', 'WKWebView_SetHighlight is not defined'), true);
  });

  it('keeps the unprefixed WKWebView word so a real message still reports', () => {
    assert.equal(isIgnored('Error', 'WKWebView failed to render our checkout frame'), false);
  });

  it("drops Android WebView's Java-bridge teardown error (WORLDMONITOR-117)", () => {
    // Verbatim production value: Instagram 415 on Android 13, fired from a
    // `beforeunload` listener, with only infra frames (the `/pro/assets/
    // sentry-*.js` chunk and two `<anonymous>`) — so `marketingBeforeSend`'s
    // frame gates have nothing to act on and this must be message-level.
    assert.equal(
      isIgnored('Error', 'Error invoking enableButtonsClickedMetaDataLogging: Java object is gone'),
      true,
    );
    // The method name in the sentence is whatever bridge the host app called,
    // so the pattern keys on Chromium's fixed suffix, not the one observed
    // method.
    assert.equal(isIgnored('Error', 'Error invoking getDeviceInfo: Java object is gone'), true);
  });

  it('drops the envelope with a non-ASCII bridge method name', () => {
    // Java identifiers are not ASCII-only — `@JavascriptInterface
    // obtenirDonnées()` is legal and Chromium emits the same sentence for it.
    // An `[\w$]+` slot silently misses these because JavaScript's `\w` is
    // ASCII-only, which is what these controls exist to catch (PR #7356
    // review).
    assert.equal(isIgnored('Error', 'Error invoking obtenirDonnées: Java object is gone'), true);
    assert.equal(isIgnored('Error', 'Error invoking 获取设备信息: Java object is gone'), true);
    assert.equal(isIgnored('Error', 'Error invoking процесс: Java object is gone'), true);
  });

  it('keeps a first-party message that merely CONTAINS the phrase', () => {
    // The control that matters, and the one an unanchored `/Java object is
    // gone/` fails: `ignoreErrors` is frame-blind, so a substring pattern drops
    // this even with a `/pro/assets/*.js` frame on the stack. Changing a word
    // the pattern requires (`gateway` for `object`) does NOT exercise this —
    // that control passes against the unanchored pattern too, so it can never
    // fail (PR #7354 review).
    assert.equal(isIgnored('Error', 'Our Java object is gone'), false);
    assert.equal(isIgnored('Error', 'Session expired: Java object is gone'), false);
    assert.equal(
      isIgnored('Error', 'Error invoking foo: Java object is gone (retrying)'),
      false,
    );
  });

  it('keeps other Java-flavoured messages so a real one still reports', () => {
    assert.equal(isIgnored('Error', 'Java object is missing'), false);
    assert.equal(isIgnored('Error', 'Our Java gateway is gone'), false);
  });
});

describe('marketingBeforeSend — Safari-masked injected script (WORLDMONITOR-110)', () => {
  it('drops a readonly-property write whose only executable frames are masked', () => {
    // Verbatim production stack: iOS 18.7 / Mobile Safari 26.6, four
    // `webkit-masked-url://hidden/` frames plus the prerendered document.
    assert.equal(
      marketingBeforeSend(event('Attempting to change value of a readonly property.', [
        'webkit-masked-url://hidden/',
        'webkit-masked-url://hidden/',
        '[native code]',
        'https://www.worldmonitor.app/',
      ])),
      null,
    );
  });

  // Positive control for the `!hasFirstParty` half: a strict-mode write to a
  // frozen object inside our own bundle raises this exact message and must
  // still page. Delete the gate and this goes red.
  it('keeps the same message when a marketing-bundle frame is present', () => {
    const kept = event('Attempting to change value of a readonly property.', [
      'webkit-masked-url://hidden/',
      '/pro/assets/index-a1b2c3.js',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control for the masked-frame half: absence of first-party frames
  // alone must not suppress — the masked frame is what licenses the drop.
  it('keeps the same message when no frame is masked', () => {
    const kept = event('Attempting to change value of a readonly property.', [
      'https://www.worldmonitor.app/',
    ]);
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('marketingBeforeSend — unparseable module (WORLDMONITOR-TS)', () => {
  // `action: null` means "no tags on the event at all". It must NOT be spelled
  // `undefined`: a default parameter fires on an explicit `undefined` argument,
  // so the no-tag case would silently get `load-clerk` and the gate's positive
  // control would assert nothing.
  const typedEvent = (
    type: string,
    value: string,
    filenames: string[] = [],
    action: string | null = 'load-clerk',
  ): PolicyEvent => ({
    exception: {
      values: [{
        type,
        value,
        stacktrace: { frames: filenames.map((filename) => ({ filename })) },
      }],
    },
    ...(action === null ? {} : { tags: { action } }),
  });

  it("drops the zero-frame Clerk parse failure on a 2020 browser", () => {
    // Verbatim production event: Chrome Mobile 80 / Android 10 (TECNO KE5k),
    // `action: load-clerk`, no frames — the throw happens at parse time.
    assert.equal(marketingBeforeSend(typedEvent('SyntaxError', "Unexpected token '('")), null);
    assert.equal(marketingBeforeSend(typedEvent('SyntaxError', 'Invalid or unexpected token')), null);
  });

  it('drops the same failure from the other two Clerk loader catches', () => {
    for (const action of ['load-clerk-for-nav', 'open-sign-in']) {
      assert.equal(
        marketingBeforeSend(typedEvent('SyntaxError', "Unexpected token '('", [], action)),
        null,
        `expected ${action} dropped`,
      );
    }
  });

  // Positive control for the action gate — the whole point of PR #7218's review
  // round. An identically-shaped parse rejection that did NOT come from a named
  // SDK-loader catch (an unhandled `import()` rejection, or a loader added
  // later without being allowlisted) must still report: that shape is how a
  // genuinely broken chunk would arrive, and swallowing it would hide it.
  it('keeps an identically-shaped parse failure with no action tag', () => {
    const kept = typedEvent('SyntaxError', "Unexpected token '('", [], null);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a parse failure from an action that is not an SDK loader', () => {
    const kept = typedEvent('SyntaxError', "Unexpected token '('", [], 'check-entitlement');
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control for the type gate: a first-party bug raises TypeError, not
  // SyntaxError, and must survive even with an identical message and no frames.
  it('keeps the same frameless message under a non-SyntaxError type', () => {
    const kept = typedEvent('TypeError', "Unexpected token '('");
    assert.equal(marketingBeforeSend(kept), kept);
  });

  // Positive control for the empty-stack gate: an in-bundle `JSON.parse` on a
  // malformed API body throws exactly this and carries the calling frame.
  it('keeps a SyntaxError that carries a marketing-bundle frame', () => {
    const kept = typedEvent('SyntaxError', "Unexpected token '<'", ['/pro/assets/index-a1b2c3.js']);
    assert.equal(marketingBeforeSend(kept), kept);
  });

  it('keeps a SyntaxError whose message is not a parse failure', () => {
    const kept = typedEvent('SyntaxError', 'Invalid regular expression: missing /');
    assert.equal(marketingBeforeSend(kept), kept);
  });
});

describe('third-party SDK loader allowlist stays true to the call sites', () => {
  // The parse rule's safety argument is "these are the only catches that stamp
  // an SDK-load action". Pin it to the source so a new loader tag added without
  // updating THIRD_PARTY_SDK_LOAD_ACTIONS is caught here rather than silently
  // widening (or narrowing) the suppression.
  it('every allowlisted action exists as a capture tag under pro-test/src', () => {
    const files = ['App.tsx', 'services/checkout.ts', 'services/clerk.ts']
      .map((f) => readFileSync(resolve(root, 'pro-test/src', f), 'utf8'))
      .join('\n');
    for (const action of ['load-clerk', 'load-clerk-for-nav', 'open-sign-in']) {
      assert.ok(
        files.includes(`action: '${action}'`),
        `allowlisted action ${action} has no capture call site`,
      );
    }
  });
});

describe('policy wiring', () => {
  // A perfect policy that nothing calls filters nothing. The values themselves
  // are exercised above; this only proves `Sentry.init` actually receives them.
  it('initSentry passes both halves of the policy to Sentry.init', () => {
    const source = readFileSync(resolve(root, 'pro-test/src/sentry.ts'), 'utf8');
    assert.match(source, /from '\.\/sentry-filter-policy'/);
    assert.match(source, /ignoreErrors:\s*MARKETING_IGNORE_ERRORS/);
    assert.match(
      source,
      /beforeSend:\s*\(event\)\s*=>\s*\{\s*const filteredEvent = marketingBeforeSend\(event\);/,
    );
    assert.match(source, /sanitizeMarketingRequestUrl\(filteredEvent\.request\.url\)/);
  });

  it('does not copy the dashboard array wholesale', () => {
    // The dashboard list is vetted against a different bundle (deck.gl /
    // MapLibre / Convex). If someone bulk-copies it here, the marketing surface
    // silently inherits suppressors for messages this bundle can emit.
    const dashboard = readFileSync(resolve(root, 'src/bootstrap/sentry-init.ts'), 'utf8');
    const dashboardCount = (dashboard.match(/^\s{6}\/.*\/,\s*(\/\/.*)?$/gm) ?? []).length;
    assert.ok(dashboardCount > 100, `sanity: expected a large dashboard array, got ${dashboardCount}`);
    assert.ok(
      MARKETING_IGNORE_ERRORS.length < 20,
      `marketing array must stay a vetted subset, got ${MARKETING_IGNORE_ERRORS.length}`,
    );
  });

  // The WORLDMONITOR-10N no-listener entry is frame-blind (ignoreErrors runs
  // before marketingBeforeSend, and the observed event carried zero frames),
  // so its only safety argument is that this surface can never itself produce
  // a runtime-messaging rejection. That premise lives in the array's comments;
  // this test turns it into a failing check. If it goes red, either move the
  // suppression behind marketingBeforeSend's first-party-frame gate or
  // re-justify message-level suppression for the new call site. Note the same
  // limit the comment carries: this covers pro-test sources, not bundled
  // vendor chunks.
  it('keeps the no-listener admission true: no runtime-messaging call site under pro-test/src', () => {
    const files = readdirSync(resolve(root, 'pro-test/src'), { recursive: true })
      .map((entry) => String(entry))
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('sentry-filter-policy.ts'));
    assert.ok(files.length > 0, 'sanity: expected to scan pro-test sources');
    const offenders = files.filter((file) =>
      /chrome\.runtime|browser\.runtime|\bsendMessage\b/.test(
        readFileSync(resolve(root, 'pro-test/src', file), 'utf8'),
      ),
    );
    assert.deepEqual(offenders, []);
  });
});

// ─── WORLDMONITOR-107: wallet-extension JSON-RPC rejection ────────────────────
//
// `{code: -32603, message: "Internal JSON-RPC error."}` rejected into
// `onunhandledrejection` on `https://www.worldmonitor.app/`. Sentry has no
// Error to work with, so it synthesises
// `UnhandledRejection: Object captured as promise rejection with keys: code, message`
// with `stacktrace: null` and stores the object at `extra.__serialized__`.
//
// The dashboard has dropped this shape since #4005 via a bare
// `/^Object captured as promise rejection with keys:/` in `ignoreErrors`. The
// marketing bundle runs a separate client, which is the same gap that let
// WORLDMONITOR-15/-102/-108/-10N/-10T through — but the dashboard's wording-only
// entry is NOT safe to copy here: this React bundle can itself reject with a
// plain object, and a synthetic rejection has no stack, so `!hasFirstParty`
// cannot tell ours from an extension's.
//
// The JSON-RPC reserved error range is the discriminator instead, and it is
// structural rather than a wording heuristic: `pro-test/src` holds no JSON-RPC
// client at all (it speaks REST to our API and to Clerk), so a payload carrying
// a −32768..−32000 `code` can only come from an injected EIP-1193 wallet
// provider. Same design as THIRD_PARTY_SDK_LOAD_ACTIONS above — name the thing
// that proves third-party origin, don't pattern-match the prose.
describe('marketing beforeSend — wallet JSON-RPC rejection (WORLDMONITOR-107)', () => {
  const rejection = (code: unknown): PolicyEvent => ({
    exception: {
      values: [{
        type: 'UnhandledRejection',
        value: 'Object captured as promise rejection with keys: code, message',
      }],
    },
    extra: { __serialized__: { code, message: 'Internal JSON-RPC error.' } },
  });

  it('drops the verbatim production event', () => {
    assert.equal(marketingBeforeSend(rejection(-32603)), null);
  });

  it('drops the rest of the JSON-RPC reserved range', () => {
    // -32000 (server error) and -32700 (parse error) bound the reserved block;
    // wallets use several of them (4001 user-rejected is NOT in this range and
    // is deliberately left reporting).
    for (const code of [-32000, -32700, -32768]) {
      assert.equal(marketingBeforeSend(rejection(code)), null, `code ${code}`);
    }
  });

  it('KEEPS a plain-object rejection whose code is outside the reserved range', () => {
    // Positive control: our own bundle rejecting with `{code, message}` — an
    // HTTP status, an app error code, EIP-1193's own 4001 — must still report.
    for (const code of [500, 4001, -1, 0]) {
      assert.ok(marketingBeforeSend(rejection(code)) !== null, `code ${code}`);
    }
  });

  it('KEEPS the rejection when no serialized code is present at all', () => {
    // Absence of evidence is not evidence of an extension.
    assert.ok(marketingBeforeSend(rejection(undefined)) !== null);
    assert.ok(marketingBeforeSend(rejection('-32603')) !== null, 'string code is not proof');
    assert.ok(marketingBeforeSend({
      exception: { values: [{ type: 'UnhandledRejection', value: 'Object captured as promise rejection with keys: code, message' }] },
    }) !== null, 'no extra at all');
  });

  it('KEEPS an unrelated EXCEPTION VALUE even with a reserved-range code', () => {
    // The rule needs BOTH halves; a real first-party error that happens to
    // carry a JSON-RPC-shaped code must not be swallowed by the range alone.
    // "Message" here means the synthetic exception value Sentry built — NOT the
    // rejected payload's own `message`, which the next test pins separately.
    assert.ok(marketingBeforeSend({
      exception: { values: [{ type: 'TypeError', value: 'Cannot read properties of undefined (reading "plan")' }] },
      extra: { __serialized__: { code: -32603, message: 'Internal JSON-RPC error.' } },
    }) !== null);
  });

  it('ignores the PAYLOAD message entirely — the code is the whole discriminator', () => {
    // Asked for in review (PR #7241): `{code: -32603, message: 'checkout
    // failed'}` IS dropped, and that is deliberate. Requiring the literal
    // "Internal JSON-RPC error." would reintroduce exactly the wording
    // heuristic this rule was designed to avoid — wallets emit many different
    // strings inside the reserved block (-32002 "Request already pending", and
    // provider-specific texts), so a message match would shrink coverage and
    // break on the next wallet. The reserved range is protocol-defined; the
    // message is free text.
    //
    // What licenses ignoring it is the JSON-RPC-free invariant below: no
    // first-party code on this surface can mint a -32768..-32000 code at all,
    // whatever message it pairs with. Pinned so a later "fix" toward
    // message-matching has to argue with a red test.
    for (const message of ['checkout failed', '', 'Internal JSON-RPC error.', 'user rejected']) {
      assert.equal(
        marketingBeforeSend({
          exception: {
            values: [{
              type: 'UnhandledRejection',
              value: 'Object captured as promise rejection with keys: code, message',
            }],
          },
          extra: { __serialized__: { code: -32603, message } },
        }),
        null,
        `payload message ${JSON.stringify(message)} must not change the verdict`,
      );
    }
  });

  it('pins the marketing bundle as JSON-RPC-free, which is what licenses the rule', () => {
    // If a JSON-RPC client is ever added to this surface, the reserved-range
    // discriminator stops proving third-party origin and this suppression must
    // be re-derived. Fails loudly instead of silently widening.
    const offenders = marketingFirstPartySources()
      .filter((f) => !f.rel.includes('sentry-filter-policy'))
      .filter((f) => /jsonrpc|JSON-RPC|json_rpc/i.test(f.code))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [],
      'a JSON-RPC client on the marketing surface invalidates the WORLDMONITOR-107 rule');
  });

  it('the JSON-RPC scan reaches the whole bundle, shared/ included', () => {
    // Two ways the invariant above could pass vacuously: a walk that returns
    // nothing, and a walk that stops at `pro-test/src` — the exact hole this
    // pass closed. Both are pinned here, so the scan is known to have teeth.
    const files = marketingFirstPartySources().map((f) => f.rel);
    assert.ok(files.length > 20, `walk must reach the real tree, got ${files.length} files`);
    assert.ok(files.includes('pro-test/src/App.tsx'), 'walk must include the app root');
    for (const rel of MARKETING_INLINE_SCRIPT_FILES) {
      assert.ok(files.includes(rel), `walk must include ${rel}`);
    }
    const shared = files.filter((f) => f.startsWith('shared/'));
    assert.ok(shared.length >= 3,
      `walk must follow the out-of-tree imports, got ${JSON.stringify(shared)}`);
    const nestedSharedImports = marketingFirstPartySources()
      .filter((f) => f.rel.startsWith('shared/'))
      .flatMap((f) => [...f.code.matchAll(/(?:import|export).*from ['"](\.[^'"]+)['"]/g)]
        .map((match) => `${f.rel}: ${match[1]}`));
    assert.deepEqual(nestedSharedImports, [],
      'shared leaves gained relative imports; make the source inventory recursive');
  });
});

describe('marketing beforeSend — document-URL frames (WORLDMONITOR-115)', () => {
  const instagramFrames = [
    { filename: '/pro' },
    { filename: '/pro' },
    { filename: '/pro' },
    { filename: '/pro' },
    { filename: '[native code]' },
    { filename: '/pro' },
    { filename: '/pro' },
  ];

  const injected = (value: string, frames = instagramFrames): PolicyEvent => ({
    exception: { values: [{ type: 'TypeError', value, stacktrace: { frames } }] },
  });

  it('drops the verbatim production event', () => {
    assert.equal(
      marketingBeforeSend(injected("null is not an object (evaluating 'e.contentWindow.postMessage')")),
      null,
    );
  });

  it('drops the same shape served from the absolute document URL', () => {
    const abs = instagramFrames.map((f) =>
      f.filename === '/pro' ? { filename: 'https://www.worldmonitor.app/pro' } : f);
    assert.equal(
      marketingBeforeSend(injected("undefined is not an object (evaluating 'e.contentWindow')", abs)),
      null,
    );
  });

  it('drops the same shape on every marketing document route variant', () => {
    for (const filename of [
      '/',
      '/?utm_source=test',
      '/pro/',
      '/pro#pricing',
      'https://preview.example.com/',
      'https://custom.example.com/pro/?utm_source=test#pricing',
    ]) {
      assert.equal(marketingBeforeSend(injected(
        "null is not an object (evaluating 'e.contentWindow.postMessage')",
        [{ filename }],
      )), null, filename);
    }
  });

  it('drops a TypeError-prefixed value when Sentry omits the exception type', () => {
    const ev: PolicyEvent = {
      exception: {
        values: [{
          value: "TypeError: null is not an object (evaluating 'e.contentWindow.postMessage')",
          stacktrace: { frames: instagramFrames },
        }],
      },
    };
    assert.equal(marketingBeforeSend(ev), null);
  });

  it('KEEPS the same message when a marketing bundle chunk is on the stack', () => {
    const withOurs = [...instagramFrames, { filename: '/pro/assets/index-A1b2C3.js' }];
    assert.ok(marketingBeforeSend(injected('null is not an object (evaluating \'e.contentWindow.postMessage\')', withOurs)) !== null);
  });

  it('KEEPS a linked event with a first-party parent exception', () => {
    const ev: PolicyEvent = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "null is not an object (evaluating 'e.contentWindow.postMessage')",
            stacktrace: { frames: instagramFrames },
          },
          {
            type: 'Error',
            value: 'checkout failed',
            stacktrace: { frames: [{ filename: '/pro/assets/index-A1b2C3.js' }] },
          },
        ],
      },
    };
    assert.ok(marketingBeforeSend(ev) !== null);
  });

  it('KEEPS a first-party inline-script TypeError on the same frames', () => {
    for (const value of [
      "null is not an object (evaluating 'l.rel')",
      "undefined is not an object (evaluating 'MONITORS.world')",
      'links.querySelectorAll is not a function',
    ]) {
      assert.ok(
        marketingBeforeSend(injected(value)) !== null,
        `first-party inline-script error must survive: ${value}`,
      );
    }
  });

  it('KEEPS a non-TypeError with the same frames', () => {
    const ev: PolicyEvent = {
      exception: {
        values: [{
          type: 'Error',
          value: "null is not an object (evaluating 'e.contentWindow.postMessage')",
          stacktrace: { frames: instagramFrames },
        }],
      },
    };
    assert.ok(marketingBeforeSend(ev) !== null);
  });

  it('KEEPS a TypeError whose frames are real script files', () => {
    const scripts = [{ filename: 'https://cdn.example.com/widget.js' }, { filename: '/pro/assets/x-Ab12Cd.js' }];
    assert.ok(marketingBeforeSend(injected(
      "null is not an object (evaluating 'e.contentWindow.postMessage')",
      scripts,
    )) !== null);
  });

  it('KEEPS the same message on extensionless non-document script URLs', () => {
    for (const filename of ['/widget', 'https://cdn.example.com/widget']) {
      assert.ok(marketingBeforeSend(injected(
        "null is not an object (evaluating 'e.contentWindow.postMessage')",
        [{ filename }],
      )) !== null, filename);
    }
  });

  it('KEEPS a TypeError with no frames at all', () => {
    assert.ok(marketingBeforeSend(injected(
      "null is not an object (evaluating 'e.contentWindow.postMessage')",
      [],
    )) !== null);
  });

  it('pins the whole surface as contentWindow-free, inline scripts included', () => {
    const sources = marketingFirstPartySources()
      .filter((f) => !f.rel.includes('sentry-filter-policy'));
    const offenders = sources.filter((f) => /contentWindow/.test(f.code)).map((f) => f.rel);
    assert.deepEqual(offenders, [],
      'the marketing surface now touches an iframe contentWindow — re-derive the WORLDMONITOR-115 rule');

    for (const rel of ['pro-test/welcome.html', 'pro-test/prerender.mjs']) {
      const body = sources.find((f) => f.rel === rel)?.code ?? '';
      assert.ok(body.length > 500, `${rel} did not resolve`);
      assert.match(body, /<script|SCRIPT =/, `${rel} is expected to carry inline script`);
    }
  });
});
