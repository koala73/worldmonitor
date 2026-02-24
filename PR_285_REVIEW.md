# PR #285 Review

## Summary

The PR title says **"fix: sync YouTube live panel mute state with native player controls"** but the actual diff spans **16 files** with **193 additions and 685 deletions**. The mute-sync fix itself is clean and correct, but it is bundled with several unrelated changes that reverse prior work, remove features, delete shared infrastructure, and drop tests. This should be split into separate PRs.

---

## Mute Sync Fix (the stated change) - Looks Good

The core fix in `api/youtube/embed.js` and `src/components/LiveNewsPanel.ts` is well-implemented:

- **Embed side** (`api/youtube/embed.js`): Adds `readMuted()` helper and `startMuteSync()` with 500ms polling that posts `yt-mute-state` messages to the parent window only on state change (avoids unnecessary message traffic).
- **Panel side** (`src/components/LiveNewsPanel.ts`): Handles the `yt-mute-state` postMessage for the desktop embed proxy path, and adds direct `syncMuteStateFromPlayer()` polling for the native YT IFrame API path. Both paths converge on `updateMuteIcon()`.
- Cleanup is handled properly: `stopMuteSyncPolling()` is called in both `destroyPlayer()` and `destroy()`.
- The `getVolume?(): number` addition to the `YouTubePlayer` type is correct.

**Minor nit on the mute sync:**
- Both the embed *and* the panel poll at 500ms independently. When using the desktop embed proxy, both polling loops run simultaneously (one inside the iframe posting messages, one in the panel reading the player). The panel-side polling (`syncMuteStateFromPlayer`) short-circuits with `if (this.useDesktopEmbedProxy || ...) return` which is correct, so there's no double-sync. Good.

---

## Issues With Bundled Changes

### 1. ACLED Shared Cache Layer Deleted - Regression

`server/_shared/acled.ts` is deleted and its logic is **inlined into each consumer** (`list-acled-events.ts`, `list-unrest-events.ts`, `get-risk-scores.ts`). This is a functional regression:

- **Before (main):** Three endpoints call `fetchAcledCached()` which deduplicates identical ACLED queries via a shared Redis cache key (`acled:shared:{eventTypes}:{startDate}:{endDate}:{country}:{limit}`). If two endpoints query the same event types and date range, the second one gets a cache hit.
- **After (this PR):** Each endpoint has its own fetch + its own cache key (`conflict:acled:v1`, `unrest:events:v1`, etc). Overlapping ACLED queries now result in **separate upstream API calls**, increasing ACLED rate-limit risk and latency.

The shared layer was specifically introduced to solve this problem. If there was a correctness issue with it, it should be fixed rather than removed.

### 2. Cache TTL Changes Reverse Prior Optimization

| Endpoint | main (PR #275) | This PR | Upstream Refresh |
|----------|----------------|---------|-----------------|
| Climate anomalies | 10800s (3h) | 1800s (30min) | ERA5: 2-7 day lag |
| Fire detections | 3600s (1h) | 1800s (30min) | FIRMS: ~3h updates |

The prior TTLs were aligned with upstream data refresh rates. Polling ERA5 data every 30 minutes when it updates on a multi-day lag wastes resources. No rationale is provided for the change.

### 3. Test File Deleted Without Replacement

`tests/ttl-acled-ais-guards.test.mjs` (168 lines) is deleted. This file tested:
- TTL alignment for climate/fire caches
- ACLED shared cache layer behavior
- Maritime AIS visibility guard

The tests fail now because the code they tested was removed in this PR. But the replacement inline ACLED implementations have **zero test coverage**. The correct approach would be to write new tests for the inlined implementations, not delete tests entirely.

### 4. Maritime AIS Visibility Guard Removed

The `document.hidden` check in `pollSnapshot()`, along with `pausePolling()`, `resumePolling()`, and the `visibilitychange` listener, are all deleted from `src/services/maritime/index.ts`. This means:

- AIS polling continues at 30-second intervals even when the browser tab is backgrounded
- This wastes Railway relay bandwidth on invisible tabs
- The guard was added specifically to control infrastructure costs

If there was a bug with the guard (e.g., polling not resuming properly), the fix should address that bug, not remove the optimization entirely.

### 5. External Link Interception Removed (`App.ts`)

The Tauri desktop app's `click` event listener that intercepts external links and opens them via `invokeTauri('open_url', ...)` is deleted. The code comment explicitly says: *"Tauri WKWebView/WebView2 traps target='_blank' -- links don't open otherwise."* Removing this will likely break external link navigation in the desktop app.

### 6. Optional Channels Feature Removed

The `OPTIONAL_LIVE_CHANNELS` array (35 channels across 5 regions), the `OPTIONAL_CHANNEL_REGIONS` data, and the entire "Available Channels" tab UI in `live-channels-window.ts` are removed. This includes:
- Region-based tab UI and card grid in JavaScript
- 125 lines of CSS for the card layout, tab bar, etc.
- i18n keys for region labels and "Custom channel" / "Available channels"

This is a significant feature removal that should be its own PR with context on *why* it's being removed.

### 7. User-Agent and Cloudflare Fallback Removed (`local-api-server.mjs`)

- The shared `CHROME_UA` constant is removed from the sidecar.
- All `'User-Agent': CHROME_UA` headers are stripped from API validation probes (Groq, OpenRouter, FRED, EIA, Cloudflare, ACLED, URLhaus, OTX, AbuseIPDB, Wingbits, Finnhub, NASA FIRMS, OpenSky).
- The `isCloudflare403()` helper and all Cloudflare 403 fallback paths (`return ok('... key stored (Cloudflare blocked verification)')`) are removed.

Some API providers may return different responses (or block requests) when no User-Agent is sent. The Cloudflare fallbacks allowed key storage even when Cloudflare blocked the verification probe -- removing them means a Cloudflare WAF block would now cause key validation to fail entirely.

One RSS feed User-Agent was changed to a hardcoded string (`Chrome/120.0.0.0`) instead of using the shared constant -- this looks like an inadvertent change from a merge conflict or stale edit.

---

## Recommendations

1. **Split this PR**: The mute sync fix should be its own PR. The ACLED refactoring, TTL changes, feature removals, and cleanup should each be separate PRs with clear rationale.
2. **Don't delete the shared ACLED layer** without replacing it with equivalent deduplication.
3. **Don't delete tests** without writing replacement tests.
4. **Justify TTL changes** -- the current values match upstream refresh rates.
5. **Keep the AIS visibility guard** -- fix bugs in it if any exist rather than removing it.
6. **Keep the Tauri link interception** unless the desktop app's link handling has been solved another way.
7. **Keep the User-Agent headers** on API validation probes to avoid provider-side blocking.

---

**Verdict: Request changes.** The mute-sync fix is correct and ready to merge on its own. The bundled changes introduce regressions and need discussion/justification before merging.
