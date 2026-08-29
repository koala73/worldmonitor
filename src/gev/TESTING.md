# God's Eye View — Testing Guide (voice map-annotation whiteboard + live tracking)

> [!NOTE]
> This is a **manual field-test scenario script** for the June-2026 whiteboard +
> tracking work. The AUTOMATED gates live elsewhere: `npm test` (unit),
> `npm run test:track` (tracking invariants), and the headless harnesses under
> `scripts/qa-*.mjs` — see [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md) for the full test surface.

This guide covers the hardened annotation and tracking behavior. Record a voice
note + screenshots as you go; each scenario
lists what **✅ pass** looks like and (where it applies) the **❌ old bug** it replaces.

## Focus/horizon moving evidence

With the Vite development server already running on port 4173, capture all four
focus/recession scenarios with a deterministic virtual frame clock:

```sh
node scripts/qa-focus-evidence.mjs --url http://localhost:4173 \
  --screenshots-dir qa-shots/focus-evidence \
  --json qa-shots/focus-evidence/report.json
```

For a quick operator loop, `--smoke` captures only S1 in six frames. For visual
sign-off, add `--headful`; this removes the SwiftShader launch flags and uses
the machine's real GPU. The harness brings its page to the foreground at the
start of every scenario so a headful Chromium run keeps streaming tiles.

Google 3D remains the default basemap. If its tile stream is the bottleneck
rather than the behavior under test, select an existing map stack explicitly:

```sh
--basemap bing-aerial
--basemap osm
```

Accepted values are `photoreal`, `bing-aerial`, `bing-labels`, and `osm`; Bing
stacks still require the app's usual Cesium ion token.

Tune both systems without editing source by adding, for example:

```sh
--params '{"focus":{"dimFloor":0.35,"nearerBehavior":"partial"},"horizon":{"scaleFloor":0.5,"alphaFloor":0.4}}'
```

The script never starts the server. During scenarios it pauses Cesium's default
render loop, advances focus time explicitly, and renders each frame before the
screenshot, so computed alpha/scale sequences repeat for identical parameters.
Headless Chromium still forces SwiftShader, so its pixels are relative CI/A-B
evidence only; headful real-GPU output is the sign-off surface. Screenshots use
scenario/frame names and the JSON report records effective tuning plus
per-contact alpha, scale, and screen data. Before each scenario's first capture,
the harness gives the active Google photoreal tileset up to 45 seconds to reach
Cesium's `tilesLoaded`/`allTilesLoaded` condition. Every frame records
`tilesSettled: true|false` and whether that gate applied; a timeout is recorded
as false, never promoted to a pass. Non-photoreal stacks record the gate as
settled and not applicable because no Google 3D tileset is active.

> [!IMPORTANT]
> Do not use a screenshot for visual judgment unless its report frame records
> `tilesSettled: true`.

## Setup

- **URL:** http://localhost:4173 — auto-flies to Austin on load. Give photoreal tiles ~10s.
- **Voice (the real feature):** click **GEV MIC** (bottom of screen) → wait for **LISTENING** →
  just talk. It marks the map *as it talks*, without announcing that it's drawing. Click
  **STOP** when done. (Needs `OPENAI_API_KEY`; `dev-fresh.sh` injects it from Keychain.)
- **Console (deterministic, no mic/live-data needed):** open DevTools (**Cmd-Opt-J**) and use:
  - `window.__gevAnnotations.tour()` — self-running narrated SF tour (camera + marks in sequence)
  - `window.__gevAnnotations.demo()` — lays the SF set down at once
  - `window.__gevAnnotations.clear()` — erase all marks
  - `window.__gevAnnotations.count()` — how many marks are live

---

## What changed (the list)

**Live aircraft tracking & camera (Batch D)** — civilian + military, mirrored:
- **R14** warm-up: tracked plane glides immediately (no freeze-then-jump / backward snap),
  via a display-layer reconciliation that smooths any position discontinuity over ~0.9s.
- **R15** framing: calibrated initial follow distance (altitude-scaled, 3–30 km).
- **R16** trail: head stays glued to the moving icon per-frame; never trails ~1s behind or
  pokes out in front of the nose.
- **R13** z-order: screen annotations fade where they'd cover the **tracked** plane + its label.

**Voice annotation — scoping & honesty (Batch B):**
- **R1** resolver scope: a place name resolves to the *right* thing (building vs neighborhood
  vs natural feature vs city) instead of an oversized admin blob.
- **R2** boundary stitching: complex outlines no longer close with bay-spanning chords.
- **R6** route honesty: a routing outage draws a *labeled* straight "direct line", never a
  silently faked road.
- **R12** partial honesty: if some targets fail, it says so — no masking partial as success.
- **R10** cache: transient failures aren't negative-cached for the whole session.

**Annotation rendering & motion (Batch C):**
- **R8** route flow: route dashes **animate** (flow along the path).
- **R9 / R17** perf: idle annotations stop their animation loop; height cache is bounded.
- **R11** no-freeze: large/complex boundaries simplify without locking the UI.

**Abuse guards (Batch A)** — mostly internal: input caps on `annotate_map`, clear/new-topic
cancellation, hardened Overpass + route proxies. Not much to see by hand (see §4).

---

## 1. Live aircraft tracking (Batch D) — the 3 issues you reported + z-order

> Needs a live plane. Track by **clicking a plane icon**; **Esc** (or click empty space) untracks.
> If you see no planes, scroll out once — Texas airspace is busy.

**1a · Warm-up smoothness (your issue #1 → R14)**
1. Click a moving plane. 📸 Snap the instant it locks, then watch ~2–3s.
- ✅ Starts gliding smoothly *immediately*. ❌ *Was:* froze ~1s, then jumped forward.

**1b · Initial framing (your issue #2 → R15)**
1. On the same lock-on, look at how the camera frames the plane. 📸 Snap the initial view.
- ✅ Plane + label readable with context, no scrolling. ❌ *Was:* jammed in too tight.

**1c · Trail glued to the plane (your issue #3 → R16)**
1. Keep tracking ~10s. 📸 Snap the cyan trail while it moves.
- ✅ Trail tail stays attached to the plane; nothing pokes out *in front* of the nose; no ~1s lag.
  ❌ *Was:* trail lagged a beat behind.

**1d · Military layer (same fixes, mirrored)**
1. Enable the **Military** layer (left column). Track an **amber** plane. Repeat 1a–1c.
- ✅ Identical smooth behavior.

**1e · Z-order: tracked plane stays on top (→ R13, trickiest to stage)**
1. While tracking a plane over Austin, GEV MIC: *"annotate downtown Austin."*
2. Orbit/zoom so the plane crosses the annotation's outline or label. 📸 Snap the overlap.
- ✅ The annotation **dims** where it covers the plane/label — plane stays visible on top.
  ❌ *Was:* the annotation drew over and hid the plane.

---

## 2. Voice annotation — scoping & honesty (Batch B)

> All from the Austin default view (no camera move needed). Click GEV MIC, then speak.

**2a · Scope: building vs region (→ R1)** — say each, watch what gets outlined:
- *"annotate the Texas State Capitol"* → ✅ the **Capitol building**, not the whole state.
- *"annotate Barton Creek"* → ✅ the **creek / greenbelt**, not Barton Creek *Mall* or the city.
- *"annotate downtown Austin"* → ✅ the **downtown district**, a sensible neighborhood-size area.
- *"annotate the University of Texas at Austin"* → ✅ the **campus**, not the city.
- 📸 Snap each outline. ❌ *Was:* incidental names ballooned into giant county/state blobs.

**2b · Classic SF set (optional)** — first say *"take me to San Francisco,"* then:
- *"annotate the Mission District"* → neighborhood. *"...the Presidio"* → the full former-base
  outline (not a single point, not a bay-spanning blob → R2). *"...Chinatown"* → the district.

**2c · Route honesty (→ R6)**
1. *"draw a route from Austin-Bergstrom airport to the Texas Capitol."*
- ✅ A real **road** route with a flowing dashed line + a labeled callout.
- If a route ever comes back as a **straight** line, it should be **labeled** as a direct/approx
  line (not pretending to be a road). ❌ *Was:* silent fake straight-line "routes."

**2d · Partial-failure honesty (→ R12)**
1. *"annotate the Texas Capitol and the Flibbergibbet Building."*
- ✅ It annotates the Capitol **and tells you** it couldn't find the other one.
  ❌ *Was:* reported success and silently dropped the missing one.

**2e · Clear / new-topic race (→ R4)**
1. *"annotate downtown Austin"* and, right as it starts, *"actually, clear everything."*
- ✅ Marks clear and **stay** cleared (the in-flight one doesn't pop back a second later).
- Sanity in console: `window.__gevAnnotations.count()` → `0` after a clear.

---

## 3. Annotation rendering & motion (Batch C) — deterministic, no mic

**3a · Full experience (smoke test)**
1. Console: `window.__gevAnnotations.tour()`. 📸 A couple of frames as it runs.
- ✅ Camera flies to SF; Palace highlight → arrow → Presidio **draped** outline → ILM pin →
  Crissy Field **route** appear in sequence; marks stay glued as the camera moves.

**3b · Route dashes animate (→ R8)**
1. During/after `tour()` (or `demo()`), watch the **route** line (Crissy Field shoreline).
- ✅ The dashes **flow** along the path (animated), not static. ❌ *Was:* dashes never moved.

**3c · Draping & persistence**
1. After `demo()`, orbit the camera around the Presidio outline.
- ✅ The footprint **drapes onto** the 3D ground/buildings and conforms; callouts/rings/arrows
  are the hand-drawn SVG style and stay anchored to their real spot.

**3d · Large boundary, no freeze (→ R11)**
1. Console:
   `window.__gevAnnotations.annotate([{type:'area',target:'Travis County, Texas',label:'Travis County',color:'green',footprint:true}],{flyTo:true,persist:true})`
- ✅ The complex county boundary simplifies and draws **without** freezing/janking the UI.

---

## 4. Robustness / guards (Batch A) — mostly internal

These are server-side / defensive and don't have a clean visual tell. Light checks only:
- Rapid-fire several annotate commands, then a clear — UI should stay responsive and end clean
  (`count()` → `0`).
- Nothing here should change normal behavior; flag it only if something feels *broken* (stuck
  spinner, marks that won't clear, errors in the console).

---

## 5. General feel — open feedback

While recording, call out anything in these areas — this is the feedback I most want:
- **Tracking feel:** does follow motion feel smooth/natural, or floaty/laggy/overshooting?
- **Framing:** is the initial tracked view a good "hero" shot, or too close/far?
- **Annotations:** do outlines land on the *right* thing? Are labels readable / well-placed /
  not overlapping? Does the hand-drawn style read well over photoreal tiles?
- **Voice:** does it mark things *as it talks* (not after), and confirm only what actually
  happened? Any command it misunderstood?
- **Anything that looks wrong, janky, or surprising** — screenshot it; that's the gold.

## If something looks off

- **Grey globe / slow tiles:** wait a few seconds after a camera flight; photoreal streams in.
- **A voice mark didn't land:** the place may not geocode — try a more specific name
  (e.g. "Palace of Fine Arts, San Francisco").
- **No planes:** OpenSky data may be momentarily sparse; scroll out or wait a poll cycle.
- **No GEV MIC button / voice errors:** `OPENAI_API_KEY` didn't load — use the console API for
  the annotation tests and skip the voice-only ones (§2).
