# Sidebar Update Button — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Problem

The auto-install update flow (`install_update` Tauri command) works end-to-end, but it is only surfaced via a toast that appears after a background check. Users have no persistent, visible indicator that an update is available and no one-click path to install it from a fixed location.

## Goal

Add a persistent update indicator to the macOS sidebar footer that:
- Shows "up to date" (muted, non-interactive) when on the latest version
- Shows a clickable install button when an update is available
- Starts the install immediately on click (no confirmation)
- Shows installing state while in progress
- Is hidden/neutral before the first check completes

## Non-goals

- Does not replace the existing update toast — both coexist
- Does not add a manual "check now" button (out of scope)
- No Windows/Linux support (auto-install is macOS-only; sidebar button only renders for desktop)

## Architecture

### 1. AppContext — new field

```ts
// app-context.ts
updateState: {
  phase: 'checking' | 'up-to-date' | 'available' | 'installing';
  version?: string;      // remote version string, present when phase === 'available'
  downloadUrl?: string;  // DMG URL, present when phase === 'available'
} | null;               // null = not yet checked (no UI shown)
```

### 2. DesktopUpdater — write state + emit event

After each check result, `DesktopUpdater` writes `ctx.updateState` and dispatches `wm:update-state` (no payload needed — sidebar reads from ctx):

- Before fetch starts: `{ phase: 'checking' }`
- No update: `{ phase: 'up-to-date' }`
- Update available: `{ phase: 'available', version, downloadUrl }`
- After install invoked: `{ phase: 'installing' }`

The existing toast logic is preserved unchanged. The state write happens alongside it.

### 3. panel-layout.ts — sidebar button

Replace the static version `<span>` in the sidebar footer with:

```html
<span id="sidebarUpdateBtn"></span>
```

Add `renderSidebarUpdateBtn()` method that reads `ctx.updateState` and sets `innerHTML`:

| `updateState` | Rendered output |
|---|---|
| `null` or `{ phase: 'checking' }` | `<span class="mac-sidebar-version">v{current}</span>` |
| `{ phase: 'up-to-date' }` | `<span class="mac-sidebar-version mac-sidebar-version--ok">v{current} ✓</span>` |
| `{ phase: 'available', version }` | `<button class="mac-sidebar-update-btn" id="sidebarUpdateInstall">v{current} → v{version}</button>` |
| `{ phase: 'installing' }` | `<span class="mac-sidebar-version mac-sidebar-version--installing">Installing…</span>` |

The `sidebarUpdateInstall` click handler calls `invokeTauri('install_update', { downloadUrl })` and immediately sets `ctx.updateState = { phase: 'installing' }` then re-renders.

`renderSidebarUpdateBtn()` is called:
1. During the initial sidebar render (reads from `ctx.updateState`, handles `null` gracefully)
2. In the `wm:update-state` event listener added once in `init()`

This means sidebar re-renders (mode transitions, Ghost Mode toggle) always show correct state because they re-call `renderSidebarUpdateBtn()` which reads live from `ctx`.

### 4. CSS — macos-native.css

Three new rules:

```css
.mac-sidebar-version--ok {
  /* same base as .mac-sidebar-version, adds subtle green tint */
  color: var(--mac-tertiary-label);
}

.mac-sidebar-update-btn {
  /* pill button, accent color, same font size as version span */
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--mac-accent);
  color: #fff;
  border: none;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
}

.mac-sidebar-version--installing {
  color: var(--mac-tertiary-label);
  font-style: italic;
}
```

## Data flow

```
DesktopUpdater.checkForUpdate()
  → writes ctx.updateState
  → dispatches wm:update-state
      → panel-layout.renderSidebarUpdateBtn()
          → reads ctx.updateState
          → updates #sidebarUpdateBtn innerHTML

User clicks install button
  → sets ctx.updateState = { phase: 'installing' }
  → renderSidebarUpdateBtn() (shows "Installing…")
  → invokeTauri('install_update', { downloadUrl })
      → Rust: download DMG → mount → verify → swap → relaunch
```

## Files changed

| File | Change |
|---|---|
| `src/app/app-context.ts` | Add `updateState` field to `AppContext` interface |
| `src/app/panel-layout.ts` | Replace static version span; add `renderSidebarUpdateBtn()`; add `wm:update-state` listener |
| `src/app/desktop-updater.ts` | Write `ctx.updateState` at each outcome; dispatch `wm:update-state` |
| `src/styles/macos-native.css` | Add 3 new CSS rules for update button states |

## Edge cases

- **Install error**: if `invokeTauri('install_update')` rejects, set `ctx.updateState` back to `{ phase: 'available', version, downloadUrl }` and re-render so the user can retry
- **Ghost Mode sidebar re-render**: `renderSidebarUpdateBtn()` is called as part of any full sidebar rebuild — no special handling needed
- **Web build**: `isDesktopApp` is false; `DesktopUpdater` already guards on `isDesktopApp`, so `updateState` stays `null` and no button renders
