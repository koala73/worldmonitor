import './styles/base-layer.css';
import './styles/happy-theme.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Sentry from '@sentry/browser';
import { inject } from '@vercel/analytics';
import { App } from './App';
import { installUtmInterceptor } from './utils/utm';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

// Known third-party hosts fetched by MapLibre (tiles, styles, glyphs, sprites).
// Used by the beforeSend `Failed to fetch (<host>)` filter to avoid suppressing
// failures from our self-hosted R2 PMTiles bucket or any api.worldmonitor.app
// fetches that happen to land on a maplibre-framed stack.
const MAPLIBRE_THIRD_PARTY_TILE_HOSTS = new Set([
  'tilecache.rainviewer.com',
  'basemaps.cartocdn.com',
  'tiles.openfreemap.org',
  'protomaps.github.io',
]);

// Initialize Sentry error tracking (early as possible)
Sentry.init({
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
    /DataCloneError.*could not be cloned/,
    /cannot decode message/,
    /WKWebView was deallocated/,
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
    /Unexpected end of script/,
    /Style is not done loading/,
    /Event `CustomEvent`.*captured as promise rejection/,
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
    /Failed to initialize WebGL/,
    /opacityVertexArray\.length/,
    /Length of new data is \d+, which doesn't match current length of/,
    /^AJAXError:.*(?:Load failed|Unauthorized|\(401\))/,
    /^NetworkError: Load failed$/,
    /^A network error occurred\.?$/,
    /nmhCrx is not defined/,
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
    /Identifier '(?:script|reportPage|element|Shop)' has already been declared/,
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
    /doesn't provide an export named/, // stale cached chunk after deploy references removed export
    /Possible side-effect in debug-evaluate/, // Chrome DevTools internal EvalError
    /ConvexError: CONFLICT/, // Expected OCC rejection on concurrent preference saves
    /ConvexError: API_ACCESS_REQUIRED/, // Expected business error: free user opens API Keys tab; client handles gracefully (UnifiedSettings.ts:731-738) — WORLDMONITOR-NA
    /\[CONVEX [AQM]\(.+?\)\] Connection lost while action was in flight/, // Convex SDK transient WS disconnect
    /Response did not contain `success` or `data`/, // DuckDuckGo browser internal tracker/content-block response — never emitted by our code
    /Cannot set properties of undefined \(setting 'bodyTouched'\)/, // Quark browser (Alibaba mobile) touch-tracking script injection (WORLDMONITOR-N1)
    /Cannot read properties of \w+ \(reading '[^']*[^\x00-\x7F][^']*'\)/, // Non-ASCII property name in message = mojibake/corrupted identifier from injected extension; our bundle emits ASCII-only identifiers (WORLDMONITOR-NS)
    /Octal literals are not allowed in strict mode/, // Runtime SyntaxError from injected extension script; our TS bundle never emits octal literals and doesn't eval (WORLDMONITOR-NV)
    /Unexpected identifier 'm'/, // Foreign script injection on Opera; pre-compiled bundle can't parse-fail at runtime (WORLDMONITOR-NT)
    /PlayerControlsInterface\.\w+ is not a function/, // Android Chrome WebView native bridge injection (Bilibili/UC/QQ-style host) — never emitted by our code (WORLDMONITOR-P2)
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
    if (/this\.style\._layers|reading '_layers'|this\.(light|sky) is null|can't access property "(id|type|setFilter)"[,] ?\w+ is (null|undefined)|can't access property "(id|type)" of null|Cannot read properties of null \(reading '(id|type|setFilter|_layers)'\)|null is not an object \(evaluating '\w{1,3}\.(id|style)|^\w{1,2} is null$/.test(msg)) {
      if (frames.some(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
    }
    // Suppress any TypeError / RangeError that happens entirely within maplibre or deck.gl internals.
    // RangeError: "Invalid array length" during deck.gl bindVertexArray / _updateCache on large
    // GL layer updates (vertex-buffer allocation failure in vendor code — WORLDMONITOR-N4).
    // EXCEPTION: `Failed to fetch (<host>)` is routed through the host-allowlist block below
    // so a self-hosted R2 PMTiles / first-party basemap regression isn't silently dropped just
    // because its stack happens to be all-vendor frames (WORLDMONITOR-NE/NF follow-up).
    const excType = event.exception?.values?.[0]?.type ?? '';
    const isMaplibreAjaxFailure = excType === 'TypeError' && /^Failed to fetch \([^)]+\)$/.test(msg);
    if (!isMaplibreAjaxFailure
        && (excType === 'TypeError' || excType === 'RangeError' || /^(?:TypeError|RangeError):/.test(msg))
        && frames.length > 0) {
      if (nonInfraFrames.length > 0 && nonInfraFrames.every(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
    }
    // Suppress MapLibre AJAXError for third-party tile fetches: maplibre wraps transient
    // network errors as `Failed to fetch (<hostname>)` and rethrows in a Generator-backed
    // Promise that leaks to onunhandledrejection even though DeckGLMap's map-error handler
    // already logs it as a warning. Allowlist KNOWN third-party tile/style/glyph hosts —
    // leaves first-party fetch failures (self-hosted R2 PMTiles bucket, api.worldmonitor.app)
    // to surface so a real basemap regression is never silently dropped (WORLDMONITOR-NE/NF).
    if (isMaplibreAjaxFailure && frames.some(f => /\/maplibre-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) {
      const hostMatch = msg.match(/^Failed to fetch \(([^)]+)\)$/);
      const host = hostMatch?.[1];
      if (host && MAPLIBRE_THIRD_PARTY_TILE_HOSTS.has(host)) return null;
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
    // Suppress parentNode.insertBefore from injected/inline scripts (iOS WKWebView, Apple Mail)
    // Also covers [native code] frames (no filename) produced by WKWebView's forEach wrapper
    if (/parentNode\.insertBefore/.test(msg) && frames.every(f => !f.filename || f.filename === '<anonymous>' || f.filename === '[native code]' || /^blob:/.test(f.filename) || /^https?:\/\/[^/]+\/?$/.test(f.filename))) return null;
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
    // Suppress Sentry SDK DOM breadcrumb null-access on document.activeElement/contains.
    // Gated on !hasFirstParty because Sentry wraps first-party handlers, so a genuine app `el.contains(...)` bug
    // can produce a stack containing both main-*.js and sentry-*.js frames.
    if (!hasFirstParty && /Cannot read properties of null \(reading 'contains'\)|null is not an object \(evaluating '\w+\.contains'\)/.test(msg) && frames.some(f => /\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
    // Suppress Convex WS onmessage JSON.parse truncation (intermittent WS frame splits on Ping/Updated control messages)
    if (excType === 'SyntaxError' && /is not valid JSON/.test(msg) && !hasFirstParty && frames.some(f => /onmessage/.test(f.function ?? ''))) return null;
    // Suppress errors originating from UV proxy (Ultraviolet service worker)
    if (frames.some(f => /\/uv\/service\//.test(f.filename ?? '') || /uv\.handler/.test(f.filename ?? ''))) return null;
    // Suppress Greasemonkey/Tampermonkey userscript errors (x-plugin-script)
    if (frames.length > 0 && frames.every(f => !f.filename || /\/x-plugin-script\//.test(f.filename))) return null;
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
    if (hasAnyStack && !hasFirstParty && (
      /\.(?:toLowerCase|trim|indexOf|findIndex) is not a function/.test(msg)
      || /Maximum call stack size exceeded/.test(msg)
      || /out of memory/i.test(msg)
      || /^\w{1,2} is not a (?:function|constructor)/.test(msg)
      || /Cannot add property \w+, object is not extensible/.test(msg)
      || /^TypeError: Internal error$/.test(msg)
      || /NotSupportedError/.test(msg)
      || /^Key not found$/.test(msg)
      || /^Element not found$/.test(msg)
      || /^(?:TypeError: )?Failed to fetch$/.test(msg)
      || /^TypeError: NetworkError/.test(msg)
      || /Could not connect to the server/.test(msg)
      || /(?:Failed to fetch|Importing a module script failed|error loading) dynamically imported module/i.test(msg)
      || (excType === 'SyntaxError' && /^Unexpected (?:token|keyword)/.test(msg))
      || /^SyntaxError: Unexpected (?:token|keyword)/.test(msg)
      || /Invalid or unexpected token/.test(msg)
      || /^Operation timed out/.test(msg)
      || /signal timed out/.test(msg)
      || /Cannot inject key into script value/.test(msg)
      || /Connection lost while action was in flight/.test(msg)
      || /WEBGLRenderPipeline.*Link error/.test(msg)
    )) return null;
    return event;
  },
});
// Suppress NotAllowedError from YouTube IFrame API's internal play() — browser autoplay policy,
// not actionable. The YT IFrame API doesn't expose the play() promise so it leaks as unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

// CSP violation filter — exported for testability.
// Returns true if the violation should be suppressed (not reported to Sentry).
// @ts-ignore — exported for tests, not consumed by other modules
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shouldSuppressCspViolation(
  disposition: string,
  directive: string,
  blockedURI: string,
  sourceFile: string,
  cspConnectSrcAllowsHttps: boolean,
): boolean {
  // Skip non-enforced violations (report-only from dual-CSP interaction).
  if (disposition && disposition !== 'enforce') return true;
  // connect-src + HTTPS: only suppress when the page CSP actually allows https: scheme.
  // This is scoped to the current policy state, not a blanket protocol assumption.
  if (directive === 'connect-src' && cspConnectSrcAllowsHttps) {
    try {
      if (new URL(blockedURI).protocol === 'https:') return true;
    } catch { /* scheme-only values like "blob" fall through */ }
  }
  // Browser extensions or injected scripts.
  if (/^(?:chrome|moz|safari(?:-web)?)-extension/.test(sourceFile) || /^(?:chrome|moz|safari(?:-web)?)-extension/.test(blockedURI)) return true;
  // blob: — browsers report "blob" (scheme-only) or "blob:https://...".
  if (blockedURI === 'blob' || /^blob:/.test(sourceFile) || /^blob:/.test(blockedURI)) return true;
  // eval/inline/data.
  if (blockedURI === 'eval' || blockedURI === 'inline' || blockedURI === 'data' || /^data:/.test(blockedURI)) return true;
  // Android WebView video poster injection.
  if (blockedURI === 'android-webview-video-poster') return true;
  // Own manifest.webmanifest — stale CSP cache hit.
  if (/manifest\.webmanifest$/.test(blockedURI)) return true;
  // Third-party injectors: Google Translate, Facebook Pixel.
  if (/gstatic\.com\/_\/translate/.test(blockedURI) || /facebook\.net/.test(blockedURI)) return true;
  // YouTube live stream manifests.
  if (/googlevideo\.com|youtube\.com\/generate_204/.test(blockedURI)) return true;
  // Corporate/school content filter injections.
  if (/securly\.com|goguardian\.com|contentkeeper\.com/.test(blockedURI)) return true;
  // Vercel Analytics script.
  if (/_vercel\/insights\/script\.js/.test(blockedURI)) return true;
  // Inline script blocks from extensions/in-app browsers.
  if (blockedURI === 'inline' && directive === 'script-src-elem') return true;
  // Null blocked URI from in-app browsers.
  if (blockedURI === 'null') return true;
  // localhost/loopback — Smart TV browsers (Tizen, webOS) and dev tools inject local service calls.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(blockedURI)) return true;
  return false;
}
// Detect once whether BOTH the meta tag and HTTP header CSP allow https: in connect-src.
// Browsers enforce both independently — the effective policy is the intersection.
// Only suppress HTTPS connect-src violations when both policies allow https:.
// The HTTP header CSP isn't directly readable from JS, so we check the meta tag and
// also parse the vercel.json-derived header value baked into the build.
const _cspAllowsHttps = (() => {
  const metaEl = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const metaCsp = metaEl?.getAttribute('content') ?? '';
  const metaConnectSrc = metaCsp.match(/connect-src\s+([^;]*)/)?.[1] ?? '';
  const metaAllows = /\bhttps:\b/.test(metaConnectSrc);
  // If no meta CSP exists, we can't confirm both policies allow https:.
  // Be conservative: only suppress if the meta tag explicitly has it.
  if (!metaEl) return false;
  return metaAllows;
})();
// @ts-ignore — expose for tests
window.__shouldSuppressCspViolation = shouldSuppressCspViolation;

// Report CSP violations in the parent page to Sentry.
// Sandbox iframe violations are isolated and not captured here.
window.addEventListener('securitypolicyviolation', (e) => {
  const blocked = e.blockedURI ?? '';
  if (shouldSuppressCspViolation(
    e.disposition ?? '',
    e.effectiveDirective ?? '',
    blocked,
    e.sourceFile ?? '',
    _cspAllowsHttps,
  )) return;
  Sentry.captureMessage(`CSP: ${e.effectiveDirective} blocked ${blocked || '(inline)'}`, {
    level: 'warning',
    tags: { kind: 'csp_violation' },
    extra: {
      violatedDirective: e.violatedDirective,
      effectiveDirective: e.effectiveDirective,
      blockedURI: blocked,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
      disposition: e.disposition,
    },
  });
});

import { debugGetCells, getCellCount } from '@/services/geo-convergence';
import { initMetaTags } from '@/services/meta-tags';
import { installRuntimeFetchPatch, installWebApiRedirect } from '@/services/runtime';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { applyStoredTheme } from '@/utils/theme-manager';
import { applyFont } from '@/services/font-settings';
import { SITE_VARIANT } from '@/config/variant';
import { clearChunkReloadGuard, installChunkReloadGuard } from '@/bootstrap/chunk-reload';
import { installSwUpdateHandler } from '@/bootstrap/sw-update';

// Auto-reload on stale chunk 404s after deployment (Vite fires this for modulepreload failures).
const chunkReloadStorageKey = installChunkReloadGuard(__APP_VERSION__);

// Initialize Vercel Analytics (10% sampling to reduce costs)
inject({
  beforeSend: (event) => (Math.random() > 0.1 ? null : event),
});

// Initialize dynamic meta tags for sharing
initMetaTags();

// In desktop mode, route /api/* calls to the local Tauri sidecar backend.
installRuntimeFetchPatch();
// In web production, route RPC calls through api.worldmonitor.app (Cloudflare edge).
installWebApiRedirect();
loadDesktopSecrets().catch(() => {});

// Apply stored theme preference before app initialization (safety net for inline script)
applyStoredTheme();
applyFont();

// Set data-variant on <html> so CSS theme overrides activate
if (SITE_VARIANT && SITE_VARIANT !== 'full') {
  document.documentElement.dataset.variant = SITE_VARIANT;

  // Swap favicons to variant-specific versions before browser finishes fetching defaults
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
    link.href = link.href
      .replace(/\/favico\/favicon/g, `/favico/${SITE_VARIANT}/favicon`)
      .replace(/\/favico\/apple-touch-icon/g, `/favico/${SITE_VARIANT}/apple-touch-icon`);
  });
}

// Remove no-transition class after first paint to enable smooth theme transitions
requestAnimationFrame(() => {
  document.documentElement.classList.remove('no-transition');
});

// Clear stale settings-open flag (survives ungraceful shutdown)
localStorage.removeItem('wm-settings-open');

// Standalone windows: ?settings=1 = panel display settings, ?live-channels=1 = channel management
// Both need i18n initialized so t() does not return undefined.
const urlParams = new URL(location.href).searchParams;
if (urlParams.get('settings') === '1') {
  void Promise.all([import('./services/i18n'), import('./settings-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initSettingsWindow();
    }
  );
} else if (urlParams.get('live-channels') === '1') {
  void Promise.all([import('./services/i18n'), import('./live-channels-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initLiveChannelsWindow();
    }
  );
} else {
  installUtmInterceptor();
  const app = new App('app');
  app
    .init()
    .then(() => {
      clearChunkReloadGuard(chunkReloadStorageKey);
    })
    .catch(console.error);
}

// Debug helpers for geo-convergence testing (remove in production)
(window as unknown as Record<string, unknown>).geoDebug = {
  cells: debugGetCells,
  count: getCellCount,
};

// Beta mode toggle: type `beta=true` / `beta=false` in console
Object.defineProperty(window, 'beta', {
  get() {
    const on = localStorage.getItem('worldmonitor-beta-mode') === 'true';
    console.log(`[Beta] ${on ? 'ON' : 'OFF'}`);
    return on;
  },
  set(v: boolean) {
    if (v) localStorage.setItem('worldmonitor-beta-mode', 'true');
    else localStorage.removeItem('worldmonitor-beta-mode');
    location.reload();
  },
});

// Suppress native WKWebView context menu in Tauri — allows custom JS context menus
if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    // Allow native menu on text inputs/textareas for copy/paste
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    e.preventDefault();
  });
}

if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window) && 'serviceWorker' in navigator) {
  installSwUpdateHandler({ version: __APP_VERSION__ });

  const SW_UPDATE_SUCCESS_INTERVAL_MS = 60 * 60 * 1000;
  const SW_UPDATE_FAILURE_INTERVAL_MS = 5 * 60 * 1000;
  const SW_UPDATE_LAST_CHECK_KEY = 'wm-sw-last-update-check';
  const SW_UPDATE_LAST_RESULT_KEY = 'wm-sw-last-update-ok';

  const readStorageNum = (key: string): number => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? Number(raw) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  };

  const writeStorageNum = (key: string, value: number): void => {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  };

  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((registration) => {
      console.log('[PWA] Service worker registered');

      let swUpdateInFlight = false;

      const maybeCheckForSwUpdate = async (
        reason: 'initial' | 'visible' | 'online' | 'interval'
      ): Promise<void> => {
        if (swUpdateInFlight) return;
        if (!navigator.onLine) return;
        if (reason === 'interval' && document.visibilityState !== 'visible') return;

        const now = Date.now();
        const lastCheck = readStorageNum(SW_UPDATE_LAST_CHECK_KEY);
        const lastOk = readStorageNum(SW_UPDATE_LAST_RESULT_KEY);
        const interval = lastOk >= lastCheck ? SW_UPDATE_SUCCESS_INTERVAL_MS : SW_UPDATE_FAILURE_INTERVAL_MS;
        if (now - lastCheck < interval) return;

        swUpdateInFlight = true;
        writeStorageNum(SW_UPDATE_LAST_CHECK_KEY, now);
        try {
          await registration.update();
          writeStorageNum(SW_UPDATE_LAST_RESULT_KEY, now);
        } catch (e) {
          console.warn('[PWA] SW update check failed:', e);
        } finally {
          swUpdateInFlight = false;
        }
      };

      void maybeCheckForSwUpdate('initial');

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void maybeCheckForSwUpdate('visible');
        }
      });

      window.addEventListener('online', () => {
        void maybeCheckForSwUpdate('online');
      });

      const swUpdateInterval = window.setInterval(() => {
        void maybeCheckForSwUpdate('interval');
      }, 15 * 60 * 1000);

      (window as unknown as Record<string, unknown>).__swUpdateInterval = swUpdateInterval;
    })
    .catch((err) => {
      console.warn('[PWA] Service worker registration failed:', err);
    });
}

// --- SW/Cache Nuke Template ---
// If stale service workers or caches cause issues after a major deploy, re-enable this block.
// It runs once per user (guarded by a localStorage key), nukes all SWs and caches, then reloads.
// IMPORTANT: This causes a visible double-load for every new/unkeyed user. Remove once rollout is complete.
//
// const nukeKey = 'wm-sw-nuked-v3';
// let alreadyNuked = false;
// try { alreadyNuked = !!localStorage.getItem(nukeKey); } catch {}
// if (!alreadyNuked) {
//   try { localStorage.setItem(nukeKey, '1'); } catch {}
//   navigator.serviceWorker.getRegistrations().then(async (regs) => {
//     await Promise.all(regs.map(r => r.unregister()));
//     const keys = await caches.keys();
//     await Promise.all(keys.map(k => caches.delete(k)));
//     console.log('[PWA] Nuked stale service workers and caches');
//     window.location.reload();
//   });
// }
