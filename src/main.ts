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
import { loadVariantThemeStylesheet } from '@/bootstrap/variant-theme';
import { App } from './App';
import { installUtmInterceptor } from './utils/utm';
import { captureContentAttributionFromUrl } from '../shared/content-attribution';

if (SITE_VARIANT === 'happy') {
  // Keeps happy-theme.css off other variants' eager CSS graph. On happy, the
  // stylesheet applies asynchronously, so a brief base-theme flash is possible.
  // The import is fire-and-forget, so its rejection must be consumed: Vite's
  // preload helper rejects with `Unable to preload CSS for <url>` when the
  // injected <link> errors, and a bare `void import(...)` let that escape to
  // onunhandledrejection (WORLDMONITOR-XT). See bootstrap/variant-theme.ts.
  void loadVariantThemeStylesheet('happy', () => import('./styles/happy-theme.css'));
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
  cspFontSrcAllowsCrossOrigin: boolean = false,
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
      // Clerk avatar CDN (`img.clerk.com`) — the only cross-origin image host
      // our UI loads (Clerk UserButton avatar). Explicitly allowed by our
      // `img-src https:`, so a block here is the same mutated-policy class as
      // the first-party rule above (WORLDMONITOR-JP round 2 — Firefox privacy
      // extensions stripping `https:`). Exact hostname + https: only, so blocks
      // on any other clerk.com host or a lookalike suffix still surface.
      if (url.protocol === 'https:' && url.hostname === 'img.clerk.com') return true;
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
  // HeyTap Browser (the stock browser on OPPO / realme / OnePlus Android
  // devices) injects its own chrome scripts from `dhfs.heytapimage.com` — the
  // vendor's asset CDN — into every page it renders. The string `heytap`
  // appears nowhere in `src/`, `pro-test/src/`, `public/`, `index.html` or
  // `tests/`, so we never request it; the block is the browser's own injection
  // failing against our policy, and the injected feature stays broken in that
  // environment regardless of our code.
  //
  // Host-pinned rather than "any cross-origin script-src block", even though
  // our `script-src` is `'self' 'strict-dynamic' <nonce> <hashes>` and admits
  // no cross-origin host at all. That invariant would license the broader rule
  // by the same argument the font-src section uses, but it must NOT be taken
  // here: a script one of our OWN trusted scripts injects without carrying the
  // nonce forward is also cross-origin and also blocked, and that is a real
  // first-party defect. WORLDMONITOR-HP holds exactly that shape in its
  // history — `clerk.worldmonitor.app/npm/@clerk/ui@1/dist/ui.browser.js` and
  // `www.worldmonitor.app/assets/locale-zh-*.js` blocks through June/July —
  // so the cross-origin invariant is the wrong axis and the vendor host is the
  // right one. Exact parsed hostname (not a suffix) so a
  // `dhfs.heytapimage.com.evil.com` lookalike still surfaces.
  //
  // Sizing: HP's 33k lifetime events are a fixed bug's residue. A 40-event
  // sample taken 2026-08-29 spanned 2026-06-25 → 2026-08-27, and the only
  // events after 2026-07-19 were 3 heytapimage blocks and 1 first-party
  // `locale-zh` block — so this host IS the live tail, and pinning it lets the
  // issue be resolved and act as a canary for any NEW script-src block class.
  if (directive === 'script-src-elem' || directive === 'script-src') {
    try {
      const url = new URL(blockedURI);
      if (url.protocol === 'https:' && url.hostname === 'dhfs.heytapimage.com') return true;
    } catch { /* scheme-only values ('inline', 'eval') fall through */ }
  }
  // Zscaler enterprise content-filter proxy: `gateway.zscloud.net` is injected into
  // corporate users' frames by Zscaler's web filter agent. We never load it ourselves;
  // it's inserted into the host page outside our control (WORLDMONITOR-HT). Match by
  // parsed hostname so a `gateway.zscloud.net.evil.com` lookalike doesn't bypass the
  // surrounding signal filters.
  if (directive === 'frame-src') {
    try {
      const frameUrl = new URL(blockedURI);
      const frameHost = frameUrl.hostname;
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
      // Tampermonkey "h5player" video-enhancement userscript (large Chinese
      // install base) frames its own vendor host into every page with a
      // <video> element. We never reference anzz.site; exact parsed-hostname
      // match like the vendor rules above so lookalikes still surface
      // (WORLDMONITOR-HT long tail — 5.8k events / 1.2k users since March).
      if (frameHost === 'h5player.anzz.site') return true;
      // `div.show` — an origin-only frame (no path) that appears nowhere in our
      // source, repeated across many users over months. The injector is not
      // identified, but it does not need to be: frame-src is a BOUNDED
      // allowlist — named hosts plus five vendor wildcard subdomains
      // (*.clerk.accounts.dev, *.vercel.app, *.dodopayments.com and two more) —
      // and div.show falls under none of them, so it can only have been framed
      // into the page from outside. That safety argument depends on frame-src
      // staying bounded — pinned by "CSP frame-src stays a bounded host
      // allowlist" in tests/deploy-config.test.mjs.
      // Sizing, unlike the font/style rules above: this is ~9% of the issue and
      // NOT its dominant slice. WORLDMONITOR-HT has no dominant host, and its
      // largest share is the Google account hosts we deliberately keep
      // surfaced, so no rule here can quiet it — this one is added because it
      // is cleanly identifiable, not because it fixes HT. Exact host, so the
      // rotating merchant-domain tail below stays surfaced (WORLDMONITOR-HT).
      // Narrowed to the exact observed shape — https, origin-only, no path —
      // rather than the whole host, because a destination match alone does not
      // establish that the frame was injected. Anything else on this host still
      // reports.
      if (frameUrl.protocol === 'https:' && frameHost === 'div.show' && frameUrl.pathname === '/') return true;
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
  // ---- font-src: one invariant, not a host list.
  //
  // The app ships `font-src 'self' data:` (vercel.json, the catch-all route that
  // serves /dashboard) and self-hosts every face it uses. That policy admits NO
  // cross-origin source, so a cross-origin font block is by construction a face
  // WE DID NOT REQUEST — an extension or in-app browser injected a stylesheet
  // into our page and the browser blocked its font.
  //
  // This replaces sixteen host-pinned rules shipped over eight rounds
  // (fonts.gstatic /s/ and /l/font, perplexity, doubao, migaku, at.alicdn,
  // slant, shopback, simplycodes, scite, typekit, use.fontawesome, merci-app,
  // yiban, marmot, unpkg, jsDelivr, cdnjs). Every one of them carried this same
  // justification in its comment — "our font-src is 'self' data:, so this cannot
  // be ours" — and every one was followed within days by a different extension
  // injecting a different host. The host set is unbounded and attacker/vendor
  // controlled, so enumerating it can never converge; applying the invariant
  // once does. Round 9 would have been assets.faircado.com.
  //
  // Why a bare https: check is sufficient to mean "cross-origin": `'self'`
  // already permits our own origin, so a same-origin font never produces a
  // violation at all. The existence of an https font-src violation is therefore
  // itself proof the URI was not same-origin.
  //
  // Policy-aware, exactly like the connect-src / media-src gates above — this is
  // scoped to the current policy state, not a blanket protocol assumption. If
  // the app ever adopts a cross-origin font host, the caller passes true here
  // and font blocks surface again. tests/deploy-config.test.mjs pins the shipped
  // header to zero cross-origin font sources so that adoption cannot land
  // silently and leave this suppression over-broad.
  //
  // Scope: font-src ONLY. style-src/script-src/connect-src keep their exact-host
  // pinning below, because a violation there can indicate a real injection
  // vector, whereas a blocked webfont is cosmetic and already-mitigated.
  if (directive === 'font-src' && !cspFontSrcAllowsCrossOrigin) {
    try {
      if (new URL(blockedURI).protocol === 'https:') return true;
    } catch { /* scheme-only values ('data', 'inline', 'eval') fall through */ }
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
    // Same reason as `fontFile` above: the plain suffix rules below would
    // otherwise re-type this per host, which is how such rules drift apart.
    // Two rules deliberately do NOT use it: Google Fonts matches a path PREFIX
    // (`/css`, `/css2`), and Typekit pins an exact path shape per host.
    const cssFile = /\.css$/;
    try {
      const url = new URL(blockedURI);
      if (url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com' && /^\/css2?$/.test(url.pathname)) return true;
      // Chinese-market extension CDN injecting its overlay stylesheet
      // (www.6ppn.com/ext/assets/style.<hash>.css — the /ext/ path is the
      // extension's own asset root). Exact host + .css path (WORLDMONITOR-J0).
      if (url.protocol === 'https:' && url.hostname === 'www.6ppn.com' && cssFile.test(url.pathname)) return true;
      // FontAwesome public CDN. The injected sheet is v4.7.0 — a 2016 release
      // this app never shipped — and our style-src is `'self' 'unsafe-inline'`
      // with no cross-origin host at all, so any use.fontawesome.com stylesheet
      // is third-party by construction (WORLDMONITOR-J0 round 3: 80% of the
      // issue's current volume). Exact host + .css path; their JS bundle under
      // script-src still surfaces.
      if (url.protocol === 'https:' && url.hostname === 'use.fontawesome.com'
          && url.pathname.startsWith('/releases/') && cssFile.test(url.pathname)) return true;
      // Adobe Typekit / Adobe Fonts kit CSS, from both hosts it serves:
      // `use.typekit.net/<kit>.css` and the `p.typekit.net/p.css?...` tracking
      // sheet — together 17% of this issue's current volume. We self-host every
      // font and reference no kit id, so these are injected by a theme
      // extension or the user's own stylesheet manager.
      if (url.protocol === 'https:'
          && ((url.hostname === 'use.typekit.net' && /^\/[^/]+\.css$/.test(url.pathname))
            || (url.hostname === 'p.typekit.net' && url.pathname === '/p.css'))) return true;
      // unpkg's Leaflet stylesheet. WorldMonitor renders every map with
      // MapLibre/deck.gl and has never depended on Leaflet — the string appears
      // nowhere in src/, api/, public/, index.html or package.json — and this
      // page's style-src is `'self' 'unsafe-inline'` with no cross-origin host,
      // so an unpkg sheet is injected by an extension or userscript. Round 4 of
      // WORLDMONITOR-J0, and the only blockedURI still live: a 300-event sample
      // taken 2026-08-16 showed every other host silent since its own rule
      // shipped (6ppn 07-05, Google Fonts 07-20, Typekit 08-02, FontAwesome
      // 08-07) while unpkg produced 6 events that morning across 3 builds.
      // Exact host + `.css` path, like the 6ppn rule; unpkg under script-src
      // still surfaces, which matters because it is a general npm CDN.
      if (url.protocol === 'https:' && url.hostname === 'unpkg.com' && cssFile.test(url.pathname)) return true;
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
// font-src counterpart of `_cspAllowsHttps`, but asking a different question.
// connect-/media-src ask "does the policy allow the https: SCHEME?"; font-src asks
// "does the policy allow ANY cross-origin source at all?" — because the shipped
// header is `font-src 'self' data:` and every face is self-hosted, which is what
// licenses suppressing cross-origin font blocks wholesale.
// Keyword sources ('self', 'none', 'unsafe-inline') and the data:/blob: schemes are
// not cross-origin hosts; anything else in the list is.
const _cspFontSrcAllowsCrossOrigin = (() => {
  const metaEl = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  // No meta CSP: the deployed header is the source of truth, and
  // tests/deploy-config.test.mjs pins it to zero cross-origin font sources.
  if (!metaEl) return false;
  const metaCsp = metaEl.getAttribute('content') ?? '';
  const metaFontSrc = metaCsp.match(/font-src\s+([^;]*)/)?.[1] ?? '';
  return metaFontSrc
    .split(/\s+/)
    .filter(Boolean)
    .some(token => !/^'[^']*'$/.test(token) && !/^(?:data|blob):$/.test(token));
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
    _cspFontSrcAllowsCrossOrigin,
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
import { installFetchFailureAttribution } from '@/services/fetch-failure-attribution';
import { installRuntimeFetchPatch, installWebApiRedirect } from '@/services/runtime';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { applyStoredTheme } from '@/utils/theme-manager';
import { applyFont } from '@/services/font-settings';
import { applyFontScale, FONT_SCALE_STORAGE_KEY } from '@/services/font-scale-settings';
import { initAnalytics, trackContentHandoff } from '@/services/analytics';
import { clearChunkReloadGuard, installChunkReloadGuard } from '@/bootstrap/chunk-reload';
import { initDebugBearRum } from '@/bootstrap/debugbear-rum';
import { installStaleBundleCheck } from '@/bootstrap/stale-bundle-check';
import { installSwUpdateHandler, readServiceWorkerContainer } from '@/bootstrap/sw-update';

// Auto-reload on stale chunk 404s after deployment (Vite fires this for modulepreload failures).
const chunkReloadStorageKey = installChunkReloadGuard(__BUILD_HASH__);

// Product analytics are secondary startup work; RUM starts once the trusted
// dashboard entry executes so it can observe page-load vitals.
const capturedContentAttribution = captureContentAttributionFromUrl();
if (capturedContentAttribution) {
  // The event is queued safely if the deferred Umami tracker is not ready.
  // `captureContentAttributionFromUrl` returns only fresh URL captures, so a
  // reload does not duplicate the landing handoff.
  trackContentHandoff();
}
void initAnalytics();
initVercelAnalytics();
initDebugBearRum();

// Initialize dynamic meta tags for sharing
initMetaTags();

// MUST stay first among the fetch wrappers. This one wraps native `fetch`
// directly and sits at the BOTTOM of the delegation chain, so every request
// that reaches the network passes through it — including the ones
// `wmSessionFetch` early-returns past (non-API targets, credential-less public
// data, premium paths), which is where the Umami beacon lives. Installed above
// instead, it would miss exactly the traffic it exists to attribute.
// Guarded by tests/fetch-attribution-install-order.test.mts. #6746.
installFetchFailureAttribution();
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
applyFontScale();
window.addEventListener('storage', (event) => {
  if (event.key === FONT_SCALE_STORAGE_KEY) applyFontScale();
});

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
    .catch((error: unknown) => {
      console.error(error);
      try {
        // init() registers WebMCP before its first await. A failed boot must
        // therefore run normal teardown so the browser cannot retain tools
        // bound to an App that will never become ready.
        app.destroy();
      } catch (cleanupError) {
        // Cleanup is best-effort on a partially initialised App; never replace
        // the original boot failure with an unhandled teardown rejection.
        console.error('[App] Failed to clean up after initialization failure:', cleanupError);
      }
    });
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

// `'serviceWorker' in navigator` is not a safe gate: in a sandboxed iframe the
// property exists but reading it throws SecurityError (WORLDMONITOR-Y5), which
// at module scope aborts every top-level statement below. Read it once, safely.
const swContainer = readServiceWorkerContainer();
if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window) && swContainer) {
  installSwUpdateHandler({ version: __APP_VERSION__, swContainer });

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
