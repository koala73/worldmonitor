/**
 * Marketing-surface Sentry filtering policy.
 *
 * `/` (rewritten to `/pro/welcome.html`) and `/pro` render from this bundle,
 * whose Sentry client is a SEPARATE `@sentry/react` init (`./sentry.ts`). The
 * dashboard's ~250-entry `ignoreErrors` array and its `beforeSend` live in
 * `src/bootstrap/sentry-init.ts` and never run here, so browser/extension noise
 * the dashboard has filtered for months still lands as marketing-surface
 * issues. The 2026-08-19 triage found five, every one sent by
 * `sentry.javascript.react` with a null release (the dashboard SDK reports as
 * `sentry.javascript.browser` and always carries `worldmonitor@<version>`):
 * WORLDMONITOR-ZY, -ZX, -ZZ, -ZW and -15. WORLDMONITOR-15 is named in the
 * dashboard's own suppressor comment in `src/bootstrap/sentry-init.ts` — it has
 * been dropped there since #4005 and leaked here the whole time.
 *
 * Deliberately NOT a copy of the dashboard array. Those entries were vetted
 * against the dashboard bundle (deck.gl / MapLibre / Convex / IndexedDB);
 * copying them wholesale would suppress messages this React bundle genuinely
 * can emit, which is the exact observability blind spot `ignoreErrors` is
 * supposed to avoid. Only patterns impossible from ANY first-party bundle
 * belong here — anything that could come from our own minified output goes in
 * `marketingBeforeSend` behind the first-party-frame gate instead.
 *
 * Kept dependency-free (no `@sentry/react` import) so
 * `tests/pro-sentry-filter-policy.test.mts` can import the real values rather
 * than re-deriving them from source text — same reason as `./sentry-allow-urls.ts`.
 */

/** Minimal structural view of the Sentry event fields this policy reads. */
interface PolicyFrame {
  filename?: string;
}
interface PolicyException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: PolicyFrame[] };
}
export interface PolicyEvent {
  exception?: { values?: PolicyException[] };
  tags?: Record<string, string | number | boolean | undefined>;
  /**
   * Where Sentry parks the rejected value when a promise rejects with a
   * non-Error: `eventFromUnknownInput` synthesises the exception and copies the
   * original object to `extra.__serialized__`. It is the only surviving
   * evidence of what actually rejected, because such an event carries no stack.
   */
  extra?: { __serialized__?: Record<string, unknown> };
}

const SAFE_MARKETING_PATH = /^\/(?:pro\/?)?$/;
const SAFE_MARKETING_HASH = /^#(?:pricing|tiers|api|enterprise|enterprise-contact)$/i;
const MAX_MARKETING_ORIGIN_LENGTH = 200;

/**
 * Strip attribution, checkout, and auth-handoff data from the browser URL that
 * Sentry's default HttpContext integration attaches to every event. Only this
 * bundle's public routes and named in-page sections are useful for diagnosis.
 */
export function sanitizeMarketingRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.origin.length > MAX_MARKETING_ORIGIN_LENGTH ||
        !SAFE_MARKETING_PATH.test(url.pathname)) {
      return undefined;
    }
    const pathname = url.pathname === '/pro/' ? '/pro' : url.pathname;
    const safeHash = SAFE_MARKETING_HASH.test(url.hash) ? url.hash : '';
    return `${url.origin}${pathname}${safeHash}`;
  } catch {
    return undefined;
  }
}

export const MARKETING_IGNORE_ERRORS: RegExp[] = [
  /ResizeObserver loop/,
  /^TypeError: Load failed/,
  /^TypeError: Failed to fetch/,
  /^TypeError: NetworkError/,
  /Non-Error promise rejection captured with value:/,
  // WKWebView host-app JS bridge timeout — Apple WebKit emits this exact phrase
  // when a JS-to-native `postMessage` gets no reply within the host's window.
  // Common in the in-app browsers that open marketing links (DuckDuckGo,
  // Instagram, Reddit). We never postMessage to a WKScriptMessageHandler, so it
  // is browser-native and unactionable. Verbatim from the dashboard array,
  // where it has run since WORLDMONITOR-KJ (WORLDMONITOR-ZY).
  /WKWebView API client did not respond to this postMessage/,
  // Browser-extension messaging API. `chrome.runtime`/`browser.runtime` is only
  // reachable from an extension context; this bundle never calls it, so the
  // rejection always belongs to an extension injected into the page
  // (WORLDMONITOR-ZX).
  /runtime\.sendMessage\(\)/,
  // The no-listener half of the same extension messaging API: Chrome emits
  // this exact sentence when a `runtime`/`tabs` sendMessage reaches a context
  // with no `onMessage` receiver (a content script not yet injected, or a
  // service worker that has shut down). A different sentence from the entry
  // above, so that pattern does not cover it. `pro-test/src` holds no
  // chrome.runtime/tabs.sendMessage call site — the only textual occurrences
  // are the suppressor patterns in this very file, which is what the grep
  // verification covers and what the policy-wiring suite locks in — so the
  // rejection always belongs to
  // an extension injected into the page. Already suppressed on the dashboard
  // in `src/bootstrap/sentry-init.ts`; the two surfaces run separate Sentry
  // clients, so the marketing copy was the gap that let WORLDMONITOR-10N
  // through as an unhandled rejection with zero frames.
  /Could not establish connection\. Receiving end does not exist/,
  // Zalo's in-app browser (Vietnam's dominant messaging app) injects a JS
  // bridge that references `zaloJSV2` before the host app defines it. Same
  // class as the `WeixinJSBridge` entry in the dashboard array: a named
  // in-app-browser global. Our source contains no `zaloJSV2` identifier at
  // all, so this can never come from our own bundle, minified or not
  // (WORLDMONITOR-102).
  /\bzaloJSV2\b/,
  // Twitter's iOS in-app browser injects its own chrome script into the
  // document (`init`, `updateFooterPositions`, `updateGapFiller` — the toolbar
  // inset/gap-filler layout it draws over the page) and that script references
  // `currentInset` / `CONFIG` before the host app defines them. Neither
  // identifier, nor any of those function names, appears anywhere in `src/`,
  // `pro-test/src/`, `api/`, `public/` or `index.html` — the only textual
  // occurrences in the repo are the suppressor patterns here and the
  // dashboard's. Already suppressed on the dashboard since #4005
  // (`src/bootstrap/sentry-init.ts` carries both names in its
  // `Can.t find variable: (CONFIG|currentInset|…)` entry); the two surfaces run
  // separate Sentry clients, so the missing marketing copy is what let
  // WORLDMONITOR-10T and -10V through (browser tag `Twitter 12.18` / `12.19`,
  // frames on the prerendered document itself).
  /Can't find variable: (?:CONFIG|currentInset)\b/,
  // The "Friendly" social-reader iOS app injects a media-player bridge under a
  // per-install GUID-suffixed global (`window.__65829_Friendly`) and its own
  // `setTimeout` callback dereferences `mediaPlayerBridge` before the host
  // registers it. A named in-app-browser global, same class as `zaloJSV2`
  // above: the identifier is absent from both bundles, and the numeric infix
  // rotates per install, so match on the stable `__<digits>_Friendly` shape
  // rather than one observed instance (WORLDMONITOR-10Z).
  /\b__\d+_Friendly\b/,
  // Apple's native WKWebView find-on-page bridge. The host app evaluates
  // `WKWebView_RemoveAllHighlights()` in the page when the user dismisses the
  // in-app find bar, and it is undefined in web content the host never
  // instrumented. `WKWebView_` is Apple's native-bridge prefix and appears in
  // neither bundle — the sibling `WKWebView API client did not respond to this
  // postMessage` entry above covers the same bridge from the other direction
  // (WORLDMONITOR-10W, whose dashboard-side copy is added in the same pass).
  /\bWKWebView_[A-Za-z]\w*/,
  // Android WebView's Java-bridge teardown error. Chromium's `android_webview`
  // emits this exact sentence — `Error invoking <method>: Java object is gone` —
  // when injected JS calls a `@JavascriptInterface` method whose Java object has
  // already been garbage-collected or detached, which is what happens when an
  // in-app browser's own chrome script runs during `beforeunload`. The observed
  // event is Instagram 415 on Android 13 calling its own
  // `enableButtonsClickedMetaDataLogging` bridge; neither that method name nor
  // the phrase appears anywhere in this bundle, and a pure-web bundle has no
  // `@JavascriptInterface` object to lose, so it can never be ours. Already
  // suppressed on the dashboard since #4005 (`/Java object is gone/` in
  // `src/bootstrap/sentry-init.ts`); the two surfaces run separate Sentry
  // clients, so the missing marketing copy is what let WORLDMONITOR-117 through
  // with three infra-only frames (the `/pro/assets/sentry-*.js` chunk plus two
  // `<anonymous>`), which `marketingBeforeSend`'s frame gates cannot act on.
  //
  // Anchored to the whole sentence, unlike the dashboard's bare
  // `/Java object is gone/`. `ignoreErrors` is frame-blind, so an unanchored
  // substring also drops any first-party message that happens to CONTAIN the
  // phrase (`Our Java object is gone`) even when its stack points straight at
  // `/pro/assets/*.js` — the observability blind spot this array exists to
  // avoid. Only the complete Chromium shape is third-party by construction, so
  // only that shape is suppressed; the method name varies per host-app bridge,
  // so it is matched by shape rather than pinned to the one observed
  // (PR #7354 review).
  //
  // The method slot is "anything but whitespace or a colon", NOT `[\w$]+`:
  // Java identifiers are not ASCII-only (`@JavascriptInterface
  // obtenirDonnées()` is legal, and Chromium emits the same sentence for it)
  // while JavaScript's `\w` is, so an ASCII slot silently misses them. Widening
  // it cannot loosen the rule — the envelope is anchored at both ends and the
  // reason is fixed, so this matches only if our own bundle emits the whole
  // Chromium sentence. Java method names hold no colon, so excluding one keeps
  // the slot off the reason separator (PR #7356 review).
  /^Error invoking [^\s:]+: Java object is gone$/,
  // iOS in-app WebView native bridge. The host app injects `sendDataToNative` /
  // `sendPageHideMessage` into the document and they dereference
  // `window.webkit.messageHandlers`, which only exists when a WKWebView host
  // registered a script-message handler — so it is undefined in the plain
  // browsers those in-app views also run. Neither identifier appears anywhere
  // in either bundle, and this array's sibling `WKWebView API client did not
  // respond to this postMessage` entry covers the same injected bridge from
  // the other direction. Already suppressed on the dashboard since
  // WORLDMONITOR-KJ (`src/bootstrap/sentry-init.ts`); the two surfaces run
  // separate Sentry clients, so the marketing copy was the gap that let
  // WORLDMONITOR-108 through.
  /webkit\.messageHandlers/,
];

/** Sentry's own hashed SDK chunk — infrastructure, never evidence of our code. */
const SENTRY_CHUNK_FRAME = /\/assets\/sentry-[A-Za-z0-9_-]+\.js/;
/** Marketing bundle output. `pro-test/vite.config.ts` sets `base: '/pro/'`. */
const MARKETING_ASSET_FRAME = /\/pro\/assets\/[A-Za-z0-9_-]+\.js/;
/** A whole message that is nothing but a short identifier. */
const BARE_SYMBOL_MESSAGE = /^[a-zA-Z_$]+$/;
/**
 * Every browser phrasing for "a module failed to load or link". Chrome/Edge
 * `Failed to fetch dynamically imported module`, Safari `Importing a module
 * script failed.`, Firefox `error loading dynamically imported module`, and the
 * link-time counterpart `Importing binding name '<x>' is not found.`
 */
const MODULE_LOAD_FAILURE =
  /(?:Failed to fetch|error loading) dynamically imported module|Importing a module script failed|Importing binding name '[^']*' is not found/i;
/**
 * Runaway recursion, in every browser phrasing (Chrome/Safari "Maximum call
 * stack size exceeded", Firefox "too much recursion"). Deliberately NOT in
 * `MARKETING_IGNORE_ERRORS`: our own React bundle can absolutely recurse
 * infinitely, and suppressing this by message alone would hide it.
 */
const STACK_OVERFLOW = /Maximum call stack size exceeded|too much recursion/i;
/**
 * A marketing document frame: `/`, `/pro`, or an absolute URL on any production,
 * preview, or custom host with one of those paths. Query strings, hashes, and a
 * trailing slash do not change the document identity.
 *
 * WebKit attributes a MAIN-world injected script — in-app-browser chrome,
 * WKUserScript content scripts, bookmarklets — to the DOCUMENT URL rather than
 * to a distinct `.js` URL.
 *
 * On the DASHBOARD that shape alone proves injection, because its entry is
 * always a hashed `/assets/*.js` chunk (WORLDMONITOR-V8). It does NOT prove it
 * here: these pages ship executable inline script (welcome.html's WebMCP
 * bootstrap, prerender.mjs's DEFERRED_STYLES_SCRIPT), which lands on the
 * document URL too. So this is one necessary signal among several at the call
 * site, never the whole licence on its own.
 */
const MARKETING_DOCUMENT_FRAME =
  /^(?:https?:\/\/[^/?#]+)?\/(?:pro\/?)?(?:[?#]|$)/;

/**
 * Safari's placeholder for a script it refuses to attribute to a real document
 * URL — extension content scripts and injected `eval`/blob contexts. Every
 * frame of this bundle is served from an ordinary `https://` URL, so a masked
 * frame is positive evidence of injection, not merely the absence of
 * first-party evidence.
 */
const MASKED_URL_FRAME = /^webkit-masked-url:/;
/**
 * A script the browser fetched but could not PARSE. Deliberately NOT in
 * `MARKETING_IGNORE_ERRORS`: a `SyntaxError` message is generic enough that our
 * own bundle could in principle produce one (a `JSON.parse` on a malformed API
 * body throws exactly these phrasings), so it must stay behind the frame gate.
 */
const PARSE_FAILURE = /^(?:Unexpected token|Unexpected identifier|Invalid or unexpected token|Unexpected end of (?:script|input))\b/;
/**
 * The `action` tags our third-party-SDK loader call sites stamp on a capture.
 *
 * This is the load-bearing gate on the parse rule below, and it is a call-site
 * allowlist rather than a message/shape heuristic on purpose. Keying the
 * suppression on the exception's SHAPE alone would stay correct only while the
 * marketing bundle happens to have no other dynamic import whose rejection
 * reaches Sentry — an invariant nothing enforces, which a future `import()`
 * (or a removed `.catch`) would silently break, widening the rule to swallow a
 * real broken-chunk report. Naming the call sites makes it structural: a new
 * SDK loader has to be added here deliberately.
 *
 * All three are Clerk: `ensureClerk` (`services/clerk.ts`) is the only live
 * dynamic import on this surface, awaited by these three catches.
 */
const THIRD_PARTY_SDK_LOAD_ACTIONS = new Set(['load-clerk', 'load-clerk-for-nav', 'open-sign-in']);

/**
 * Sentry's synthetic message for a promise that rejected with a plain object.
 * There is no Error, so the event carries `stacktrace: null` — which is why the
 * `!hasFirstParty` gate every other rule leans on is useless here: OUR plain
 * object and an extension's both arrive frameless.
 */
const PLAIN_OBJECT_REJECTION = /^Object captured as promise rejection with keys:/;
/**
 * JSON-RPC 2.0's reserved error block (§5.1). An injected EIP-1193 wallet
 * provider (MetaMask et al.) rejects with `{code: -32603, message: "Internal
 * JSON-RPC error."}` straight into `onunhandledrejection`.
 */
const JSON_RPC_RESERVED_MIN = -32768;
const JSON_RPC_RESERVED_MAX = -32000;

/**
 * Stack-gated suppressors for messages that our own minified bundle COULD
 * produce, so they must not go in `MARKETING_IGNORE_ERRORS` (which matches on
 * message text alone, with no access to frames).
 */
export function marketingBeforeSend<T extends PolicyEvent>(event: T): T | null {
  const exceptionValues = event.exception?.values ?? [];
  const msg = exceptionValues[0]?.value ?? '';

  // A message that is nothing but a 1-3 character identifier (`ga`, `Ba`) is an
  // injected in-app-browser/extension script rethrowing its own minified
  // symbol. Our bundles throw `Error` objects built from written-out strings;
  // even minified, the *message* text survives verbatim, so a bare short
  // identifier can never be ours. Unconditional (no frame gate) exactly as in
  // the dashboard's `beforeSend`, where it is the first statement
  // (WORLDMONITOR-ZZ, -ZW).
  if (msg.length <= 3 && BARE_SYMBOL_MESSAGE.test(msg)) return null;

  const frames = exceptionValues[0]?.stacktrace?.frames ?? [];
  const nonInfraFrames = frames.filter(
    (f) =>
      f.filename &&
      f.filename !== '<anonymous>' &&
      f.filename !== '[native code]' &&
      !SENTRY_CHUNK_FRAME.test(f.filename),
  );
  const hasFirstParty = nonInfraFrames.some(
    (f) => /\.(ts|tsx)$/.test(f.filename ?? '') || MARKETING_ASSET_FRAME.test(f.filename ?? ''),
  );

  // Stale-chunk-after-deploy: the browser fires these as synthetic TypeErrors
  // at fetch/link time, not at any first-party call site, so they arrive with
  // zero frames. A built bundle always links consistently, so at runtime this
  // is version skew (a hashed filename that 404s after a deploy), never a code
  // defect. Gated on `!hasFirstParty` so a genuine `import()` regression inside
  // our own code — which rides a `/pro/assets/*.js` frame — still surfaces
  // (WORLDMONITOR-15).
  if (!hasFirstParty && MODULE_LOAD_FAILURE.test(msg)) return null;

  // Injected-script recursion. The observed events (Chrome Mobile iOS) report
  // frames on the prerendered document itself — `https://www.worldmonitor.app/`
  // at lines that fall inside `<script type="application/ld+json">` blocks,
  // which are inert data and cannot execute. The document therefore holds no
  // executable inline JS at those offsets, so the recursion belongs to a script
  // an in-app browser injected, not to us; our own code always rides a
  // `/pro/assets/*.js` frame. Gated on `!hasFirstParty` so a genuine render
  // loop in this bundle — the realistic first-party cause — still pages
  // (WORLDMONITOR-103).
  if (!hasFirstParty && STACK_OVERFLOW.test(msg)) return null;

  // Safari-masked injected script. The observed event (WORLDMONITOR-110,
  // `TypeError: Attempting to change value of a readonly property.` on iOS
  // 18.7) runs four `webkit-masked-url://hidden/` frames through `appendChild`
  // and `defineProperty` on the prerendered document. The message itself is a
  // plain strict-mode assignment failure our own bundle could raise, which is
  // why this is a frame rule and not an `ignoreErrors` entry: the suppression
  // is licensed by the masked frame, not by the wording. Requiring BOTH a
  // masked frame and no first-party frame keeps a genuine readonly-write bug in
  // our own code reporting — it would ride a `/pro/assets/*.js` frame.
  // Dashboard-side this class is covered by the standing
  // `Attempting to change value of a readonly property` entry in
  // `src/bootstrap/sentry-init.ts`.
  if (!hasFirstParty && nonInfraFrames.some((f) => MASKED_URL_FRAME.test(f.filename ?? ''))) return null;

  // A module the browser fetched but could not parse. WORLDMONITOR-TS is the
  // shape: `action: load-clerk` on Chrome Mobile 80 / Android 10 (a 2020
  // browser on a TECNO KE5k), where `import()`-ing Clerk's SDK throws
  // `SyntaxError: Unexpected token '('` because the chunk uses syntax that
  // engine cannot parse. It arrives with zero frames — the throw happens at
  // parse time, at no call site of ours — and no first-party frame, so it is
  // the parse-time twin of the `MODULE_LOAD_FAILURE` fetch/link rule above.
  // Unactionable: the third-party SDK targets modern engines and the user's
  // browser predates them by six years.
  //
  // Gated four ways so a real defect still surfaces. The `action` tag is the
  // load-bearing one: it proves the throw came from one of our own named
  // third-party-SDK loader catches, so an unhandled parse rejection from
  // anywhere else on this surface is never eligible (see
  // THIRD_PARTY_SDK_LOAD_ACTIONS for why a shape-only rule was not enough).
  // The other three narrow within that: `SyntaxError` excludes the
  // `TypeError`/`Error` families a first-party bug would raise, the empty stack
  // excludes every in-bundle `JSON.parse` (those carry the calling frame), and
  // `!hasFirstParty` excludes anything attributable to `/pro/assets/*.js`.
  const excType = exceptionValues[0]?.type ?? '';
  const action = event.tags?.action;
  if (!hasFirstParty
      && frames.length === 0
      && excType === 'SyntaxError'
      && PARSE_FAILURE.test(msg)
      && typeof action === 'string'
      && THIRD_PARTY_SDK_LOAD_ACTIONS.has(action)) return null;

  // A browser wallet extension rejecting an EIP-1193 call into the page's
  // `onunhandledrejection`. The dashboard has dropped this shape since #4005
  // with a bare `/^Object captured as promise rejection with keys:/` in
  // `ignoreErrors`; the marketing bundle runs a separate client, which is the
  // same gap that let WORLDMONITOR-15/-102/-108/-10N/-10T through
  // (WORLDMONITOR-107).
  //
  // The dashboard's wording-only entry is NOT safe to copy here. This React
  // bundle can itself reject with a plain object, and a synthetic rejection has
  // no stack, so `!hasFirstParty` — load-bearing for every rule above — cannot
  // separate ours from an extension's. The JSON-RPC reserved code range is the
  // discriminator instead, and it is structural rather than a wording
  // heuristic: `pro-test/src` contains no JSON-RPC client at all (it speaks
  // REST to our API and to Clerk), so a `-32768..-32000` code can only have
  // come from an injected provider. Same shape of argument as
  // THIRD_PARTY_SDK_LOAD_ACTIONS above — name what proves third-party origin
  // rather than pattern-matching prose — and
  // `tests/pro-sentry-filter-policy.test.mts` fails if a JSON-RPC client is
  // ever added to this surface, rather than letting the rule silently widen.
  //
  // Deliberately narrow on the CODE: EIP-1193's own `4001` (user rejected the
  // request) is outside the reserved range and keeps reporting, as does any
  // non-integer, string, or absent code.
  //
  // The payload's own `message` is deliberately NOT consulted, so
  // `{code: -32603, message: 'checkout failed'}` is dropped too (raised in
  // review, PR #7241). Requiring the literal "Internal JSON-RPC error." would
  // reintroduce the wording heuristic this rule exists to avoid: wallets emit
  // many different strings inside the reserved block (-32002 "Request already
  // pending", provider-specific texts), so matching on message would shrink
  // coverage and break on the next wallet. The reserved range is
  // protocol-defined; the message is free text. What licenses ignoring it is
  // the JSON-RPC-free invariant above — no first-party code on this surface can
  // mint a -32768..-32000 code at all, whatever message it pairs with.
  const rejected = event.extra?.__serialized__;
  const rejectedCode = rejected?.code;
  if (PLAIN_OBJECT_REJECTION.test(msg)
      && typeof rejectedCode === 'number'
      && Number.isInteger(rejectedCode)
      && rejectedCode >= JSON_RPC_RESERVED_MIN
      && rejectedCode <= JSON_RPC_RESERVED_MAX) return null;

  // An injected script attributed to the document URL, dereferencing an iframe
  // this bundle does not have. Instagram's in-app browser was the observed case
  // (WORLDMONITOR-115): its own chrome script threw `null is not an object
  // (evaluating 'e.contentWindow.postMessage')` on `/pro`, with every frame
  // reading `/pro:1` / `/pro:37` and minified names (`T`, `w`, `i`,
  // `sendMessageToIFrames`), plus breadcrumbs naming its bridge
  // (`hxp-chat-suppression`, `IAB unified bridge`).
  //
  // Scoped to `contentWindow`, NOT to the frame shape alone. The first draft of
  // this rule suppressed ANY TypeError whose frames were all non-script URLs —
  // a straight port of the dashboard's WORLDMONITOR-V8 rule. Review showed that
  // port is unsound HERE, because the premise it rests on does not hold on this
  // surface: the dashboard's entry really is always a hashed chunk, but the
  // marketing pages ship executable INLINE script, which WebKit also attributes
  // to the document URL —
  //
  //   - `pro-test/welcome.html` — the WebMCP bootstrap IIFE
  //   - `pro-test/prerender.mjs` — DEFERRED_STYLES_SCRIPT, whose
  //     `setTimeout(a, 3000)` arm runs long after Sentry has initialised
  //
  // A TypeError thrown in either is first-party and indistinguishable from an
  // injected one by frame shape, so the broad rule would have silently hidden
  // real bugs. `contentWindow` is the discriminator instead: it appears nowhere
  // on this surface — not in `pro-test/src`, and not in the inline scripts the
  // original source scan did not read — so an error dereferencing one can only
  // have come from injected code. `tests/pro-sentry-filter-policy.test.mts`
  // pins that across all three file kinds, so the licence cannot rot.
  if ((excType === 'TypeError' || /^TypeError:/.test(msg))
      && exceptionValues.length === 1
      && !hasFirstParty
      && /\bcontentWindow\b/.test(msg)
      && nonInfraFrames.length > 0
      && nonInfraFrames.every((f) => MARKETING_DOCUMENT_FRAME.test(f.filename ?? ''))) return null;

  return event;
}
