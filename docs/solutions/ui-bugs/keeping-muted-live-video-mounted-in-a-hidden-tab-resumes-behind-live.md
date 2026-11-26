---
title: "Keeping muted live video mounted in a hidden tab brings it back minutes behind live"
date: 2026-11-24
category: ui-bugs
module: src/components/LiveNewsPanel.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "A customer reported live video stopping whenever the dashboard tab lost focus"
  - "Live News the viewer was listening to from another tab went silent the moment the tab was hidden"
  - "Video the viewer had started came back as a placeholder (Live News) or as preview tiles (webcams) and needed starting again"
  - "After the first fix, a muted viewer-started stream kept mounted through a hidden tab came back about 7 minutes behind live after a 7-minute absence"
  - "Every Playwright test passed throughout, because Playwright pages always report visibilityState 'visible'"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [live-video, hidden-tab, visibilitychange, background-tab-media, muted-autoplay, live-edge, playwright-visibility, cdp, live-news, webcams]
---

# Keeping muted live video mounted in a hidden tab brings it back minutes behind live

## Problem

Both live panels stopped their video on `visibilitychange` to hidden, whatever the viewer was doing. A customer reported this as one of the reasons they would not buy a premium account. The obvious fix, keeping the player mounted while the tab is hidden, is right for audible streams and wrong for muted ones.

## Symptoms

- Audible Live News went silent as soon as the viewer switched tabs.
- A stream the viewer had started returned as a placeholder or as webcam preview tiles.
- With the first fix (keep every viewer-started stream mounted), a muted stream came back paused in the past: in a real Chrome run it resumed about 7 minutes behind live after 7 minutes hidden.
- None of this showed in Playwright, which reports every page as visible.

## What Didn't Work

- **Keeping every viewer-started stream mounted while hidden.** In the real-Chrome run (Bloomberg over HLS, this session), Chrome paused the muted `<video>` in the background tab on its own. On return the kept player resumed from the paused position, not the live edge. The viewer saw stale "live" news with nothing to say it was stale.
- **Removing the idle clock's hidden-tab suspension** in `src/services/live-media-idle.ts` so kept muted streams would still idle-stop. That only made sense while muted streams stayed mounted. Once they stop while hidden, the suspension is correct, so that change was reverted.
- **Testing hidden-tab behaviour with Playwright.** `page.evaluate(() => document.visibilityState)` always returned `'visible'`, even with a second page in front, so the e2e suite could not show either the bug or the fix.

## Solution

Choose by whether the stream is audible, not by who started it (#11209):

| Stream | Tab hidden | Tab visible again |
|---|---|---|
| Live News with sound on | Keeps playing, same player | Untouched |
| Live News muted, started by the viewer | Stops | Restarts by itself at the live edge |
| Muted autoplay (news or webcams) | Stops | Restarts, as before |
| Webcams the viewer started | Stop | The same feeds come back playing |

In `LiveNewsPanel.ts` the visibility handler returns early for an audible stream (`src/components/LiveNewsPanel.ts:84`). For a muted one it records whether to restart, then stops (`src/components/LiveNewsPanel.ts:89`):

```ts
if (this.isAudible()) return;
this.resumeOnTabReturn = this.startedByViewer && this.isPlaying && this.ownsLiveNewsMedia();
stopLiveMediaPlayback('live-news', 'hidden');
```

On return, `resumeAfterHiddenTab()` (`src/components/LiveNewsPanel.ts:385`) restarts playback unless the panel was closed, idle-stopped or already playing again. `LiveWebcamsPanel` saves the feed IDs that were playing (`src/components/LiveWebcamsPanel.ts:134`) and restores them. Closing the panel clears that list (`src/components/LiveWebcamsPanel.ts:812`).

"Started by the viewer" needs every way a viewer starts playback, not just the panel's play button: the play-all starter, Tap to play, re-selecting the current channel, and pressing play inside the embedded player (reported through the session's `onPlayingChange`). Pausing from the panel or inside the player must clear the restart.

Audible streams are also exempt from the idle stop (`src/components/LiveNewsPanel.ts:399`). Muting through the embed's own controls counts as activity (`noteLiveMediaActivity()`), so the idle hour starts at the mute. Otherwise the exemption swallows the last idle signal and the muted stream plays past the limit.

## Why This Works

A hidden tab gives a muted stream nothing worth keeping. Nobody sees it, the browser pauses it anyway, and the kept position goes stale. Stopping costs nothing while hidden, and a fresh start on return lands at the live edge. Audible playback is the one case where someone is still using the stream, and browsers keep audible media running in background tabs. Restarting it would also hit the autoplay rule that blocks unmuted starts without a gesture.

## Prevention

- Test hidden-tab media behaviour in real Chrome over raw CDP, not Playwright. The driver used for #11209 (a local script, not committed) does this:
  - launches Chrome with `--remote-debugging-port` and a throwaway `--user-data-dir`;
  - opens the dashboard in one target, then puts a second target in front with `PUT /json/new` and `/json/activate/<id>`. `/json/activate` returns plain text, not JSON;
  - samples `document.visibilityState`, `video.currentTime`, `video.paused` and the panel state over `Runtime.evaluate`.
- Before accepting "keep it mounted", measure the live gap: compare `currentTime` or the stream's live edge before and after a hidden interval of several minutes.
- The DOM suites (`tests/dom/live-news-hidden-tab-playback.test.mts`, `tests/dom/live-webcams-hidden-tab-playback.test.mts`) fake `document.hidden` and `visibilitychange`. They cover the panel's decisions, not the browser's background-media behaviour, which only the real-browser drive covers.
- Not verified here: YouTube-embed channels in a real hidden tab, Safari, Firefox, and the desktop app.

## Related Issues

- #11209: this fix.
- #11204: deploy reloads wait for a hidden, silent tab. It reads the same audible state through `setAudibleMedia('live-news', …)`, so an audible tab is never reloaded for a compatible deploy.
- [A forced reload on tab-focus destroys the modal the user left the app to serve](stale-bundle-reload-destroys-an-in-progress-modal.md): the same tab-return path, from the reload side.
