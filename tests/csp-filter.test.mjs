import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extract the shouldSuppressCspViolation function from main.ts source.
// We parse it as a standalone function to avoid importing the entire Sentry/App bootstrap.
const mainSrc = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
const fnMatch = mainSrc.match(/function shouldSuppressCspViolation\(([\s\S]*?)\): boolean \{([\s\S]*?)\nfunction |function shouldSuppressCspViolation\(([\s\S]*?)\): boolean \{([\s\S]*?)\n\}/);
assert.ok(fnMatch, 'shouldSuppressCspViolation must exist in src/main.ts');

// Build a callable version from the source text
const fnBody = (fnMatch[2] ?? fnMatch[4]).trim();
const fnParams = (fnMatch[1] ?? fnMatch[3])
  .split(',')
  .map(p => p.replace(/:.*/s, '').trim())
  .filter(Boolean);
// eslint-disable-next-line no-new-func
const suppress = new Function(...fnParams, fnBody);

describe('CSP violation filter (shouldSuppressCspViolation)', () => {
  describe('disposition gating', () => {
    it('suppresses report-only disposition', () => {
      assert.ok(suppress('report', 'connect-src', 'https://example.com', '', true));
    });

    it('allows enforce disposition', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/inject.js', '', false));
    });

    it('allows empty disposition (browser did not set it)', () => {
      assert.ok(!suppress('', 'script-src', 'https://evil.com/inject.js', '', false));
    });
  });

  describe('connect-src HTTPS suppression (policy-aware)', () => {
    it('suppresses HTTPS connect-src when CSP allows https:', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://api.worldmonitor.app/api/oref-alerts', '', true));
    });

    it('suppresses HTTPS connect-src for tilecache.rainviewer.com', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://tilecache.rainviewer.com/v2/radar/abc/256/4/3/4/6/1_1.png', '', true));
    });

    it('suppresses HTTPS connect-src for Sentry ingest (origin-only)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://o450.ingest.us.sentry.io', '', true));
    });

    it('suppresses HTTPS connect-src for Sentry ingest (with port and path)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://o450.ingest.us.sentry.io:443/api/12345/envelope/', '', true));
    });

    it('suppresses HTTPS connect-src for foxnews HLS', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://247preview.foxnews.com/hls/live/stream.m3u8', '', true));
    });

    it('does NOT suppress HTTPS connect-src when CSP does not allow https:', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://api.worldmonitor.app/api/oref-alerts', '', false));
    });

    it('does NOT suppress HTTP connect-src even when CSP allows https:', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'http://insecure.example.com/api', '', true));
    });

    it('does NOT suppress non-connect-src HTTPS violations', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/inject.js', '', true));
    });
  });

  describe('media-src HTTPS suppression (policy-aware) — WORLDMONITOR-HV', () => {
    // 7th positional arg = cspMediaSrcAllowsHttps. Our media-src policy carries
    // `https:` in both the meta tag and the vercel.json header, so an enforced
    // https: media-src block is an environmental policy mutation (proxy/extension
    // stripping `https:`), not a real regression.
    it('suppresses HTTPS media-src for a custom HLS stream when CSP allows https:', () => {
      assert.ok(suppress('enforce', 'media-src', 'https://bloomberg.com/media-manifest/streams/us.m3u8', '', false, null, true));
    });

    it('suppresses HTTPS media-src for a built-in HLS stream when CSP allows https:', () => {
      assert.ok(suppress('enforce', 'media-src', 'https://247preview.foxnews.com/hls/live/stream.m3u8', '', false, null, true));
    });

    it('does NOT suppress HTTPS media-src when CSP does not allow https:', () => {
      assert.ok(!suppress('enforce', 'media-src', 'https://bloomberg.com/media-manifest/streams/us.m3u8', '', false, null, false));
    });

    it('does NOT suppress HTTP media-src (real mixed-content) even when CSP allows https:', () => {
      assert.ok(!suppress('enforce', 'media-src', 'http://insecure.example.com/stream.m3u8', '', false, null, true));
    });

    it('does NOT suppress non-media-src HTTPS violations via the media gate', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/inject.js', '', false, null, true));
    });
  });

  describe('media-src tts.baidu.com extension injection — WORLDMONITOR-TW', () => {
    // Baidu read-aloud / TTS extensions inject `<audio src="http://tts.baidu.com/
    // text2audio?...&text=...">` to speak page content. http: mixed-content the
    // CSP correctly blocks; we never load tts.baidu.com, so it is third-party
    // noise. Host-pinned (not protocol-gated) — works even with cspMediaSrcAllowsHttps
    // false because the http: block can never originate from our own bundle.
    it('suppresses http: media-src for tts.baidu.com regardless of policy detection', () => {
      assert.ok(suppress('enforce', 'media-src', 'http://tts.baidu.com/text2audio?lan=en&text=hello', '', false, null, false));
      assert.ok(suppress('enforce', 'media-src', 'http://tts.baidu.com/text2audio?lan=en&text=hello', '', false, null, true));
    });

    it('does NOT suppress a tts.baidu.com.evil.com lookalike host', () => {
      assert.ok(!suppress('enforce', 'media-src', 'http://tts.baidu.com.evil.com/text2audio?text=x', '', false, null, true));
    });

    it('does NOT suppress http: media-src for an unrelated host (real mixed-content)', () => {
      assert.ok(!suppress('enforce', 'media-src', 'http://insecure.example.com/stream.m3u8', '', false, null, true));
    });
  });

  describe('default-src HTTP mixed-content suppression — WORLDMONITOR-S0', () => {
    // Browser link-prefetch / extension fetching a feed-supplied http article
    // URL; falls to the default-src fallback (no prefetch-src set). HTTPS-only
    // app never ships http subresource loads, so third-party http default-src
    // blocks are environmental.
    it('suppresses http default-src block to a third-party news host', () => {
      assert.ok(suppress('enforce', 'default-src', 'http://www.euronews.com/my-europe/2026/05/27/some-article', '', false));
    });

    it('does NOT suppress http default-src block to our own host (real mixed-content regression)', () => {
      assert.ok(!suppress('enforce', 'default-src', 'http://www.worldmonitor.app/asset.json', '', false));
      assert.ok(!suppress('enforce', 'default-src', 'http://worldmonitor.app/asset.json', '', false));
    });

    it('does NOT suppress an https default-src block (still potential signal)', () => {
      assert.ok(!suppress('enforce', 'default-src', 'https://prefetch.example.com/page', '', false));
    });

    it('does NOT let a worldmonitor.app suffix-spoof lookalike bypass the first-party gate', () => {
      // worldmonitor.app.evil.com is third-party → http block IS suppressed (it is not us).
      assert.ok(suppress('enforce', 'default-src', 'http://worldmonitor.app.evil.com/x', '', false));
    });
  });

  describe('extension and injection filters', () => {
    it('suppresses chrome-extension source', () => {
      assert.ok(suppress('enforce', 'script-src', 'https://x.com/a.js', 'chrome-extension://abc/content.js', false));
    });

    it('suppresses moz-extension blocked URI', () => {
      assert.ok(suppress('enforce', 'script-src', 'moz-extension://abc/inject.js', '', false));
    });

    it('suppresses safari-web-extension', () => {
      assert.ok(suppress('enforce', 'script-src', 'safari-web-extension://abc', '', false));
    });

    it('suppresses ms-browser-extension blocked URI (Edge)', () => {
      assert.ok(suppress('enforce', 'font-src', 'ms-browser-extension://abc/font.woff2', '', false));
    });

    it('suppresses ms-browser-extension source file (Edge)', () => {
      assert.ok(suppress('enforce', 'script-src', 'https://x.com/a.js', 'ms-browser-extension://abc/inject.js', false));
    });
  });

  describe('scheme-only and special values', () => {
    it('suppresses blob (scheme-only)', () => {
      assert.ok(suppress('enforce', 'worker-src', 'blob', '', false));
    });

    it('suppresses blob: URI', () => {
      assert.ok(suppress('enforce', 'worker-src', 'blob:https://www.worldmonitor.app/abc', '', false));
    });

    it('suppresses eval', () => {
      assert.ok(suppress('enforce', 'script-src', 'eval', '', false));
    });

    it('suppresses inline for script-src-elem', () => {
      assert.ok(suppress('enforce', 'script-src-elem', 'inline', '', false));
    });

    it('suppresses inline regardless of directive (eval/inline catch-all)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'inline', '', false));
    });

    it('suppresses data: URI', () => {
      assert.ok(suppress('enforce', 'img-src', 'data:image/png;base64,abc', '', false));
    });

    it('suppresses null blocked URI', () => {
      assert.ok(suppress('enforce', 'frame-src', 'null', '', false));
    });

    it('suppresses android-webview-video-poster', () => {
      assert.ok(suppress('enforce', 'img-src', 'android-webview-video-poster', '', false));
    });

    it('suppresses about (scheme-only) for frame-src — Smart TV browsers / extensions', () => {
      assert.ok(suppress('enforce', 'frame-src', 'about', '', false));
    });

    it('suppresses about:blank frame-src', () => {
      assert.ok(suppress('enforce', 'frame-src', 'about:blank', '', false));
    });

    it('suppresses about:srcdoc frame-src', () => {
      assert.ok(suppress('enforce', 'frame-src', 'about:srcdoc', '', false));
    });
  });

  describe('third-party noise', () => {
    it('suppresses Google Translate', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://translate.gstatic.com/_/translate_http', '', false));
    });

    it('suppresses Google Fonts font files from stale or injected stylesheets', () => {
      assert.ok(suppress('enforce', 'font-src', 'https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk2wotcqA.woff2', '', false));
    });

    it('suppresses Google Fonts font files with query params', () => {
      assert.ok(suppress('enforce', 'font-src', 'https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk2wotcqA.woff2?display=swap', '', false));
    });

    it('does NOT let a font extension in the QUERY STRING trigger the Google Fonts rule', () => {
      // The rule anchors on `url.pathname`, which excludes the query, so a
      // font-looking query value cannot satisfy it. The fixture uses a non-font
      // pathname because the rule now covers the whole woff2/woff/ttf/otf
      // fallback chain (WORLDMONITOR-TR round 3) — a `.woff` PATH is suppressed
      // on purpose now, so it can no longer carry this assertion.
      assert.ok(!suppress('enforce', 'font-src', 'https://fonts.gstatic.com/s/mulish/v18/font.css?kit=abc.woff2', '', false));
    });

    it('does NOT suppress a Google Fonts lookalike host', () => {
      // Every other font-src host rule has this; gstatic did not, so a host
      // widening there was the one such mutation the suite could not catch.
      assert.ok(!suppress('enforce', 'font-src', 'https://fonts.gstatic.com.evil.com/s/mulish/v18/x.woff2', '', false));
    });

    it('does NOT suppress Google Fonts files outside the /s/ path', () => {
      // Pins the `/^\/s\/.+/` conjunct — without this, deleting that conjunct
      // leaves the whole suite green.
      assert.ok(!suppress('enforce', 'font-src', 'https://fonts.gstatic.com/x/a/b.woff2', '', false));
    });

    it('does NOT suppress http: font-src on the injected-webfont hosts', () => {
      // Pins the `url.protocol === 'https:'` conjunct the new rules share; the
      // other new negatives only cover lookalike host and non-font path.
      assert.ok(!suppress('enforce', 'font-src', 'http://migaku-public-data.migaku.com/fonts/x/cw_0.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'http://at.alicdn.com/t/c/font_1011144_jmo4009ffif.woff', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'http://www.slant.co/fonts/plus-jakarta/Display-Bold.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'http://static.shopback.com/fonts/ShopBackSans-Bold.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'http://images.simplycodes.com/fonts/simply-circular/CircularXXWeb-Regular.woff2', '', false));
    });

    it('does NOT suppress a SIBLING registrable domain of a pinned font host', () => {
      // The `<host>.evil.com` fixtures elsewhere are rejected by ANY hostname
      // check, including a suffix match, so they cannot prove exactness. These
      // do: each is a domain an attacker can register that a naive
      // `endsWith('alicdn.com')` style refactor would start swallowing.
      assert.ok(!suppress('enforce', 'font-src', 'https://evilalicdn.com/t/c/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://evil-at.alicdn.com/t/c/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://myslant.co/fonts/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://notmigaku.com/fonts/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://evil-fonts.gstatic.com/s/a/b.woff2', '', false));
      // Sibling SUBDOMAINS too — these kill an `endsWith('.migaku.com')` style
      // mutant that a sibling registrable domain alone leaves alive.
      assert.ok(!suppress('enforce', 'font-src', 'https://cdn.migaku.com/fonts/chiron-hei-hk-webfont-2.6.7/cw_0.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://cdn.doubao.com/obj/flow-doubao/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://cdn.perplexity.ai/_agi_assets/fonts/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://cdn.shopback.com/fonts/ShopBackSans-Bold.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://cdn.simplycodes.com/fonts/simply-circular/CircularXXWeb-Regular.woff2', '', false));
    });

    it('pins the end-anchor on the shared font matcher', () => {
      // Without the `$`, `/\.(?:woff2?|ttf|otf)/` matches mid-path and a
      // sourcemap alongside the font would be swallowed.
      assert.ok(!suppress('enforce', 'font-src', 'https://at.alicdn.com/t/c/font_1011144.woff2.map', '', false));
    });

    it('does NOT suppress http: font-src on gstatic', () => {
      // The other http: negative covers migaku/alicdn/slant; without this one,
      // dropping gstatic's https gate leaves the whole suite green.
      assert.ok(!suppress('enforce', 'font-src', 'http://fonts.gstatic.com/s/a/b.woff2', '', false));
    });

    it('does NOT suppress an unrelated path on an injected-webfont host', () => {
      // A destination match alone does not prove injection: the same host could
      // serve a font our own code someday references. Each rule is pinned to the
      // path prefix actually observed from the injector, so an off-signature
      // path on the same host keeps reporting.
      assert.ok(!suppress('enforce', 'font-src', 'https://migaku-public-data.migaku.com/unrelated/regression.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://at.alicdn.com/other/regression.woff', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://www.slant.co/assets/regression.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai/unrelated/regression.ttf', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/unrelated/regression.otf', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://static.shopback.com/unrelated/regression.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://images.simplycodes.com/unrelated/regression.woff2', '', false));
    });

    it('does NOT suppress a SIBLING registrable domain, or http:, on a pinned stylesheet host', () => {
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://notfontawesome.com/releases/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://faketypekit.net/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'http://use.fontawesome.com/releases/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'http://use.typekit.net/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'http://p.typekit.net/p.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://cdn.fontawesome.com/releases/v4.7.0/css/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://cdn.6ppn.com/ext/assets/style.abc.css', '', false));
    });

    it('pins the end-anchor on the shared stylesheet matcher', () => {
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://www.6ppn.com/ext/assets/style.abc.css.map', '', false));
    });

    it('does NOT suppress an unrelated path on an injected-stylesheet host', () => {
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.fontawesome.com/unrelated/regression.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.typekit.net/nested/regression.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://p.typekit.net/regression.css', '', false));
    });

    it('does NOT suppress arbitrary third-party font-src hosts', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://fonts.evil.example/s/mulish/v18/font.woff2', '', false));
    });

    it('suppresses Perplexity Comet overlay webfont injection (WORLDMONITOR-TR)', () => {
      assert.ok(suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai/_agi_assets/fonts/FKGroteskNeue.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai/_agi_assets/fonts/FKGroteskNeue.woff', '', false));
      // Shares the whole-chain matcher with the other font-src hosts, so the
      // block header's "every host rule below" claim is literally true.
      assert.ok(suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai/_agi_assets/fonts/FKGroteskNeue.ttf', '', false));
    });

    it('does NOT suppress a perplexity.ai lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://frontend-cdn.perplexity.ai/_agi_assets/app.js', '', false));
    });

    it('suppresses Doubao AI-assistant overlay KaTeX font injection (WORLDMONITOR-TR round 2)', () => {
      // ByteDance Doubao extension injects KaTeX fonts with a woff2/woff/ttf
      // fallback chain — all three extensions must be covered.
      assert.ok(suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/flow-ext-doubao/cdn-media-assets/KaTeX_Fraktur-Regular.7c187121.woff', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/flow-ext-doubao/cdn-media-assets/KaTeX_Fraktur-Regular.d3c882a6.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/flow-ext-doubao/cdn-media-assets/KaTeX_Fraktur-Bold.b18f59e1.ttf', '', false));
    });

    it('does NOT suppress a doubao.com lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/app.js', '', false));
    });

    it('suppresses the Doubao .otf fallback the woff2/woff/ttf rule missed (WORLDMONITOR-TR round 3)', () => {
      // The observed escape: an .otf face is part of the same @font-face
      // fallback chain, so restricting the rule to woff2?/ttf leaked it.
      assert.ok(suppress('enforce', 'font-src', 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/flow-ext-doubao/cdn-media-assets/Montserrat-SemiBold.c57269b8.otf', '', false));
    });

    it('suppresses Google Fonts faces in every format, not just woff2 (WORLDMONITOR-TR round 3)', () => {
      // Observed escape: fonts.gstatic.com/s/poppins/v24/*.ttf. Legacy browsers
      // and stale injected stylesheets request ttf/woff from the same /s/ path.
      assert.ok(suppress('enforce', 'font-src', 'https://fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJfedw.ttf', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk2wotcqA.woff', '', false));
    });

    it('suppresses Migaku language-extension webfont injection (WORLDMONITOR-TR round 3)', () => {
      // Migaku injects a subsetted Chiron Hei HK webfont as many numbered
      // chunks; 38 distinct URLs in a 14-day sample, 69% of the issue's volume.
      assert.ok(suppress('enforce', 'font-src', 'https://migaku-public-data.migaku.com/fonts/chiron-hei-hk-webfont-2.6.7/cw_0.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://migaku-public-data.migaku.com/fonts/chiron-hei-hk-webfont-2.6.7/kx_12.woff2', '', false));
    });

    it('does NOT suppress a migaku.com lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://migaku-public-data.migaku.com.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://migaku-public-data.migaku.com/fonts/app.js', '', false));
    });

    it('suppresses Alibaba iconfont CDN injection (WORLDMONITOR-TR round 3)', () => {
      // at.alicdn.com/t/c/font_* is iconfont.cn's project CDN. One icon font
      // requested in all three formats by an injected @font-face chain.
      assert.ok(suppress('enforce', 'font-src', 'https://at.alicdn.com/t/c/font_1011144_jmo4009ffif.woff?t=1719821135173', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://at.alicdn.com/t/c/font_1011144_jmo4009ffif.woff2?t=1719821135173', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://at.alicdn.com/t/c/font_1011144_jmo4009ffif.ttf?t=1719821135173', '', false));
    });

    it('does NOT suppress an alicdn lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://at.alicdn.com.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://at.alicdn.com/t/c/loader.js', '', false));
    });

    it('suppresses slant.co overlay webfont injection (WORLDMONITOR-TR round 3)', () => {
      // Plus Jakarta Display in 3 weights x 2 formats, served from the
      // injecting extension's own origin. We ship no cross-origin webfonts.
      assert.ok(suppress('enforce', 'font-src', 'https://www.slant.co/fonts/plus-jakarta/Display-Bold.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://www.slant.co/fonts/plus-jakarta/Display-Regular.woff', '', false));
    });

    it('does NOT suppress a slant.co lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://www.slant.co.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://www.slant.co/fonts/loader.js', '', false));
    });

    it('suppresses ShopBack cashback-extension webfont injection (WORLDMONITOR-TR round 4)', () => {
      // ShopBackSans in 8 weight/style combinations from the extension's own
      // static origin. 100% of the issue's volume in the window after the
      // round-3 rules deployed — every host named there went silent, this one
      // did not, which is what regressed the issue minutes after a resolve.
      assert.ok(suppress('enforce', 'font-src', 'https://static.shopback.com/fonts/ShopBackSans-Bold.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://static.shopback.com/fonts/ShopBackSans-BlackItalic.woff2', '', false));
    });

    it('does NOT suppress a shopback lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://static.shopback.com.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://static.shopback.com/fonts/loader.js', '', false));
    });

    it('suppresses SimplyCodes coupon-extension webfont injection (WORLDMONITOR-TR round 4)', () => {
      // Three families (Circular XX, Neue Haas Grotesk, Degular) under one
      // /fonts/ root — 10 distinct URLs, the second-largest remaining slice.
      assert.ok(suppress('enforce', 'font-src', 'https://images.simplycodes.com/fonts/simply-circular/CircularXXWeb-Regular.woff2', '', false));
      assert.ok(suppress('enforce', 'font-src', 'https://images.simplycodes.com/fonts/neue-haas-grotesk/NHaasGroteskDSPro-55Rg.woff2', '', false));
    });

    it('does NOT suppress a simplycodes lookalike host or non-font path', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://images.simplycodes.com.evil.com/x.woff2', '', false));
      assert.ok(!suppress('enforce', 'font-src', 'https://images.simplycodes.com/fonts/loader.js', '', false));
    });

    it('does NOT suppress Google Fonts under unrelated directives', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://fonts.gstatic.com/s/mulish/v18/1Ptvg83HX_SGhgqk2wotcqA.woff2', '', false));
    });

    it('suppresses Facebook Pixel', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://connect.facebook.net/en_US/fbevents.js', '', false));
    });

    it('suppresses googlevideo (YouTube embeds)', () => {
      assert.ok(suppress('enforce', 'media-src', 'https://rr1---sn-abc.googlevideo.com/videoplayback', '', false));
    });

    it('suppresses securly (school filter)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://api.securly.com/v1/track', '', false));
    });

    it('suppresses manifest.webmanifest', () => {
      assert.ok(suppress('enforce', 'default-src', 'https://www.worldmonitor.app/manifest.webmanifest', '', false));
    });

    it('suppresses third-party stylesheet injection from cdn.jsdelivr.net (style-src-elem)', () => {
      // WORLDMONITOR-J0: extension/bookmarklet injecting antd@4 CSS on
      // finance.worldmonitor.app — 270 events / 26 users. We never load
      // CSS from jsDelivr (only JSON atlases + chart.js JS).
      assert.ok(suppress('enforce', 'style-src-elem', 'https://cdn.jsdelivr.net/npm/antd@4/dist/antd.min.css', '', false));
    });

    it('suppresses cdn.jsdelivr.net for plain style-src directive too', () => {
      // Older browsers / legacy CSP fall back to `style-src` rather than
      // `style-src-elem`; same suppression should apply.
      assert.ok(suppress('enforce', 'style-src', 'https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css', '', false));
    });

    it('does NOT suppress jsDelivr for legitimate directive (script-src world-atlas / chart.js)', () => {
      // We DO load JSON + JS from jsdelivr legitimately. Only style-src*
      // is blanket-filtered. A real script-src block here would be a
      // vendor-CDN CSP regression we want to see.
      assert.ok(!suppress('enforce', 'script-src', 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js', '', false));
      assert.ok(!suppress('enforce', 'connect-src', 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json', '', false));
    });

    it('suppresses Google Fonts CSS injection under style-src* (WORLDMONITOR-J0 round 2)', () => {
      // Extensions/user-style themes inject <link> stylesheets for families we
      // never reference (DM Sans, Syne, Roboto). We self-host all fonts, so a
      // style-src* block on fonts.googleapis.com/css* is always injection.
      assert.ok(suppress('enforce', 'style-src-elem', 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap', '', false));
      assert.ok(suppress('enforce', 'style-src', 'https://fonts.googleapis.com/css?family=Roboto:wght@400;500&display=swap', '', false));
    });

    it('does NOT suppress fonts.googleapis.com under other directives or non-css paths', () => {
      assert.ok(!suppress('enforce', 'font-src', 'https://fonts.googleapis.com/css2?family=DM+Sans', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://fonts.googleapis.com/icon.js', '', false));
    });

    it('suppresses 6ppn.com extension stylesheet injection (WORLDMONITOR-J0)', () => {
      assert.ok(suppress('enforce', 'style-src-elem', 'https://www.6ppn.com/ext/assets/style.CMoYtLrp.css?v=uTaroZOITRdUkyChp', '', false));
    });

    it('suppresses literal [email] placeholder stylesheet URL from a broken extension template', () => {
      assert.ok(suppress('enforce', 'style-src-elem', 'https://[email]', '', false));
    });

    it('suppresses FontAwesome CDN stylesheet injection (WORLDMONITOR-J0 round 3)', () => {
      // FontAwesome 4.7.0 (a 2016 release we never shipped) loaded from the
      // public CDN — 80% of the issue's current volume.
      assert.ok(suppress('enforce', 'style-src-elem', 'https://use.fontawesome.com/releases/v4.7.0/css/font-awesome-css.min.css', '', false));
    });

    it('does NOT suppress a fontawesome lookalike host or non-css path', () => {
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.fontawesome.com.evil.com/releases/v4.7.0/css/x.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.fontawesome.com/releases/v4.7.0/js/all.js', '', false));
    });

    it('suppresses Adobe Typekit stylesheet injection (WORLDMONITOR-J0 round 3)', () => {
      // Typekit kit css from both of its hosts; we self-host every font and
      // reference no Adobe Fonts kit.
      assert.ok(suppress('enforce', 'style-src-elem', 'https://use.typekit.net/izn6gyh.css', '', false));
      assert.ok(suppress('enforce', 'style-src-elem', 'https://p.typekit.net/p.css?s=1&k=izn6gyh&ht=tk&f=16927.17005.17006&a=5344842&app=typekit&e=css', '', false));
    });

    it('does NOT suppress a typekit lookalike host or non-css path', () => {
      // BOTH arms of the hostname OR need lookalike cover — a mutation that
      // widened only the p.typekit.net side left every use.typekit.net
      // assertion green, so testing one arm proves nothing about the other.
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.typekit.net.evil.com/izn6gyh.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://use.typekit.net/kit.js', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://p.typekit.net.evil.com/p.css', '', false));
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://p.typekit.net/kit.js', '', false));
    });

    it('does NOT suppress arbitrary third-party style-src hosts', () => {
      assert.ok(!suppress('enforce', 'style-src-elem', 'https://styles.evil.example/inject.css', '', false));
    });
  });

  describe('localhost/loopback', () => {
    it('suppresses http://localhost:9009 (Smart TV tuner service)', () => {
      assert.ok(suppress('enforce', 'connect-src', 'http://localhost:9009/service/tvinfo', '', false));
    });

    it('suppresses http://127.0.0.1:8080', () => {
      assert.ok(suppress('enforce', 'connect-src', 'http://127.0.0.1:8080/api', '', false));
    });

    it('suppresses https://localhost:3000', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://localhost:3000/dev', '', false));
    });
  });

  describe('first-party infrastructure (mutated user CSP)', () => {
    // Corporate proxies / privacy extensions strip bare `https:` from connect-src in
    // the user's effective policy, blocking our first-party Convex backend even though
    // our policy allows it. Suppress unconditionally for our exact configured Convex
    // host so we don't drown Sentry in events from those users (WORLDMONITOR-HN).
    // Convex is multi-tenant — must NOT broaden to all *.convex.cloud (would silently
    // suppress blocks to foreign / attacker-controlled tenants).
    const FIRST_PARTY_CONVEX = 'tacit-curlew-777.convex.cloud';

    it('suppresses connect-src to OUR configured convex host', () => {
      assert.ok(suppress('enforce', 'connect-src', 'https://tacit-curlew-777.convex.cloud/api/1.34.0/sync', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to a DIFFERENT *.convex.cloud tenant (multi-tenant safety)', () => {
      // Multi-tenant Convex: any other adjective-noun-N.convex.cloud is a foreign
      // project. A real user-side block to one of these is signal, not noise.
      assert.ok(!suppress('enforce', 'connect-src', 'https://abc-def-123.convex.cloud/api/x', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to a similarly-named *.convex.cloud tenant', () => {
      // e.g. attacker-controlled `tacit-curlew-778.convex.cloud` — exact-hostname
      // match prevents a typo/lookalike from being whitelisted.
      assert.ok(!suppress('enforce', 'connect-src', 'https://tacit-curlew-778.convex.cloud/api/1.34.0/sync', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to suffix-spoof lookalike `convex.cloud.evil.com`', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://convex.cloud.evil.com/api', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to OUR convex host when firstPartyConvexHost is null (env unconfigured)', () => {
      // Dev/test environments without VITE_CONVEX_URL set should leave the filter
      // open — falls through to other rules (extension, blob, etc.) instead of
      // accidentally whitelisting on a stale closure.
      assert.ok(!suppress('enforce', 'connect-src', 'https://tacit-curlew-777.convex.cloud/api/1.34.0/sync', '', false, null));
    });

    it('suppresses script-src-elem for YouTube IFrame API loader', () => {
      assert.ok(suppress('enforce', 'script-src-elem', 'https://www.youtube.com/iframe_api', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses script-src-elem for YouTube IFrame API with cache-buster', () => {
      assert.ok(suppress('enforce', 'script-src-elem', 'https://www.youtube.com/iframe_api?ver=1', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses script-src for YouTube IFrame API loader (browser-variant directive)', () => {
      assert.ok(suppress('enforce', 'script-src', 'https://www.youtube.com/iframe_api', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress other youtube.com paths under script-src-elem', () => {
      assert.ok(!suppress('enforce', 'script-src-elem', 'https://www.youtube.com/embed/abc', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses frame-src for Zscaler corporate proxy injection', () => {
      assert.ok(suppress('enforce', 'frame-src', 'https://gateway.zscloud.net/auth/sso', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to Zscaler (only frame-src is the injection)', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://gateway.zscloud.net/api', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses frame-src for content-filter/security agent vendor frames (WORLDMONITOR-HT)', () => {
      // NetSTAR inSITE, Techloq, Trend Micro agents frame their own vendor
      // hosts into every page. frame-src reports origin-only for cross-origin
      // frames, so these are origin-shaped blockedURIs.
      assert.ok(suppress('enforce', 'frame-src', 'https://gw-3z9x.iss.netstar-inc.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(suppress('enforce', 'frame-src', 'https://filter.techloq.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(suppress('enforce', 'frame-src', 'https://pwm-image.trendmicro.com', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses frame-src for Google-internal extension API hosts (*.clients6.google.com)', () => {
      assert.ok(suppress('enforce', 'frame-src', 'https://toolytics.pa.clients6.google.com', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses frame-src for h5player userscript vendor frame (WORLDMONITOR-HT)', () => {
      // Tampermonkey "h5player" video-enhancement userscript frames its own
      // vendor host into every page. Origin-only blockedURI, exact host.
      assert.ok(suppress('enforce', 'frame-src', 'https://h5player.anzz.site', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses frame-src for the div.show injected frame (WORLDMONITOR-HT)', () => {
      // Origin-only frame to a host that appears nowhere in our source, seen
      // repeatedly across many users — the stable head of HT, unlike its
      // rotating merchant-domain tail below.
      assert.ok(suppress('enforce', 'frame-src', 'https://div.show', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress frame-src for lookalike filter-vendor hosts', () => {
      assert.ok(!suppress('enforce', 'frame-src', 'https://netstar-inc.com.evil.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://clients6.google.com.evil.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://h5player.anzz.site.evil.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://div.show.evil.com', '', false, FIRST_PARTY_CONVEX));
      // Pinned to the exact observed shape, so a pathful or http: frame on the
      // same host still reports — a destination match alone is not provenance.
      assert.ok(!suppress('enforce', 'frame-src', 'https://div.show/embed', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'http://div.show', '', false, FIRST_PARTY_CONVEX));
      // Sibling registrable domain + subdomain: a suffix-match refactor would
      // swallow both, and `div.show.evil.com` alone would not catch it.
      assert.ok(!suppress('enforce', 'frame-src', 'https://xdiv.show', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://sub.div.show', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://cdn.anzz.site', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress frame-src for arbitrary third-party hosts (rotating extension long tail stays surfaced)', () => {
      // WORLDMONITOR-HT's rotating merchant-domain tail is deliberately NOT
      // blanket-suppressed — a future first-party embed regression must surface.
      assert.ok(!suppress('enforce', 'frame-src', 'https://www.service.com.au', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress frame-src for accounts.google.com / support.google.com (potential first-party sign-in embeds)', () => {
      assert.ok(!suppress('enforce', 'frame-src', 'https://accounts.google.com', '', false, FIRST_PARTY_CONVEX));
      assert.ok(!suppress('enforce', 'frame-src', 'https://support.google.com', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to the filter vendors (only frame-src is the injection)', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://filter.techloq.com/api', '', false, FIRST_PARTY_CONVEX));
    });

    // First-party img-src suppression — same pattern as connect-src+Convex above.
    // Corporate proxies / privacy extensions / school content-filters can strip
    // both `'self'` and `https:` from img-src in the user's effective policy,
    // causing browsers to block our own favicon and panel icons even though our
    // policy (`img-src 'self' data: blob: https:`) allows them (WORLDMONITOR-JP).
    it('suppresses img-src to apex worldmonitor.app (favicon)', () => {
      assert.ok(suppress('enforce', 'img-src', 'https://worldmonitor.app/favico/favicon-32x32.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses img-src to www.worldmonitor.app (production favicon, WORLDMONITOR-JP)', () => {
      assert.ok(suppress('enforce', 'img-src', 'https://www.worldmonitor.app/favico/favicon-32x32.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses img-src to finance.worldmonitor.app subdomain', () => {
      assert.ok(suppress('enforce', 'img-src', 'https://finance.worldmonitor.app/favico/finance/apple-touch-icon.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('suppresses img-src to tech.worldmonitor.app subdomain', () => {
      assert.ok(suppress('enforce', 'img-src', 'https://tech.worldmonitor.app/favico/tech/favicon-32x32.png', '', false, FIRST_PARTY_CONVEX));
    });

    // Clerk avatar CDN — the only cross-origin image host our UI loads (the
    // Clerk UserButton avatar). Our img-src allows every https: host, so an
    // enforced block on img.clerk.com is the same mutated-policy class as the
    // first-party rules above (WORLDMONITOR-JP round 2, Firefox privacy
    // extensions stripping `https:` from img-src).
    it('suppresses img-src to img.clerk.com (Clerk avatar, WORLDMONITOR-JP)', () => {
      assert.ok(suppress('enforce', 'img-src', 'https://img.clerk.com/eyJ0eXBlIjoicHJveHkifQ?width=200', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress http:// img-src to img.clerk.com (wrong-scheme block must surface)', () => {
      assert.ok(!suppress('enforce', 'img-src', 'http://img.clerk.com/eyJ0eXBlIjoicHJveHkifQ', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress img-src to suffix-spoof `img.clerk.com.evil.com`', () => {
      assert.ok(!suppress('enforce', 'img-src', 'https://img.clerk.com.evil.com/pixel.gif', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress img-src to other clerk.com hosts (rule is exact-host)', () => {
      // Only the avatar CDN is expected; a block on any other clerk.com host
      // is not a known injection pattern and must surface.
      assert.ok(!suppress('enforce', 'img-src', 'https://clerk.com/logo.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to img.clerk.com (rule is scoped to img-src)', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'https://img.clerk.com/avatar', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress img-src to a foreign host', () => {
      // Real third-party CDN image blocks should still surface.
      assert.ok(!suppress('enforce', 'img-src', 'https://malicious.example.com/tracker.gif', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress img-src to suffix-spoof lookalike `worldmonitor.app.evil.com`', () => {
      // Endswith check uses a leading `.` so attacker-controlled lookalikes
      // (`worldmonitor.app.evil.com`, `not-worldmonitor.app`) are not whitelisted.
      assert.ok(!suppress('enforce', 'img-src', 'https://worldmonitor.app.evil.com/pixel.gif', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress img-src to prefix-spoof `not-worldmonitor.app`', () => {
      assert.ok(!suppress('enforce', 'img-src', 'https://not-worldmonitor.app/pixel.gif', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress connect-src to worldmonitor.app (rule is scoped to img-src)', () => {
      // First-party img-src rule must not bleed into other directives.
      // A real connect-src regression to our own host must still surface.
      assert.ok(!suppress('enforce', 'connect-src', 'https://api.worldmonitor.app/api/health', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress script-src to worldmonitor.app (rule is scoped to img-src)', () => {
      // A script-src block on our own host indicates a real CSP regression
      // we want to see — must not be swallowed by the img-src rule.
      assert.ok(!suppress('enforce', 'script-src', 'https://www.worldmonitor.app/assets/main-abc.js', '', false, FIRST_PARTY_CONVEX));
    });

    // Mixed-content / wrong-scheme regression guard. Our CSP only allows `https:`
    // for img-src, so a future `<img src="http://...">` regression on a
    // first-party host would be blocked by the browser. The first-party host
    // suppression MUST NOT hide that signal — it requires `https:` explicitly.
    it('does NOT suppress http:// img-src to our own apex (mixed-content regression must surface)', () => {
      assert.ok(!suppress('enforce', 'img-src', 'http://worldmonitor.app/favico/favicon-32x32.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress http:// img-src to a worldmonitor.app subdomain', () => {
      assert.ok(!suppress('enforce', 'img-src', 'http://www.worldmonitor.app/favico/favicon-32x32.png', '', false, FIRST_PARTY_CONVEX));
    });

    it('does NOT suppress ws:// img-src to a worldmonitor.app subdomain (only https: is whitelisted)', () => {
      // ws:// is not a valid img source but a malformed reference could trigger
      // a violation; protocol gate must reject anything other than https:.
      assert.ok(!suppress('enforce', 'img-src', 'ws://www.worldmonitor.app/socket', '', false, FIRST_PARTY_CONVEX));
    });
  });

  describe('real violations pass through', () => {
    it('reports third-party script-src violation', () => {
      assert.ok(!suppress('enforce', 'script-src', 'https://evil.com/crypto-miner.js', '', true));
    });

    it('reports unknown frame-src violation', () => {
      assert.ok(!suppress('enforce', 'frame-src', 'https://malicious-iframe.com/phish', '', false));
    });

    it('reports HTTP connect-src even with https: allowed', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'http://insecure-api.com/leak', '', true));
    });

    it('reports ws: connect-src violation', () => {
      assert.ok(!suppress('enforce', 'connect-src', 'ws://insecure-ws.com/socket', '', true));
    });
  });
});
