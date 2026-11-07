---
title: "An HLS redirect hop without Access-Control-Allow-Origin blocks hls.js while the source checker reads the stream as live"
module: live-video-panels (Live News)
date: 2026-11-07
category: integration-issues
problem_type: integration_issue
component: frontend_stimulus
severity: medium
symptoms:
  - "DebugBear desktop run on www.worldmonitor.app logs a CORS console error for https://bloomberg.com/media-manifest/streams/us.m3u8 after Live News autoplay shipped (#10218)"
  - "Bloomberg on Live News falls past its HLS entry to a YouTube fallback in Chrome and Firefox, while Safari plays it"
  - "scripts/check-live-video-sources.mjs reports the same Bloomberg HLS entry as live"
root_cause: config_error
resolution_type: code_fix
related_components:
  - testing_framework
tags: [hls, hls-js, cors, redirect, live-video, live-news, source-checker, debugbear]
---

# An HLS redirect hop without Access-Control-Allow-Origin blocks hls.js while the source checker reads the stream as live

## Problem

The Bloomberg Live News entry pointed at `https://bloomberg.com/media-manifest/streams/us.m3u8`. The apex host answers with a 301 to `www.bloomberg.com` and sends no `Access-Control-Allow-Origin`. The `www` playlist itself sends `Access-Control-Allow-Origin: *`. Browsers that play through hls.js refused the redirect, so Bloomberg never played over HLS on the web dashboard. The source checker followed the redirect server-side and reported the stream as live.

## Symptoms

- A DebugBear change alert for the desktop dashboard test (project 103025) showed a CORS console error for the apex Bloomberg URL. The error first appeared after #10218 made Live News autoplay on load.
- Chrome fell through the candidate chain to a YouTube fallback. Safari and WKWebView played the stream, because they play HLS natively instead of through XHR.
- The live-video source checker passed the entry.

## What Didn't Work

- **Trusting the source checker.** It fetched with Node `fetch`, which has no CORS rules, and sent no `Origin` header. A stream it called live could still be unreadable from the dashboard.
- **Checking only the final response's headers.** The final `www` playlist allows `*`. The block happens on the earlier 301, which a final-response check never sees.
- **Testing in Safari.** Native HLS playback does not use CORS, so the bug does not reproduce there.

## Solution

1. Point the entry at the host that serves the playlist directly, so no redirect is needed (`src/config/live-video-sources.ts:93`, PR #10294):

   ```ts
   // before
   'https://bloomberg.com/media-manifest/streams/us.m3u8',
   // after
   'https://www.bloomberg.com/media-manifest/streams/us.m3u8',
   ```

2. Make the checker apply the browser's CORS rule to playlists (`scripts/check-live-video-sources.mjs`, PR #10294):
   - It sends `origin: https://www.worldmonitor.app` on every playlist fetch, including reloads (`:602`).
   - It treats a response as readable only when `Access-Control-Allow-Origin` is `*` or the dashboard origin (`allowsDashboard`, `:562-564`).
   - It fails a redirect hop that is not readable, before following it (`:610`).
   - It fails a 2xx playlist that is not readable (`:616`).

3. Add regression tests in `tests/live-video-check-cli.test.mjs` (`:640`, `:660`, `:671`) covering three cases: a redirect hop without the header fails and is not followed, a playlist with a missing or foreign header fails, and the dashboard origin is sent and accepted. All three failed before the checker change.

Regenerate the derived files after changing an HLS host. `shared/source-attribution-manifest.json` is keyed by host, and the TUI catalog is generated from the live-video sources. Run `node scripts/source-attribution.mjs --write` and `npm run generate`; otherwise the pre-push hook fails.

## Why This Works

hls.js loads playlists and segments with XHR. A cross-origin XHR that follows a redirect must pass the CORS check on every hop, not just the last one. With the redirect gone, the only response is the `www` playlist, and it allows any origin. The checker now fails a playlist, or a redirect hop to it, that a browser would block for a missing header.

The checker still passes some streams a browser blocks:

- **Segments.** It fetches playlists, never media segments. A stream whose segment host sends no `Access-Control-Allow-Origin` passes the checker and still fails in hls.js.
- **`Origin: null` after a redirect.** It sends the dashboard origin on every hop. After a cross-origin redirect, a browser sends `Origin: null` instead. A target that allows only `https://www.worldmonitor.app`, and not `*`, passes the checker but is blocked in the browser. `www.bloomberg.com` answers `*`, so Bloomberg is unaffected.

A browser playback check, such as DebugBear's console-error audit or a manual load in Chrome, covers both.

Verified on production on 2026-11-07, after the merge. The dashboard bundle references only the `www` URL. On a dashboard load in Chromium, the Live News `<video>` played from an hls.js `blob:` source (readyState 4, currentTime about 27 s), with segments loading from `liveproduseast.akamaized.net` and no CORS console errors. At the time of writing, the apex URL still answers 301 with no `Access-Control-Allow-Origin`.

## Prevention

- Use an HLS URL that does not redirect. A checker pass rules out playlist CORS failures only; segment CORS and redirect targets that reject `Origin: null` still need a browser check.
- Test HLS playback in Chrome or Firefox, not only Safari, since native HLS hides CORS failures.
- DebugBear's console-error audit on the desktop dashboard test catches this class of failure. A new CORS error on a media host after a Live News change points at the candidate chain.
- At the time of writing, the gb-news entry (`live-gbnews.simplestreamcdn.com`) sends no `Access-Control-Allow-Origin`. It can play only through native HLS, and the checker's CORS rule fails it.

## Related

- [Live video panels silently degrade](live-video-panels-silently-degrade-dead-youtube-detection-rotted-fallback-ids-idle-stop.md): how the source checker decides whether a stream is live, and the earlier Live News audit.
