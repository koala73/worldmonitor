/**
 * Deferred Sentry SDK init and filtering policy.
 *
 * This module is dynamically imported by `sentry-defer.ts` so the large
 * `beforeSend` policy and Sentry SDK import stay out of the eager dashboard
 * entry chunk. Keep pre-init queuing in `sentry-defer.ts`; keep SDK setup here.
 */

import { isDebugBearRumScriptFrame } from './debugbear-rum';

type SentryNs = typeof import('@sentry/browser');

// Known third-party hosts fetched by MapLibre (tiles, styles, glyphs, sprites).
// Hosts whose `Failed to fetch (<host>)` errors are suppressed in beforeSend.
// Originally maplibre-only (transient tile/style failures), expanded to cover
// first-party callers that hit the same hosts directly (e.g.
// `MapContainer.fetchAndApplyRadar` → `api.rainviewer.com`). The set IS the
// safety: only known third-party hosts are suppressed; first-party fetches
// to `api.worldmonitor.app` and the self-hosted R2 PMTiles bucket are NOT
// in the set, so genuine basemap / API regressions still surface.
const THIRD_PARTY_FETCH_HOST_ALLOWLIST = new Set([
  'tilecache.rainviewer.com',
  'api.rainviewer.com', // weather radar API used by MapContainer.fetchAndApplyRadar — WORLDMONITOR-QG
  'basemaps.cartocdn.com',
  'tiles.openfreemap.org',
  'protomaps.github.io',
  // Clerk Frontend API (CNAME → Clerk's auth infra). The bundled Clerk SDK
  // fetches it for session/token refresh and retries transient failures
  // itself (`retryImmediately`); a `Failed to fetch (clerk.worldmonitor.app)`
  // that leaks to onunhandledrejection is a Clerk-SDK-internal network blip,
  // not our code — same disposition as the existing `/ClerkJS: Network error/`
  // ignoreError. NOT our `api.worldmonitor.app`, which stays off the list so
  // genuine API regressions still surface (WORLDMONITOR-SA/SB).
  'clerk.worldmonitor.app',
  // DebugBear RUM beacon collector. We embed the DebugBear RUM script
  // (`src/bootstrap/debugbear-rum.ts` → cdn.debugbear.com) whose collector
  // POSTs field metrics to `data.debugbear.com`; a leaked
  // `NetworkError ... (data.debugbear.com)` / `Failed to fetch (data.debugbear.com)`
  // is a dropped monitoring beacon (adblock / network blip) — invisible to the
  // user and unactionable, same disposition as the Clerk-SDK-internal fetch
  // above. NOT `api.worldmonitor.app` (stays off so real API regressions
  // surface). WORLDMONITOR-RP.
  'data.debugbear.com',
  // Self-hosted Umami analytics collector (`src/services/analytics.ts` loads
  // `abacus.worldmonitor.app/script.js`, whose tracker POSTs events to
  // `/api/send`). Same disposition as the DebugBear beacon above: a dropped
  // analytics beacon is invisible to the user and unactionable — typically an
  // ad-blocker or a fetch-wrapping extension killing the POST. It reaches
  // Sentry despite the extension gate because the leaked rejection carries our
  // Vite `window.fetch` trampolines, which make hasFirstParty true. Serves no
  // product data, so an abacus outage belongs to uptime monitoring, not a
  // per-user Sentry error. NOT `api.worldmonitor.app` (stays off so real API
  // regressions surface). WORLDMONITOR-WH/WJ.
  'abacus.worldmonitor.app',
]);

function buildSentryInitOptions(): Parameters<SentryNs['init']>[0] {
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  return {
    dsn: sentryDsn || undefined,
    release: `worldmonitor@${__APP_VERSION__}`,
    environment: (location.hostname === 'worldmonitor.app' || location.hostname.endsWith('.worldmonitor.app')) ? 'production'
      : location.hostname.includes('vercel.app') ? 'preview'
      : 'development',
    enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost') && !('__TAURI_INTERNALS__' in window),
    allowUrls: [
      /https?:\/\/(www\.|tech\.|finance\.|commodity\.|happy\.)?worldmonitor\.app/,
      /https?:\/\/.*\.vercel\.app/,
    ],
    sendDefaultPii: true,
    tracesSampleRate: 0.1,
    ignoreErrors: [
      'Invalid WebGL2RenderingContext',
      'WebGL context lost',
      /imageManager/,
      /ResizeObserver loop/,
      /NotAllowedError/,
      /InvalidAccessError/,
      /importScripts/,
      /^TypeError: Load failed( \(.*\))?$/,
      /^TypeError: (?:cancelled|avbruten)$/,
      /runtime\.sendMessage\(\)/,
      /Java object is gone/,
      /^Object captured as promise rejection with keys:/,
      /Unable to load image/,
      /Non-Error promise rejection captured with value:/,
      /Connection to Indexed Database server lost/,
      // Library-thrown (Convex client / Clerk persistent cache) when the user's
      // browser has IndexedDB disabled (Safari Private Browsing, hardened
      // Firefox, some WebView contexts). Our code only initializes the
      // library; the throw is environmental and unavoidable from our side.
      // Same disposition as the existing "Connection to Indexed Database
      // server lost" entry above. WORLDMONITOR-RC.
      /^IndexedDBUnavailableError|IndexedDB is not available in this environment/,
      /webkit\.messageHandlers/,
      /(?:unsafe-eval.*Content Security Policy|Content Security Policy.*unsafe-eval)/,
      /Fullscreen request denied/,
      /requestFullscreen/,
      /webkitEnterFullscreen/,
      /vc_text_indicators_context/,
      /Program failed to link/,
      /too much recursion/,
      /zaloJSV2/,
      /Java bridge method invocation error/,
      /Could not compile fragment shader/,
      /can't redefine non-configurable property/,
      /Can.t find variable: (CONFIG|currentInset|NP|webkit|EmptyRanges|logMutedMessage|UTItemActionController|DarkReader|Readability|onPageLoaded|Game|frappe|getPercent|ucConfig|\$a)/,
      /invalid origin/,
      /\.data\.split is not a function/,
      /signal is aborted without reason/,
      /contentWindow\.postMessage/,
      /Could not compile vertex shader/,
      /objectStoreNames/,
      /Unexpected identifier 'https'/,
      /Can't find variable: _0x/,
      /Can't find variable: video/,
      /hackLocationFailed is not defined/,
      /userScripts is not defined/,
      /NS_ERROR_ABORT/,
      /NS_ERROR_OUT_OF_MEMORY/,
      /NS_ERROR_UNEXPECTED/, // Firefox XPCOM: Worker init failure on privacy-hardened Firefox/Ubuntu — WORLDMONITOR-N6/N7/N8/N9
      /NS_ERROR_FILE_NO_DEVICE_SPACE/, // Firefox XPCOM: disk-full on IndexedDB/cache/SW write — WORLDMONITOR-Q0
      /DataCloneError.*could not be cloned/,
      /cannot decode message/,
      /WKWebView was deallocated/,
      // WKWebView host-app JS bridge timeout — Apple WebKit emits this exact phrase
      // when a JS-to-native `postMessage` (e.g. WKScriptMessageHandler) gets no
      // reply within the host's expected window. Common in in-app browsers like
      // DuckDuckGo / Yelp / Reddit-mobile / Instagram. We never postMessage to a
      // WKScriptMessageHandler ourselves; this is browser-native and unactionable
      // (WORLDMONITOR-KJ — 15 events / 14 users in DuckDuckGo 26.3 on macOS).
      /WKWebView API client did not respond to this postMessage/,
      /Unexpected end of(?: JSON)? input/,
      /window\.android\.\w+ is not a function/,
      /Attempted to assign to readonly property/,
      /Cannot assign to read only property/,
      /FetchEvent\.respondWith/,
      /QuotaExceededError/,
      /^TypeError: 已取消$/,
      /^fetchError: Network request failed$/,
      /window\.ethereum/,
      /setting 'luma'/,
      /ML request .* timed out/,
      /(?:AbortError: )?The operation was aborted\.?\s*$/,
      // Bare `Uncaught Error: AbortError` (no message body) from Convex
      // server-side action timeouts auto-captured by Convex's Sentry
      // integration. Zero-frame, environment 'prod', no actionable context
      // — the action retries cleanly. WORLDMONITOR-QH.
      /^Uncaught Error: AbortError$/,
      /Unexpected end of script/,
      /Style is not done loading/,
      /Event `CustomEvent`.*captured as promise rejection/,
      /Event `ProgressEvent`.*captured as promise rejection/, // resource/XHR `error` ProgressEvent leaking via onunhandledrejection (img/script/audio/EventSource load failure). Our IDB/worker/FileReader onerror handlers all reject with wrapped Errors (never a raw ProgressEvent); the only XHR caller is fire-and-forget + Tauri-desktop-only where Sentry is disabled — so a raw ProgressEvent rejection can never originate from our bundle. Sibling of the CustomEvent entry above — WORLDMONITOR-SQ
      /getProgramInfoLog/,
      /__firefox__/,
      /ifameElement\.contentDocument/,
      /Invalid video id/,
      /Fetch is aborted/,
      /Stylesheet append timeout/,
      /Worker is not a constructor/,
      /_pcmBridgeCallbackHandler/,
      /UCShellJava/,
      /Cannot define multiple custom elements/,
      /maxTextureDimension2D/,
      /Container app not found/,
      /this\.St\.unref/,
      /evaluating 'elemFound\.value'/,
      /[Cc]an(?:'t|not) access (?:'\w+'|lexical declaration '\w+') before initialization/,
      /^Uint8Array$/,
      /createObjectStore/,
      /The database connection is closing/,
      /shortcut icon/,
      /Attempting to change value of a readonly property/,
      /reading 'nodeType'/,
      /The node to be removed is not a child of this node/,
      /The object can not be found here/, // Safari variant of above (Clerk SDK removeChild on detached DOM)
      /feature named .\w+. was not found/,
      /a2z\.onStatusUpdate/,
      /Attempting to run\(\), but is already running/,
      /this\.player\.destroy is not a function/,
      /isReCreate is not defined/,
      /reading 'style'.*HTMLImageElement/,
      /can't access property "write", \w+ is undefined/,
      /(?:AbortError: )?The user aborted a request/,
      /\w+ is not a function.*\/uv\/service\//,
      /__isInQueue__/,
      /^(?:LIDNotify(?:Id)?|onWebViewAppeared|onGetWiFiBSSID|onHide|onShow|onReady|tapAt|removeHighlight|UTItemActionController) is not defined$/,
      /Se requiere plan premium/,
      /hybridExecute is not defined/,
      /reading 'postMessage'/,
      /appendChild.*Unexpected token/,
      /\bmag is not defined\b/,
      /evaluating '[^']*\.luma/,
      /translateNotifyError/,
      /GM_getValue/,
      /gm_menus/, // WORLDMONITOR-TJ — Greasemonkey/Violentmonkey internal (GUID-keyed window['<uuid>'].gm_menus userscript-menu registry); never in our bundle, sibling of GM_getValue
      /^InvalidStateError:|The object is in an invalid state/,
      /Could not establish connection\. Receiving end does not exist/,
      /webkitCurrentPlaybackTargetIsWireless/,
      /webkit(?:Supports)?PresentationMode/,
      /Cannot redefine property: webdriver/,
      /null is not an object \(evaluating '\w+\.theme'\)/,
      /this\.player\.\w+ is not a function/,
      /videoTrack\.configuration/,
      /evaluating 'v\.setProps'/,
      /button\[aria-label/,
      /The fetching process for the media resource was aborted/,
      /Invalid regular expression: missing/,
      /WeixinJSBridge/,
      /evaluating '\w+\.type'/,
      /Policy with name .* already exists/,
      /[sx]wbrowser is not defined/,
      /browser\.storage\.local/,
      /The play\(\) request was interrupted/,
      /MutationEvent is not defined/,
      /Cannot redefine property: userAgent/,
      /st_framedeep|ucbrowser_script/,
      /iabjs_unified_bridge/,
      /DarkReader/,
      /window\.receiveMessage/,
      /Cross-origin script load denied/,
      /orgSetInterval is not a function/,
      /Blocked a frame with origin.*accessing a cross-origin frame/,
      /SnapTube/,
      /sortedTrackListForMenu/,
      /isWhiteToBlack/,
      /window\.videoSniffer/,
      /closeTabMediaModal/,
      /missing \) after argument list/,
      /Error invoking postMessage: Java exception/,
      /IndexSizeError/,
      /Failed to construct 'Worker'.*cannot be accessed from origin/,
      /undefined is not an object \(evaluating '(?:this\.)?media(?:Controller)?\.(?:duration|videoTracks|readyState|audioTracks|media)/,
      /\$ is not defined/,
      /Qt\([^)]*\) is not a function/,
      /shaderSource must be an instance of WebGLShader/,
      /WebGL2RenderingContext\.shaderSource: Argument 1 is not an object/,
      // Chrome wording for the same condition (gl.createShader returned null,
      // typically after WebGL context loss or on degraded GPU drivers). WORLDMONITOR-RM.
      /Failed to execute 'shaderSource' on 'WebGL2?RenderingContext': parameter 1 is not of type 'WebGLShader'/,
      /Failed to initialize WebGL/,
      /opacityVertexArray\.length/,
      /Length of new data is \d+, which doesn't match current length of/,
      /^AJAXError:.*(?:Load failed|Unauthorized|\(401\))/,
      /^NetworkError: Load failed$/,
      /^A network error occurred\.?$/,
      /nmhCrx is not defined/,
      /\bcrusoe is not defined\b/, // WORLDMONITOR-R3 — injected userscript reference, anonymous-frames-only stack
      /\bvc_request_action is not defined\b/, // WORLDMONITOR-RB — Samsung Internet / Tizen smart-view-cast global injection
      /\bmainWorldSdk is not defined\b/, // WORLDMONITOR-TG — browser extension SDK injected into the page main world references its global before define; not in our bundle (Edge 148/Windows, anonymous-frames-only stack)
      /navigationPerformanceLoggerJavascriptInterface/,
      /jQuery is not defined/,
      /illegal UTF-16 sequence/,
      /detectIncognito/,
      /Cannot read properties of null \(reading '__uv'\)/,
      /Can't find variable: p\d+/,
      /^timeout$/,
      /Can't find variable: caches/,
      /crypto\.randomUUID is not a function/,
      /ucapi is not defined/,
      /Identifier '(?:script|reportPage|element|Shop|change_ua|originalPrompt)' has already been declared/, // change_ua: User-Agent-changer browser extension injecting same script twice — WORLDMONITOR-2D (88 events / 26 users). originalPrompt: extension hooking window.prompt double-injected — WORLDMONITOR-TE (not in our bundle; build would fail on a duplicate top-level const)
      /getAttribute is not a function.*getAttribute\("role"\)/,
      /SCDynimacBridge/,
      /errTimes is not defined/,
      /Failed to get ServiceWorkerRegistration/,
      /^ReferenceError: Cannot access uninitialized variable\.?$/,
      /Failed writing data to the file system/,
      /Error invoking initializeCallbackHandler/,
      /releasePointerCapture.*Invalid pointer/,
      /Array buffer allocation failed/,
      /Client can't handle this message/,
      /Invalid LngLat object/,
      /autoReset/,
      /webkitExitFullScreen/,
      /downProgCallback/,
      /syncDownloadState/,
      /^ReferenceError: HTMLOUT is not defined$/,
      /^ReferenceError: xbrowser is not defined$/,
      /LibraryDetectorTests_detect/,
      /contentBoxSize\[0\] is undefined/,
      /Attempting to run\(\), but is already running/,
      /Out of range source coordinates for DEM data/,
      /Invalid character: '\\0'/,
      /Failed to execute 'unobserve' on 'IntersectionObserver'/,
      /WKErrorDomain/,
      /Content-Length header of network response exceeds response Body/,
      /^Uncaught \[object ErrorEvent\]$/,
      /^\[object Event\]$/,
      /trsMethod\w+ is not defined/,
      /checkLogin is not a function/,
      /VConsole is not defined/,
      /exitFullscreen.*Document not active/,
      /Force close delete origin/,
      /zp_token is not defined/,
      /literal not terminated before end of script/,
      /'' is not a valid selector/,
      /frappe is not defined/,
      /Unexpected identifier 'does'/,
      /Failed reading data from the file system/,
      /^UnavailableError(:.*)?$/,
      /null is not an object \(evaluating '\w{1,3}\.indexOf'\)/,
      /export declarations may only appear at top level/,
      /ucConfig is not defined/,
      /getShaderPrecisionFormat/,
      /Cannot read properties of null \(reading 'touches'\)/,
      /Failed to execute 'querySelectorAll' on '[^']*': ':[a-z]+\(/,
      /args\.site\.enabledFeatures/,
      /can't access property "\w+", FONTS\[/,
      /null is not an object \(evaluating '\w+\.magnitude\.toFixed'\)/,
      /start offset of Int16Array should be a multiple of 2/,
      /Cannot read properties of undefined \(reading 'then'\)/,
      /^(?:Error: )?uncaught exception: undefined$/,
      /ss_bootstrap_config/, // Surfly proxy — "Can't find variable: ss_bootstrap_config" (Safari) or "ss_bootstrap_config is not defined" (Chrome)
      /undefined is not an object \(evaluating '[a-z]\.includes'\)/,
      /^"use strict" is not a function$/,
      /Can only call Window\.setTimeout on instances of Window/, // iOS Safari cross-frame setTimeout from 3rd-party injected script
      /^Can't find variable: _G$/, // browser extension/userscript injecting _G global
      /onAppPageCallback is not defined/, // Android Chrome WebView injection (Huawei/Samsung browsers)
      /\.at is not a function/, // Instagram/older Android in-app browsers missing Array.at()
      /Response cannot have a body with the given status/, // Safari: Response constructor with 204/304 + body
      /ClerkJS: Network error/, // Clerk SDK transient network failures on user devices
      /^ClerkJS: Response: needs_(?:first|second)_factor\b/, // Clerk SDK auth-flow branch not yet supported; SDK-internal limitation, not our code — WORLDMONITOR-Q1. Narrow to the observed `needs_*_factor` family so future actionable `ClerkJS: Response: <something>` errors (e.g. misconfigured redirect URI) still surface.
      /\[clerk\] failed to load/, // Clerk SDK failed to load its own UI chunk from clerk.worldmonitor.app — SDK-internal load failure, not our code (WORLDMONITOR-??: Yandex Browser 26.4).
      /doesn't provide an export named/, // stale cached chunk after deploy references removed export
      /Possible side-effect in debug-evaluate/, // Chrome DevTools internal EvalError
      /ConvexError: CONFLICT/, // Expected OCC rejection on concurrent preference saves
      /ConvexError: API_ACCESS_REQUIRED/, // Expected business error: free user opens API Keys tab; client handles gracefully (UnifiedSettings.ts:731-738) — WORLDMONITOR-NA
      /\[CONVEX [AQM]\(.+?\)\] Connection lost while action was in flight/, // Convex SDK transient WS disconnect
      /^Invalid start version: \d+:\d+:\d+, transitioning from \d+:\d+:\d+$/, // Convex SDK internal sync protocol error from `remote_query_set.js` (server republished query mid-transition or WS reconnect race) — WORLDMONITOR-Q5
      /Response did not contain `success` or `data`/, // DuckDuckGo browser internal tracker/content-block response — never emitted by our code
      /Cannot set properties of undefined \(setting 'bodyTouched'\)/, // Quark browser (Alibaba mobile) touch-tracking script injection (WORLDMONITOR-N1)
      /Cannot read properties of \w+ \(reading '[^']*[^\x00-\x7F][^']*'\)/, // Non-ASCII property name in message = mojibake/corrupted identifier from injected extension; our bundle emits ASCII-only identifiers (WORLDMONITOR-NS)
      /Octal literals are not allowed in strict mode/, // Runtime SyntaxError from injected extension script; our TS bundle never emits octal literals and doesn't eval (WORLDMONITOR-NV)
      /Unexpected identifier 'm'/, // Foreign script injection on Opera; pre-compiled bundle can't parse-fail at runtime (WORLDMONITOR-NT)
      /PlayerControlsInterface\.\w+ is not a function/, // Android Chrome WebView native bridge injection (Bilibili/UC/QQ-style host) — never emitted by our code (WORLDMONITOR-P2)
      /github\.com\/styled-components\/styled-components\/blob/, // styled-components runtime error (errors.md#N URL); we don't depend on styled-components, so it can only be a browser extension (Grammarly et al.) injecting its own bundle — WORLDMONITOR-SE
    ],
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value ?? '';
      if (msg.length <= 3 && /^[a-zA-Z_$]+$/.test(msg)) return null;
      const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
      const vendorChunk = /\/(maplibre|deck-stack|d3|topojson|i18n|sentry|transformers|onnxruntime)-[A-Za-z0-9_-]+\.js/;
      const firstPartyFile = (filename: string) => {
        if (/\.(ts|tsx)$/.test(filename) || /^src\//.test(filename)) return true;
        if (/\/assets\/[A-Za-z0-9_-]+(-[A-Za-z0-9_-]+)*\.js/.test(filename)) return !vendorChunk.test(filename);
        return false;
      };
      const nonInfraFrames = frames.filter(f => f.filename && f.filename !== '<anonymous>' && f.filename !== '[native code]' && !/\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename));
      const hasFirstParty = nonInfraFrames.some(f => firstPartyFile(f.filename ?? ''));
      const hasAnyStack = nonInfraFrames.length > 0;
      // Suppress maplibre internal null-access crashes (light, placement) only when stack is in map chunk
      if (/this\.style\._layers|reading '_layers'|this\.(light|sky) is null|can't access property "(id|type|setFilter|bind)"[,] ?[\w.]+ is (null|undefined)|can't access property "(id|type)" of null|Cannot read properties of null \(reading '(id|type|setFilter|_layers)'\)|null is not an object \(evaluating '\w{1,3}\.(id|style)|^\w{1,2} is null$/.test(msg)) {
        if (frames.some(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      }
      // Suppress any TypeError / RangeError that happens entirely within maplibre or deck.gl internals.
      // RangeError: "Invalid array length" during deck.gl bindVertexArray / _updateCache on large
      // GL layer updates (vertex-buffer allocation failure in vendor code — WORLDMONITOR-N4).
      // EXCEPTION: `Failed to fetch (<host>)` is routed through the host-allowlist block below
      // so a self-hosted R2 PMTiles / first-party basemap regression isn't silently dropped just
      // because its stack happens to be all-vendor frames (WORLDMONITOR-NE/NF follow-up).
      const excType = event.exception?.values?.[0]?.type ?? '';
      // Host-suffixed fetch-failure shapes — Chrome/Edge `Failed to fetch (<host>)`
      // (maplibre's AJAX wrapper AND first-party fetch callers) and Firefox
      // `NetworkError when attempting to fetch resource. (<host>)` (the
      // engine-equivalent phrasing, e.g. an embedded SDK's beacon fetch —
      // WORLDMONITOR-RP). Both route through the host allowlist below, which is
      // the load-bearing safety; this match is just the shape detector.
      const isHostScopedFetchFailure = excType === 'TypeError'
        && /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.) \([^)]+\)$/.test(msg);
      if (!isHostScopedFetchFailure
          && (excType === 'TypeError' || excType === 'RangeError' || /^(?:TypeError|RangeError):/.test(msg))
          && frames.length > 0) {
        if (nonInfraFrames.length > 0 && nonInfraFrames.every(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      }
      // Suppress `Failed to fetch (<host>)` for known third-party hosts. Originally
      // scoped to maplibre's tile/style/glyph fetches (which wrap transient network
      // errors and rethrow in a Generator-backed Promise that leaks to
      // onunhandledrejection even though DeckGLMap's map-error handler already
      // logs the warning). Expanded (WORLDMONITOR-QG) to also cover first-party
      // call sites that fetch the same allowlisted hosts directly — e.g.
      // `MapContainer.fetchAndApplyRadar` hitting `api.rainviewer.com`. The
      // host-allowlist set is the load-bearing safety: only known third-party
      // hosts get suppressed; first-party fetch failures (self-hosted R2 PMTiles
      // bucket, `api.worldmonitor.app`) are intentionally NOT in the set so a
      // real basemap / API regression is never silently dropped
      // (WORLDMONITOR-NE/NF, WORLDMONITOR-QG).
      if (isHostScopedFetchFailure) {
        const hostMatch = msg.match(/^(?:Failed to fetch|NetworkError when attempting to fetch resource\.) \(([^)]+)\)$/);
        const host = hostMatch?.[1];
        if (host && THIRD_PARTY_FETCH_HOST_ALLOWLIST.has(host)) return null;
      }
      // Suppress Three.js/globe.gl TypeError crashes in main bundle (reading 'type'/'pathType'/'count'/'__globeObjType' on undefined during WebGL traversal/raycast).
      // __globeObjType is exclusively set by three-globe on its own objects and we have no user onClick/onHover handler, so it is always globe.gl internal even when the stack shows the bundled main chunk (WORLDMONITOR-ME).
      if (/reading '__globeObjType'|__globeObjType/.test(msg)) return null;
      if (/reading '(?:type|pathType|count)'|can't access property "(?:type|pathType|count|__globeObjType)",? \w+ is (?:undefined|null)|undefined is not an object \(evaluating '\w+\.(?:pathType|count)'\)/.test(msg)) {
        if (!hasFirstParty) return null;
      }
      // deck.gl/maplibre internal null-access on Layer.isHidden during render (Safari 26.4 beta,
      // empty stacks, preceded by DeckGLMap map-error breadcrumbs). Our first-party `isHidden`
      // lives on SmartPollContext in runtime.ts — any access there would produce frames, so gate
      // on !hasFirstParty to preserve signal on a real poller regression (WORLDMONITOR-NR).
      if (/undefined is not an object \(evaluating '\w{1,3}\.isHidden'\)|Cannot read properties of undefined \(reading 'isHidden'\)/.test(msg)) {
        if (!hasFirstParty) return null;
      }
      // Short minified ReferenceError from Safari ("Can't find variable: ss"). With an empty stack
      // and no first-party frames, this is userscript/extension injection. Our own minified bundle
      // would keep frames via the source-mapped assets/*.js chunks; if the SDK strips them, the
      // stack is non-empty. Bound var length to 1–2 to avoid masking a real "foo is not defined"
      // that happens to hit the unhandledrejection path (WORLDMONITOR-NQ).
      if (!hasFirstParty && frames.length === 0 && /^Can't find variable: \w{1,2}$/.test(msg)) return null;
      // Suppress minified Three.js/globe.gl crashes (e.g. "l is undefined" in raycast, "b is undefined" in update/initGlobe)
      if (/^\w{1,2} is (?:undefined|not an object)$/.test(msg) && frames.length > 0) {
        if (frames.some(f => /\/(main|index)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? '') && /(raycast|update|initGlobe|traverse|render)/.test(f.function ?? ''))) return null;
      }
      // Suppress Three.js OrbitControls touch crashes (finger lifted during pinch-zoom).
      // OrbitControls is bundled into the main chunk, so hasFirstParty is true.
      // Match by function name pattern (_handleTouch*Dolly*) or suppress when no first-party frames.
      //
      // Symbolicated case: function name regex hits (_handleTouchDolly*, OrbitControls).
      // Unsymbolicated case (Sentry WORLDMONITOR-P7): single minified frame in the main
      // bundle (e.g. `Yge`) on iOS/iPadOS Safari. iOS is the only platform where a
      // touch-driven `t.x` crash is plausible AND the production build can lose source
      // maps for OrbitControls' touch handlers. Gate on:
      //   - exactly one main-bundle frame in the trace (no other first-party functions)
      //   - device.family/os indicates iOS/iPadOS
      // so a real `t.x` regression elsewhere on desktop still surfaces.
      if (/undefined is not an object \(evaluating 't\.x'\)|Cannot read properties of undefined \(reading 'x'\)/.test(msg)) {
        if (!hasFirstParty || frames.some(f => /\b_handleTouch\w*Dolly|OrbitControls/.test(f.function ?? ''))) return null;
        const osName = ((event.contexts as any)?.os?.name as string) ?? '';
        const isTouchOs = /^(iOS|iPadOS)$/.test(osName);
        const mainBundleFrames = nonInfraFrames.filter(f => /\/(main|index)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''));
        if (isTouchOs && mainBundleFrames.length === 1 && nonInfraFrames.length === mainBundleFrames.length) return null;
      }
      // Suppress Three.js OrbitControls pointer-capture race: pointerdown handler calls
      // setPointerCapture but the browser has already released the pointer (focus change,
      // rapid re-tap). OrbitControls is bundled into main-*.js, so hasFirstParty=true and
      // production stacks are often unsymbolicated — require a positive three.js signature
      // in the frame context (the literal `this._pointers … setPointerCapture` code slice)
      // so an unrelated first-party setPointerCapture regression still surfaces (WORLDMONITOR-NC).
      if (excType === 'NotFoundError' && /setPointerCapture.*No active pointer with the given id/.test(msg)) {
        // Sentry wire format includes `context: [[lineno, text], ...]` per frame, but the
        // SDK's StackFrame type omits it — cast to any to read it.
        const hasOrbitControlsContext = frames.some(f => {
          const ctx = (f as any).context;
          if (!Array.isArray(ctx)) return false;
          return ctx.some(row =>
            Array.isArray(row) && typeof row[1] === 'string'
            && /_pointers[^\n]*setPointerCapture|setPointerCapture[^\n]*_pointers/.test(row[1]),
          );
        });
        if (hasOrbitControlsContext) return null;
      }
      // Suppress deck.gl/maplibre null-access crashes with no usable stack trace (requestAnimationFrame wrapping)
      if (/null is not an object \(evaluating '\w{1,3}\.(id|type|style)'\)/.test(msg) && frames.length === 0) return null;
      // Suppress Safari sortedTrackListForMenu native crash (value is generic "Type error", function name in stack)
      if (excType === 'TypeError' && frames.some(f => /sortedTrackListForMenu/.test(f.function ?? ''))) return null;
      // Suppress TypeErrors from anonymous/injected scripts (no real source files or only inline page URL)
      if ((excType === 'TypeError' || /^TypeError:/.test(msg)) && frames.length > 0 && frames.every(f => !f.filename || f.filename === '<anonymous>' || /^blob:/.test(f.filename) || /^https?:\/\/[^/]+\/?$/.test(f.filename))) return null;
      // Suppress errors thrown by an injected browser-automation harness driving
      // the page (e.g. Floot's agent). Its selector-resolution helpers throw
      // `Element not found: <sel>`, `No element found: <sel>`, and
      // `$pressKey(...) was called with no selector` from an injected
      // `<anonymous>` script (helperGetStyle et al.), and reference Floot's own
      // `data-floot-id` attribute. These are generic `Error` (not TypeError, so
      // the anonymous-script gate above misses them) whose only frames are
      // `<anonymous>` → hasFirstParty=false. Our bundle never emits these
      // phrasings (grep-verified across src/ + api/). Gated on !hasFirstParty so
      // a same-worded first-party error would still surface. The `... found:`
      // matches REQUIRE the trailing colon+selector, leaving the colon-less
      // ambiguous `Element not found` (handled by the !hasFirstParty ambiguous
      // gate below, which additionally demands a confirmed third-party stack)
      // untouched. WORLDMONITOR-VR/VV/VW/VX/VY/VS/VT/VZ (2026-07-09 Floot agent).
      // NB: the `called with no selector` regex deliberately omits the leading
      // "was " — the beforeSend unit-test harness strips TypeScript `as <T>`
      // assertions with a crude `/as\s+\w+/` that also mangles the English
      // "was called". Matching from "called" keeps the test's eval'd copy intact.
      if (!hasFirstParty && (
        /^(?:Element not found|No element found):/.test(msg)
        || /\bcalled with no selector\b/.test(msg)
        || /data-floot-id/.test(msg)
      )) return null;
      // Suppress parentNode.insertBefore from injected/inline scripts (iOS WKWebView, Apple Mail)
      // Also covers [native code] frames (no filename) produced by WKWebView's forEach wrapper
      if (/parentNode\.insertBefore/.test(msg) && frames.every(f => !f.filename || f.filename === '<anonymous>' || f.filename === '[native code]' || /^blob:/.test(f.filename) || /^https?:\/\/[^/]+\/?$/.test(f.filename))) return null;
      // Suppress TypeErrors whose ONLY source frames are non-script URLs — the
      // page document URL itself (a relative path like `/dashboard` or the full
      // `https://<host>/dashboard`) or any external resource served without a
      // recognized script extension. Scripts injected into the page's MAIN world
      // — WKUserScript content scripts on Firefox iOS / other in-app WebViews,
      // bookmarklets — are attributed by WebKit to the document URL (line 1,
      // minified fns `o`/`s`/`Or`, with native `insertBefore`/`forEach` frames),
      // not to a distinct `.js` script URL. Our own shipped code never runs from
      // such a URL: the app entry is a hashed `/assets/*.js` module chunk (flagged
      // first-party by firstPartyFile), so a TypeError with zero first-party
      // frames whose non-infra frames are all non-script URLs cannot originate in
      // our bundle. The `frames.every(...)` injected-script gate above misses this
      // because the `[native code]` insertBefore/forEach frames break its
      // predicate and its page-URL matcher only accepts bare origins, not document
      // paths (WORLDMONITOR-V8: Firefox iOS 152, `undefined is not an object
      // (evaluating 's[e]')`, insertBefore in a promiseReactionJob — 6 events / 1
      // user).
      //
      // `isNonScriptUrlFrame` is intentionally broader than "page document": the
      // `https?://` branch also matches extensionless third-party script URLs
      // (e.g. `https://js.stripe.com/v3/`). That is still correct to suppress here
      // — the `!hasFirstParty` guard already proves zero first-party involvement,
      // so a same-shaped error from a third-party host is equally unactionable.
      const isNonScriptUrlFrame = (filename: string) =>
        !/\.(?:m|c)?[jt]sx?(?:[?#]|$)/.test(filename)
        && (/^\/(?!\/)/.test(filename) || /^https?:\/\//.test(filename));
      if ((excType === 'TypeError' || /^TypeError:/.test(msg))
          && !hasFirstParty
          && nonInfraFrames.length > 0
          && nonInfraFrames.every(f => isNonScriptUrlFrame(f.filename ?? ''))) return null;
      // Suppress NotFoundError: insertBefore with no usable stack (Chrome 146+ extension DOM interference — stack shows minified bundle but no line/function)
      if (excType === 'NotFoundError' && /insertBefore/.test(msg) && frames.every(f => !f.lineno && !f.function)) return null;
      // Suppress Sentry breadcrumb DOM-measuring crashes (element.offsetWidth on detached DOM)
      if (/evaluating '(?:element|e)\.offset(?:Width|Height)'/.test(msg) && frames.some(f => /\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      // Suppress errors originating entirely from blob: URLs (browser extensions)
      if (frames.length > 0 && frames.every(f => /^blob:/.test(f.filename ?? ''))) return null;
      // Suppress errors where any frame is a chrome/moz/safari extension, ONLY when stack has no first-party frames.
      // A first-party frame elsewhere in the stack means the error likely originated in our code; surface it even if
      // an extension wrapped the call.
      if (!hasFirstParty && frames.some(f => /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//.test(f.filename ?? ''))) return null;
      // Bare `Failed to fetch` leaking via onunhandledrejection when a browser
      // extension has monkeypatched `window.fetch` (e.g. Adjust SDK's
      // injectScriptAdjust.js, page-inspector extensions) and chained an uncaught
      // `.then()` on the result. A transient network blip rejects the underlying
      // fetch and the extension's orphan promise surfaces as an unhandled rejection.
      // Our first-party frames (the runtime fetch interceptor + country-geometry
      // loader) appear ONLY because our wrapper sits in the call chain — our own
      // fetch callers already wrap rejections in try/catch (country-geometry's
      // ensureLoaded logs a warning and resolves), so this is NOT a first-party
      // leak. Unlike the generic `!hasFirstParty` `Failed to fetch` gate below,
      // this fires WITH first-party frames present, but only when an extension has
      // a monkeypatched-`window.fetch` frame on the stack — a genuine API outage
      // (host-suffixed `Failed to fetch (<host>)`, handled above) and any
      // non-extension user are unaffected. The function match is anchored to
      // exactly `window.fetch` / `fetch` or the `Function.prototype.apply`
      // trampoline (`Object.apply` / `apply`) an extension's hook.js uses to
      // re-invoke the original fetch — NOT a loose `/fetch/` — so an extension
      // frame named `fetchContent` / `prefetch` does NOT swallow a real bare
      // `Failed to fetch` from our own code (WORLDMONITOR-SG). The `apply`
      // trampoline variant is WORLDMONITOR-TZ: a wallet extension's
      // `injected/hook.js` wraps `window.fetch` and the leaked rejection frame
      // surfaces as `Object.apply`, not `window.fetch`.
      if (/^(?:TypeError: )?Failed to fetch$/.test(msg)
          && frames.some(f => /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//.test(f.filename ?? '') && /^(?:(?:.*\.)?window\.|(?:window|Object)\.)?(?:fetch|apply)$/i.test(f.function ?? ''))) {
        return null;
      }
      // Bare `Failed to fetch` surfacing through the DebugBear RUM collector's
      // window.fetch monkeypatch. DebugBear (src/bootstrap/debugbear-rum.ts →
      // cdn.debugbear.com/<id>.js; Sentry attributes its frames to the script
      // configured script path) wraps window.fetch to time it, so a
      // transient network blip on ANY app fetch rejects and its wrapper
      // re-surfaces the rejection as an unhandled rejection, injecting its own
      // frames. Without DebugBear the identical failure is zero-frame and already
      // suppressed above — the collector's frames are the ONLY reason it reaches
      // here. The `/assets/*.js` frames it carries are `window.fetch` TRAMPOLINES
      // (Vite code-split chunk names, e.g. panel-storage/widget-store, which do
      // not themselves fetch — grep-verified), NOT real callers. Suppress only
      // when a DebugBear collector frame is present AND every non-infra frame is
      // either that collector or the observed caller-free `window.fetch`/`fetch`
      // trampolines from panel-storage/widget-store. Other first-party fetch
      // wrappers (notably runtime.ts) must surface. Mirrors the SG
      // extension-wrapper gate above; collector identity comes from
      // DEBUGBEAR_RUM_SCRIPT_SRC via the shared predicate.
      // WORLDMONITOR-VC (93ev/69u, 2026-07-04+).
      // The optional `\w{1,3}.` receiver prefix is WORLDMONITOR-VQ: a later Vite
      // build emits the same trampoline as `Rt.window.fetch` rather than a bare
      // `window.fetch`, and the anchored match rejected it, so the identical
      // wrapper class re-surfaced as a new issue. The prefix is bounded to a
      // minified identifier (≤3 chars) so a real named receiver — e.g.
      // `apiClient.fetch` — is still read as a genuine caller and surfaces.
      if (/^(?:TypeError: )?Failed to fetch$/.test(msg)
          && frames.some(f => isDebugBearRumScriptFrame(f.filename ?? ''))
          && nonInfraFrames.every(f =>
            isDebugBearRumScriptFrame(f.filename ?? '')
            || (/\/assets\/(?:panel-storage|widget-store)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? '')
              && /^(?:\w{1,3}\.)?(?:window\.)?fetch$/.test(f.function ?? '')))) {
        return null;
      }
      // Suppress Sentry SDK DOM breadcrumb null-access on document.activeElement/contains.
      // Gated on !hasFirstParty because Sentry wraps first-party handlers, so a genuine app `el.contains(...)` bug
      // can produce a stack containing both main-*.js and sentry-*.js frames.
      if (!hasFirstParty && /Cannot read properties of null \(reading 'contains'\)|null is not an object \(evaluating '\w+\.contains'\)/.test(msg) && frames.some(f => /\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      // Suppress Convex WS onmessage JSON.parse truncation (intermittent WS frame splits on Ping/Updated control messages)
      if (excType === 'SyntaxError' && /is not valid JSON/.test(msg) && !hasFirstParty && frames.some(f => /onmessage/.test(f.function ?? ''))) return null;
      // Suppress errors originating from UV proxy (Ultraviolet service worker)
      if (frames.some(f => /\/uv\/service\//.test(f.filename ?? '') || /uv\.handler/.test(f.filename ?? ''))) return null;
      // Suppress Greasemonkey/Tampermonkey userscript errors (x-plugin-script, stay-userscript.html)
      if (frames.length > 0 && frames.every(f => !f.filename || /\/x-plugin-script\/|\/stay-userscript\.html$/.test(f.filename))) return null;
      // Suppress YouTube IFrame widget API internal errors
      if (frames.some(f => /www-widgetapi\.js/.test(f.filename ?? ''))) return null;
      // Suppress Sentry beacon XHR transport errors (readyState on aborted XHR — not our code)
      if (frames.some(f => /beacon\.min\.js/.test(f.filename ?? ''))) return null;
      // Suppress Fireglass (Symantec/Broadcom CloudSOC) console-hook recursion.
      // Fireglass wraps console.log and recurses on its own debug output, producing
      // "Maximum call stack size exceeded". Stack frames are <anonymous> so the
      // generic hasFirstParty gate below can't see it — match by function name.
      // Gated on excType === 'RangeError' (mirrors the sortedTrackListForMenu
      // pattern above) so an unrelated exception with a FireglassUtils frame
      // isn't silently dropped (WORLDMONITOR-MK).
      if (excType === 'RangeError' && frames.some(f => /FireglassUtils/.test(f.function ?? ''))) return null;
      // Suppress Chrome Mobile WebView 105+ Request constructor quirk ONLY when
      // the Dodo checkout lazy chunk is in the stack (WORLDMONITOR-MH). The
      // exact message is unique to the Fetch § Request() duplex requirement, but
      // src/services/runtime.ts (runtime fetch patch) also constructs `new
      // Request(init)` at lines 861/869/902 — without this provenance guard the
      // same filter would hide a real first-party streaming-fetch regression.
      // Guard on the vendored chunk name (checkout-*.js = Dodo SDK, lazy-loaded
      // only when startCheckout runs) so a runtime.ts failure still surfaces.
      if (/Failed to construct 'Request': The `duplex` member must be specified/.test(msg)
          && frames.some(f => /\/assets\/checkout-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      // Suppress "options is not defined" from browser extension overriding Navigator getter (WORLDMONITOR-JN).
      // Only suppress when stack has no first-party frames (filename=<anonymous> is the extension getter).
      if (/^options is not defined$/.test(msg) && frames.every(f => !f.filename || f.filename === '<anonymous>' || f.filename === '[native code]')) return null;
      // Suppress TransactionInactiveError only when no first-party frames are present
      // (Safari kills open IDB transactions in background tabs — not actionable noise)
      // First-party paths in storage.ts / persistent-cache.ts / vector-db.ts must still surface.
      if ((/TransactionInactiveError/.test(msg) || excType === 'TransactionInactiveError') && !hasFirstParty) return null;
      // Suppress ambiguous runtime errors ONLY when stack positively identifies third-party
      // origin. Empty stacks are NOT suppressed because we cannot confirm the error didn't
      // come from our own code (OOM, stack overflow, network failures all commonly arrive
      // without frames even when our code triggered them).
      // iOS Safari WKWebView throws `UnknownError: Cannot inject key into script value`
      // at the native bridge when a non-structurally-cloneable value is passed to a
      // bridge API (history.pushState, IndexedDB, etc.). The throw is native; a first-
      // party caller is always on the stack, so the generic `!hasFirstParty` gate below
      // misses it. Scope to excType==='UnknownError' — that type name is WebKit-only and
      // cannot originate from our TypeScript (WORLDMONITOR-NM).
      if (excType === 'UnknownError' && /Cannot inject key into script value/.test(msg)) return null;
      // Convex SDK re-auth race: during a WebSocket reconnect, `BaseConvexClient.
      // tryToReauthenticate` can read `this.authState.config.fetchToken` while
      // authState is transitioning out of `authenticated` state. Known Convex
      // internal; we use the SDK as-is. Gate by the exact function name so we
      // don't mask a genuine first-party `fetchToken` regression
      // (WORLDMONITOR-NJ).
      if (/Cannot read properties of undefined \(reading 'fetchToken'\)/.test(msg)
          && frames.some(f => /tryToReauthenticate/.test(f.function ?? ''))) return null;
      // Dynamic-import chunk-load failures whose browser-emitted message names one of
      // our own hashed `/assets/*.js` chunks. These FETCH-failure phrasings (Chrome
      // `Failed to fetch dynamically imported module: <url>`, Firefox `error loading
      // dynamically imported module: <url>`) are deploy-skew (a stale hashed filename
      // 404s after a deploy) or a transient network blip — never a first-party logic
      // bug: our compiled code can't synthesize the string, the URL is one of our
      // owned hashed chunks, and the load itself failed (a chunk that fetches
      // then throws during evaluation rejects with the underlying error, not
      // this wrapper). Unlike the
      // zero-frame variant below, the `import()` call site here is first-party
      // (MapContainer.initDeck, lazy panel/video loaders), so the rejection rides a
      // first-party frame and the `!hasFirstParty` gate misses it (WORLDMONITOR-TN: Map
      // chunk, WORLDMONITOR-S1: hls chunk). Match the owned, hashed asset URL in
      // the message instead of the stack.
      const dynamicImportAssetUrlMatch = msg.match(
        /(?:https?:\/\/[^\s'")]+)?\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js/i,
      );
      let isOwnedDynamicImportAssetUrl = false;
      if (dynamicImportAssetUrlMatch) {
        const assetUrl = dynamicImportAssetUrlMatch[0];
        if (assetUrl.startsWith('/')) {
          isOwnedDynamicImportAssetUrl = true;
        } else {
          try {
            const host = new URL(assetUrl).hostname;
            const currentHost = typeof location !== 'undefined' ? location.hostname : '';
            isOwnedDynamicImportAssetUrl = host === 'worldmonitor.app'
              || host.endsWith('.worldmonitor.app')
              || (currentHost.endsWith('.vercel.app') && host === currentHost);
          } catch {
            isOwnedDynamicImportAssetUrl = false;
          }
        }
      }
      if (/(?:Failed to fetch|error loading) dynamically imported module/i.test(msg)
          && isOwnedDynamicImportAssetUrl) return null;
      // Stale-chunk-after-deploy: modulepreload / dynamic import failures arrive with no
      // stack trace because the browser fires them as synthetic TypeErrors at fetch time,
      // not at any first-party call site. The chunk-reload guard auto-reloads the page,
      // so the user is unaffected — but the Sentry event is still captured. Drop these
      // even when frames.length === 0 (WORLDMONITOR-Q / WORLDMONITOR-15). The phrases
      // are runtime-emitted only — our shipped code cannot synthesize them. Browser
      // variants: Chrome/Edge `Failed to fetch dynamically imported module` (no URL /
      // modulepreload), Safari `Importing a module script failed.`, Firefox `error
      // loading dynamically imported module`. `Importing binding name '<x>' is not
      // found.` (Safari) is the module-LINK counterpart: a chunk imports a named export
      // a sibling chunk no longer provides after a deploy — a built bundle always links
      // consistently, so at runtime this is version skew, never a code defect, and it
      // throws at link time with zero first-party frames (WORLDMONITOR-TM).
      if (
        !hasFirstParty
        && /(?:Failed to fetch|error loading) dynamically imported module|Importing a module script failed|Importing binding name '[^']*' is not found/i.test(msg)
      ) return null;
      // Zero-frame async-rejection patterns: AbortSignal.timeout() rejections
      // and DOMException(NotSupportedError) bubble up via
      // onunhandledrejection without any first-party frames captured (the
      // browser fires them from internal infra at the timer boundary). Both
      // phrases are runtime-emitted only — our shipped code cannot synthesize
      // the literal "signal timed out" or DOMException name. Same `!hasFirstParty`
      // safety as the dynamic-import block (WORLDMONITOR-66 / WORLDMONITOR-62).
      //
      // Extensions to the same gate:
      //   • `out of memory` — Firefox via setInterval mechanism, zero frames
      //     (WORLDMONITOR-KE). Browser-engine signal, not synthesizable by
      //     our code.
      //   • `\.(toLowerCase|trim|indexOf|findIndex) is not a function` —
      //     Apple Mail privacy proxy walks DOM with forEach and assumes
      //     `el.className` is a string, but on SVG elements it's a
      //     `SVGAnimatedString` (WORLDMONITOR-P2). Frame stack is
      //     [sentry-chunk, [native code]] which gets fully filtered out of
      //     `nonInfraFrames` → hasAnyStack=false. The literal " is not a
      //     function" suffix anchored to those four mutator names is
      //     unambiguously a third-party prototype-mismatch (our code never
      //     calls those methods on objects of unknown shape).
      //   • `Request timeout: /...` — third-party Electron wrappers
      //     (WORLDMONITOR-PW: Electron 39.2.7 polling /api/setIsSelect, an
      //     endpoint we don't serve). Our own `Request timeout` strings
      //     don't include a colon-and-path suffix; the format is unique to
      //     wrapper-injected code.
      if (
        !hasFirstParty
        && (
          /signal timed out/.test(msg)
          || /NotSupportedError/.test(msg)
          || /out of memory/i.test(msg)
          || /\.(?:toLowerCase|trim|indexOf|findIndex) is not a function/.test(msg)
          || /^(?:Error: )?Request timeout: \//.test(msg)
          // `^Failed to fetch$` (no host suffix) with zero captured frames =
          // background fetch from a service worker / browser extension /
          // in-app webview / stale pre-deploy bundle. A first-party fetch
          // failing in our shipped code surfaces with at least one
          // source-mapped .ts frame on the rejection (the awaiting site).
          // The hostname-suffixed variant `Failed to fetch (<host>)` is
          // handled above by `isHostScopedFetchFailure` which does its own
          // first-party-host allowlist (WORLDMONITOR-KM).
          || /^(?:TypeError: )?Failed to fetch$/.test(msg)
          // Safari module-loader abort / streaming-fetch interruption: iOS
          // Safari emits `SyntaxError: Unexpected EOF` with zero captured
          // frames via `onunhandledrejection` when a dynamic `import()` or
          // service-worker-mediated fetch is truncated mid-stream (PWA
          // lifecycle transitions, background-tab termination, network blip
          // during app boot). Our own `JSON.parse` calls produce
          // engine-specific phrasings — V8: `Unexpected end of JSON input`;
          // Safari: `JSON Parse error: Unexpected EOF` (with prefix) — so
          // bare `Unexpected EOF` is engine-emitted only. Same `!hasFirstParty`
          // safety as the `Failed to fetch` / `signal timed out` blocks above
          // (WORLDMONITOR-RF).
          || /^(?:SyntaxError: )?Unexpected EOF$/.test(msg)
          // `Unexpected token '<'` with zero captured frames = HTML served
          // where JS was expected: a stale hashed chunk after a deploy (the
          // SPA index.html fallback starts with `<!DOCTYPE html>`), or a
          // captive-portal / proxy / ISP HTML interstitial intercepting a
          // `<script>` / dynamic-import fetch. The `<` is dispositive — our
          // already-parsed, build-time-validated first-party bundle cannot
          // emit a parse error on its own source, and a genuine first-party
          // SyntaxError carries a source-mapped .ts frame (hasFirstParty →
          // preserved). The `hasAnyStack`-gated `Unexpected token/keyword`
          // gate below misses this zero-frame variant. `(?:SyntaxError: )?`
          // mirrors the EOF gate above: some engines embed the type in the
          // `value` field (WORLDMONITOR-TY).
          || /^(?:SyntaxError: )?Unexpected token '<'/.test(msg)
          // Bare `Unexpected token '<keyword>'` with zero captured frames on ancient
          // Android WebView (Chrome 98) — injected bridge/extension script or a
          // browser-internal parse failure, not our already-parsed bundle. A genuine
          // first-party SyntaxError carries a source-mapped .ts frame or an owned
          // hashed-chunk URL in the message (handled above). The `hasAnyStack`-gated
          // token gate below misses this zero-frame variant (WORLDMONITOR-??:
          // Unexpected token 'else' / 'for', 2026-07-18).
          || /^(?:SyntaxError: )?Unexpected token '(?:else|for)'$/.test(msg)
          // Firefox's wording for a failed `fetch()` — the engine-emitted
          // equivalent of Chrome's bare `Failed to fetch` (above) and Safari's
          // `Load failed`. Surfaces via `onunhandledrejection` with zero captured
          // frames. Same provenance reasoning as the `Failed to fetch` gate
          // (WORLDMONITOR-KM): a genuine first-party fetch failure keeps a
          // source-mapped .ts frame on the awaiting site (hasFirstParty → NOT
          // suppressed, preserved by the first-party-stack test), so a zero-frame
          // rejection is a background / service-worker / extension / stale-pre-
          // deploy-bundle fetch. The literal phrase is engine-emitted only — our
          // shipped code never synthesizes it. This aligns the Firefox phrasing
          // with the bare `Failed to fetch` handling; the earlier blanket
          // "let NetworkError through" caution predated the KM provenance
          // refinement (WORLDMONITOR-RK).
          || /^(?:TypeError: )?NetworkError when attempting to fetch resource\.?$/.test(msg)
          // `.postMessage` on null with no first-party frame = an in-app webview
          // JS bridge / injected extension script posting to a null message
          // target (observed on ancient Mobile Safari 13 in-app browsers —
          // WORLDMONITOR-TE/TF). A genuine first-party `worker.postMessage` /
          // iframe-bridge bug keeps a source-mapped .ts frame (hasFirstParty →
          // preserved), so a no-first-party occurrence is bridge/extension noise.
          // This is the WebKit phrasing; the V8 `reading 'postMessage'` variant is
          // already suppressed via the ignoreErrors entry above.
          || /null is not an object \(evaluating '[^']*\.postMessage'\)/.test(msg)
        )
      ) return null;
      if (hasAnyStack && !hasFirstParty && (
        /Maximum call stack size exceeded/.test(msg)
        || /^\w{1,2} is not a (?:function|constructor)/.test(msg)
        || /Cannot add property \w+, object is not extensible/.test(msg)
        || /^TypeError: Internal error$/.test(msg)
        || /^Key not found$/.test(msg)
        || /^Element not found$/.test(msg)
        || /^TypeError: NetworkError/.test(msg)
        || /Could not connect to the server/.test(msg)
        || (excType === 'SyntaxError' && /^Unexpected (?:token|keyword)/.test(msg))
        || /^SyntaxError: Unexpected (?:token|keyword)/.test(msg)
        || /Invalid or unexpected token/.test(msg)
        || /^Operation timed out/.test(msg)
        || /Cannot inject key into script value/.test(msg)
        || /Connection lost while action was in flight/.test(msg)
        || /WEBGLRenderPipeline.*Link error/.test(msg)
      )) return null;
      // `SyntaxError: Invalid or unexpected token` (and the Unexpected token/keyword/EOF
      // family) surfacing THROUGH the deck.gl/maplibre WebGL init path. Our compiled,
      // already-parsed bundle cannot emit a JS parse error at the first-party
      // `MapContainer.initDeck` call site — a runtime SyntaxError here means deck.gl /
      // maplibre parsed external content (a Worker script, a `new Function` shader
      // builder, or a stale/corrupt lazily-loaded chunk after a deploy). The
      // `!hasFirstParty` token-parse gate above misses this because `initDeck` rides the
      // stack as the CALLER, not the source. Gate on the presence of a deck-stack /
      // maplibre vendor frame so a genuine first-party SyntaxError elsewhere still
      // surfaces (WORLDMONITOR-SP).
      // `(?:SyntaxError: )?` mirrors the EOF/token gates above (lines 588, 601):
      // some engines embed the exception type in the `value` field, so `msg` can be
      // either `Invalid or unexpected token` or `SyntaxError: Invalid or unexpected
      // token`. Anchoring without the optional prefix would let the prefixed variant
      // slip through here despite the first-party `MapContainer` frame (Greptile P2).
      if (excType === 'SyntaxError'
          && /^(?:SyntaxError: )?(?:Invalid or unexpected token|Unexpected (?:token|keyword|identifier|EOF|end of script))/.test(msg)
          && frames.some(f => /\/(?:maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
      return event;
    },
  };
}

export async function loadAndInitSentry(): Promise<SentryNs> {
  const ns = await import('@sentry/browser');
  ns.init(buildSentryInitOptions());
  return ns;
}
