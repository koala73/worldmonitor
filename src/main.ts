import './styles/base-layer.css';
import './bootstrap/zod-csp';
import { SITE_VARIANT } from '@/config/variant';
import { installLcpAttributionDebug } from '@/bootstrap/lcp-attribution';
import { markLcpDebug } from '@/utils/lcp-debug';
import { enqueueSentryCall, installPreInitErrorQueue, scheduleSentryInit } from '@/bootstrap/sentry-defer';
import { registerClsReporting } from '@/bootstrap/cls-report';
import { registerInpReporting } from '@/bootstrap/inp-report';
import { registerLcpReporting } from '@/bootstrap/lcp-report';
import { initVercelAnalytics } from '@/bootstrap/secondary-startup';
import { App } from './App';
import { installUtmInterceptor } from './utils/utm';

if (SITE_VARIANT === 'happy') {
  // Keeps happy-theme.css off other variants' eager CSS graph. On happy, the
  // stylesheet applies asynchronously, so a brief base-theme flash is possible.
  void import('./styles/happy-theme.css');
}

// Activate the deferred dashboard app stylesheet. The build
// (deferDashboardStylesheetLinks in vite.config.ts) emits the large dashboard
// CSS as <link media="print" data-wm-deferred-style="dashboard"> + a <noscript>
// blocking copy, so it does not block first paint; flipping media to "all" here
// applies it once main.js runs. The selector below MUST stay in lockstep with
// the attribute/value the build writes (data-wm-deferred-style="dashboard" +
// media="print"). No-JS users get the <noscript> fallback; if main.js fails to
// execute (e.g. an /assets 404 after a redeploy) the wm-sw-nuke handler in
// index.html reloads. Kept as the first body statement so it runs before the
// rest of startup.
function activateDeferredDashboardStyles(): void {
  document
    .querySelectorAll<HTMLLinkElement>('link[data-wm-deferred-style="dashboard"][media="print"]')
    .forEach((link) => {
      link.media = 'all';
    });
}

activateDeferredDashboardStyles();
installLcpAttributionDebug();

// perf G — defer @sentry/browser off the critical path (#3994).
// The eager `Sentry.init({...})` previously ran here cost ~1.96 s of pre-LCP
// CPU. Install a lightweight error-buffering queue synchronously so any error
// thrown before the SDK lands is captured + flushed on init, then schedule
// the actual SDK load via requestIdleCallback. The init options + SDK ship in
// the deferred sentry-*.js chunk, not the main entry.
installPreInitErrorQueue();
scheduleSentryInit();

// Report field INP attribution to Sentry (through the deferred-Sentry queue) so
// we can see which real interaction is slow and whether the cost is input delay,
// processing, or presentation (#4537). web-vitals loads in its own post-paint chunk.
registerInpReporting();

// Report field CLS attribution to Sentry so field-only layout shifts can name
// their largest shifting element before we scope the layout fix (#4580).
registerClsReporting();

// Report field LCP attribution to Sentry so the last-mile render-delay work can
// see the real LCP element plus TTFB / load-delay / load-time / render-delay parts (#5079).
registerLcpReporting();

// Suppress NotAllowedError from YouTube IFrame API's internal play() — browser autoplay policy,
// not actionable. The YT IFrame API doesn't expose the play() promise so it leaks as unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

// CSP violation filter — exported for testability.
// Returns true if the violation should be suppressed (not reported to Sentry).
function shouldSuppressCspViolation(
  disposition: string,
  directive: string,
  blockedURI: string,
  sourceFile: string,
  cspConnectSrcAllowsHttps: boolean,
  firstPartyConvexHost: string | null,
  cspMediaSrcAllowsHttps: boolean = false,
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
  // media-src + HTTPS: HLS / live-stream media-element loads. Our header CSP
  // allows the `https:` scheme (`media-src 'self' data: blob: https:`), so an
  // *enforced* https: media-src block means a corporate proxy / privacy extension
  // stripped `https:` from the user's effective media-src — the same environmental
  // policy mutation as the connect-src case above. The HLS *manifest* fetch is
  // connect-src (already suppressed via the foxnews-style rule); this covers the
  // media element load of that same stream. Built-in and user-added custom HLS
  // channels (LiveNewsPanel) both hit this — WORLDMONITOR-HV (bloomberg.com
  // us.m3u8, 4 users). Gated on policy detection so it stays scoped to the
  // current policy state, not a blanket protocol assumption. http: media-src
  // blocks (real mixed-content) still surface.
  if (directive === 'media-src' && cspMediaSrcAllowsHttps) {
    try {
      if (new URL(blockedURI).protocol === 'https:') return true;
    } catch { /* scheme-only values fall through */ }
  }
  // Baidu read-aloud / TTS browser extensions (common in the Chinese market)
  // inject an `<audio src="http://tts.baidu.com/text2audio?...&text=<selected
  // text>">` element to speak page content when the user clicks/selects it. We
  // never load tts.baidu.com (it appears nowhere in src) and our media-src
  // allows only `'self' data: blob: https:`, so this http: load is third-party
  // mixed-content the CSP correctly blocks — the audio never plays regardless of
  // our code. UNLIKE the https: media-src rule above this is NOT protocol-gated
  // on policy detection: it is host-pinned to an exact third-party hostname we
  // provably never reference, so suppressing its http: block cannot mask a
  // first-party mixed-content regression (we ship no http:// media). Parsed
  // hostname match (not substring) so a `tts.baidu.com.evil.com` lookalike still
  // surfaces (WORLDMONITOR-TW — map-popup description read-aloud, 1 user).
  if (directive === 'media-src') {
    try {
      if (new URL(blockedURI).hostname === 'tts.baidu.com') return true;
    } catch { /* scheme-only values fall through */ }
  }
  // default-src + HTTP: mixed-content block on a fetch type we set no explicit
  // directive for — i.e. browser link-prefetch ("Preload pages" speculation) or
  // an extension article-prefetcher. News article links render as plain
  // <a target="_blank"> navigations (NewsPanel/ClimateNewsPanel/etc.) carrying
  // feed-supplied URLs; some sources / downgrading proxies emit them over http:,
  // and the browser/extension speculatively fetches them — the load falls to the
  // default-src fallback because we set no prefetch-src. Our app is HTTPS-only and
  // ships no http:// subresource loads, and every fetch directive we DO use
  // (connect-src, img-src, script-src, media-src) is set explicitly, so a genuine
  // first-party mixed-content fetch surfaces under its specific directive — never
  // this default-src fallback. Preserve first-party worldmonitor.app http blocks
  // so a real mixed-content regression on our own assets still surfaces
  // (WORLDMONITOR-S0 — http://www.euronews.com article prefetch, 1 user/775 ev).
  if (directive === 'default-src') {
    try {
      const u = new URL(blockedURI);
      if (u.protocol === 'http:'
          && u.hostname !== 'worldmonitor.app'
          && !u.hostname.endsWith('.worldmonitor.app')) return true;
    } catch { /* scheme-only values fall through */ }
  }
  // First-party Convex backend: corporate proxies / privacy extensions that mutate the
  // page CSP (stripping bare `https:` from connect-src) cause our Convex sync calls to
  // be CSP-blocked even though our policy allows them. Suppress unconditionally for OUR
  // configured Convex deployment hostname (`VITE_CONVEX_URL`) so we don't drown Sentry
  // in 1M+ events/month from those users (WORLDMONITOR-HN). Convex is multi-tenant —
  // do NOT suppress all `*.convex.cloud`, that would silently swallow blocks to foreign/
  // attacker-controlled Convex projects. Match by exact hostname only. Real first-party
  // CSP regressions on this host are caught by the staging deploy + uptime check.
  if (directive === 'connect-src' && firstPartyConvexHost) {
    try {
      if (new URL(blockedURI).hostname === firstPartyConvexHost) return true;
    } catch { /* scheme-only values fall through */ }
  }
  // First-party img-src block on OUR registrable domain: same pattern as the Convex
  // connect-src case above. Corporate proxies / privacy extensions (Zscaler, Symantec
  // CloudSOC, school content-filters) can strip both `'self'` and `https:` from img-src
  // in the user's effective policy, causing our own favicon and panel icons to be
  // CSP-blocked even though our policy (`img-src 'self' data: blob: https:`) allows
  // them. Scope to `worldmonitor.app` and its subdomains — img-src blocks to foreign
  // hosts (a third-party CDN we never load, attacker-controlled host) still surface
  // (WORLDMONITOR-JP). Suffix check uses a leading `.` so lookalikes like
  // `worldmonitor.app.evil.com` do NOT match.
  //
  // REQUIRE https: protocol — our CSP only allows https: for img-src, so a real
  // mixed-content regression (`<img src="http://worldmonitor.app/...">`) would be
  // blocked by the browser. Suppressing http: blocks on first-party hosts would mask
  // that regression in Sentry. The `cspConnectSrcAllowsHttps` block above uses the
  // same protocol gate for connect-src.
  if (directive === 'img-src') {
    try {
      const url = new URL(blockedURI);
      if (url.protocol === 'https:'
          && (url.hostname === 'worldmonitor.app' || url.hostname.endsWith('.worldmonitor.app'))) return true;
    } catch { /* scheme-only values fall through */ }
  }
  // YouTube IFrame API loader: explicitly allowed by our script-src
  // (`https://www.youtube.com`), so a block here means a third party (extension,
  // corporate proxy, in-app webview) mutated the policy. Not actionable — embedded
  // video remains broken in that user's environment regardless of our code
  // (WORLDMONITOR-HP).
  if (
    (directive === 'script-src-elem' || directive === 'script-src')
    && /^https:\/\/www\.youtube\.com\/iframe_api(?:\?|$)/.test(blockedURI)
  ) return true;
  // Zscaler enterprise content-filter proxy: `gateway.zscloud.net` is injected into
  // corporate users' frames by Zscaler's web filter agent. We never load it ourselves;
  // it's inserted into the host page outside our control (WORLDMONITOR-HT). Match by
  // parsed hostname so a `gateway.zscloud.net.evil.com` lookalike doesn't bypass the
  // surrounding signal filters.
  if (directive === 'frame-src') {
    try {
      const frameHost = new URL(blockedURI).hostname;
      if (frameHost === 'gateway.zscloud.net') return true;
      // Same class, other vendors (WORLDMONITOR-HT long tail): NetSTAR inSITE
      // (gw-*.iss.netstar-inc.com), Techloq (filter.techloq.com — kosher
      // content filter), Trend Micro password-manager/agent asset frames
      // (pwm-image.trendmicro.com). All are filter/security agents framing
      // their own vendor hosts into every page; we never frame any of them.
      // Parsed-hostname suffix match with a leading `.` so lookalike
      // registrable domains (netstar-inc.com.evil.com) do not match.
      if (frameHost === 'netstar-inc.com' || frameHost.endsWith('.netstar-inc.com')) return true;
      if (frameHost === 'techloq.com' || frameHost.endsWith('.techloq.com')) return true;
      if (frameHost === 'trendmicro.com' || frameHost.endsWith('.trendmicro.com')) return true;
      // Google-internal extension/API hosts (`*.clients6.google.com`, e.g.
      // toolytics.pa.clients6.google.com) framed by Google-account browser
      // surfaces and extensions. We never frame Google API hosts — but keep
      // accounts.google.com / support.google.com SURFACED: a future first-party
      // Google sign-in embed regression must not be masked.
      if (frameHost.endsWith('.clients6.google.com')) return true;
    } catch { /* scheme-only values fall through */ }
  }
  // Browser extensions or injected scripts. `ms-browser-extension://` is Edge's
  // scheme for legacy/internal extensions (WORLDMONITOR-JM).
  if (/^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension/.test(sourceFile) || /^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension/.test(blockedURI)) return true;
  // blob: — browsers report "blob" (scheme-only) or "blob:https://...".
  if (blockedURI === 'blob' || /^blob:/.test(sourceFile) || /^blob:/.test(blockedURI)) return true;
  // eval/inline/data.
  if (blockedURI === 'eval' || blockedURI === 'inline' || blockedURI === 'data' || /^data:/.test(blockedURI)) return true;
  // about: — browsers report "about" (scheme-only) or "about:blank" / "about:srcdoc"
  // for iframes created by extensions, ad-injectors, or Smart TV browsers (Samsung
  // Internet on Tizen). We never set frame src to about:* ourselves (WORLDMONITOR-JQ).
  if (blockedURI === 'about' || /^about:/.test(blockedURI)) return true;
  // Android WebView video poster injection.
  if (blockedURI === 'android-webview-video-poster') return true;
  // Own manifest.webmanifest — stale CSP cache hit.
  if (/manifest\.webmanifest$/.test(blockedURI)) return true;
  // Third-party injectors: Google Translate, Facebook Pixel.
  if (/gstatic\.com\/_\/translate/.test(blockedURI) || /facebook\.net/.test(blockedURI)) return true;
  // Google Fonts font files from stale or injected stylesheets. The dashboard now
  // self-hosts its own fonts and the deploy/config tests keep Google Fonts out of
  // dashboard CSP/source surfaces; if a user's browser still tries
  // fonts.gstatic.com/s/*.woff2, the strict font-src block is expected noise.
  if (directive === 'font-src') {
    try {
      const url = new URL(blockedURI);
      if (url.protocol === 'https:' && url.hostname === 'fonts.gstatic.com' && /^\/s\/.+\.woff2$/.test(url.pathname)) return true;
      // Perplexity's Comet browser / extension injects its own UI webfont
      // (frontend-cdn.perplexity.ai/_agi_assets/fonts/*.woff2) into every page.
      // We never load it; the block is the overlay's font failing regardless of
      // our code. Allowlisted by exact host like gstatic above — NOT a blanket
      // third-party suppression, so an unexpected font injection from any other
      // host still surfaces (WORLDMONITOR-TR: 1065 events / 83 users).
      if (url.protocol === 'https:' && url.hostname === 'frontend-cdn.perplexity.ai' && /\.woff2?$/.test(url.pathname)) return true;
      // ByteDance's Doubao AI-assistant browser/extension injects its overlay's
      // KaTeX math fonts (lf-flow-web-cdn.doubao.com/obj/flow-doubao/...) into
      // every page — .woff2/.woff/.ttf fallback chain, so all three extensions
      // appear. We never load it; exact host + font-file path like the rules
      // above, NOT a blanket third-party suppression (WORLDMONITOR-TR round 2:
      // 310k events / 308 users in 11 days).
      if (url.protocol === 'https:' && url.hostname === 'lf-flow-web-cdn.doubao.com' && /\.(?:woff2?|ttf)$/.test(url.pathname)) return true;
    } catch { /* scheme-only values fall through */ }
  }
  // YouTube live stream manifests.
  if (/googlevideo\.com|youtube\.com\/generate_204/.test(blockedURI)) return true;
  // Corporate/school content filter injections.
  if (/securly\.com|goguardian\.com|contentkeeper\.com/.test(blockedURI)) return true;
  // Vercel Analytics script.
  if (/_vercel\/insights\/script\.js/.test(blockedURI)) return true;
  // Third-party stylesheet injection from public CDNs (browser extensions,
  // bookmarklets, "inspect element" UI tools loading antd/bootstrap/etc.).
  // We legitimately load JS from `cdn.jsdelivr.net` (chart.js in the
  // widget-sanitizer iframe), but never CSS — so a `style-src*` block on
  // jsDelivr is by definition third-party
  // injection (WORLDMONITOR-J0 — antd@4 CSS injection, 270 events / 26
  // users on finance.worldmonitor.app).
  if (/^style-src(-elem)?$/.test(directive) && /^https:\/\/cdn\.jsdelivr\.net\//.test(blockedURI)) return true;
  // Google Fonts CSS injected by extensions/user-style themes (DM Sans, Syne,
  // Roboto… — families we never reference). The dashboard self-hosts all fonts
  // and the deploy/config tests keep Google Fonts out of our source/CSP
  // surfaces, so a style-src* block on fonts.googleapis.com/css* is by
  // definition third-party injection — the stylesheet counterpart of the
  // fonts.gstatic.com font-src rule above (WORLDMONITOR-J0 round 2). Exact
  // host + /css path; Google Fonts under any other directive still surfaces.
  if (/^style-src(-elem)?$/.test(directive)) {
    try {
      const url = new URL(blockedURI);
      if (url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com' && /^\/css2?$/.test(url.pathname)) return true;
      // Chinese-market extension CDN injecting its overlay stylesheet
      // (www.6ppn.com/ext/assets/style.<hash>.css — the /ext/ path is the
      // extension's own asset root). Exact host + .css path (WORLDMONITOR-J0).
      if (url.protocol === 'https:' && url.hostname === 'www.6ppn.com' && /\.css$/.test(url.pathname)) return true;
    } catch { /* unparseable values fall through */ }
    // Extension bug: a literal unsubstituted `[email]` template placeholder as
    // the stylesheet URL. Not a parseable host; can never be first-party.
    if (blockedURI === 'https://[email]') return true;
  }
  // Inline script blocks from extensions/in-app browsers.
  if (blockedURI === 'inline' && directive === 'script-src-elem') return true;
  // Null blocked URI from in-app browsers.
  if (blockedURI === 'null') return true;
  // localhost/loopback — Smart TV browsers (Tizen, webOS) and dev tools inject local service calls.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(blockedURI)) return true;
  return false;
}
// Detect once whether the effective dashboard CSP allows https: in connect-src.
// The dashboard policy now ships as an HTTP header only; older/stale documents
// may still carry a meta CSP, so if one exists, honor it as the stricter local
// signal. Otherwise the deployed header is the source of truth.
const _cspAllowsHttps = (() => {
  const metaEl = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!metaEl) return true;
  const metaCsp = metaEl.getAttribute('content') ?? '';
  const metaConnectSrc = metaCsp.match(/connect-src\s+([^;]*)/)?.[1] ?? '';
  return metaConnectSrc.split(/\s+/).includes('https:');
})();
// media-src counterpart of `_cspAllowsHttps`.
const _cspMediaSrcAllowsHttps = (() => {
  const metaEl = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!metaEl) return true;
  const metaCsp = metaEl.getAttribute('content') ?? '';
  const metaMediaSrc = metaCsp.match(/media-src\s+([^;]*)/)?.[1] ?? '';
  return metaMediaSrc.split(/\s+/).includes('https:');
})();
// Resolve our configured Convex deployment hostname once. Convex is multi-tenant —
// the CSP filter must scope its first-party suppression to OUR specific hostname,
// not all *.convex.cloud, otherwise blocks to foreign/attacker tenants get silently
// dropped too. Returns null when the env var is missing (dev/test); the filter
// then leaves connect-src violations to fall through to the next rule.
const _firstPartyConvexHost = ((): string | null => {
  const url = import.meta.env.VITE_CONVEX_URL;
  if (typeof url !== 'string' || url.length === 0) return null;
  try { return new URL(url).hostname; } catch { return null; }
})();
// @ts-expect-error — expose for tests
window.__shouldSuppressCspViolation = shouldSuppressCspViolation;

// Report CSP violations in the parent page to Sentry.
// Sandbox iframe violations are isolated and not captured here.
// The listener stays installed eagerly so early violations (during the
// deferred-Sentry-init window) are still observed; `enqueueSentryCall`
// forwards immediately if the SDK is up, otherwise buffers until drain.
window.addEventListener('securitypolicyviolation', (e) => {
  const blocked = e.blockedURI ?? '';
  if (shouldSuppressCspViolation(
    e.disposition ?? '',
    e.effectiveDirective ?? '',
    blocked,
    e.sourceFile ?? '',
    _cspAllowsHttps,
    _firstPartyConvexHost,
    _cspMediaSrcAllowsHttps,
  )) return;
  const message = `CSP: ${e.effectiveDirective} blocked ${blocked || '(inline)'}`;
  const extra = {
    violatedDirective: e.violatedDirective,
    effectiveDirective: e.effectiveDirective,
    blockedURI: blocked,
    sourceFile: e.sourceFile,
    lineNumber: e.lineNumber,
    disposition: e.disposition,
  };
  enqueueSentryCall((s) => {
    s.captureMessage(message, {
      level: 'warning',
      tags: { kind: 'csp_violation' },
      extra,
    });
  });
});

import { debugGetCells, getCellCount } from '@/services/geo-convergence';
import { initMetaTags } from '@/services/meta-tags';
import { installRuntimeFetchPatch, installWebApiRedirect } from '@/services/runtime';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { applyStoredTheme } from '@/utils/theme-manager';
import { applyFont } from '@/services/font-settings';
import { initAnalytics } from '@/services/analytics';
import { clearChunkReloadGuard, installChunkReloadGuard } from '@/bootstrap/chunk-reload';
import { initDebugBearRum } from '@/bootstrap/debugbear-rum';
import { installStaleBundleCheck } from '@/bootstrap/stale-bundle-check';
import { installSwUpdateHandler } from '@/bootstrap/sw-update';

// Auto-reload on stale chunk 404s after deployment (Vite fires this for modulepreload failures).
const chunkReloadStorageKey = installChunkReloadGuard(__APP_VERSION__);

// Product analytics are secondary startup work; RUM starts once the trusted
// dashboard entry executes so it can observe page-load vitals.
void initAnalytics();
initVercelAnalytics();
initDebugBearRum();

// Initialize dynamic meta tags for sharing
initMetaTags();

// In desktop mode, route /api/* calls to the local Tauri sidecar backend.
installRuntimeFetchPatch();
// In web production, route RPC calls through api.worldmonitor.app (Cloudflare edge).
installWebApiRedirect();
// Force-reload tabs running a stale bundle (catches the class of bug where
// users keep a tab open across a wire-shape change). Skips when build-hash
// is the 'dev' marker.
installStaleBundleCheck();
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
try {
  localStorage.removeItem('wm-settings-open');
} catch {
  // Storage may be unavailable (blocked cookies, sandboxed iframe). The flag is
  // only a convenience hint, so boot must continue with the in-memory default.
}

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
  markLcpDebug('wm:boot:app-construct');
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
