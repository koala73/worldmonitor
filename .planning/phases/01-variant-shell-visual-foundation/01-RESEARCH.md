# Phase 1: Variant Shell & Visual Foundation - Research

**Researched:** 2026-02-22
**Domain:** Variant architecture, CSS theming, MapLibre basemap styling, typography, Vercel subdomain routing
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Overall vibe: **Calm & serene** — soothing, quiet optimism, not loud or playful
- Base background: **Off-white / cream** (#FAFAF5-ish) — warm, paper-like, content panels float on it
- Accent colors: **Sage green + gold** — muted sage for primary actions, warm gold for highlights and emphasis
- Semantic color system: Greens, golds, soft blues throughout — no dark military aesthetic
- **Both light and dark modes from the start** — dark mode uses warm dark tones (deep navy, dark sage) instead of pure black
- Map style: **Soft vector / minimal** — clean vector map with muted colors, simplified shapes, minimal labels (think Apple Maps light mode but warmer)
- Map colors: **Sage landmass, light blue ocean** — muted sage/olive land, very light blue ocean, subtle gray borders
- Map detail level: **Match WorldMonitor's existing level** — same zoom detail, just with the warm style applied
- Body font: **Rounded sans-serif** — soft, approachable letterforms (Nunito, Quicksand direction). Friendly without being childish
- Headings: **Same family, bolder weight** — semibold/bold of the same rounded sans-serif. Unified feel, not a second font
- Favicon: **Warm-colored globe** — small globe icon in sage/gold tones, connects to "world monitor" concept in the happy palette
- Shape language: **Soft rounded corners** — generously rounded (12-16px radius). Panels feel gentle, approachable
- Elevation: **Subtle shadow elevation** — panels float slightly above the cream background with soft shadows. Depth without heaviness
- Empty states: **Soft illustration + message** — simple, warm line illustrations (nature-themed) with friendly text like "Coming soon"
- Layout structure: **Same grid as WorldMonitor, new skin** — variant differs in theme/mood, not panel arrangement

### Claude's Discretion
- Map graticule presence and styling
- Logo/logotype design for the header
- Exact color hex values within the sage green + gold + cream direction
- Dark mode specific adjustments (exact dark tones)
- Loading skeleton and transition animations
- Specific illustration style for empty states

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | Happy variant config (`VITE_VARIANT=happy`) registered in variant architecture with panel/feed/layer definitions | Variant architecture fully mapped: `src/config/variant.ts` (runtime detection), `src/config/panels.ts` (variant-aware exports), `src/config/variants/` (per-variant configs), `vite.config.ts` (build-time VARIANT_META). Pattern is well-established — add `'happy'` to all switch points. |
| INFRA-02 | Subdomain routing for happy.worldmonitor.app via Vercel config | Vercel handles subdomains via project domain settings (dashboard), not `vercel.json`. CORS in `server/cors.ts` already allows `*.worldmonitor.app`. CSP in `index.html` frame-src needs `happy.worldmonitor.app` added. Build script `build:happy` needed in `package.json`. |
| INFRA-03 | Variant-specific metadata (title, description, OG tags, favicon) for happy subdomain | `vite.config.ts` has `VARIANT_META` record that drives `htmlVariantPlugin()` and PWA manifest. Add `happy` entry. Favicon files go in `public/favico/happy/` or override existing paths per variant. |
| THEME-01 | Warm & bright CSS theme with custom color palette | All colors are CSS custom properties in `src/styles/main.css` under `:root` (dark) and `[data-theme="light"]`. The happy variant needs a NEW set of custom properties scoped to a variant selector (e.g., `[data-variant="happy"]`). Both light and dark modes required. |
| THEME-02 | Warm map basemap style | DeckGLMap uses MapLibre GL with CARTO basemap styles (dark-matter for dark, voyager for light). Need custom style JSON derived from CARTO Voyager with modified land/water/border colors. The style JSON is self-hosted and referenced by URL. |
| THEME-03 | Typography and spacing adjustments | Current font is monospace (`SF Mono`, `Fira Code`). Happy variant uses rounded sans-serif. Load Nunito from Google Fonts, set `--font-body` per-variant. Heading weight = semibold/bold of same family. |
| THEME-04 | Positive-semantic color system | Current semantic vars: `--semantic-critical`, `--threat-high`, etc. Happy variant redefines these to celebration gold, growth green, hope blue, kindness pink. All panel CSS already uses these vars so redefining them is sufficient. |
| THEME-05 | Happy counterparts for all existing UI chrome | Panel headers, loading states (radar sweep), empty states, status indicators, skeleton shell (inline in `index.html`) all reference CSS vars. Redefining vars handles most; loading animation and empty state illustrations need new markup. |
</phase_requirements>

## Summary

Phase 1 establishes the HappyMonitor visual foundation by registering a `happy` variant in the existing multi-variant architecture and delivering a complete warm theme. The codebase already supports three variants (`full`, `tech`, `finance`) with a clean pattern: build-time `VITE_VARIANT` env var drives config selection, metadata injection, panel/layer definitions, and build scripts. Adding a fourth variant follows this exact pattern with zero architectural novelty.

The theme system is CSS custom property-based with `data-theme` attributes controlling light/dark mode. The happy variant needs a parallel system where `data-variant="happy"` overrides the base CSS variables with warm sage/gold/cream tones. The map basemap is a MapLibre GL style JSON URL (currently CARTO dark-matter/voyager); the happy variant needs a self-hosted modified Voyager style with sage landmass and light blue ocean colors. Typography requires loading a Google Font (Nunito recommended) and overriding `--font-body`.

**Primary recommendation:** Follow the established variant pattern exactly. Add `'happy'` to every switch point (`variant.ts`, `panels.ts`, `vite.config.ts`, `package.json`). Implement the theme as CSS custom property overrides scoped to `[data-variant="happy"]`, with the basemap as a self-hosted modified Voyager style JSON.

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| MapLibre GL JS | (existing) | Vector map rendering | Already used for all map basemap rendering |
| Vite | (existing) | Build tooling, env var injection | Drives `VITE_VARIANT` at build time |
| CSS Custom Properties | native | Theming system | Already used for all color theming |
| d3.js | (existing) | SVG map (mobile fallback) | Reads `--map-*` CSS vars for basemap colors |

### Supporting (new additions)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Google Fonts (Nunito) | latest | Rounded sans-serif typography | Loaded via `<link>` in `index.html`; no npm package needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Nunito | Quicksand | Quicksand was designed for display use; Nunito has better readability at small body text sizes (11-12px). Nunito also has true italics. Both are free Google Fonts. **Use Nunito.** |
| Self-hosted Voyager JSON | MapTiler custom style | MapTiler requires an API key and has tile quota. CARTO tiles are free and unlimited. Forking the Voyager JSON is simpler and zero-cost. |
| `[data-variant]` CSS scope | Separate CSS file per variant | Separate files risk duplication and drift. CSS custom property overrides via attribute selectors are the exact pattern the project uses for light/dark mode. |

**Installation:**
No npm packages needed. Nunito is loaded via Google Fonts CDN link tag.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── config/
│   ├── variant.ts              # Add 'happy' to allowed values
│   ├── variants/
│   │   ├── base.ts             # Shared (unchanged)
│   │   ├── full.ts             # (unchanged)
│   │   ├── tech.ts             # (unchanged)
│   │   ├── finance.ts          # (unchanged)
│   │   └── happy.ts            # NEW: happy variant panels/layers/feeds
│   └── panels.ts               # Add HAPPY_PANELS, HAPPY_MAP_LAYERS cases
├── styles/
│   ├── main.css                # Add [data-variant="happy"] overrides
│   └── happy-theme.css         # NEW: happy-specific theme (imported in main.css)
├── components/
│   └── DeckGLMap.ts            # Add HAPPY_LIGHT_STYLE, HAPPY_DARK_STYLE
├── utils/
│   ├── theme-manager.ts        # Unchanged (light/dark toggle works per-variant)
│   └── theme-colors.ts         # Unchanged (CSS var cache auto-invalidates)
public/
├── favico/
│   └── happy/                  # NEW: happy-variant favicon set
│       ├── favicon.ico
│       ├── favicon-16x16.png
│       ├── favicon-32x32.png
│       ├── apple-touch-icon.png
│       ├── android-chrome-192x192.png
│       ├── android-chrome-512x512.png
│       └── og-image.png
├── map-styles/
│   ├── happy-light.json        # NEW: modified Voyager for happy light mode
│   └── happy-dark.json         # NEW: modified dark basemap for happy dark mode
vite.config.ts                  # Add 'happy' to VARIANT_META, favicon paths
package.json                    # Add dev:happy, build:happy scripts
index.html                      # Add Google Fonts link, happy.worldmonitor.app to CSP
```

### Pattern 1: Variant Registration (Existing Pattern)
**What:** Every variant follows the same registration pattern across 5 files.
**When to use:** Adding any new variant.
**Example:**
```typescript
// src/config/variant.ts — Add 'happy' to allowed values
export const SITE_VARIANT: string = (() => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy') return stored;
  }
  return import.meta.env.VITE_VARIANT || 'full';
})();
```

```typescript
// src/config/panels.ts — Add happy case to ternary chain
export const DEFAULT_PANELS = SITE_VARIANT === 'happy' ? HAPPY_PANELS
  : SITE_VARIANT === 'tech' ? TECH_PANELS
  : SITE_VARIANT === 'finance' ? FINANCE_PANELS
  : FULL_PANELS;
```

```typescript
// vite.config.ts — Add happy entry to VARIANT_META
const VARIANT_META = {
  // ... existing entries ...
  happy: {
    title: 'Happy Monitor - Good News & Global Progress Dashboard',
    description: 'Positive news, progress data, and uplifting stories from around the world.',
    keywords: 'good news, positive news, global progress, happy news, ...',
    url: 'https://happy.worldmonitor.app/',
    siteName: 'Happy Monitor',
    shortName: 'HappyMonitor',
    subject: 'Good News, Global Progress, and Human Achievement',
    classification: 'Positive News Dashboard, Progress Tracker',
    categories: ['news', 'lifestyle'],
    features: ['Positive news aggregation', 'Global progress tracking', ...],
  },
};
```

### Pattern 2: CSS Variant Theming (New Pattern, Follows Existing data-theme Pattern)
**What:** Override CSS custom properties based on `data-variant` attribute on `<html>`.
**When to use:** When the variant needs a completely different visual identity.
**Example:**
```css
/* Happy variant — light mode (default) */
[data-variant="happy"] {
  --bg: #FAFAF5;
  --surface: #FFFFFF;
  --panel-bg: #FFFFFF;
  --border: #E0DDD5;
  --text: #2D3A2E;
  --accent: #6B8F5E;       /* sage green */
  --green: #6B8F5E;        /* sage green (replaces neon green) */
  --yellow: #C4A35A;       /* warm gold */
  --font-body: 'Nunito', system-ui, sans-serif;
  /* Map colors */
  --map-bg: #E8F0F4;       /* very light blue ocean */
  --map-country: #C5CEAF;  /* muted sage land */
  --map-stroke: #B8B0A0;   /* subtle warm gray borders */
  --map-grid: #D8D2C8;     /* warm grid lines */
  /* Semantic overrides */
  --semantic-critical: #C4A35A;   /* gold instead of red */
  --semantic-high: #6B8F5E;       /* sage instead of orange */
  --semantic-normal: #6B8F5E;     /* sage green */
  --status-live: #6B8F5E;         /* sage green dot */
}

/* Happy variant — dark mode */
[data-variant="happy"][data-theme="dark"] {
  --bg: #1A2332;            /* deep navy */
  --surface: #1E2A3A;       /* navy surface */
  --panel-bg: #1E2A3A;
  --border: #2D3D4F;
  --text: #E8E4DC;
  --accent: #8BAF7A;        /* lighter sage for dark bg */
  --map-bg: #16202E;
  --map-country: #2D4035;   /* dark sage land */
  --map-stroke: #3D5045;
}
```

### Pattern 3: Basemap Style Fork (MapLibre GL JSON)
**What:** Fork CARTO Voyager style JSON, modify layer paint properties for warm colors.
**When to use:** When the happy variant basemap needs different land/water/border colors.
**Example layers to modify in the Voyager style JSON:**
```json
{
  "id": "background",
  "type": "background",
  "paint": { "background-color": "#FAFAF5" }
},
{
  "id": "water",
  "type": "fill",
  "paint": { "fill-color": "#D4E6EC" }
},
{
  "id": "landcover",
  "type": "fill",
  "paint": { "fill-color": "rgba(185, 205, 170, 0.3)" }
},
{
  "id": "boundary_country_inner",
  "type": "line",
  "paint": { "line-color": "#C8C0B5" }
}
```

### Pattern 4: Variant-Aware Basemap Selection in DeckGLMap
**What:** Extend the existing DARK_STYLE/LIGHT_STYLE constants to be variant-aware.
**When to use:** When the happy variant needs different basemap style URLs.
**Example:**
```typescript
// src/components/DeckGLMap.ts
import { SITE_VARIANT } from '@/config';

const DARK_STYLE = SITE_VARIANT === 'happy'
  ? '/map-styles/happy-dark.json'
  : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const LIGHT_STYLE = SITE_VARIANT === 'happy'
  ? '/map-styles/happy-light.json'
  : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
```

### Anti-Patterns to Avoid
- **Duplicating main.css for the happy variant:** All styling should be CSS custom property overrides, not a parallel stylesheet. The existing panel CSS uses `var(--border)`, `var(--surface)`, etc. extensively. Overriding the variables is sufficient.
- **Creating a separate App class for happy:** The variant differences are purely visual (theme + basemap). The same App class handles all variants — just add the `'happy'` case to conditional blocks.
- **Using JavaScript to compute colors at runtime:** The existing `getCSSColor()` utility reads computed CSS properties. CSS custom properties cascade automatically via the `[data-variant]` attribute. No JS needed for color switching.
- **Embedding the font via npm package:** Google Fonts CDN is already cached by the service worker (see `vite.config.ts` workbox config for `fonts.googleapis.com` and `fonts.gstatic.com`). No npm package needed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Map basemap styling | Custom tile rendering | Fork CARTO Voyager style JSON | Voyager is a well-tested vector style with all the layers needed. Modifying paint properties is straightforward. |
| Font loading | Custom font-face declarations | Google Fonts CDN link | Service worker already caches Google Fonts. CDN handles subsetting, WOFF2, and preload headers. |
| Favicon generation | Manual pixel editing | realfavicongenerator.net or svg-to-png script | Need 7 sizes (ico, 16, 32, apple-touch, android-chrome 192/512, og-image). Generator handles all sizes from single SVG. |
| Dark mode color math | Manual color picking for each dark variant | CSS `color-mix()` or systematic approach | The existing project uses explicit hex values for dark mode, which is the right approach for precise control. Define a cohesive dark palette systematically. |

**Key insight:** The entire theming system is CSS custom properties. The planner should resist the temptation to create parallel component code or conditional rendering. Every visual change happens at the CSS variable layer.

## Common Pitfalls

### Pitfall 1: Variant Not Detected at Build Time
**What goes wrong:** Happy variant panels/metadata don't load because `VITE_VARIANT` is not set during the build.
**Why it happens:** Vite inlines `import.meta.env.VITE_VARIANT` at build time. If the Vercel project for happy.worldmonitor.app doesn't have `VITE_VARIANT=happy` in its environment variables, it defaults to `'full'`.
**How to avoid:** Verify Vercel project env vars include `VITE_VARIANT=happy` for the happy subdomain project. Add `"dev:happy": "VITE_VARIANT=happy vite"` and `"build:happy": "VITE_VARIANT=happy tsc && VITE_VARIANT=happy vite build"` to package.json.
**Warning signs:** Happy subdomain loads but shows the full/geopolitical panels and dark theme.

### Pitfall 2: CSS Specificity War Between Variant and Theme
**What goes wrong:** `[data-variant="happy"]` overrides conflict with `[data-theme="light"]` overrides.
**Why it happens:** Both are single-attribute selectors with equal specificity. If `[data-theme="light"]` appears after `[data-variant="happy"]` in the CSS, theme overrides win.
**How to avoid:** Use compound selectors for variant+theme combinations: `[data-variant="happy"][data-theme="light"]` and `[data-variant="happy"][data-theme="dark"]`. Place variant CSS AFTER the base theme CSS. The happy light mode is the default; happy dark mode is the override.
**Warning signs:** Dark mode colors bleed into happy light mode, or happy colors don't appear when dark mode is toggled.

### Pitfall 3: MapLibre Style JSON Tile Source URLs
**What goes wrong:** Self-hosted style JSON references CARTO tile sources with relative URLs that break.
**Why it happens:** The Voyager style JSON has `sources` that point to `https://basemaps.cartocdn.com/...` tile endpoints. When you fork the JSON and host it locally, these source URLs must remain absolute.
**How to avoid:** When forking the Voyager style JSON, keep ALL `sources` entries and their `tiles`/`url` fields unchanged. Only modify `layers[].paint` and `layers[].layout` properties.
**Warning signs:** Map loads as blank/white because tiles can't be fetched.

### Pitfall 4: Skeleton Shell in index.html
**What goes wrong:** The pre-JS skeleton (inline CSS in `index.html`) still shows dark colors for the happy variant.
**Why it happens:** The skeleton CSS is hardcoded inline and doesn't use CSS custom properties. It has explicit dark-mode and light-mode variants but no variant awareness.
**How to avoid:** Add `[data-variant="happy"] .skeleton-*` overrides in the inline `<style>` block. The variant attribute must be set before the skeleton renders, which means the inline `<script>` tag that reads `localStorage` must also check for variant.
**Warning signs:** Brief flash of dark skeleton before the main app renders with warm colors.

### Pitfall 5: D3 SVG Map (Mobile) Also Needs Warm Colors
**What goes wrong:** Desktop (DeckGLMap/MapLibre) looks great but mobile (Map.ts/D3+SVG) still renders with the dark basemap.
**Why it happens:** The D3-based Map.ts reads `getCSSColor('--map-bg')`, `getCSSColor('--map-country')`, etc. These CSS variables must be overridden by the happy variant CSS for the D3 map to also render warm.
**How to avoid:** Ensure `--map-bg`, `--map-country`, `--map-stroke`, `--map-grid` are defined in the `[data-variant="happy"]` CSS rules. The D3 map code requires NO changes — it already reads these CSS vars dynamically.
**Warning signs:** Mobile map looks dark/military while desktop map looks warm.

### Pitfall 6: Font Flash of Unstyled Text (FOUT)
**What goes wrong:** Page loads with monospace font, then jumps to Nunito after Google Fonts loads.
**Why it happens:** Google Fonts loads asynchronously. The skeleton and initial render use the fallback font stack.
**How to avoid:** Use `<link rel="preconnect" href="https://fonts.googleapis.com">` and `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` before the font stylesheet link. Consider `font-display: swap` (default for Google Fonts). The skeleton should use a similar-metric fallback (system-ui sans-serif) to minimize layout shift.
**Warning signs:** Visible font change 200-500ms after page load.

### Pitfall 7: Panel CSS with Hard-Coded Colors
**What goes wrong:** Some panel-specific CSS uses hard-coded `rgba(255, 50, 50, ...)` instead of CSS variables.
**Why it happens:** Some older panel CSS (e.g., `.panel-header-error`, `.risk-no-data`) uses hardcoded colors.
**How to avoid:** Audit `src/styles/panels.css` and `src/styles/main.css` for hardcoded color values that should be replaced with CSS variables. For phase 1, focus on the most visible elements (panel headers, loading states, empty states). Hardcoded colors in content-specific panels (fires, UCDP, displacement) can be addressed when those panels are adapted for the happy variant.
**Warning signs:** Red/orange threat colors bleeding through on panels that are supposed to show warm sage/gold.

## Code Examples

Verified patterns from the existing codebase:

### Variant Detection and Conditional Logic
```typescript
// Source: src/config/variant.ts (line 1-7)
// Pattern: IIFE with localStorage fallback to VITE_VARIANT env
export const SITE_VARIANT: string = (() => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy') return stored;
  }
  return import.meta.env.VITE_VARIANT || 'full';
})();
```

### Variant-Aware Panel Export
```typescript
// Source: src/config/panels.ts (line 374-376)
// Pattern: Ternary chain selecting config by variant
export const DEFAULT_PANELS = SITE_VARIANT === 'tech' ? TECH_PANELS
  : SITE_VARIANT === 'finance' ? FINANCE_PANELS
  : FULL_PANELS;
// Extend to:
export const DEFAULT_PANELS = SITE_VARIANT === 'happy' ? HAPPY_PANELS
  : SITE_VARIANT === 'tech' ? TECH_PANELS
  : SITE_VARIANT === 'finance' ? FINANCE_PANELS
  : FULL_PANELS;
```

### Basemap Theme Switching
```typescript
// Source: src/components/DeckGLMap.ts (line 3854-3861)
// Pattern: switchBasemap() called on theme change event
private switchBasemap(theme: 'dark' | 'light'): void {
  if (!this.maplibreMap) return;
  this.maplibreMap.setStyle(theme === 'light' ? LIGHT_STYLE : DARK_STYLE);
  this.countryGeoJsonLoaded = false;
  this.maplibreMap.once('style.load', () => {
    this.loadCountryBoundaries();
  });
}
```

### Theme Manager (Unchanged for Happy)
```typescript
// Source: src/utils/theme-manager.ts (line 35-48)
// Pattern: setTheme() dispatches event, updates DOM attribute
// Happy variant reuses this exactly — data-theme toggles light/dark
// The data-variant attribute is set separately and doesn't interact with this
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  invalidateColorCache();
  // ... localStorage, meta theme-color, event dispatch
}
```

### Inline Skeleton Theme Awareness
```html
<!-- Source: index.html (line 95) -->
<!-- Pattern: Inline script runs before CSS loads to prevent FOUC -->
<script>(function(){
  try{
    var t=localStorage.getItem('worldmonitor-theme');
    if(t==='light')document.documentElement.dataset.theme='light';
    // Add variant detection:
    var v=localStorage.getItem('worldmonitor-variant');
    if(!v){
      // Detect from hostname for first visit
      var h=location.hostname;
      if(h.startsWith('happy.'))v='happy';
      else if(h.startsWith('tech.'))v='tech';
      else if(h.startsWith('finance.'))v='finance';
    }
    if(v)document.documentElement.dataset.variant=v;
  }catch(e){}
  document.documentElement.classList.add('no-transition');
})()</script>
```

### Google Fonts Loading
```html
<!-- Add to index.html <head>, before main.css -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Only load when happy variant is detected at build time -->
<!-- Vite htmlVariantPlugin can conditionally inject this -->
<link href="https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mapbox GL JS | MapLibre GL JS | Fork in 2021 | Free, open-source, no API key needed for library |
| Separate CSS files per theme | CSS custom properties with data-attribute selectors | Standard since 2020+ | One stylesheet, attribute toggles theme. Project already uses this. |
| npm font packages | Google Fonts CDN with preconnect | Always been standard for web | Zero bundle size impact, CDN caching, automatic subsetting |
| CARTO tile keys | Free CARTO basemaps (no key) | Always been free | `basemaps.cartocdn.com` requires no authentication |

**Deprecated/outdated:**
- Mapbox GL JS: Still exists but requires API key. MapLibre is the drop-in replacement already in use.
- CSS-in-JS theming: Not relevant — this project uses vanilla CSS custom properties, which is the correct approach for a monolithic App.ts architecture.

## Open Questions

1. **Vercel Project Configuration for happy.worldmonitor.app**
   - What we know: Existing variants (tech, finance) each have `VITE_VARIANT` set in Vercel. The CORS pattern `*.worldmonitor.app` already covers happy. The Vercel domain configuration is done through the dashboard UI, not `vercel.json`.
   - What's unclear: Whether the user runs separate Vercel projects per subdomain or a single project with multiple domains. The existing `build:tech` and `build:finance` scripts suggest separate builds, which implies separate Vercel projects.
   - Recommendation: Confirm with user during planning. The implementation is the same either way — just needs `VITE_VARIANT=happy` in the Vercel env vars for the happy project.

2. **Favicon Design Specifics**
   - What we know: User wants a "warm-colored globe in sage/gold tones." Need 7 image assets (ico, 16px, 32px, apple-touch 180px, android-chrome 192px/512px, og-image 1200x630).
   - What's unclear: Whether to use an SVG-based approach (inline SVG favicon) or pre-rendered PNGs. The current project uses pre-rendered PNGs.
   - Recommendation: Create an SVG globe icon and use a favicon generator (realfavicongenerator.net) to produce all sizes. For OG image, create a simple branded card with the sage/gold color scheme. During implementation, the SVG can be designed as a simple globe outline filled with sage green, with gold accent on the meridian or a small highlight.

3. **Happy Variant Panel Selection (for Phase 1)**
   - What we know: Phase 1 delivers the visual shell with no content panels. But the variant config still needs a `DEFAULT_PANELS` definition.
   - What's unclear: Which panels from the full variant should the happy variant include in its config? Phase 1 will show them as empty states.
   - Recommendation: Start with a minimal panel set: `map`, `live-news` (for Phase 3), `counters` (for Phase 5), `progress` (for Phase 5). All will show "Coming soon" empty states in Phase 1. Additional panels get added in their respective phases.

4. **Dark Mode Basemap for Happy Variant**
   - What we know: User wants warm dark tones (deep navy, dark sage) instead of pure black. The existing dark mode uses CARTO dark-matter.
   - What's unclear: There's no off-the-shelf warm dark basemap style. Would need to fork dark-matter and warm its colors, or create a custom dark style from scratch.
   - Recommendation: Fork CARTO dark-matter style JSON, replace the cold grays/blacks with deep navy blues and the land colors with dark sage. This is the same technique as forking Voyager for the light mode.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/config/variant.ts`, `src/config/panels.ts`, `src/config/variants/*.ts`, `vite.config.ts`, `src/styles/main.css`, `src/components/DeckGLMap.ts`, `src/utils/theme-manager.ts`, `index.html`, `server/cors.ts`, `package.json`
- CARTO Voyager style JSON: `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json` — verified layer structure (background, water, landcover, boundary layers with paint properties)
- MapLibre Style Spec: `https://maplibre.org/maplibre-style-spec/` — authoritative reference for style JSON format
- Google Fonts Nunito: `https://fonts.google.com/specimen/Nunito` — confirmed availability, weight range (300-900), italic support

### Secondary (MEDIUM confidence)
- CARTO basemap customization: `https://github.com/CartoDB/basemap-styles` — fork approach confirmed viable, style JSON is public and modifiable
- Vercel subdomain routing: `https://github.com/vercel/vercel/discussions/8374` — confirmed per-domain env vars require separate project/environment configuration
- Nunito vs Quicksand comparison: Multiple font comparison sources confirm Nunito has better body text readability at small sizes

### Tertiary (LOW confidence)
- None — all findings verified against primary sources (codebase + official docs)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, Nunito is a proven Google Font, CARTO basemap fork is well-documented
- Architecture: HIGH — existing variant pattern is crystal clear, theme system is CSS custom properties, MapLibre basemap switching already works
- Pitfalls: HIGH — identified from direct codebase analysis (inline skeleton, D3 mobile map, CSS specificity, hardcoded panel colors)

**Research date:** 2026-02-22
**Valid until:** 2026-04-22 (stable — no fast-moving dependencies)
