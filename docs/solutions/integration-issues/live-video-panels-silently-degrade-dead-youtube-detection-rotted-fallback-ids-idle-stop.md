---
title: "Live video panels silently degrade: dead YouTube detection, rotted fallback IDs, and an undisclosed 5-minute idle stop"
module: live-video-panels (Live News / Live Webcams)
date: 2026-09-14
category: integration-issues
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "Production `/api/youtube/live` returns `{videoId: null, channelExists: false}` for all 20 tested channel handles (including `@CNN`, `@BBCNews`, `@markets`), while the same `youtube.com/@handle/live` pages return `isLive: true` when fetched from a residential IP"
  - "LiveWebcamsPanel's default grid (jerusalem, middle-east, kyiv, washington) plays hardcoded fallback video IDs that ended in 2026-06/2026-07; the kyiv fallback replays a 2022 recording under a 'LIVE' tile"
  - "Live News fallbacks for cnbc and cnn play unrelated or deleted videos (a documentary marathon, a deleted ABC News clip) instead of live coverage"
  - "After 5 minutes with no mousedown/keydown/scroll/touchstart/mousemove, Live News and Live Webcams silently stop playback and CSS animations pause, with no explanation in the Auto-play setting copy"
  - "A cancelling paying user reported the dashboard 'only lasts about 4 minutes' and 'the wrong video links in the tv screen'"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - frontend_stimulus
  - testing_framework
tags: [youtube, live-video, relay-fetch, railway-relay, fallback-video-ids, idle-timeout, silent-degradation, dashboard]
---

# Live video panels silently degrade: dead YouTube detection, rotted fallback IDs, and an undisclosed 5-minute idle stop

## Problem

The dashboard's "TV screen" (Live News and Live Webcams) looks healthy for a few minutes, then fails in three independent ways. None of them raises an error or an alarm. A cancelling paying user reported it on 2026-09-14: "your dashboard only last for about 4 minutes. you have the wrong video links in the tv screen". Each part of that report maps to a verified defect. Defect 1 is fixed by #8155. Defect 3 has a data fix and a liveness checker in #8163. Defect 2 has no fix yet. This doc records the diagnosis, the audit method, and the fixes.

## Symptoms

- Every Live News and Live Webcams stream stops about 5 minutes after the last mouse, keyboard, scroll, or touch input. Live News reverts to "Ready when you are" with a "Play live feed" button (`src/components/LiveNewsPanel.ts:487`, `:496`). Webcams show the `components.webcams.pausedIdle` placeholder (`src/locales/en.json:927`). Neither names the idle timeout; the webcam text says only "move mouse to resume".
- The default webcam grid shows YouTube's own "Video unavailable" error in 3 of 4 tiles. The "LIVE" Kyiv tile plays a 2022 recording (observed on production 2026-09-14).
- On the Live News CNN channel, the panel shows the `cannotEmbed` message ("can't be played here", "may be restricted in your region (error 150)", `src/locales/en.json:2256`, rendered at `src/components/LiveNewsPanel.ts:1260`). CNBC plays a 24/7 documentary marathon instead of news (observed on production 2026-09-14).
- `/api/youtube/live` returns `{"videoId":null,"channelExists":false}` for all 20 probed handles, including channels that are live (observed on production 2026-09-14).
- Nothing reaches server logs or alerts (the browser console only), and no test fails.

## What Didn't Work

These approaches gave wrong or misleading readings during diagnosis.

- **Headless Chromium.** It always gets WorldMonitor's SVG map, never deck.gl (auto memory [claude]), so it does not show what users see. The session used headed Chrome (Playwright `channel: 'chrome'`).
- **Synthetic clicks to start playback.** `element.click()` from `page.evaluate` dispatches no `mousedown` or `mousemove`. It started playback without resetting the idle timers. The stop fired at boot+305s, not click+300s, which looks like a shorter timeout than the code sets (observed on production 2026-09-14).
- **Probing the API with an agent user agent.** Production answers 403 `agent_request_blocked` (`shared/agent-request-policy.json:14`). The probe needs a non-agent UA. `Origin` is optional, but when sent it must be an allowed origin (`api/_cors.js:187-191`).
- **Testing a handle's `/live` URL from a residential IP.** Those URLs returned HTTP 200 with `videoDetails` and `"isLive":true` for every tested handle except @CNN (observed 2026-09-14). The relay does not fetch from that network, so a residential success says nothing about the production path.
- **Trusting the "validated Feb 2026" comment** (`src/components/LiveWebcamsPanel.ts:26`). The default-grid IDs came from three different commits. kyiv and washington came from the original panel (935a58abd4, 2026-02-19); `git blame` on the washington line shows a same-day reorder commit instead. jerusalem came from #2068 (2026-03-22). middle-east came from #3747 (2026-05-17). The comment certifies none of their current state.

## Solution

Status: diagnosis verified against production and against the code at 618757b97b. The Defect 1 fix merged in #8155. Defect 3 has a data fix and a liveness checker in #8163; runtime detection of streams that end later is still to come. The Defect 2 fixes below remain recommendations.

### Defect 1: the 5-minute idle stop ("only lasts about 4 minutes")

`IDLE_PAUSE_MS` is `5 * 60 * 1000` (`src/config/idle.ts:2`). Three timers consume it.

- **App shell.** `setupIdleDetection` listens for `mousedown`, `keydown`, `scroll`, `touchstart`, and `mousemove` (`src/app/event-handlers.ts:1416`). After `IDLE_PAUSE_MS` with no input, `resetIdleTimer` adds `body.animations-paused` and logs `[App] User idle - pausing animations to save resources` (`src/app/event-handlers.ts:1427-1433`). That class pauses every CSS animation and disables transitions (`src/styles/main.css:250-255`).
- **Live News.** The idle handler arms `pauseForIdle` (`src/components/LiveNewsPanel.ts:733-738`), which calls `stopLiveMediaPlayback('live-news', 'idle')` (`:751`). The next input calls `resumeFromIdle` (`:819-824`).
- **Live Webcams.** The idle handler tears down every iframe with `teardownPlayback('idle')` and writes the paused placeholder (`src/components/LiveWebcamsPanel.ts:855-861`).

The only bypass is the "Auto-play live streams on dashboard" setting. It is stored in localStorage as `wm-live-streams-always-on` and defaults to false (`src/services/live-stream-settings.ts:7`, `:28-30`). Both panel idle handlers return early when it is on (`src/components/LiveNewsPanel.ts:734`, `src/components/LiveWebcamsPanel.ts:841`). Its description reads "Starts Live News and Live Webcams automatically when visible. Leave off to load video only after you click Play." (`src/locales/en.json:1603-1604`). It never mentions the idle stop. The app-shell animation pause has no bypass.

The idle stop is not new. Idle detection arrived on 2026-01-18 (2ef99d2565), well before the click-to-play intent gate from #4341 (issue #4334, 2026-06-22). Issue #914 ("Live news panel cams stop working every 10-15 minutes", closed 2026-03-04) was an earlier user report of live video stopping after minutes.

Observed on production 2026-09-14, driven with real input:

- The last `locator.click` landed at t=64s.
- The idle log fired at t=364s, exactly +300s.
- The Live News HLS `<video>` and all 4 webcam iframes were removed.
- A `page.mouse.move` at about t=434s resumed both panels within 12s.
- An untouched run stopped at boot+305s.

A secondary factor makes the first minutes feel static. Feeds refresh every 20 minutes and markets every 12 (`src/config/variants/base.ts:13-14`). The untouched run recorded almost no API requests between about 20s and 570s (observed on production 2026-09-14).

Fix (merged in #8155):

- One owner, `src/services/live-media-idle.ts`, replaces the two panel timers. It listens once, suspends while the tab is hidden, and fires once per idle episode.
- A "Stop live video when idle" preference (`wm-live-media-idle-stop`: 15/30/60/120/240 minutes or never, default 60) lives in `src/services/live-stream-settings.ts`. It is cloud-synced and absence-tolerant during rolling deploys. A user who had saved always-on reads as never, and always-on now means autoplay only.
- An idle stop renders an in-panel notice naming inactivity, with Resume and "Keep playing when idle". Input no longer restarts video, and neither does autoplay on tab return or scroll-back for a user who has auto-play on with a chosen idle duration. Fullscreen panels and a native video the viewer paused are not stopped.
- The app-shell animation pause keeps its own 5-minute timer.
- Verified with vitest DOM tests on fake timers and a real-browser drive using Playwright `page.clock`. After 6 minutes idle playback continues. After 66 minutes the notice shows and a mouse move does not resume. Resume restores Live News and the webcam wall, and Never keeps playing through 5 hours.

### Defect 2: YouTube live detection returns null for every channel

The client calls `/api/youtube/live?channel=@handle` (`src/services/live-news.ts:18`). It plays `info.videoId || channel.fallbackVideoId` (`src/components/LiveNewsPanel.ts:1133-1134`). A null answer therefore silently selects the hardcoded fallback.

The request passes through three fallback layers. In the failure mode observed in production, none of them can fire.

1. **Relay proxy to direct.** `ytFetch` falls back to `ytFetchDirect` only inside a `catch` (`scripts/ais-relay.cjs:11527-11533`). But `ytFetchViaProxy` ends in `.catch(() => ({ ok: false, status: 0, body: '' }))` (`scripts/ais-relay.cjs:11493`), so it never rejects. Whenever `YOUTUBE_PROXY_URL` is set (`:11487`), the direct path never runs.
2. **Redirects.** `proxyFetch` does not follow redirects. It sets `ok` for 2xx only and returns `location` (`scripts/_proxy-utils.cjs:374-376`), which `ytFetchViaProxy` then drops (`scripts/ais-relay.cjs:11492`). YouTube answers `/@CNN/live` with a 303 to `/cnn/live`. The session called the real `proxyFetch` with an injected direct-TLS `connectTunnel` (verified 2026-09-14):
   - @CNN gave `ok=false status=303`.
   - @SkyNews and @markets gave `ok=true status=200` with `videoDetails`.

   `ytFetchDirect` does follow redirects (`scripts/ais-relay.cjs:11505-11507`).
3. **Edge to its own scrape.** On any non-2xx, `handleYouTubeLiveRequest` replies HTTP 200 `{videoId:null, channelExists:false}` without logging (`scripts/ais-relay.cjs:11587-11589`). The edge handler treats any `relayRes.ok` as success and caches the null for 600s (`api/youtube/live.js:61-69`). Its own scrape, which uses `redirect: 'follow'` (`api/youtube/live.js:104-139`), runs only when the relay is unset, unreachable, or answers non-2xx (`api/youtube/live.js:57-74`). The server RPC has the same shape. `parseRelayPayload` always returns an object (`server/worldmonitor/aviation/v1/get-youtube-live-stream-info.ts:47-57`), so `fetchLiveStreamInfo` returns the relay's null before its own scrape (`:161-162`).

Verified 2026-09-14: `YOUTUBE_PROXY_URL` points at Froxy (host `proxy.froxy.com`), and a CONNECT to `www.youtube.com` through it returns HTTP 422, which `ytFetchViaProxy` swallows. UNVERIFIED: why Froxy refuses the tunnel for handles such as @SkyNews, which return 200 both from a residential IP and through a direct TLS tunnel. Candidates:

- proxy authentication or plan limits
- the proxy blocking youtube.com as a target
- a YouTube bot wall served to the proxy's exit IPs

The relay logs no upstream status, so Railway logs cannot answer this today. The Froxy dashboard and its request logs are the first place to look.

The relay detection path was added in efc1945bb8 (2026-02-28) and last changed in #2702 (2026-04-05).

Recommended (not implemented as of 2026-09-14):

- Decide the mechanism before repairing it. Issue #5503 flagged this page scrape plus residential proxy as a YouTube Terms of Service violation and was closed as not planned (2026-07-23). Every repair below strengthens that path. The alternative is the official YouTube Data API for live-video lookup.
- In `ytFetch`, fall back to direct on a non-2xx proxy result, not only on a throw.
- Follow redirects on the proxied YouTube fetch, or pass `location` through and re-request.
- Log the upstream status and `location` on every non-2xx before returning null.
- When detection fails, return a non-200 or an explicit error field. That lets the edge and RPC fallbacks run and stops the null from being cached for 10 minutes.
- Add a synthetic monitor that fails when `/api/youtube/live` returns null for handles known to be live.
- Measure before turning on a direct fallback from Railway. The edge handler itself notes that datacenter IPs are limited for live detection (`api/youtube/live.js:76`, `:104`). A fix that revives a dead proxy path can also raise the proxy bill (Froxy) without anyone noticing (auto memory [claude]).

### Defect 3: rotted hardcoded fallback IDs ("wrong video links")

Live Webcams never detects anything. `channelHandle` was declared (`src/components/LiveWebcamsPanel.ts:22`) and filled in for every feed, but no code read it. Tiles play `fallbackVideoId` only. With the default `regionFilter` of `'all'`, the grid is `ALL_GRID_IDS = ['jerusalem', 'middle-east', 'kyiv', 'washington']` (`src/components/LiveWebcamsPanel.ts:215-221`).

Audit results for the default grid, observed 2026-09-14:

| Feed | ID (source line) | Result |
|---|---|---|
| jerusalem | `e34xb-Fbl0U` (`LiveWebcamsPanel.ts:30`) | Stream ended 2026-06-08, UNPLAYABLE |
| middle-east | `oxT5R6I0N6E` (`:31`) | Stream ended 2026-07-18, UNPLAYABLE |
| kyiv | `-Q7FuPINDjA` (`:36`) | DW "LIVE: View of Kyiv as Russia launches major Ukraine invasion", ended 2022-02-26, plays as a recording under a LIVE tile |
| washington | `1wV9lLe14aU` (`:42`) | Stream ended 2026-06-27, UNPLAYABLE |

About 7 webcam feeds were live (observed 2026-09-14). The current tree defines 23. `space-x` and `space-walk` share `fO9e9jnhYK8` (`src/components/LiveWebcamsPanel.ts:55-56`), which belongs to the "Sen" channel, not SpaceX or NASA.

Dead IDs render YouTube's own error inside the tile, not the app's blocked overlay (observed on production 2026-09-14). On web, `handleEmbedMessage` reads only `onReady`, `initialDelivery`, and `infoDelivery` with `playerState === 1` (`src/components/LiveWebcamsPanel.ts:619-629`). No branch handles YouTube `onError`. `markIframeBlocked` is reached only through the 15s ready timeout (`:130`, `:390`) or the desktop sidecar's `yt-error` (`:645-646`).

Live News full-variant defaults (`src/components/LiveNewsPanel.ts:69-79`), observed on production 2026-09-14:

- **Played.** bloomberg, sky, euronews, dw, france24, alarabiya, and aljazeera have `DIRECT_HLS_MAP` entries (`src/components/LiveNewsPanel.ts:244`).
- **cnbc.** It has HLS only on desktop: `PROXIED_HLS_MAP` (`:300-302`) is gated by `isDesktopRuntime()` (`:620`). On web it goes to detection, gets null, and plays fallback `9NyxcX3rhQs` (`:74`), titled "LIVE: CNBC Marathon - Documentaries and deep dives 24/7". Resolved by removal: CNBC is no longer a Live News channel, and a stored channel order that names it drops it on load.
- **cnn.** Its HLS stream (`:252`) hit `[LiveNews] HLS fatal error for cnn` (`:1398`). The handler sets a cooldown and re-initializes the player (`:1403-1408`; `HLS_COOLDOWN_MS` is 5 minutes, `:411`). Detection then returns null, and the panel plays fallback `w_Ma8oQLmSM` (`:75`), a deleted ABC News Live video. That is the error 150 message.

The current tree has 47 unique Live News fallback IDs. The session audited 46 and found many ended or gone:

- france24 `u9foWyMSETk` returned oEmbed 404.
- nhk-world `f0lYfG_vY_U` returned 404.
- several returned LOGIN_REQUIRED.
- kan-11's fallback `TCnaIE_SAtM` (`src/components/LiveNewsPanel.ts:160`) belongs to Taiwan CTV news.

The existing structural tests only check presence. `tests/live-news-hls.test.mjs:63-71` checks that each `DIRECT_HLS_MAP` channel has a fallback ID, an `hlsUrl`, or a handle. `:96-101` checks that full-variant channels have a `fallbackVideoId`. No test, script, or workflow checks whether an ID is still live.

Fix (#8163, 2026-09-14):

- `npm run live-video:check -- <video URL, channel URL, video ID or https .m3u8> ...` plays each YouTube entry in headless Chromium as if embedded on `https://www.worldmonitor.app`. It classifies the player with `classifyAttempt` (`src/services/live-video/model.ts`) and exits 1 when any entry is not live. The rules:
  - A player error such as 150 is failed.
  - `isLive` true plus a sample taken while the player is PLAYING is live. A scheduled stream also reports `isLive` true but never plays.
  - `isLive` false that holds while playing through the recording-confirm window (`recordingConfirmMs`, 2 s) is an ended recording.
  - At the 15 s verdict deadline, `isLive` true that never played is not started (failed), and a missing `isLive` is unverifiable.
  - An HLS entry's media playlist is fetched, reloaded one target duration later (clamped to 1-10 s and to the deadline), and reloaded once more half a target duration after that. It is live as soon as the playlist advanced: a higher `#EXT-X-MEDIA-SEQUENCE`, a different last segment, or more segments. `#EXT-X-ENDLIST` or `#EXT-X-PLAYLIST-TYPE:VOD` is a recording, and only a playlist that advanced in neither reload fails. The second look follows RFC 8216 6.3.4: a CDN edge can still serve the previous copy one target duration on, so one unchanged reload is not a frozen stream. When the deadline leaves no room for that second look and already clipped the first wait, the entry reads as unverifiable rather than dead. `#EXT-X-PROGRAM-DATE-TIME` is not a liveness signal, because a frozen playlist keeps it.
  - A LIVE verdict covers the web embed origin only. The desktop sidecar embed (`http://localhost:<port>/api/youtube-embed`) is not probed, so a video whose owner restricts embedding by referrer can pass here and still fail on desktop.
- Every webcam and Live News `fallbackVideoId` was re-checked with it. Dead or ended IDs were replaced with verified live streams, most of them found by the owner. Where no live stream exists, the ID was removed: the tel-aviv, beirut-mtv, nasa-live and space-x webcams are gone, and 25 optional Live News channels lost their dead fallback. The odessa webcam was folded into one Ukraine feed that rotates through several cities, and the unused `channelHandle` field was deleted.
- The checker also read CNN's `DIRECT_HLS_MAP` stream (`cnn_slate`) as a recording: a playlist with `#EXT-X-ENDLIST`, about 10 minutes long, that played under a LIVE label on web. It was removed, so CNN plays its live YouTube stream `GotlA1KKWoo`.

Still recommended:

- Verify liveness in the player at runtime, and move to the next feed on an ended recording or a player error, so a stream that ends after a check is never shown as live.
- Map YouTube `onError` from the native iframe to `markIframeBlocked` or to the next feed.
- Add a scheduled run of the checker over every configured entry that opens an issue naming each slot that needs a replacement.

### Audit recipe: is a video ID still live?

The consent cookie avoids a consent interstitial in place of the watch page.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
ID=e34xb-Fbl0U

curl -s -o /dev/null -w 'oembed %{http_code}\n' \
  "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=$ID&format=json"

curl -s -A "$UA" -H 'Cookie: CONSENT=YES+cb; SOCS=CAI' "https://www.youtube.com/watch?v=$ID" \
  | grep -oE '"playabilityStatus":\{"status":"[A-Z_]+"|"isLiveNow":(true|false)|"endTimestamp":"[^"]+"' \
  | sort -u
```

How to read the output:

- **Live:** oEmbed 200, `"status":"OK"`, `"isLiveNow":true`, and no `endTimestamp`.
- **Ended:** an `endTimestamp` is present. The ID may still play, but as a recording.
- **Dead:** `UNPLAYABLE`, `LOGIN_REQUIRED`, or an oEmbed 404. The tile will fail.
- **Ownership:** compare the oEmbed `author_name` with the channel the feed claims.

### Audit recipe: which path answered production detection?

Agent user agents get 403 `agent_request_blocked` (`shared/agent-request-policy.json:14`). Send a non-agent UA. `Origin` is optional, but a disallowed one gets 403 (`api/youtube/live.js:20-22`).

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
curl -s -D - -A "$UA" -H 'Origin: https://www.worldmonitor.app' \
  'https://api.worldmonitor.app/api/youtube/live?channel=@SkyNews'
```

Read `cache-control` to fingerprint the path:

- **`max-age=600`:** the relay answered (`api/youtube/live.js:63`, `:69`).
- **`max-age=300`:** the edge's own scrape answered (`api/youtube/live.js:138`).

Vercel strips `s-maxage` from the response (observed on production 2026-09-14). A `max-age=600` with `videoId:null` for a channel that is live is Defect 2.

When a handle starts with `@`, never put it at the start of a curl `-w` format string. curl reads `-w @name` as a filename.

### Idle test recipe

- **Use real input.** Use Playwright `locator.click()` or `page.mouse.move`, never `element.click()` inside `page.evaluate`.
- **Time from the last real input.** Measure the stop from there, not from boot or from playback start.
- **Keep the tab visible.** A hidden document triggers a separate teardown with reason `hidden` (`src/components/LiveNewsPanel.ts:723-725`, `src/components/LiveWebcamsPanel.ts:822-825`). The app-shell idle timer also skips hidden documents (`src/app/event-handlers.ts:1428`).
- **Fast coverage exists.** `e2e/live-media-intent.spec.ts:223` covers idle teardown. It rewrites timeouts equal to `IDLE_PAUSE_MS` to 120ms (`:247-252`).

## Why This Works

All three defects share one shape: a fallback turns a failure into a plausible-looking success, and nothing signals it.

- **Idle stop.** The stop is intentional resource saving, but the UI never names it, so a user reads it as the product breaking. Disclosing it in the placeholder and the setting, or offering a wall mode, removes the misreading and keeps the saving.
- **Detection.** Each layer either reports failure as HTTP 200 with a null body or swallows a rejection, so the next layer's fallback never triggers. The recommended changes restore those triggers: fall back on non-2xx, follow redirects, and return a failure the edge and the RPC can see. Status logging turns the UNVERIFIED proxy cause into a question Railway logs can answer.
- **Fallback IDs.** Dead detection pushes all playback onto the hardcoded IDs, and nothing checks them. YouTube live video IDs end whenever a broadcaster ends or restarts a stream; the audited grid IDs ended between 2022 and 2026-07. A scheduled audit plus `onError` handling surfaces that decay within a day, instead of at a customer's cancellation.

## Prevention

- Add a synthetic check that `/api/youtube/live` returns a non-null `videoId` for 3 to 5 handles that are live 24/7. Alert on sustained failure, not on a single miss.
- Add a scheduled job that runs the audit recipe over every `fallbackVideoId` in `LiveNewsPanel.ts` and `LiveWebcamsPanel.ts`. It should open an issue listing dead, ended, or mis-owned IDs.
- In any fallback chain, the layer above must be able to tell a failure from an empty success. Do not return HTTP 200 with a null body for an upstream error. Do not end a promise with a catch-all resolve when the caller's fallback lives in a `catch`.
- Log the upstream status of every non-2xx third-party fetch in the relay.
- Read a comment like "validated Feb 2026" as a date stamp, not a guarantee. A liveness claim about a third-party ID needs a check that runs.
- When a timed behaviour changes what the user sees, say so in the UI state it leaves behind.

## Related Issues

- #5503: the page scrape plus residential proxy used for live detection was flagged as a YouTube Terms of Service violation, closed as not planned. Read it before choosing how to repair Defect 2.
- #4334 / #4341: the click-to-play intent gate for Live News and Live Webcams, and the rationale for not loading video before the user asks.
- #914: an earlier user report of live news video stopping every 10-15 minutes, from before the current intent-gate design.
- #1123: webcams showing "This stream is blocked or failed to load" about 15 seconds after start. That is the embed ready timeout, not the idle stop.
- #2068, #3747: the latest commits that replaced default-grid webcam IDs.
- #2702: the last change to the relay's proxied YouTube fetch path. efc1945bb8 (2026-02-28) moved YouTube scraping to the relay.
- `docs/solutions/runtime-errors/ais-relay-self-request-configured-vs-bound-port.md`: same relay, same failure shape. A fallback swallowed the failure and degraded to a plausible-looking result with nothing surfaced.
- `docs/solutions/logic-errors/playback-control-gated-on-a-clerk-role-field-with-no-writer.md`: same failure class, a user-visible feature broken for months with no error and no alarm.
- `e2e/live-media-intent.spec.ts`: existing coverage for idle, hidden-tab, and always-on playback.
