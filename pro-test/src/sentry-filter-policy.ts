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
  value?: string;
  stacktrace?: { frames?: PolicyFrame[] };
}
export interface PolicyEvent {
  exception?: { values?: PolicyException[] };
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
  // Zalo's in-app browser (Vietnam's dominant messaging app) injects a JS
  // bridge that references `zaloJSV2` before the host app defines it. Same
  // class as the `WeixinJSBridge` entry in the dashboard array: a named
  // in-app-browser global. Our source contains no `zaloJSV2` identifier at
  // all, so this can never come from our own bundle, minified or not
  // (WORLDMONITOR-102).
  /\bzaloJSV2\b/,
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
 * Stack-gated suppressors for messages that our own minified bundle COULD
 * produce, so they must not go in `MARKETING_IGNORE_ERRORS` (which matches on
 * message text alone, with no access to frames).
 */
export function marketingBeforeSend<T extends PolicyEvent>(event: T): T | null {
  const msg = event.exception?.values?.[0]?.value ?? '';

  // A message that is nothing but a 1-3 character identifier (`ga`, `Ba`) is an
  // injected in-app-browser/extension script rethrowing its own minified
  // symbol. Our bundles throw `Error` objects built from written-out strings;
  // even minified, the *message* text survives verbatim, so a bare short
  // identifier can never be ours. Unconditional (no frame gate) exactly as in
  // the dashboard's `beforeSend`, where it is the first statement
  // (WORLDMONITOR-ZZ, -ZW).
  if (msg.length <= 3 && BARE_SYMBOL_MESSAGE.test(msg)) return null;

  const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
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

  return event;
}
