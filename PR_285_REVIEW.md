# PR #285 Review — "fix: sync YouTube live panel mute state with native player controls"

## Summary

Clean, focused bug fix across 2 files (+53 / -1). Synchronizes the LiveNewsPanel's mute button with the YouTube player's native mute controls, which previously could drift out of sync.

**Verdict: Approve with minor suggestions.**

---

## How It Works

Two parallel sync paths cover both player modes:

### Path 1: Desktop embed proxy (`api/youtube/embed.js`)
- New `readMuted()` helper checks `player.isMuted()` with `getVolume() === 0` fallback
- `startMuteSync()` polls at 500ms, posts `yt-mute-state` message to parent **only on state change** — avoids unnecessary message traffic
- Called from `onReady` callback so polling starts as soon as the player is initialized
- Panel-side handler (`msg.type === 'yt-mute-state'`) updates `this.isMuted` and calls `updateMuteIcon()`

### Path 2: Native YT IFrame API (`src/components/LiveNewsPanel.ts`)
- `startMuteSyncPolling()` polls `syncMuteStateFromPlayer()` at 500ms
- `syncMuteStateFromPlayer()` short-circuits immediately if `this.useDesktopEmbedProxy` — no double-sync when using the embed proxy path
- Reads mute state via `isMuted()` or `getVolume() === 0` fallback, same as embed side
- Updates `this.isMuted` + `updateMuteIcon()` on change

### Cleanup
- `stopMuteSyncPolling()` called in both `destroyPlayer()` and `destroy()` — no leaked intervals
- `getVolume?(): number` correctly added to the `YouTubePlayer` type definition

---

## What's Good

- **No double-sync**: The `useDesktopEmbedProxy` guard in `syncMuteStateFromPlayer()` prevents both paths from running simultaneously
- **Change-only messaging**: The embed only posts `yt-mute-state` when the value actually changes (`m !== lastMuted`), not every 500ms
- **Proper lifecycle management**: Intervals are cleaned up on player destruction and panel teardown
- **Defensive null checks**: `readMuted()` returns `null` if player isn't ready; callers handle it gracefully

---

## Suggestions

### 1. No cleanup of `muteSyncIntervalId` in the embed on player destruction

In `embed.js`, `muteSyncIntervalId` is set but never cleared. If the player errors out or the iframe is reloaded, the interval keeps firing against a dead player. Consider clearing it in `onError` or adding a `stopMuteSync()` function:

```js
function stopMuteSync(){
  if(muteSyncIntervalId){clearInterval(muteSyncIntervalId);muteSyncIntervalId=null}
}
```

This is low-risk since the iframe gets destroyed entirely on channel switch, but it's good hygiene.

### 2. `postMessage` uses `'*'` as target origin

```js
window.parent.postMessage({type:'yt-mute-state',muted:lastMuted},'*');
```

This is acceptable here since the embed is served from a Vercel edge function and the parent origin varies, but worth noting. The panel-side handler should ideally validate `event.origin` against the expected embed URL to prevent spoofed `yt-mute-state` messages from other iframes. Currently the handler at line ~211 doesn't check origin:

```ts
} else if (msg.type === 'yt-mute-state') {
  const muted = msg.muted === true;
```

Low severity since the worst case is toggling a mute icon, but worth hardening.

### 3. Consider using `onVolumeChange` YouTube event instead of polling

The YouTube IFrame API fires a `volumechange` event (via `onApiChange`) that could replace the 500ms polling approach. This would be more efficient and responsive than polling, though the IFrame API's event support can be inconsistent across browsers, so polling is the safer choice. Just noting the alternative.

### 4. Minor: `MUTE_SYNC_POLL_MS` as instance property

```ts
private readonly MUTE_SYNC_POLL_MS = 500;
```

This is an instance property but behaves as a constant. A `static readonly` or a module-level `const` would be more idiomatic, but this is purely stylistic.

---

## Overall

Solid, well-scoped fix. The dual-path approach correctly handles both the native API and desktop embed proxy cases. Cleanup is thorough. The suggestions above are minor hardening — nothing blocking.
