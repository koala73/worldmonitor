# YouTube Autoplay on Tauri Desktop (WKWebView) — Cannot Work

**Status**: Confirmed impossible. All JS/CSS approaches exhausted.
**Date**: February 2026
**Affects**: Live News panel, Live Webcams panel (macOS desktop app)
**Root cause**: WKWebView blocks programmatic media playback in cross-origin iframes without a direct user gesture.

---

## Architecture

```
tauri://localhost (main webview)
  └── http://localhost:PORT (sidecar youtube-embed handler)
        └── https://www.youtube.com/embed/VIDEO_ID (YouTube IFrame Player)
```

Three nested origins. The YouTube player sits inside a sidecar-served HTML page, which sits inside the Tauri WKWebView. The user gesture context is lost crossing each origin boundary.

---

## What Was Tested (All Failed)

### 1. `allow="autoplay"` iframe attribute

**What**: Set `allow="autoplay; encrypted-media"` on the sidecar's `<iframe>` embedding YouTube.
**Why it fails**: WKWebView does not honor the `allow` attribute for media autoplay policy. This attribute works in Chromium-based browsers but is ignored by WebKit's media policy engine.

### 2. MutationObserver to patch iframe attributes

**What**: Used a `MutationObserver` in the sidecar embed HTML to watch for YT.Player's dynamically-created `<iframe>` and force `allow="autoplay"` onto it at creation time.
**Result**: The attribute was successfully added (confirmed via console logs), but WKWebView's autoplay policy operates at a layer below HTML attributes — it checks the media element's playback context, not iframe permissions.

### 3. Mute-first retry chain

**What**: After `onReady`, immediately call `player.mute()` + `player.playVideo()`, then retry at 500ms and 1500ms intervals.
**Why it fails**: In Chromium, muted autoplay is always allowed. In WKWebView, even muted playback requires a user gesture in cross-origin iframe contexts. `playVideo()` silently does nothing — no error thrown, no state change.

### 4. `Permissions-Policy: autoplay=*` response header

**What**: Added `Permissions-Policy: autoplay=*, encrypted-media=*` to the sidecar's HTTP response for the embed page.
**Why it fails**: `Permissions-Policy` is a Chromium feature. WebKit/WKWebView does not implement this header for media autoplay decisions.

### 5. Secure context via `http://localhost` (vs `http://127.0.0.1`)

**What**: Per W3C spec, `http://localhost` is a secure context while `http://127.0.0.1` is not. Changed all sidecar URLs from `127.0.0.1` to `localhost` hoping secure context would unlock autoplay.
**Result**: No effect. WKWebView's autoplay restriction is orthogonal to secure context status. The policy is about user gesture propagation, not HTTPS/secure origin.

### 6. YouTube playerVars configuration

**What**: Set all relevant playerVars: `autoplay: 1`, `mute: 1`, `playsinline: 1`, `enablejsapi: 1`, plus `origin` and `widget_referrer` matching the sidecar origin.
**Result**: YouTube's player respects these in Chromium. In WKWebView, the underlying `<video>` element's `play()` call is what gets blocked — playerVars just configure what YouTube *attempts* to do, not what WKWebView *allows*.

### 7. `player.playVideo()` from various timing contexts

**What**: Called `playVideo()` from:
- `onReady` callback (immediate)
- `setTimeout` at 500ms, 1500ms, 2000ms
- After `player.mute()`
**Why it fails**: None of these run in a user gesture context. JavaScript's event loop loses gesture propagation after any async boundary (`setTimeout`, `Promise.then`, `await`). The `onReady` callback itself is fired asynchronously by YouTube's API.

### 8. Iframe reload fallback

**What**: After 2 seconds, if autoplay hasn't started (no `YT.PlayerState.PLAYING` or `BUFFERING` event), destroy and recreate the iframe.
**Result**: The fresh iframe loads but still cannot autoplay — same policy applies. Reloading doesn't create a user gesture.

### 9. wry/WKWebView configuration check

**What**: Verified that wry 0.54.2 (Tauri's WebKit wrapper) sets `mediaTypesRequiringUserActionForPlayback = []` (equivalent to `.none`), meaning autoplay should be allowed at the WKWebView level.
**Result**: This setting works for **same-origin** content. It does NOT override the cross-origin iframe media policy. The YouTube embed is cross-origin (`youtube.com` vs `localhost`), so the WKWebView-level permission is insufficient.

### 10. Play overlay with click handler

**What**: Added a full-screen overlay div inside the sidecar embed. On click, called `player.playVideo()` + `player.unMute()`.
**Result**: This DOES work — the click is a genuine user gesture. However, it requires the user to click inside the sidecar iframe first, and the gesture doesn't propagate to the cross-origin YouTube iframe underneath. The overlay approach only works if the overlay itself triggers `playVideo()` via the JS API (which does work from a user gesture).

---

## Why It's a Platform Limitation

WKWebView's media autoplay policy:

1. **Same-origin content**: Respects `mediaTypesRequiringUserActionForPlayback` setting. If set to `.none`, autoplay works.
2. **Cross-origin iframes**: Requires a **user gesture that originates within the iframe's own browsing context**. A gesture in the parent frame does NOT propagate. This is a WebKit security decision, not a bug.
3. **Gesture propagation**: JavaScript loses user gesture context after any async operation (`await`, `setTimeout`, `Promise`). Even `onReady` is async.

There is an open Tauri issue (#13200) requesting exposure of `mediaTypesRequiringUserActionForPlayback` per-webview, but even with it exposed, it wouldn't help for cross-origin iframes.

The only way autoplay would work is if YouTube's embed was served from the **same origin** as the WKWebView — which would mean serving it from `tauri://localhost`, which is impossible since YouTube's player must load from `youtube.com`.

---

## What Works Instead

### Click-to-play (current solution)

- Grid view iframes have `pointer-events: auto` — user clicks YouTube's native play button directly
- Sidecar overlay starts hidden and non-interactive (`pointer-events: none`)
- Each grid cell has an expand button (arrow icon) to switch to single/fullscreen view
- YouTube's own play button UI handles the user gesture natively

### Why Vercel-hosted embeds worked before

The previous architecture served embeds from `https://worldmonitor.app/api/youtube/embed`. The parent was also `https://worldmonitor.app`. **Same origin** = WKWebView's autoplay policy respected the `.none` setting. When we moved embeds to the local sidecar (`http://localhost:PORT`), the parent became `tauri://localhost` — now cross-origin, breaking autoplay.

**Trade-off**: Reverting to Vercel-hosted embeds would restore autoplay but adds a cloud dependency for the desktop app (defeats offline/local-first goals) and adds latency.

---

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/sidecar/local-api-server.mjs` | MutationObserver, retry chain, overlay fixes, `postMessage('*')`, `Permissions-Policy` header |
| `src/styles/main.css` | `.webcam-iframe { pointer-events: auto }` (was `none`), expand button styles |
| `src/components/LiveWebcamsPanel.ts` | Expand button in grid cells, `localhost` embed URLs |
| `src/components/LiveNewsPanel.ts` | `localhost` embed URLs, `embedOrigin` getter |
| `index.html` | CSP `frame-src` added `http://localhost:*` |
| `src-tauri/tauri.conf.json` | CSP `frame-src` added `http://localhost:*` |

---

## Future Options (Not Pursued)

1. **Tauri custom protocol for YouTube proxy**: Serve YouTube embed HTML from `tauri://` scheme to make it same-origin. Would require proxying YouTube's iframe API JS — legally and technically complex.
2. **Native AVPlayer**: Use a native macOS media player instead of WKWebView for video. Would lose YouTube's player UI/controls.
3. **Electron migration**: Electron uses Chromium where muted autoplay always works. Not viable — Tauri chosen deliberately.
4. **Revert to Vercel embeds on desktop**: Adds cloud dependency but restores autoplay. Could be a user-toggleable setting.
