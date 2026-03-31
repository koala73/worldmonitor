import './styles/base-layer.css';
import './styles/happy-theme.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Sentry from '@sentry/browser';
import { inject } from '@vercel/analytics';
import { App } from './App';
import { installUtmInterceptor } from './utils/utm';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

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
    /^TypeError: Failed to fetch( \(.*\))?$/,
    /^TypeError: (?:cancelled|avbruten)$/,
    /^TypeError: NetworkError/,
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
    /Failed to fetch dynamically imported module/,
    /Importing a module script failed/,
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
    /^Key not found$/,
    /DataCloneError.*could not be cloned/,
    /cannot decode message/,
    /WKWebView was deallocated/,
    /Unexpected end of(?: JSON)? input/,
    /window\.android\.\w+ is not a function/,
    /Attempted to assign to readonly property/,
    /Cannot assign to read only property/,
    /FetchEvent\.respondWith/,
    /e\.toLowerCase is not a function/,
    /\.trim is not a function/,
    /\.(indexOf|findIndex) is not a function/,
    /QuotaExceededError/,
    /^TypeError: 已取消$/,
    /Maximum call stack size exceeded/,
    /^fetchError: Network request failed$/,
    /window\.ethereum/,
    /^SyntaxError: Unexpected token/,
    /^Operation timed out\.?$/,
    /setting 'luma'/,
    /ML request .* timed out/,
    /^Element not found$/,
    /(?:AbortError: )?The operation was aborted\.?\s*$/,
    /Unexpected end of script/,
    /error loading dynamically imported module/,
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
    /Invalid or unexpected token/,
    /evaluating 'elemFound\.value'/,
    /[Cc]an(?:'t|not) access (?:'\w+'|lexical declaration '\w+') before initialization/,
    /^Uint8Array$/,
    /createObjectStore/,
    /The database connection is closing/,
    /shortcut icon/,
    /Attempting to change value of a readonly property/,
    /reading 'nodeType'/,
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
    /^(?:LIDNotify(?:Id)?|onWebViewAppeared|onGetWiFiBSSID|onHide|onShow|onReady|tapAt|removeHighlight) is not defined$/,
    /signal timed out/,
    /Se requiere plan premium/,
    /hybridExecute is not defined/,
    /reading 'postMessage'/,
    /NotSupportedError/,
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
    /Cannot add property \w+, object is not extensible/,
    /Failed to construct 'Worker'.*cannot be accessed from origin/,
    /undefined is not an object \(evaluating '(?:this\.)?media(?:Controller)?\.(?:duration|videoTracks|readyState|audioTracks|media)/,
    /\$ is not defined/,
    /Qt\([^)]*\) is not a function/,
    /out of memory/,
    /Could not connect to the server/,
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
    /^TypeError: Internal error$/,
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
    /^SyntaxError: Unexpected keyword/,
    /ucConfig is not defined/,
    /getShaderPrecisionFormat/,
    /Cannot read properties of null \(reading 'touches'\)/,
    /Failed to execute 'querySelectorAll' on '[^']*': ':[a-z]+\(/,
    /args\.site\.enabledFeatures/,
    /can't access property "\w+", FONTS\[/,
    /^\w{1,2} is not a function\. \(In '\w{1,2}\(/,
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
  ],
  beforeSend(event) {
    const msg = event.exception?.values?.[0]?.value ?? '';
    if (msg.length <= 3 && /^[a-zA-Z_$]+$/.test(msg)) return null;
    const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
    // Suppress maplibre internal null-access crashes (light, placement) only when stack is in map chunk
    if (/this\.style\._layers|reading '_layers'|this\.(light|sky) is null|can't access property "(id|type|setFilter)"[,] ?\w+ is (null|undefined)|can't access property "(id|type)" of null|Cannot read properties of null \(reading '(id|type|setFilter|_layers)'\)|null is not an object \(evaluating '\w{1,3}\.(id|style)|^\w{1,2} is null$/.test(msg)) {
      if (frames.some(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
    }
    // Suppress any TypeError that happens entirely within maplibre or deck.gl internals
    const excType = event.exception?.values?.[0]?.type ?? '';
    if ((excType === 'TypeError' || /^TypeError:/.test(msg)) && frames.length > 0) {
      const nonSentryFrames = frames.filter(f => f.filename && f.filename !== '<anonymous>' && f.filename !== '[native code]' && !/\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename));
      if (nonSentryFrames.length > 0 && nonSentryFrames.every(f => /\/(map|maplibre|deck-stack)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? ''))) return null;
    }
    // Suppress Three.js/globe.gl TypeError crashes in main bundle (reading 'type'/'pathType'/'count'/'__globeObjType' on undefined during WebGL traversal/raycast)
    if (/reading '(?:type|pathType|count|__globeObjType)'|can't access property "(?:type|pathType|count|__globeObjType)",? \w+ is (?:undefined|null)|undefined is not an object \(evaluating '\w+\.(?:pathType|count|__globeObjType)'\)|null is not an object \(evaluating '\w+\.__globeObjType'\)/.test(msg)) {
      const nonSentryFrames = frames.filter(f => f.filename && f.filename !== '<anonymous>' && f.filename !== '[native code]' && !/\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename));
      const hasSourceMapped = nonSentryFrames.some(f => /\.(ts|tsx)$/.test(f.filename ?? '') || /^src\//.test(f.filename ?? ''));
      if (!hasSourceMapped) return null;
    }
    // Suppress minified Three.js/globe.gl crashes (e.g. "l is undefined" in raycast, "b is undefined" in update/initGlobe)
    if (/^\w{1,2} is (?:undefined|not an object)$/.test(msg) && frames.length > 0) {
      if (frames.some(f => /\/(main|index)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? '') && /(raycast|update|initGlobe|traverse|render)/.test(f.function ?? ''))) return null;
    }
    // Suppress Three.js OrbitControls touch crashes (finger lifted during pinch-zoom)
    if (/undefined is not an object \(evaluating 't\.x'\)|Cannot read properties of undefined \(reading 'x'\)/.test(msg)) {
      const nonSentryFrames = frames.filter(f => f.filename && f.filename !== '<anonymous>' && f.filename !== '[native code]' && !/\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename));
      const hasSourceMapped = nonSentryFrames.some(f => /\.(ts|tsx)$/.test(f.filename ?? '') || /^src\//.test(f.filename ?? ''));
      if (!hasSourceMapped) return null;
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
    // Suppress errors originating from UV proxy (Ultraviolet service worker)
    if (frames.some(f => /\/uv\/service\//.test(f.filename ?? '') || /uv\.handler/.test(f.filename ?? ''))) return null;
    // Suppress Greasemonkey/Tampermonkey userscript errors (x-plugin-script)
    if (frames.length > 0 && frames.every(f => !f.filename || /\/x-plugin-script\//.test(f.filename))) return null;
    // Suppress YouTube IFrame widget API internal errors
    if (frames.some(f => /www-widgetapi\.js/.test(f.filename ?? ''))) return null;
    // Suppress Sentry beacon XHR transport errors (readyState on aborted XHR — not our code)
    if (frames.some(f => /beacon\.min\.js/.test(f.filename ?? ''))) return null;
    // Suppress TransactionInactiveError only when no first-party frames are present
    // (Safari kills open IDB transactions in background tabs — not actionable noise)
    // First-party paths in storage.ts / persistent-cache.ts / vector-db.ts must still surface.
    if (/TransactionInactiveError/.test(msg) || excType === 'TransactionInactiveError') {
      const appFrames = frames.filter(
        f => f.filename && f.filename !== '<anonymous>' && f.filename !== '[native code]'
          && !/\/sentry-[A-Za-z0-9_-]+\.js/.test(f.filename)
      );
      const hasFirstParty = appFrames.some(
        f => /\.(ts|tsx)$/.test(f.filename ?? '') || /^src\//.test(f.filename ?? '')
          || /\/(main|index|app)-[A-Za-z0-9_-]+\.js/.test(f.filename ?? '')
      );
      if (!hasFirstParty) return null;
    }
    return event;
  },
});
// Suppress NotAllowedError from YouTube IFrame API's internal play() — browser autoplay policy,
// not actionable. The YT IFrame API doesn't expose the play() promise so it leaks as unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

// Report CSP violations in the parent page to Sentry.
// Sandbox iframe violations are isolated and not captured here.
window.addEventListener('securitypolicyviolation', (e) => {
  const src = e.sourceFile ?? '';
  const blocked = e.blockedURI ?? '';
  // Skip violations originating from browser extensions or injected scripts.
  // Browsers may report blockedURI as scheme-only ("chrome-extension") or with origin ("chrome-extension://...").
  if (/^(?:chrome|moz|safari(?:-web)?)-extension/.test(src) || /^(?:chrome|moz|safari(?:-web)?)-extension/.test(blocked)) return;
  // Browsers may report blob: as "blob" (scheme-only) or "blob:https://..." — both are noise.
  if (blocked === 'blob' || /^blob:/.test(src) || /^blob:/.test(blocked)) return;
  // Skip eval/inline/data: blocked URIs — browsers may report "data" (scheme-only) or full data: URI.
  if (blocked === 'eval' || blocked === 'inline' || blocked === 'data' || /^data:/.test(blocked)) return;
  // Skip Android WebView video poster injection.
  if (blocked === 'android-webview-video-poster') return;
  // Skip own manifest.webmanifest — stale CSP cache hit, not a real violation (default-src 'self' covers it).
  if (/manifest\.webmanifest$/.test(blocked)) return;
  // Skip third-party injectors: Google Translate, Facebook Pixel
  if (/gstatic\.com\/_\/translate/.test(blocked) || /facebook\.net/.test(blocked)) return;
  // Skip Sentry reporting itself (connect-src bootstrap paradox — SDK blocked before it can report)
  if (/sentry\.io\/api\//.test(blocked)) return;
  // Skip YouTube live stream manifests (media-src — expected from YouTube embeds)
  if (/googlevideo\.com|youtube\.com\/generate_204/.test(blocked)) return;
  // Skip corporate/school content filter injections (securly, GoGuardian, etc.)
  if (/securly\.com|goguardian\.com|contentkeeper\.com/.test(blocked)) return;
  // Skip Vercel Analytics (script-src — known first-party, not a real violation to action)
  if (/_vercel\/insights\/script\.js/.test(blocked)) return;
  // Skip inline script blocks — browser extension or in-app browser injection, not actionable
  if (blocked === 'inline' && e.effectiveDirective === 'script-src-elem') return;
  // Skip null blocked URI — in-app browsers (Baidu, WeChat, Instagram) inject null-src iframes
  if (blocked === 'null') return;
  Sentry.captureMessage(`CSP: ${e.effectiveDirective} blocked ${blocked || '(inline)'}`, {
    level: 'warning',
    tags: { kind: 'csp_violation' },
    extra: {
      violatedDirective: e.violatedDirective,
      effectiveDirective: e.effectiveDirective,
      blockedURI: blocked,
      sourceFile: src,
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
