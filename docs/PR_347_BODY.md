<!-- PR description body: copy from "Summary" below to the end of "Screenshots" -->

Made-with: Cursor

## Summary

Fixes the bug where the Live News panel stays black after switching from an offline channel back to a live channel (Issue #347). The root cause was that `showOfflineMessage()` and `showEmbedError()` replaced the panel content without calling `destroyPlayer()`, so `this.player` remained set. When switching back to a live channel, `initializePlayer()` returned early and no new YouTube player was created. This PR calls `destroyPlayer()` at the start of both methods so that a new player is created when returning to a live stream.

**Cause analysis:** `LiveNewsPanel.ts` — `showOfflineMessage()` and `showEmbedError()` replace `this.content.innerHTML` without calling `destroyPlayer()`, so `this.player` stays set; `initializePlayer()` then returns early (`if (this.player) return`) and no new player is created. See also `docs/GITHUB_ISSUE_LIVE_NEWS_BLACK_SCREEN.md` (Root cause section).

**Trade-off:** Offline/error view now explicitly destroys the player so that returning to a live channel creates a fresh one (intended).

## Type of change

- [x] Bug fix
- [ ] New feature
- [ ] New data source / feed
- [ ] New map layer
- [ ] Refactor / code cleanup
- [ ] Documentation
- [ ] CI / Build / Infrastructure

## Affected areas

- [ ] Map / Globe
- [x] News panels / RSS feeds
- [ ] AI Insights / World Brief
- [ ] Market Radar / Crypto
- [ ] Desktop app (Tauri)
- [ ] API endpoints (`/api/*`)
- [ ] Config / Settings
- [x] Other: Live News panel (YouTube embed)

## Checklist

- [x] Tested on [worldmonitor.app](https://worldmonitor.app) variant (browser)
- [ ] Tested on [tech.worldmonitor.app](https://tech.worldmonitor.app) variant (if applicable)
- [ ] Tested on Tauri (.exe) for Live News panel flow (optional; same code path as browser)
- [ ] New RSS feed domains added to `api/rss-proxy.js` allowlist (if adding feeds)
- [x] No API keys or secrets committed
- [x] TypeScript compiles without errors (`npm run typecheck`)
- [x] Regression: zoom/pan, language/theme switch, and existing Live News behavior (other channels) checked

## Screenshots

No screenshots. Reproduce by adding an offline channel → switch to it → switch back to a live channel; the stream now loads instead of staying black.
