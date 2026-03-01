# Tasks & Contributions Tracker

This file tracks ongoing work and contributions to World Monitor.

## Completed Tasks

### 2026-03-01

#### ✅ Task 1: Add Reuters UK RSS Feed
- **File:** `src/config/feeds.ts`
- **Change:** Added Reuters UK to Europe feeds with Tier 1 wire service classification
- **Details:** 
  - Feed URL: `https://www.reuters.com/world/uk/rss.xml`
  - Added to SOURCE_TIERS as Tier 1 (wire service)
  - Added to SOURCE_TYPES as 'wire'

#### ✅ Task 2: Add Keyboard Shortcuts Help Modal
- **Files:** 
  - `src/components/KeyboardShortcutsModal.ts` (new)
  - `src/components/index.ts`
  - `src/app/event-handlers.ts`
  - `src/styles/main.css`
  - `src/locales/en.json`
- **Change:** Press `?` key to show keyboard shortcuts modal
- **Shortcuts documented:**
  - `?` - Show keyboard shortcuts
  - `Ctrl/Cmd + K` - Open search
  - `Shift + F` - Toggle fullscreen
  - `Shift + T` - Toggle TV mode
  - `Shift + P` - Toggle playback control
  - `Escape` - Close modal / Exit fullscreen
  - `↑/↓` - Navigate search results
  - `Enter` - Select highlighted result

#### ✅ Task 3: Fix Documentation Typos
- **File:** `README.md`
- **Change:** Fixed grammar "HLS native streaming" → "Native HLS streaming" (2 occurrences)

#### ✅ Task 4: Dark/Light Mode Toggle Review
- **Status:** Already implemented and working
- **Location:** Header theme toggle button with sun/moon icons

## Pending / Complex Tasks

### ⚠️ Task 5: India Map Boundary (Jammu & Kashmir)
- **File:** `public/data/countries.geojson`
- **Status:** Complex - requires geo-spatial expertise
- **Issue:** The map currently uses UN-recognized boundaries which show the Line of Control (LoC) in Kashmir
- **Required changes:**
  - Modify India's polygon to include full J&K region coordinates
  - Modify Pakistan's polygon to exclude those areas
  - Precise coordinate manipulation around 74-77°E longitude, 32-37°N latitude
- **Note:** Politically sensitive - should be done carefully

## Codebase TODOs Found

### `src/app/panel-layout.ts:182`
```html
<!-- TODO: Add "Download App" link here for non-desktop users (this.ctx.isDesktopApp === false) -->
```
- Add a "Download App" button in the header for web users

### `src/services/ai-flow-settings.ts:5`
```typescript
// TODO: Migrate panel visibility, sources, and language selector into this
//       settings hub once the UI is extended with additional sections.
```
- Migrate settings into unified settings hub

## How to Contribute

1. Check GitHub Issues: https://github.com/koala73/worldmonitor/issues
2. Check GitHub Discussions: https://github.com/koala73/worldmonitor/discussions
3. See CONTRIBUTING.md for guidelines
