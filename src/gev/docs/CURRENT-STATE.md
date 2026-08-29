# God's Eye View Current State

Updated: August 24, 2026

> **2026-08-23 — first-run mission launcher** (`src/firstRunExperience.js`,
> `#first-run-launcher`, styles at the tail of `style.css`). After startup
> settles, a fresh session gets one card offering **Live Contacts · Space
> Missions · Environmental · Explore manually**. No layer and no optional API
> call happens until a tile is clicked. The right-hand DISPLAY rail
> (`pp-toggles`) now starts **collapsed** on a first run rather than expanded —
> a stored collapse state still wins, as before.
>
> **The ENVIRONMENTAL tile is quakes AND fires** — live USGS earthquakes plus
> NASA FIRMS active fires (`layerIds: ['earthquakes', 'local-firms']`), with the
> tile subcopy naming both. **The launcher optimizes for the fully configured
> experience:** it does not trim what it offers down
> to the lowest-configured install. The mission does not branch on whether a key
> is present — everyone gets the same tile.
>
> Keyless, the honest surface is the **layer row**, which reads
> `UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED`, and the earthquakes half
> still delivers in full. The shared loading reducer now treats an explicitly
> declared missing optional key as a configured terminal state rather than a
> failed multi-layer mission, so the global chip completes without showing
> `LOAD FAILED`. A genuine lifecycle or fetch failure still retains failure
> priority.
>
> **Acceptance changed with that ruling (2026-08-23).** `qa-firstrun` no longer
> asserts "a keyless Environmental never shows a failure chip" — that stopped
> being a launch requirement when the tile went back to promising both feeds.
> The Environmental section now **branches on the observed key state** and says
> which branch it took: KEYED asserts both datasets actually arrive and that no
> LOAD FAILED banner appears while the mission runs; KEYLESS asserts the
> layer-row honesty (`KEY REQUIRED`), the quakes half loading, and that the
> deliberate missing-key state never becomes a global failure.
>
> **An INFRASTRUCTURE tile is deliberately absent.** It was built, playtested,
> and cut: one click enabling `local-datacenters` + `local-dams` +
> `telegeography-submarine-cables` puts ~5,700 entities on a full-earth view and
> the frame rate goes with them. The layers are unchanged and still reachable by
> hand and by voice ("infrastructure mode" is still mapped). Do not re-add the
> tile before the bundled-infra globe-LOD declutter lands — that is the real
> fix, and it is post-launch work.
>
> **Show policy — it is NOT one-shot.** Precedence, highest first: a share link
> never sees it → `?welcome=0` suppresses → `?welcome=1` replays (past both
> suppressions, for demos/support) → the durable
> `localStorage['gev:first-run-mission:v1'] === 'suppressed'`, written **only**
> by the "Don't show this again" checkbox → the per-session
> `sessionStorage['gev:first-run-mission-session:v1'] === 'dismissed'`, written
> by **every** close path (mission, Explore, ESC). So it returns each fresh
> browser session until the visitor ticks the box; clearing storage un-ticks it,
> which is accepted. Both stores fail open — an unreadable store still shows the
> launcher rather than silently swallowing first launch.
>
> **What a mission may persist (do not "simplify" this).** Layer enablement is
> durable in this app (`gev:layer-state:v2`, written by
> `LayerStateCoordinator._commitExplicit` only for origin `user`/`voice`/`tool`).
> A mission enables **its own** layers at `origin: 'user'` — durable, exactly as
> clicking those rows is, because picking the mission *is* that choice. The two
> Context missions also expand the Context panel, as the visible tabs do; the
> globe missions open no panel. Everything else is off limits: detection
> mode/density, `gev:detection-allocation:v1`, 3D models, feather, and above all
> `_detectionUserOverridden` — setting that flag means "the operator hand-edited
> detection" and would silently disable the CRT/NVG/FLIR auto-preset contract for
> the session. The full table is a comment block in the module and is pinned by
> `src/firstRunExperience.test.mjs`.
>
> **Voice is instruction-only.** Both globe missions are expressible with
> shipped tools (`set_layer_visibility`'s enum already carries
> `local-datacenters`, `local-dams`, `telegeography-submarine-cables`,
> `local-firms`, `earthquakes`; `zoom_to_globe` supplies the camera), so
> `GEV_REALTIME_TOOLS` is **byte-identical to `main`** and pinned by sha256 in
> the unit suite. One instruction paragraph in `vite.config.js` teaches the
> phrase mapping; deleting it is the complete rollback.
>
> **ESC arbitration — three rules, do not collapse them into one.** (1) The
> launcher **yields**: a MutationObserver watches `body` for the surfaces that
> take the screen (`cockpit-mode`, `scene-playback-mode`, `recording-mode`,
> `ui-clean-view` — `EXCLUSIVE_SURFACE_CLASSES`, kept in step with the CSS hide
> rule by a unit pin), and session-dismisses rather than contesting the key; if
> one is already up at init it **waits** instead of appearing over it. (2) A
> surface can take the screen with **no class to watch** — the Cesium attribution
> lightbox is full-screen at `z-index: 200` against the card's `175`, which left
> the launcher measurable (`getClientRects()` non-empty) and buried, so ESC
> dismissed a card nobody could see and burned the session flag. `isTopmost()`
> therefore also **hit-tests the card's own centre** with `elementFromPoint`; any
> overlay, classed or not, disarms the handler. Every inconclusive answer counts
> as uncovered, so the guard can never be why ESC stops working. (3) A small
> control that claims only the **key** (a disclosure, a popover) is not something
> to yield to: whoever handles ESC first calls `preventDefault()` **and**
> `stopImmediatePropagation()`, and the launcher skips `defaultPrevented` events.
> `stopPropagation()` alone does **not** stop later listeners on the same
> `document` — that is exactly how the compact Radio disclosure made one key
> close the disclosure *and* dismiss the launcher.
>
> **Accepted:** a surface class that never clears means no launcher for that page
> load, with no timeout. None of the four classes is restored at startup, so an
> already-blocked init is an error path, while a long recording or clean-view
> session is ordinary — a "reveal anyway" timer would trade a benign no-show for
> the card punching through a recording in progress. The no-show is benign: the
> handler is inert, no session flag is written, the observer still reveals the
> card if the class clears, and it returns next session either way.
>
> **Blocked storage un-ticks the box.** "Don't show this again" is a claim about
> the future, so a refused `setItem` reverts the checkbox and says so in the
> status line instead of showing a saved preference that was never saved.
>
> Gates: `node scripts/qa-firstrun.mjs --url <app>` (in-app checks across eight
> independent sections) plus its `--teeth` negative control, which removes
> the launcher and requires EVERY launcher-dependent section to go red — it
> always exits non-zero, `1` meaning the control is healthy and `2` meaning it
> is not. Plus the unit pins above.

> **2026-08-08 — performance waves 1+2:** the app idles via an explicit render
> governor (`src/renderGovernor.js` — hold/release from every per-frame
> animator; discrete mutators call `governorRequestRender`). Any NEW
> per-frame visual animation MUST register a hold; any new discrete scene
> mutation MUST request a frame — `scripts/qa-perf.mjs` is the gate. The
> circular scope is an explicit canvas (`src/scopeMask.js`, DISPLAY-rail
> SCOPE toggle + FEATHER slider, hash keys `sc`/`scf`) — it is NOT the
> six zero-intensity style stages anymore (those are disabled; see the
> history note in `_initStages`). Hidden tabs stop the render loop.
> The scope's OUTSIDE terminus is **altitude-adaptive** (2026-08-17): 0.94
> at/above **10 Mm**, so
> faint stars survive in the corners of a TRUE full-globe view, fading quickly
> (smoothstep) to fully opaque by **7 Mm** — every working altitude below that
> is solid black, because there the same 6% bleed reads as smeared geometry.
> FEATHER is unaffected by the terminus ramp and there is NO new slider (its own
> default later moved 35 → 0 on 2026-08-22, 0 → 8 on 2026-08-23, and 8 → 11 at
> the 2026-08-24 final lock; see Current
> Global Post Defaults); hash key
> `sce` pins the terminus and is **clamped to 94..100 on BOTH parse and write**
> (out-of-range clamps into the band; absent or non-numeric = the adaptive
> default), so a shared link can neither freeze the ramp by accident nor carry
> an unsupported sub-94 terminus. Repaints are gated on a quantized 0.005 alpha
> step, so a full 20 Mm→ground descent costs 12 canvas repaints (the alpha span
> sets that, not the altitude span) and a parked camera costs zero. That
> quantization also means the PAINTED value plateaus at each end of the band:
> measured, the painted terminus stays 0.94 from the top of the band down to
> ~9.63 Mm (first step), and is solid black from ~7.37 Mm (last step) rather
> than exactly at the 10 Mm / 7 Mm clamp heights. SCOPE OFF costs less still:
> no height sampling and no canvas work after the single clear on the disable
> transition. The hard-crop (FEATHER 0) path honors the same terminus.

This is the current runtime/source-of-truth snapshot for the project.

> [!IMPORTANT]
> **Delta since the July-2 body below** (the detailed sections are still accurate
> for everything they describe; these landed after):
> - **"Never answered yet" is a THIRD state, distinct from empty (2026-08-23):**
>   `sourceState` in `src/data/militaryAwareness.js` treats a dependency that is
>   busy AND has never produced an answer (`loading === true && !lastUpdate`) as
>   unavailable, so the Contacts panel prints `?` and voice says "unknown". This
>   is deliberately NOT "busy": a source that has answered once keeps its real
>   count through every later refresh poll. It is a CONTRACT over the whole
>   dependency list rather than a fix for one layer, and the dependencies reach
>   it by different routes:
>   - **AIS vessels is its reachable producer.** `enable()`/`update()` both
>     resolve as soon as the first `/api/ais-live` poll answers, so the manager's
>     lifecycle settles to `enabled` — but until the server-side socket delivers
>     a position, `firstConnectPhase` stays `'loading'` and `getStats()` reports
>     `loading: true`, `lastUpdate: null`, count 0, and an UNDEFINED status.
>     Without the predicate that window prints an all-clear `0`.
>   - **Mapped installations never reaches that window.**
>     `militaryInstallations.enable()` is synchronous and the manager awaits
>     `update()`, which owns the first Overpass fetch, so the lifecycle stays
>     `enabling` for the whole fetch and the pre-existing `enabling` branch
>     covers it. Confirmed live on :4272 across a held 17 s first fetch (34
>     samples, `enabling` throughout, panel non-numeric) and across a failing
>     one. Its `status: 'idle'` is not what saves it — the lifecycle is; the
>     module has no `loading` status at all.
>
>   Any new dependency that can be slow must report `loading` and `lastUpdate`
>   honestly for the contract to hold, and must be pinned against the shape its
>   own module really returns — a fixture that invents a status the module cannot
>   emit guards nothing (that is exactly how a hole here survived a green suite).
> - **A held ground snap is dropped when measured ground contradicts it
>   (2026-08-23):** the WARM hold described below answers on DISTANCE travelled,
>   which is only a proxy for whether the value still describes the ground. A
>   contact can taxi ~200 m onto a different surface INSIDE the 250 m bound, and
>   since a miss preserves the hold, nothing would ever correct the burial. So
>   `heldSnapM` (`src/data/groundSnap.js`) also consults `cachedMeshFloor` at the
>   contact's CURRENT position: a measured floor more than
>   `HELD_SNAP_CONTRADICTION_M` (5 m) ABOVE the held value drops the hold and the
>   contact is COLD again, back to the floored 2D billboard. The rule is
>   ONE-SIDED on purpose — it targets BURIAL. A cell reading BELOW a real sample
>   is the floor chain's expected under-read (one-shot latch over ~111 m,
>   neighbours lean lowest, `displayFloorHeightM` only ever raises), not evidence
>   of anything, and a two-sided cut was disproved on the track rig by a planted
>   cell 66.7 m below a real sample at the same spot. Accepted residual, stated
>   with its condition: a DOWNHILL taxi floats, and the only correction on this
>   path is a SUCCESSFUL resample — nothing guarantees one. On the OSM fallback
>   `sampleHeight` misses forever, so the float persists for as long as the
>   contact stays inside the 250 m bound, with no timer beside it and no vertical
>   cap of its own beyond whatever the ground drops within that radius. It is
>   accepted because it errs UPWARD and stays visible. Three boundaries are
>   load-bearing — that one direction, MESH cells only
>   (`cachedGroundFloor`'s DEM fallback is a DIFFERENT surface; the skin/DEM
>   spread is what `MESH_FLOOR_BELOW/ABOVE_PRIOR_M` budget 15 m / 80 m for) and
>   the contact's OWN cell only (a neighbour ~111 m away may be a terminal roof —
>   `neighborFloorM` leans lowest for that reason — and must never be borrowed to
>   DISCARD a real measurement). Do not widen either without re-arguing both.
> - **The trail's acceptance bar is visual (2026-08-23):**
>   the trail terminates roughly BACK-CENTRE on the aircraft; MINOR hull overlap
>   is acceptable; there is no conspicuous top, bottom or lateral protrusion; it
>   is stable across headings; and a parked aircraft draws no moving head
>   segment. That is the bar a future change is judged against — NOT sub-metre
>   precision. The pins below are tighter than the bar on purpose, because a
>   measurable property is what a test can hold, but a pin's tolerance is not the
>   product requirement and tightening one is not an improvement to the picture.
>   Measured on live traffic at the shipped transform, the airliner anchor sits
>   24.09 m aft (70 % of the model's rendered envelope, so inside it), 2.22 m
>   below centre (6 %), and 2e-9 m off the centreline.
> - **The tracked trail attaches to REAL HULL, aft and below (2026-08-23):**
>   `MODEL_TRAIL_ANCHOR_NATIVE` (`src/data/modelVisualAnchor.js`) holds, per GLB
>   and in RAW glTF coordinates (see the transform-chain entry below), the point
>   of the hull's CENTRELINE PROFILE (its y = 0 slice) closest to the aft-belly
>   AABB corner. It is NOT the corner: a bounding-box corner is empty
>   space, 4.80 m off the nearest triangle on `airplane.glb` and 6.14 m on
>   `jet.glb`, so the trail ended in mid air beside the aircraft. The head segment
>   is drawn from a point behind the aircraft to this anchor, so the anchor must
>   stay aft (83–96 % of each aft extreme) or the segment enters at the tail and
>   stops inside the fuselage. `modelScale.test.mjs` reads the POSITION BUFFERS —
>   real vertices and triangles, because accessor min/max cannot tell a corner
>   from a surface — and re-derives on-hull, aft, lowest-at-its-station,
>   on-centreline, and the construction itself. Re-measure, never re-guess.
> - **The trail anchor rides CESIUM'S transform chain, not a hand-rolled one
>   (2026-08-23 regression fix):** `MODEL_TRAIL_ANCHOR_NATIVE` stores RAW
>   glTF coordinates and `modelAnchorWorld()` assembles
>   `modelMatrix × components.transform × axisCorrection` — the same chain
>   `ModelSceneGraph` renders with, built from Cesium's own exported
>   `Axis.Y_UP_TO_Z_UP` / `Axis.Z_UP_TO_X_UP` and the model instance's own root
>   transform. The anchors were previously PRE-CONVERTED by a single glTF
>   Y-up → Z-up step (`[x,y,z]` → `[x,−z,y]`) and multiplied straight by
>   `modelMatrix`; that is half the correction (the defaults also apply
>   `Z_UP_TO_X_UP`, the complete mapping being raw `[x,y,z]` → `[z,x,y]`), and an
>   aircraft's longitudinal axis is raw glTF X, so the aft offset landed on the
>   RENDERED model's LATERAL axis. `modelMatrix` carries the heading, so both
>   frames rotated together and the trail terminated a fuselage-length to one
>   SIDE, swapping sides with the course. Measured live in each aircraft's own
>   (aft, cross, up) frame: civil airliner (0.00, −81.47, −7.50) before,
>   (81.47, 0.00, −7.50) after; rotorcraft (0.00, −73.67, −16.33) →
>   (73.67, 0.00, −16.33). **Never pre-convert an anchor** — one transform,
>   Cesium's, or a second hand-maintained convention drifts again. The pin sweeps
>   headings 0/45/90/180/270/315 across every shipped asset plus a hovering
>   rotorcraft and asserts NO lateral component, and it derives its reference axes
>   from the ENU frame and the heading rather than through the function under
>   test: the first version routed them through `modelAnchorWorld` and passed
>   against the very bug it was written for, because a wrong transform rotates the
>   anchor and its reference frame together.
> - **A stationary contact draws no trail head, and the head end NEVER gives
>   (2026-08-23):** grounded tracking starts a trail unconditionally, and on a
>   contact that has not moved the last body point sits where the aircraft is — so
>   the head segment became a line from inside the model out to its own anchor,
>   through half the fuselage. `trailHeadStart()` decides where that segment
>   starts being drawn: nothing while the last body point is no further from the
>   model centre than the ANCHOR'S OWN STATION (every millimetre would be drawn
>   forward of the attachment point, into the fuselage — a parked contact sits at
>   exactly zero), the whole segment once it has cleared the model's rendered
>   ENVELOPE, and between them the drawn start slides along the segment so the
>   visible length grows CONTINUOUSLY from zero. Three earlier cuts are recorded
>   because their shape matters: testing segment LENGTH against the radius HID
>   real trail (58 m aft of `airplane.glb`'s 34.41 m envelope gives a 33.98 m
>   segment, suppressed, though ~23.6 m of it is open air); CLIPPING at the
>   envelope and keeping only what lay outside stopped a moving trail visibly
>   SHORT of the aircraft, since a bounding sphere encloses a lot of empty space
>   around a slender airframe; and a BOOLEAN containment test flashed 10.33 m of
>   trail on and off across 2 cm of travel at the boundary, and again on any fix
>   that fell back inside. The END is never cut — that end is the whole point.
>   `radiusM` carries `computedScale`, so the verdict is the same at every camera
>   distance, and any contact that has moved more than its own size (every
>   airborne one: 30 s of flight is kilometres) gets bit-identical geometry to the
>   containment rule this replaces.
> - **The AIR bracket alpha floor SCALES with the OUTSIDE slider (2026-08-23):**
>   `aircraftBracketAlphaFloor` (`src/data/detectionPolicy.js`) is piecewise
>   linear through 0 → 0, **the default → 0.35**, and 100 % → 1.0. The default
>   value reproduces the previously shipped flat 0.35 exactly at every keyhole
>   alpha, so the approved bracket look is unchanged; a flat floor made every
>   reachable stop below 35 % paint identically. `AIRCRAFT_BRACKET_FLOOR_ANCHOR`
>   mirrors `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` (kept Cesium-free on purpose), the
>   two are pinned together, and **the anchor MOVES WITH THE DEFAULT** — both are
>   `0.01` since the 2026-08-24 final lock (`0.03` on 08-23, `0.05` before). That pin is the
>   tripwire for a default move: the mapping is pinned to bracket BRIGHTNESS,
>   not slider position. The `detection-opacity-slider` `step` is **1** so low values are
>   reachable — the mapping was always continuous from 0, but at the
>   previous step of 5 the entire sub-default range was one stop wide. Both the
>   markup and the ordering of 1–5 % are pinned in `detectionPolicy.test.mjs`.
> - **A grounded contact HOLDS its floor through a terrain outage (2026-08-21):**
>   when the Re:Earth proxy fails, the floor cells a grounded contact stands on
>   never warm, and the un-clamped render height for a contact reporting no
>   altitude at all is the GEOID — ~150 m below the ground at an inland field.
>   Both steps now hold instead. At POLL time `geoidSurfaceLastResortM()`
>   (`src/data/renderAltitude.js`) withholds the geoid guess from any contact
>   that already has a `renderAltitudeM`, so the sentinel path holds that height;
>   the guess is reserved for a genuine first sighting. At DISPLAY time
>   `_heldDisplayFloorM()` (`src/data/flights.js`) answers with the contact's own
>   last resolved floor — valid within `HELD_FLOOR_MAX_DRIFT_KM` (1 km, one
>   rollout's worth of travel) of the cell that supplied it — and otherwise with
>   a resolved ADJACENT cell via `neighborFloorM()`, which takes the LOWEST of
>   at least `NEIGHBOR_FLOOR_MIN_SAMPLES` (2) resolved neighbours and otherwise
>   refuses. An earlier cut leaned HIGH, reasoning from "never below the visible
>   surface"; that principle is about a contact's OWN measured ground and it
>   inverts for a BORROWED cell, as playtesting confirmed — planes
>   floating at terminal gates. The errors are not symmetric: too LOW is inert
>   (`displayFloorHeightM` only ever raises, so an under-reading floor simply
>   does not lift, bounded by one cell of grade), while too HIGH invents a
>   position bounded by BUILDING height and a parked contact holds it — measured
>   at 29.5 m of permanent float from a lone roof neighbour. A plane at a gate is
>   on the apron, never on the roof. The honest residual is the mirror image: on
>   a genuine slope the lowest neighbour under-reads, so the clamp lifts a little
>   less than it could, which shows up as no lift rather than a wrong one and is
>   corrected as soon as the contact's own cell warms. Both tiers are validated
>   measurements out of the shared floor cache; with neither available the
>   position passes through untouched, exactly as before. Adjacent-cell probes
>   are throttled per contact (500 ms) and rationed no further: a probe is eight
>   synchronous `Map` reads with no I/O — every DEM request is driven by
>   `warmGroundFloor` from the poll loop, bounded there — and 200 synchronised
>   all-cold contacts probing on the same tick measure 1.0 ms median / 1.2 ms worst on the all-cold workload (a noisier ad-hoc run of the same workload peaked at 2.1 ms), 1.4% of one 80 ms
>   fleet tick (`scripts/qa-floorhold-probe-cost.mjs`). A global per-tick budget
>   with a fairness queue was built over that and DELETED: it protected single-
>   digit milliseconds and produced two starvation defects. Nothing can starve
>   because there is no shared resource to be starved of.
>   A floor that moves DOWN under a contact standing on a BORROWED one is
>   APPROACHED exponentially (`FLOOR_EASE_TAU_MS`, 360 ms — ~20% of the
>   remaining gap per fleet tick, hard-capped at `FLOOR_EASE_MAX_STEP` so a
>   delayed or stalled tick cannot close more) from the value currently displayed, rather than
>   interpolated from a fixed anchor over a fixed duration. The target moves: a
>   second, lower neighbour can warm mid-approach, and re-evaluating a fixed
>   anchor against a moved target jumps by the eased fraction of the change
>   (measured at 100 m in one tick). Approaching from the displayed value has no
>   such seam. Rises are always taken whole, including mid-approach, since an
>   eased rise is time spent under the mesh; a change between two resolved floors
>   keeps its existing timing. The hold state is retired the moment a contact
>   stops being a grounded billboard (airborne or model-owned), but the floor
>   itself is PARKED as a rehydration seed rather than destroyed: deleting it
>   outright let an `on_ground` flap through a rotation cold-start the contact
>   under the runway (observed with VIR138M at JFK). **A seed is a memory, not
>   a reading**, and three bounds keep it honest. `HELD_FLOOR_MAX_DRIFT_KM`
>   refuses it more than a kilometre from where it was measured.
>   `FLOOR_SEED_GRACE_MS` (90 s, three polls) expires it on wall-clock age,
>   judged BOTH while the contact is away and AGAIN at the moment it re-grounds —
>   a contact that makes no calls in between (off the poll on a cruise, outside
>   the corridor radius, tab hidden) never reaches the first check, and an
>   earlier cut that only had that one reused a floor parked 198 s earlier. And
>   the seed ranks BELOW the neighbour tier: two freshly resolved adjacent cells
>   overrule it, which is what stops a contact re-grounding half a kilometre
>   away from floating on the field it left (measured before that rule: a 200 m
>   seed held over a 100 m/105 m neighbourhood, 100 m in the air). So a short hop
>   back onto the same apron inside the grace window and the drift bound DOES
>   reuse its floor — deliberately, and only while nothing fresh contradicts it.
>   What starts clean is a genuine departure. A model→billboard handoff retires
>   and rehydrates by exactly the same rules. What none of this fixes is the flap
>   tick ITSELF: the display clamp passes airborne positions through by design
>   (an airborne height is the fix-time clamp's job), and at a sea-level field
>   the airborne fix IS baro + geoid N, ~4 m under the runway. That is an
>   accepted one-tick transition residual, and
>   `scripts/qa-floorhold-staircase.mjs` §F1 counts every tick so it stays
>   visible: 1 of 23 ticks below the runway, all of it that airborne tick, 0 of
>   22 grounded ticks — against 12 of 22 grounded and not recovering before the
>   seed existed. **A third tier that read the rendered mesh
>   where no DEM existed to validate it was built and REMOVED** — measured
>   against a real GPU with the proxy down, it recorded a coarse-LOD 20.6 m for
>   ground that is really ~122 m; `tilesLoaded` goes true while coarse tiles are
>   what is loaded, so without a DEM prior there is nothing to tell a surface
>   from a mis-hit. Gates: `scripts/qa-floorhold-mutations.mjs` (22 named
>   defects, each reverted individually and required to go red) and
>   `scripts/qa-floor-hold.mjs` (live, real GPU — the proxy is failed mid-run and
>   the contact is measured against `scene.sampleHeight`). This floor-hold path
>   currently applies to `flights.js`; `militaryFlights.js` does not use it.
> - **Screen picks are validated before conversion (2026-08-21):** anything that
>   comes back from `scene.pickPosition()` must clear
>   `isPickedWorldPosition()` (`src/data/scenePick.js`) before it is converted
>   to a Cartographic. The guard is a magnitude BAND — 6,000,000 m to
>   1,000,000,000 m, plus finite components — not a null check, because a depth
>   read over empty sky can return a Cartesian that Cesium mishandles three
>   different ways: non-finite throws `DeveloperError: normalized result is not
>   a number`, exactly `(0,0,0)` returns undefined, and a near-center value such
>   as `(500,0,0)` converts SILENTLY into a point 6,378 km underground that
>   reverse-geocodes as 0°, 0°. The floor sits ~346 km below the smallest real
>   surface magnitude (WGS84 polar radius 6,356,752 m); the ceiling is ~24×
>   geostationary, so no real contact is rejected. **A degenerate pick is a
>   MISSED pick:** the cascade in `getViewTargetCartesian()` and
>   `pickWorldFromScreen()` falls through to `pickEllipsoid` and then the globe
>   ray, and callers receive the same `null` they already handle for a miss —
>   there is no new sentinel. Two consumers had no owner for a throw and were
>   hardened to match: the moveEnd view-target prewarm runs inside
>   `requestIdleCallback` (now catches and reports once per viewer at
>   `console.debug`), and `IntelHUD._updateSummary()` awaits its context INSIDE
>   a guard, because every caller invokes it as `void this._updateSummary(...)`
>   and a rejection there is ownerless. Gate:
>   `scripts/qa-view-target-prewarm.mjs`.
> - **Scene playback ownership + reconcile (2026-08-20):** five corrections to
>   `src/scenes/director.js`, with the pure decisions in `src/scenes/scenePolicy.js`.
>   (1) A shot reconciles ONLY the layers it declares. The old walk forced every
>   undeclared layer off, so a recipe authored against the original four layers
>   tore down CCTV, vessels and fires with no restore pass. Operator captures
>   snapshot the whole registry, so those still reconcile in full.
>   (2) Playback claims the camera through `runImmediateNavigation('scene', …)`
>   instead of a bare `camera.flyTo`, so it releases the follow camera, respects
>   the navigation policy and lets Cockpit refuse before anything mutates.
>   (3) **Playback NEVER re-establishes tracking.** `SCENE_TRACKING_PARAM_KEYS`
>   (`selectedFlightsTrackingId`, `selectedMilitaryTrackingId`,
>   `selectedSatTrackingId`) are stripped on the way to the layer — a shot
>   captured while following a contact would otherwise hand the camera straight
>   back to the follow loop it was just taken from, recreating the two-writer
>   jitter. The keys stay in the STORED capture; only the apply path drops them.
>   A unit pin sweeps every layer's `getParams()` for the whole selection naming
>   family (`SCENE_SELECTION_PARAM_PATTERN` — `selected…`/`tracked…`, `…TrackingId`,
>   `…Mmsi`/`…Norad`/`…Icao`), and each match must be on the strip list or on
>   `SCENE_KEPT_SELECTION_PARAM_KEYS`; a name like `trackedVesselMmsi` therefore
>   cannot slip through by not matching the older spelling. CCTV's
>   `selectedCameraId` is the one recorded keep: it raises a monitor plane and
>   never writes `viewer.trackedEntity` or the camera.
>   (4) An **isolating Context mode is exited before a shot's layers apply**.
>   Space Missions refuses every enable outside its replay bundle, so with it
>   left dirty all five recipes were refused (or, for Orbital Watch, composed
>   over a replay they never declared). The verdict is read off the shared guard
>   (`contextLayerEnableBlockReason`), not a mode name, so a future isolating
>   mode is covered — the probe id `SCENE_EXCLUSIVITY_PROBE_LAYER_ID` is
>   reserved by a test against the real layer registry. The exit itself is the
>   ordinary `setContextMode('off')` exact-restore path and is deliberately NOT
>   abortable: leaving the mode IS the restore to the operator's pre-mode state,
>   and tearing that transaction in half would strand Context. A refused
>   `setEnabled` is surfaced in the status line and a `shot_layers_refused`
>   telemetry event instead of being reported as success. **Mixed accepted /
>   refused layers are reported honestly, not rolled back** — a shot whose
>   enables partly failed leaves the layers that did move in place.
>   (5) **Cancellation cancels the work, not just the next step.** Checking a
>   flag after an `await` only stops what has not started, so both awaited
>   operations are now themselves cancellable. Layers: the run/LOAD owns an
>   `AbortController` whose signal is passed to every `setEnabled`, and STOP,
>   supersession, and run teardown abort it — the data manager rolls an aborted
>   enable back through the module's own `disable()`, so no layer is left on
>   carrying stale params. Visuals: `styleManager.applyVisualState(state, {
>   isCurrent })` gates BOTH halves of the map-stack switch, which is its only
>   suspension point. The switch is a *mutation*, not just a wait, and
>   `mapStackController` invalidates a switch only when another `setStack()`
>   arrives — a winning state that omits `mapStack` (every normalized shot does)
>   never issues one, so a stale switch would otherwise stand on the globe.
>   So: an already-superseded caller never starts the switch, and one superseded
>   *during* it puts the globe back to the stack the winner inherited — but only
>   while `getSwitchGeneration()` shows no newer switch has claimed it, because
>   a newer switch is a live intent that must not be stomped. The shader-uniform
>   commit after the await keeps its own gate. Precisely: a stale LOAD's
>   *synchronous* prelude (style/bloom/HUD) can still have landed before it was
>   superseded, and is then overwritten by the newer state; what cannot survive
>   is its map stack, its uniform commit, its layers, or its camera flight.
>   Post-`await` flag checks remain as a backstop. Known remainder: run cleanup
>   still waits on a suspended
>   visual/map operation, because `setRecordingMode(false)` is not idempotent
>   (a second call restores HUD `auto` rather than the operator's saved mode) —
>   worst case is recording chrome staying up until the promise settles, which
>   then restores correctly.
> - **Ambient contact labels (2026-08-20):** detection callsign callouts paint
>   on the shared normal-blend world-overlay canvas as their own host lane
>   (`detection-callouts`) — NOT on the screen-blended sensor surface. `screen`
>   can only lighten, so a dark backing plate drawn there is a no-op over sunlit
>   ground and the text dissolves into the imagery. Brackets, the scanline wash
>   and the mode banner stay on the sensor surface; the callout lane registers
>   in the same `detection` slot, so callouts keep their z-position beneath every
>   ordinary overlay card and beneath the tracked readout. Plate fills come from
>   per-theme `calloutPlate` / `calloutPlateSpace` tokens (~63% / ~73% of the
>   tracked card's `CARD_PLATE_ALPHA`), resolved once per style change; space-tier
>   contacts take the heavier one. Rows are pooled, and an empty field must clear
>   the replay buffer or the final callsigns strand on the canvas. **Do not move
>   callouts back onto the sensor surface, and do not merge the plate tokens into
>   `labelBg`** — that token is the scanline wash and shifting it retunes the
>   sensor texture. Plates are additionally **backdrop-selective (2026-08-21)**:
>   `skyBackdropFactor()` (`src/data/iconOrientation.js`, exact scaled-space
>   ellipsoid silhouette) feathers the plate FILL ALPHA to `SKY_PLATE_SCALE`
>   (0.18×) for labels above the horizon — sky backdrops read as near-bare text,
>   terrain backdrops keep the full plate — across a smoothstep band of
>   `HORIZON_FEATHER_RAD` (~1.09°/side). Only the plate alpha feathers; text,
>   tier accents, leaders, brackets, and the tracked readout card are untouched.
>   **The test is TWO-REGIME, and only the first regime is a ray test
>   (2026-08-22).** Above the ellipsoid, `1` means the view ray genuinely misses
>   the planet and the function is the exact complement of the occluder. **At and
>   below the ellipsoid the horizon is EYE LEVEL** — the local geodetic
>   horizontal plane through the camera — and that is NOT a ray-miss test: from a
>   −18 m camera the ray to a contact 900 m up crosses the ellipsoid and still
>   reads sky, deliberately, because the ellipsoid it crosses is not a surface
>   anyone can see. It is reached by clamping the tangent cone's half-angle at
>   90°, the continuous limit of the same formula (the horizon dip goes to zero
>   at the surface), and is the convention Cesium's `EllipsoidalOccluder` already
>   uses there, so the two stay sign-consistent. This is not an edge case:
>   coastal airports sit at NEGATIVE ellipsoid height (JFK ramp ≈ −30 m, geoid
>   ≈ −34 m), so a ground-level cockpit is genuinely inside the ellipsoid and
>   **must not** be treated as degenerate — doing so put a full plate behind
>   every label on an empty sky. Fail-closed now covers only unanswerable input
>   (null, zero-length ray, non-finite camera, camera at the planet's centre).
>   Note the pairing: from such a camera the occluder culls every contact BELOW
>   eye level before detection sees it, so ground-backed labels only reappear
>   once the camera clears the ellipsoid. Rendered proof:
>   `scripts/qa-cockpit-plates.mjs`.
> - **Required attribution has two named keep-out rules (2026-08-20):** the
>   Google/Cesium credit line must stay visible in every state, and below 900px
>   two surfaces used to paint over it — the command dock's popover tray (any
>   width ≤900px) and the right context rail, which goes edge-to-edge below
>   720px and covered the credit with every dock panel closed. Both now yield;
>   the credit itself never moves, shrinks, or hides. **The clearance is not a
>   single constant:** `#command-dock` is anchored at `2vh` down to 721px and
>   re-anchors to a flat `8px` at 720px while `#cesium-credits` keeps its `2vh`
>   base, so anything reasoning "the 2vh terms cancel" is only true in the
>   721–900px band. `src/creditAttribution.test.mjs` is a **fail-closed** cascade
>   model: it flattens `style.css`, resolves each anchor by importance →
>   specificity → source order, evaluates a 14×11 viewport grid, and fails
>   loudly on any construct it cannot resolve (`!important`, `inset`/`margin`
>   shorthands, unvetted custom properties, unparsable or nested media queries,
>   or an unrecognized selector positioning one of these elements). Extend the
>   model rather than working around it — a silent skip here ships a ToS
>   violation.
> - **Dock tray stacking is decided by ID count (2026-08-20):** the pinned-tray
>   selectors `#command-dock.dock-has-two-pinned-trays …` carry one ID against
>   five classes, so any narrow-width override written with two IDs outranks
>   them and the upper tray silently loses `var(--dock-lower-pinned-height)`,
>   landing on its pinned sibling. The ≤900px and ≤720px overrides therefore
>   name the panel (`#location-bar` / `#control-panel`) to reach (2,5,0). Adding
>   a new tray rule means checking it against the pinned variants, not just
>   against the base rule.
> - **LOCATION mini-status is data-only today (2026-08-20):** the collapsed
>   readout now follows a free-text geocode search as well as preset pills
>   (`src/locationStatus.js` owns the copy for both), and every other camera
>   destination invalidates the searched label — `_stampNavigation` covers
>   voice/reset/takeover/selection, and scene playback calls the public
>   `clearSearchedLocation()` per shot. `#command-dock` still hides
>   `.location-mini-status` with `display: none !important`, so none of this is
>   on screen; a `display:none` subtree is also out of the accessibility tree,
>   so nothing is announced. Unhiding it is a separate product decision.
> - **The Street Traffic sync chip shows one percentage (2026-08-20):** the
>   settled confirmation flash carries the layer's coverage figure and NO
>   progress number. `reduceTrafficSyncFeedback` returns an empty
>   `progressText` once the sync lands and `#traffic-sync-progress:empty`
>   collapses the slot; the renderer writes the empty value rather than
>   guarding on truthiness, or the busy `...` strands beside the settled label.
> - **`#active-style-name` has exactly one writer (2026-08-20):** the style-name
>   mapping in `setStyle`. Location, search, and scene paths report where the
>   camera is through the LOCATION surfaces, never the style slot.
> - **Share-link selected-subject Follow (2026-08-20):** a copied v2 link adds
>   an ephemeral `at` epoch-seconds field; ordinary live hash updates omit it.
>   A shared Flights, Military Flights, or Satellites selection restores only
>   after the base destination camera, ordinary layer restoration, and a new
>   destination-scoped source refresh settle. The source module—not lifecycle
>   success or the UI—owns the final presence decision: Flights and Military
>   use the exact accepted snapshot, while Satellites waits for the applicable
>   dense catalog and treats a partial CelesTrak catalog as unable to prove
>   absence. A found subject starts the normal moving Follow at its current
>   position regardless of link age. An authoritatively missing subject is
>   `expired` only when copy age is strictly greater than 90 seconds for Flights,
>   45 seconds for Military, or 5 minutes for Satellites; equality, missing or
>   malformed time, and other non-found cases are unavailable. Feed/catalog
>   failure has its own feed-unavailable message. These warnings use the
>   universal top-center status banner and its standard failure dwell, beginning
>   only after the shared-view startup cover clears. If
>   teardown or disable invalidates an in-flight refresh, any selected-subject
>   restore waiting behind it settles as cancelled instead of remaining pending.
>   Terminal non-found cleanup compare-clears only the exact passive ID in memory and the live URL, never
>   recipient local storage. A newer explicit selection, visibility request,
>   destination, pointer gesture, wheel gesture, destroy, or source cancellation
>   wins and suppresses late Follow/status work without cancelling unrelated
>   shared layer visibility or options. Radio station selection remains outside
>   the share payload; Radio restores only its allowlisted filter and volume.
> - **AIS feed watchdog (2026-08-18):** feed liveness is judged by DATA, not
>   socket state — AISStream can complete the handshake and then deliver
>   nothing forever. `/api/ais-live` reports `live | stale | reconnecting |
>   down | auth-failed` (plus the unchanged `missing-key`/`unsupported`) with
>   `silentForMs`, `reconnectAttempt` and `nextAttemptAt`. Silence is REPORTED
>   at 120s and ACTED ON at 300s; recovery walks a 5s/15s/60s/300s ladder and
>   then stops at a terminal `down` with a slow 15-min retry running behind it
>   (a retry never flips the chip back to "connecting" — only real data clears
>   `down`). Liveness credit requires a frame that arrived on a still-owned
>   socket AND decoded into a real AIS record: handshakes, malformed frames and
>   error envelopes are never liveness, and orphan frames are dropped entirely.
>   Failures are CLASSIFIED — auth rejections (error envelope, HTTP 401/403)
>   are terminal with an hourly probe and an actionable chip, 429 honours
>   `Retry-After` and otherwise enters at the slowest rung, and only genuine
>   transport faults use the ladder; worst case is single-digit connection
>   attempts per hour in every class. Degraded states stay visible in the chip
>   even while cached vessels are still drawn.
>   **Locked invariants — do not "fix" these:** teardown is `ws.terminate()`,
>   never `close()` (the built-in WebSocket has no hard-abort and its `close()`
>   never completes against a black-holed peer, leaking the single per-key
>   connection); socket generations are monotonic for the module lifetime and
>   never reused across a dispose, and every socket-map mutation is
>   identity-checked (otherwise a pre-disposal close event orphans a
>   post-disposal socket and two connections race for the one slot); durations
>   use a monotonic clock, wall time only for display. Policy is a pure state
>   machine (`src/data/aisWatchdog.js`) returning actions; the socket lifecycle
>   is `src/data/aisStreamAdapter.js`, tested directly with mock sockets; the
>   transport assumption is pinned in `src/data/aisWatchdogTransport.test.mjs`.
> - **Honest live AIS health:** the vessel layer treats socket connection,
>   first message receipt, raw payload rows, and accepted vessel positions as
>   separate stages. Each enabled session owns one 30-second first-connect
>   grace: an open or connecting socket with no accepted position reads
>   `LOADING`, and polls do not restart that deadline. The first accepted
>   position ends the grace and establishes freshness; expiry, missing
>   credentials, rejected transport, or another definitive failure reads
>   `UNAVAILABLE`. Disable/re-enable starts a new isolated session. A socket
>   with no received message or no usable positions does not advance
>   `lastUpdate` or replace warm accepted vessels;
>   warm selection and trail state remain visible as stale/degraded. Late
>   responses from disabled, destroyed, or replaced layer requests cannot
>   mutate or finalize the current lifecycle. Layer stats expose transport
>   status, message time, and raw/accepted row counts for diagnosis.
> - **Vessel/fire camera transfer:** clicking an actionable AIS vessel sprite
>   or painted card selects that MMSI and requests one close oblique camera
>   transfer; re-clicking the selected vessel refocuses it. FIRMS detection
>   sprites and actionable detection cards do the same using a refetch-stable
>   identity that includes position, acquisition time, and source satellite.
>   Aggregate fire cells remain non-actionable. Painted actionable cards are
>   also mirrored into a named, focusable assistive-control list that exposes
>   selected state and announces focus only after the backing record accepts
>   activation. Global FIRMS cards reject far-side cells before
>   filling the bounded overlay cohort; the shared overlay still owns final
>   horizon culling. The UI validates world-focus
>   requests before releasing tracking, refuses Cockpit-owned moves before any
>   camera mutation, and releases follow owners before accepted flights.
>   Sibling-owned picks win without clearing the vessel/fire selection or
>   issuing a competing camera command. Deferred geocoding stamps intent but
>   retains the current owner until a valid destination resolves; immediately
>   before flight it rechecks shared navigation authority. Newer destinations,
>   voice `move_camera`, `fly_route`, overhead framing, strongest-fire focus,
>   vessel/aircraft/satellite tracking, reset, Cockpit entry, or teardown
>   make older work and its UI completion inert. Teardown removes immediate
>   camera-entry listeners before its first asynchronous restoration step and
>   refuses any new immediate or deferred navigation after disposal begins.
> - **Loading, reset, and Display completion:** every registered layer exposes
>   one normalized manager loading contract. Enable and disable feedback remains
>   lifecycle-authoritative, while manager-owned periodic updates publish
>   refreshing, failure, and recovery without replacing a producer's more
>   specific error or availability state. The shared presentation is delayed to
>   avoid flashes, visible outside the rails, and retained in
>   Cockpit. One continuous overlapping load interval retains the strongest
>   terminal outcome (`failed`, then `cancelled`, then `complete`) until every
>   participant settles, so a later success cannot mask an earlier failure.
>   A participating producer's terminal error, unavailable status, or
>   key-required state also outranks generic completion without requiring a
>   separate manager failure event; AIS first-connect expiry therefore ends as
>   `LOAD FAILED`, not `LOAD COMPLETE`.
>   Slow disable work is labeled as turning live data off rather than
>   as a completed load. Street Traffic's dedicated sync chip shows genuine
>   work and one bounded completion; steady TomTom coverage, including 0%, does
>   not keep it open. Mapped Installations reports its bounded camera-driven
>   requests to the same shared surface, but full-globe `zoom-in` guidance is
>   not presented as loading. Terminal completion, cancellation, and failure
>   labels are centered in that surface without an empty detail slot. The circular `RESET GLOBE` action sits beside the top-center share
>   control in map view; Cockpit hides the complete action group and provides a
>   cockpit-styled `RESET` beside `EXIT COCKPIT`. Both resets share one route
>   with the voice action, release continuous/POI/Cockpit/entity and
>   Space Mission camera ownership, and returns to the 18,000 km globe frame.
>   Reset preserves the selected Contact while invalidating delayed automatic
>   refocus work; the normal Context `FOCUS` action is the explicit route back
>   to that same flight or vessel after the globe view settles. Location
>   navigation uses the same selection-preserving camera
>   handoff once a city, landmark, coordinates, or search destination resolves;
>   failed searches leave the current camera owner untouched, and Context Focus
>   can return to the preserved Contact. Focus also restores the selected
>   aircraft's canonical follow frame after a manual zoom-away.
>   Visual presets retain the order Normal, CRT, NVG, FLIR, Anime, Noir, Snow.
>   Configurable preset selection—including same-style reselection—opens the
>   shared Parameters surface directly below Detection and scrolls it into
>   view; share-link restoration
>   does not force that disclosure. Presets remain in the map Display. The
>   shared Parameters surface moves into Cockpit Display for the session and
>   returns on exit, with slider values contained by the panel at its supported widths;
>   the bottom Visual Presets tray owns the MAP SOURCE label, centered status,
>   and four-tile source row. Its compact wing is a keyboard disclosure:
>   Enter/Space opens and focuses Map Source, Escape closes and returns focus,
>   and unavailable sources remain tabbable with their reason exposed. Expanded left-panel
>   headers use the same container-owned background treatment without changing
>   their collapsed launchers; a soft 28% cyan divider identifies expanded
>   titles on both side rails.
>   Cockpit portals HUD, Detection, the single shared Parameters surface, and
>   3D controls, but not the visual-preset grid. Parameters follow the active
>   Cockpit vision treatment and remain directly below Detection. Changing the
>   top vision style does not close an open Display or Radio utility; explicitly
>   opening Display still collapses Live Signals. Its left-side
>   Data Layers and Contact interactions do not collapse an expanded
>   Display or Radio utility. Presentation-only adaptive collapse is reconsidered after HUD
>   and viewport changes, while explicit collapse remains the only persisted
>   user intent.
>   Display orders 3D immediately above Celestial and Clean UI immediately
>   below it. The top-center action group places Clear Layers to the left of
>   Share and Reset Globe to the right. Clear Layers turns off the currently
>   selected manager-owned data layers, including an active Context choice,
>   while retaining visual, HUD, map, and panel settings. A disabled layer may
>   still release camera work that it owns through its normal teardown.
>   Direct Data Layers entry into Space Missions excludes the new mission ON
>   intent from its pre-entry snapshot. Its OFF control therefore leaves Space
>   Missions off and restores Satellites to their exact pre-entry visibility
>   and parameter state.
>   The title and loading logos use a blue 10 px outer-eye stroke with a
>   translucent slate fill, while the globe-and-cage gaze travels up to 34 SVG
>   units toward the pointer for clearer feedback at the compact title size.
> - **Context, Cockpit, and Radio interaction contract:** explicit Contacts,
>   Space Missions, and successful Cockpit actions reveal the Context panel, while
>   restoration and replay preserve its prior collapsed state. Contacts uses the
>   dedicated right-side chooser; the underlying Global Context coordinator is
>   registered for lifecycle and restoration but is not duplicated in Data Layers.
>   Inside Cockpit, the focused summary card is titled Contact in both visible
>   copy and its accessible control labels.
>   The top-center Cockpit vision cycle shows the inherited map preset name
>   (for example, `NOIR`) followed by CRT, NVG, FLIR, and NOIR. That inherited entry
>   leaves the selected map preset unchanged inside Cockpit. NONE is not offered
>   in the cycle; CRT, NVG, FLIR, and NOIR temporarily override that preset, while returning to it or exiting
>   Cockpit restores the captured map style and its exact shader intensities.
>   Selecting a Cockpit vision treatment with configurable parameters opens
>   Cockpit Display and reveals those parameters through the existing right-side
>   accordion; an inherited parameterless Normal preset does not force it open.
>   Expanded Cockpit Display uses a container-integrated header and soft 28% cyan divider
>   matching the expanded left-side panel treatment; its collapsed launcher
>   keeps the standalone glass surface and muted divider. Cockpit Display and
>   Radio use right-rail chevrons: left to expand and right to collapse.
>   Cockpit side surfaces use one expanded body per side: Display or Radio
>   collapses Live Signals and vice versa. When both utilities close, Live
>   Signals reopens unless the user explicitly collapsed it. Expansion notifications
>   fire only on a real collapsed-to-expanded transition, preventing repeated close
>   synchronization from re-entering the disclosure coordinator. Data Layers collapses
>   Contact, while expanding Contact returns that panel to its visible
>   launchers. Live viewport-height changes remeasure both utility lanes and
>   keep their collapsed launchers inside the obstacle-free corridor above
>   Contact and Live Signals. An expanded Data Layers panel is solved against the
>   viewport rather than the Cockpit cards: the CONTACT card and the peripheral
>   Intel HUD corners stop shortening its corridor while it is open, so it
>   unfurls downward from its collapsed launcher position and renders over them
>   (`#left-panel-stack` is z-index 147, above the Intel HUD readouts at 146 and
>   the Cockpit HUD at 145), scrolling internally when the layer list is longer than
>   the corridor. Cesium's credit line is never passable and still bounds the
>   corridor. Layer toggles stay live from there, and collapsing returns the
>   plain launcher. The map-only Clear, Share, and Reset Globe actions are hidden
>   for the duration of Cockpit, both as a group and as individual controls.
>   It uses the `radar` symbol and provides roving keyboard tab navigation. Its action row
>   places the single Cockpit entry before Search Nearby Sites. Cockpit removes
>   the duplicate floating map entry and topline exit; the bottom-center
>   `EXIT COCKPIT` control (offset downward by a `-95px` bottom margin) plus `Escape`/`C` own exit, with entry/exit focus
>   transfer and failure-safe shortcut routing. The exit control sits at the
>   bottom-center compass position. A Cockpit-only control strip sits
>   directly above Live Signals, anchored 12px under the REC readout it shares
>   the right margin with and clamped to keep 8px above the briefing card,
>   never rising past `max(96px, 12vh)`; Cockpit owns that anchor and
>   republishes it every layout tick (the left accordion no longer donates its
>   corridor). Its minimal Display popover exposes Intel HUD,
>   Detection, Parameters, and 3D aircraft. During Cockpit, those existing
>   standard Display controls move into the Cockpit popover and retain their normal
>   nested interaction: HUD plus Tactical/Operator/Minimal layout, Detection plus
>   Density/Allocation/Fade/Outside tuning, and 3D plus Proximity/All mode. The
>   same nodes and state return to the map Display on exit, so Cockpit does not
>   maintain a second control state. **Detection is owned by the CONTACTS
>   session, not by Cockpit** (validated 2026-08-18): activating Contacts
>   forces detection on at the shared military preset (`MILITARY_DETECTION_PRESET`
>   — Dense @ 75%, the same frozen object the CRT/NVG/FLIR styles apply), and it
>   then stays on for the whole session — cockpit enter, cockpit exit and
>   third-person tracking are moves WITHIN Contacts and do not touch detection at
>   all. A manual DETECT change during the session holds for the rest of it.
>   Deactivating Contacts restores the pre-Contacts state, except that a map
>   style chosen during the session keeps its own auto-enable preset (that rule
>   is younger than the entry snapshot). The trigger lives on
>   `_syncContactsDetection()`, called from `_syncContextModeButtons()` and gated
>   on `!_contextModeChanging` so it fires at transaction settle, never at click
>   — a failed activation cannot strand detection on. Policy in
>   `src/contactsDetectionPolicy.js`. Detection continues to show surrounding
>   aircraft in Cockpit while omitting only the active first-person subject's bracket;
>   handoffs move that suppression to the new subject and exit restores the
>   selected aircraft's map-view bracket. Remaining Cockpit bracket strokes render
>   at 45% of their normal presentation opacity to reduce visor clutter; callouts,
>   density, allocation, fade, and Outside tuning are unchanged and normal bracket
>   opacity returns on exit. AIR presentation follows the same retained 3D mode:
>   Proximity uses 150/185 km and All uses 400/450 km. With 3D off, in-range
>   contacts remain rotating 2D silhouettes; with 3D on, ready admitted models
>   take over under the Cockpit cap of 60. Loading/capped contacts remain 2D,
>   out-of-range contacts use rotation-free dots, and exit restores map treatment.
>   Its Radio popover exposes compact power,
>   transport, station, and volume controls. Cockpit Previous/Next preserves
>   selection, autoplay, and broadcaster fallback audio without starting the
>   map-view station flights that compete with the first-person camera. These
>   are a Cockpit-only accordion:
>   each static header uses the left accordion's label and divider with a dedicated
>   directional-chevron disclosure button and no full-row hover treatment. Only one
>   utility body expands at a time. On desktop, its collapsed sibling remains
>   visible whenever both controls fit above Live Signals; a constrained
>   corridor gives the expanded utility the full height and temporarily hides
>   that sibling, restoring it as soon as room returns. Collapsed Display
>   matches the collapsed Data Layers launcher width. Expanded Display uses the
>   standard map Display panel's 272 px width, glass shell, header surface, and
>   internal spacing. Radio retains its independent compact and expanded widths.
>   Display no longer follows the Data Layers corridor: that corridor is solved
>   against left-lane obstacles and has nothing to say about the right margin,
>   which dropped the strip into Live Signals below roughly 830 px of browser
>   height. Cockpit owns the strip's anchor and republishes it on every layout
>   tick — including the settling pass after HUD transitions and asynchronous
>   map-provider swaps — hanging it 12 px under the REC readout, clamping it up
>   to keep 8 px above Live Signals, and never letting it rise past
>   `max(96 px, 12vh)`. The utility height is measured from that resolved top
>   and floors on a launcher height rather than a fixed minimum, so expansion is
>   bounded to the real corridor below the Cockpit topline and above Live
>   Signals, including when a tall panel takes over the corridor. A hidden
>   sibling is also removed from the accessibility tree, and focus transfers to
>   the expanded utility if a layout transition hides the focused launcher. The
>   shared map Display, Radio detail,
>   ordinary Global Context, and Scenes surfaces stay hidden in Cockpit. Data
>   Layers remains available. Its Cockpit-only stack paints
>   above the curved speed and altitude rulers, matching the existing Context,
>   Signals, Display, and Radio surface ordering without changing map-view
>   stacking. Narrow mobile Cockpit
>   viewports suppress the legacy layer stack, peripheral HUD, and secondary
>   Context/briefing panes so the flight instruments and primary controls remain
>   unobstructed. Outside Cockpit, Radio starts collapsed while off. When Context
>   is collapsed, its Radio header icon opens compact controls whose explicit
>   Enable/Disable action owns power; stable close and full-panel buttons own
>   compact dismissal and one-way detailed expansion independently. When Context
>   is already expanded, that same icon skips the floating compact card, expands
>   the embedded Radio section, scrolls it into view, and moves keyboard focus to
>   its disclosure control. The detailed panel's normal accordion control owns
>   its collapse. Compact/detailed state and playback continuity remain shared.
>   Radio volume in the full, compact, and Cockpit surfaces, plus Space Mission
>   replay speed, use Display / Sharpen's muted 3px rail, circular cyan thumb,
>   glow, and mono value treatment. Their larger transparent hit areas, keyboard
>   focus indication, ranges, disabled states, and mission speed scale remain
>   control-specific.
>   Outside Cockpit, panel collapse state is independent. Multiple expanded
>   panels in either desktop lane share the measured viewport-safe corridor.
>   If a later panel would receive less than half its intrinsic height, the
>   layout presents it as a collapsed, accessible launcher without overwriting
>   the user's saved preference; the panel most recently opened by the user
>   keeps the lane, so an older expanded sibling yields when necessary. In a
>   constrained Tactical lane, later competing panels collapse to their
>   launchers even when they would narrowly exceed that threshold. While the
>   left lane remains constrained, every collapsed sibling launcher is hidden
>   and the primary panel uses the complete safe corridor; the launchers return
>   when that panel closes or the stack fits again. An expanded
>   Tactical Display claims the right lane and hides every collapsed CCTV and
>   Context sibling, including a layout-collapsed Context; those launchers
>   return when Display releases the lane. Display itself remains the single
>   scroll surface when a visual preset adds Parameters: those rows do not form
>   a nested scroll surface. The bottom Visual Presets MAP SOURCE row keeps the
>   `3D` status and four source tiles inside its padded tray; the row wraps
>   from one row to two at 620 px, and live viewport changes keep the complete
>   tray inside the screen.
>   Adaptive remeasurement preserves the user's
>   scroll position across Tactical, Minimal, and HUD Off layouts.
>   During an active Scene run, Clear Selected Layers and Reset Globe remain
>   hidden until playback stops or completes because the Scene transport owns
>   layer and camera sequencing for that interval.
>   The Cockpit Contact summary exposes Previous and Next contact navigation
>   plus its collapse control; it does not offer a Focus action because the
>   first-person Cockpit camera remains owned by the tracked aircraft.
>   A voice Cockpit request that retargets to a filtered civilian or military
>   contact carries voice selection authority through navigation, so the
>   aircraft entered is also the durable target used by Copy Link and reload.
>   Missing context values render as `—` with an accessible “Unavailable” name.
>   Because the panel hosts its own Previous/Next controls, the ONLY condition
>   that hides it is the absence of a context snapshot. Contact identity never
>   gates visibility — hiding on a non-aircraft subject stranded the operator
>   the moment Next landed on a vessel or an installation.
> - **Contact readout: foreign subjects and CONTACT LOST.** When the selected
>   contact is not the tracked aircraft (a vessel, an installation, another
>   aircraft), the panel stays up and keeps its label, cohort counts, nearest
>   contact, distance and evaluated time live. Only the nose-relative direction
>   arrow and BRG readout are dashed: those two are measured in the tracked
>   aircraft's own frame while the rest of that row is measured from the
>   selected contact, and rendering both live presents one mixed-frame reading
>   as a single measurement.
>   A contact that leaves its feed holds the panel in a `CONTACT LOST` state
>   (`data-state="lost"`, the same panel-level cue mechanism as `uncertain`,
>   in the amber the app already spends on unknown/stale inputs): the last
>   rendered values stay on screen rather than being recomputed against a
>   position that stopped updating, and Previous/Next stay operable so the
>   operator can step off. It fires on two paths, and both retain the snapshot:
>   an eviction-origin selection clear (`reason: 'evicted'` — the aged-out
>   branches in `flights.js` / `militaryFlights.js`, AIS pin exhaustion, and a
>   viewport refresh that drops a selected record), and a refresh whose
>   presence check comes back absent. A DELIBERATE clear (click-away, Escape,
>   voice stop, layer disable) still clears the subject and takes the panel
>   down; an untagged clear defaults to deliberate.
> - **Presence contract (`hasContact`).** `flights`, `militaryFlights` and
>   `aisLiveVessels` each expose `hasContact(id)`: `true`/`false` in O(1) from
>   the layer's own keyed map, or `null` when the layer holds no data and
>   therefore cannot answer (disabled, or not yet loaded). Presence consumers
>   MUST use it and must never infer absence from `getAllPositions`, which
>   stops at its cap — the live flights layer routinely carries ~11k contacts
>   against a 1,000-row cap, so "not in the returned rows" is not "gone".
>   `null` leaves the previous verdict untouched, so a silent layer can never
>   fabricate a CONTACT LOST cue.
> - **Compact data-attribution panel:** the complete Cesium credit inventory
>   remains available without taking over the viewport. Its expanded desktop
>   panel is capped at 70dvh/36rem, the wrapped 12px credit list scrolls inside
>   it, and narrow screens retain Cesium's full-screen surface with an internal
>   scroller. The title, close control, links, and persistent Google/Cesium line
>   remain unchanged and visible.
> - **Distant-aircraft recession:** both civilian and military billboard fleets
>   retain their locked class/ground scale and `NearFarScalar`, then multiply a
>   limb-relative taper in the existing ~12 Hz tick. The taper is 1 below 0.5×
>   geometric limb distance and smoothsteps to 0.45 scale plus a 0.35 alpha-haze
>   factor at the limb. That treatment eases continuously back to identity from
>   3,500–4,500 km camera height, avoiding a globe-view threshold pop. These
>   values, the start ratio, blend band, composed floor, and write epsilon remain
>   runtime tunings. No aircraft is count-culled or made fully transparent.
>   Focus emphasis and limb haze multiply at one deadband-gated write site, and
>   their product is clamped to 0.20 before freshness alpha is applied. Ambient
>   fleet models receive that same composed alpha; class/ground/cockpit repaints
>   preserve the current limb scale instead of dropping it for a tick.
> - **Focus-aware contact de-emphasis:** civilian/military aircraft and
>   satellites publish the selected target's padded screen bounds and camera
>   distance from the same per-frame position cache already consumed by their
>   tracked entity. Ambient flight sprites, AIS chevrons, CCTV icons, and
>   satellite points then ease their own alpha where they compete with that
>   target; no draw-order assumption participates. The always-visible rule is
>   narrowly amended rather than removed: emphasis never falls below 0.25,
>   contacts never blink or disappear, entry/exit use 6 px hysteresis, and
>   writes use a 0.005 alpha deadband. Defaults are 18 px padding, 300 ms attack,
>   600 ms release, an 8%-of-target-distance range hysteresis band, and
>   `nearerBehavior: 'allow'`; `dim` and `partial` remain runtime/evidence
>   tunings. Ambient overlap includes each sprite's own rendered extent. The
>   gated AIS, CCTV, and satellite passes retain an active-emphasis count so a
>   settled dim contact always completes its release after tracking ends.
> - **Terrain-height resilience:** `/api/terrain/heights` caches canonical
>   5-decimal points individually, reconstructs reordered/overlapping batches
>   in exact request order, and refreshes only missing or stale points. Network,
>   429, and 5xx failures receive bounded jittered retries with `Retry-After`;
>   stale real heights remain usable per point, while an uncached absent height
>   still returns 502 rather than becoming a fabricated ground value. Client
>   geoid fallbacks wait 60 seconds before retrying and self-heal to Re:Earth on
>   the first later successful fetch.
> - **Overpass cache admission:** `/api/overpass` parses and sanitizes requests,
>   then checks fresh memory, identical in-flight work, and fresh disk entries
>   before invoking its local 90/min limiter. Cache and single-flight responses
>   therefore do not spend quota; upstream-bound misses retain the existing
>   limiter, mirror, stale, and sanitization behavior.
> - **CCTV world-click focus:** clicking an in-world CCTV icon or ambient card
>   activates it and routes the camera flight through the panel FOCUS policy.
>   Aircraft/satellite tracking releases outside cockpit; cockpit retains the
>   view, keeps the CCTV activation, and surfaces the existing refusal toast.
>   Auto-hop and programmatic camera activation remain activation-only. CCTV
>   world clicks must stay within 6 px and 400 ms; drag-like or long gestures
>   are inert, and re-clicking the already active camera emits no focus request.
>   A clean empty-space click clears the active CCTV camera in place without
>   moving the view or disabling the layer. Sibling-layer picks and ADJUST-mode
>   interactions never trigger that clear. The resulting null selection remains
>   stable across rendering and updates; configured auto-hop is held until a
>   later explicit activation or AUTO HOP toggle-on.
> - **Tracked-flight close-range feel:** the existing 150 m camera floor is
>   unchanged, while the selected-only civilian and military model cap is now
>   200 px so minimum range reads as close. Pointer travel over 6 px suppresses
>   selection and empty-space untracking; duration over 400 ms suppresses only
>   untracking, so a stationary slow press on a plane still selects it. Escape
>   still releases tracking in place. The 200 px feel needs close-range field
>   verification; fleet model sizing remains unchanged.
> - **Deterministic sprite stacking:** contact collections reassert the stable
>   bottom-to-top order CCTV, FIRMS, bikeshare, AIS, military, then civilian
>   flights after every relevant layer init/enable and immediately after FIRMS
>   lazily registers its detection sprites. Always-visible contact
>   depth settings are unchanged. Cesium OIT weighted blending may soften strict
>   alpha layering on some GPUs, so the ordering remains a real-browser check.
> - **Deterministic card stacking:** CCTV, FIRMS, vessel, and tracked-target
>   cards use the shared world-overlay canvas. Detection paints through the
>   same host/frame contract onto one host-owned blend surface beneath that
>   canvas — parented into `#cesiumContainer` so its `screen` blend still
>   reaches the WebGL scene. The exact detection, ambient-label, ambient-track,
>   ambient-card, thumbnail, selected, and tracked lane sequence is binding;
>   the detection callback runs first and z-index preserves its shipped z5
>   position below the z6 cards.
> - **Cross-layer vessel ownership:** clicking a sibling-layer contact leaves
>   the active vessel card, HUD, context, and trail unchanged while the sibling
>   handles the pick, preventing two camera commands from one click. Starting entity tracking still clears vessel
>   inspection; AIS itself never sets `viewer.trackedEntity`. Own unkeyed or
>   evicted vessel-record picks and `gev-trail:*` remain no-ops. CCTV choices
>   made from the panel dropdown do not currently emit a cross-layer event and
>   therefore do not clear vessel inspection.
> - **World-overlay host and Phase 2–6 source migrations:**
>   `src/overlays/worldOverlay.js` owns one shared DPR-aware text/card canvas,
>   one detection blend surface, and one world-overlay post-render
>   scheduler. Both surfaces share the same sizing, clear, projection,
>   and teardown paths. The host includes bounded per-source/per-collision-domain
>   arbitration, horizon/viewport culling, shared keyhole fading, cached UI
>   exclusions, cockpit source gating, pooled hit
>   rectangles, and development diagnostics. **UI exclusion is a per-rectangle
>   PLACEMENT PREFERENCE over currently visible chrome — it clips no canvas and
>   vetoes no entry.** Rectangles are never coalesced into bounding unions
>   (that requirement existed only for even-odd canvas holes, and the host
>   punches none). Exclusion strength is decided per element by its EFFECTIVE
>   stacking level (the outermost positioned ancestor carrying a z-index, i.e.
>   the stacking context that competes with `#world-overlay-root`): chrome ABOVE
>   the host — map panels z90-1000, the dock, the cockpit windows inside
>   `#cockpit-hud` z145 — is a soft preference, so an entry with no
>   collision-free placement keeps its full placement set and simply renders
>   beneath that chrome. Chrome at or BELOW the host keeps an absolute veto:
>   `#intel-hud` is z2, under both host surfaces (detection z5, cards z6), so a
>   kept placement there would paint over HUD text. Placement runs two passes —
>   prefer variants clear of all chrome, else variants clear of the below-host
>   chrome, else drop the entry. Cockpit line art (rims, arcs, rails, toplines, readouts) is not
>   in the inventory at all: the AR-HUD model puts world-space content beneath
>   the cockpit's screen-space HUD by z-order. Its empty-host path performs no
>   post-setup layout reads or canvas work under resize/mutation noise; removed
>   entry records are pruned, and text measurement uses a host-lifetime,
>   1,024-entry LRU. Steady-state rendering reuses arbiter output, placement,
>   paint-item, and paint-rectangle storage; track display text is rebuilt only
>   when its title or detail changes. DOM mutations only flag exclusions dirty,
>   with selector/layout scans deferred until there is overlay paint work, and
>   host teardown severs pooled record/entry references before releasing every
>   pool. A custom paint-lane contract gives source-owned batched painters the
>   same DPR-sized context, per-frame view-projection matrix, ellipsoid
>   occluder, keyhole geometry, and cached UI rectangles without transferring
>   their selection policy into the host. Datacenters and Dams now publish card
>   entries into that host on their
>   existing 450 ms screen-grid cadence. Each source retains two deterministic
>   contenders per grid cell and publishes at most 160 entries. The legacy
>   700/900 winner ceilings are no longer the effective shipped caps; active
>   `ambient-card` source budgets sum to a bounded 1,150-card shared lane: two
>   96-card infrastructure budgets, FIRMS' shipped 18-card cohort, AIS's
>   existing configured 900-row absolute ceiling, and CCTV's shipped 40-card
>   ambient maximum. Runtime AIS demand still
>   derives from its shipped 118 px grid: 112 candidates at the 1600×900
>   allocation viewport and 170 at full HD; its existing 150 px greedy
>   separation usually admits fewer. The host owns final cross-source declutter
>   without letting source count grow beyond the pre-migration source bounds.
>   Cards use the infrastructure name plus available operator/capacity for
>   datacenters or river for dams. Their native Cesium points, stems, polygons,
>   selection/picking, terrain sampling, and enable/disable lifecycle remain in
>   `localGeojson.js`; it creates no native label graphics.
>   The bundled public-release snapshots omit contact-oriented fields and note
>   values containing email or phone identifiers. Runtime cards and entity
>   context do not depend on those fields; geometry, identity, name,
>   operator/capacity/river metadata, and ODbL attribution remain intact.
>   Stem position and
>   polyline properties are constant between initialization, camera `moveEnd`,
>   and successful near-surface ground samples rather than per-frame callbacks
>   or every 450 ms visibility pass. Unchanged or sub-0.5 m tips do not call
>   `setValue`, and each record alternates between two preallocated two-position
>   stem arrays so real tip changes notify Cesium without steady-state allocation.
>   Shared placement records retain the raw anchor plus one signed integer
>   leader offset; painters apply that offset without materializing four pairs
>   of computed doubles per entry. The arbiter's spread distances and compact
>   placement-availability masks live in pooled numeric buffers. Because solve
>   occupancy only grows, few-placement identities whose complete set is
>   blocked are dismissed once instead of being returned and re-spread; the
>   authoritative collision lookup remains the final semantic check. Protected
>   entries that cannot separate completely choose the placement with the least
>   total protected-rectangle overlap rather than stacking on the first option.
>   Cards use the host's shared keyhole fade and global detection fade/opacity
>   controls with no source-local edge constants; cached keyhole geometry is
>   invalidated by live tuning as well as canvas size, so Fade changes reach the
>   next frame. Outside opacity defaults to the shipped floor (5 % when this
>   landed; 1 % since the 2026-08-24 final lock, 3 % on 08-23). The
>   `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` change from 0 to 0.05 also affects
>   detection: callouts and brackets previously hard-culled outside the keyhole
>   now paint at the OUTSIDE default (1% since the 2026-08-24 final lock;
>   aircraft brackets hold the 0.35 readable floor) and consume ambient budget
>   viewport-wide under the same
>   fade-don't-cull principle; this remains pending visual review. Cards
>   also reproduce the former
>   `scaleByDistance` curve (1.0× at 250 km to 0.62× at 9,000 km).
>   Mapped Military Installations create no empty native labels; selected names
>   remain in the tracked readout. Submarine-cable labels moved into the shared
>   host on 2026-08-18 (Option 2, superseding the Phase-5 Option-1 native
>   exception): the same nearest-160 bounded cohort now publishes
>   `ambient-label` entries on a dirty sweep with exactly two dirty
>   conditions — camera `moveEnd` / layer enable / load completion, plus a
>   motion fallback that samples the camera at most once per 2 s and only
>   re-arms past 250 m of travel since the last swept position, so tracked
>   and orbit cameras (which never emit `moveEnd`) cannot starve the sweep
>   while a parked camera still costs zero. The former 500 ms timer path was
>   removed in the same-day perf round — timer-driven stem re-sizes rebuilt
>   the 2,629-instance batched stem primitive mid-motion. The 2,629 reference
>   stems are staticized constants (no per-frame `CallbackProperty`), and an
>   unchanged cohort is never republished so a parked camera stays
>   governor-idle at the source level.
>   The 2026-08-18
>   host fix extends that to the HOST level: chrome mutation observation is
>   scoped (body childList filtered to inventory-chrome add/remove;
>   per-occluder attribute observation element-only, no subtree) and the
>   right-rail allocator writes `--right-panel-allocated-height` only on real
>   change, so parked idle with ANY live overlay source measures 0 postRender
>   fires / 5 s — empty-scene control parity (pre-fix ~56-61; dams
>   cross-checked at 0). Genuine chrome changes (occluder add/remove,
>   own-attribute flips, resizes) still invalidate;
>   `qa-cables-overlay.mjs` gates idle at ≤6 / 5 s.
> - **Phase 6 detection consolidation:** `src/data/detection.js` retains its own
>   `LabelArbiter` instance and existing 125 ms solve cadence, density/altitude
>   budgets, layer quotas, Elastic/Weighted allocation, manual scalar matrix
>   projection, tier palette, batched bracket paths, callout painter,
>   acquire/keyhole fades, sparse focus ring, banner, scanlines, suspension, and
>   diagnostic object. It no longer creates or sizes a canvas, clears pixels,
>   builds a camera matrix or UI inventory, observes layout, or attaches a
>   render listener. The host creates and lifecycle-manages
>   `#world-overlay-detection-surface`, DPR-sizes it through the same frame path
>   as `#world-overlay-canvas`, and invokes detection against its
>   plain source-over context. Detection writes the exact shipped theme
>   `mixBlendMode` and `filter + drop-shadow(...)` strings to that provided
>   element, preserving scene-level CRT/NVG/FLIR glow and once-per-layer
>   filtering. The surface is host-owned but **parented into `#cesiumContainer`
>   at `z-index:5`**, not into `#world-overlay-root`: the root is a stacking
>   context (`z-index:6`), i.e. an isolated blending group, and a surface inside
>   it has its `mix-blend-mode: screen` silently discarded by the browser
>   instead of compositing against the WebGL scene. z-index (5 under the root's
>   6) keeps it beneath ambient-through-tracked host paint.
>   The >22 ms odd-frame relief valve is restored: the host does not clear the
>   detection surface on a held frame, while unrelated shared lanes repaint,
>   and `throttleSkipCount` remains a live diagnostic. Detection `data-*` fields
>   now live on `#world-overlay-canvas`, while the StyleManager diagnostic API
>   remains unchanged. Disable and suspension deactivate only the detection
>   lane, leaving unrelated host entries intact; teardown unregisters the lane
>   before the host is destroyed. The production-shaped allocation gate covers
>   5,000 visible Dense observations at 2,500 km under the unchanged 154
>   B/observation/frame ceiling. The host owns one world-overlay `postRender`
>   listener; the repository has five `postRender` listeners total (host,
>   celestial ring, annotations SVG, missions frame tick, and traffic).
> - **World-label accounting:** All intended label/card migrations use the
>   shared host. The former native `LabelGraphics` exception for cable reference
>   labels was retired on 2026-08-18; cable text may render over tile geometry,
>   so **zero native world-label creation sites remain**. The mission replay DOM vehicle, awareness
>   compass, annotation SVG callouts, and host-owned detection isolation target
>   are explicit exceptions; the awareness ring and cockpit contact pips are
>   non-text out-of-scope surfaces. Annotation callout text, geometry, leaders,
>   and behavior retain their tested presentation; a future annotation style
>   system is outside this phase. `src/overlays/worldOverlayTokens.js` is the single home for
>   shared world-overlay, CCTV-thumbnail, and detection-theme presentation
>   constants. Former source renderers own no canvas, DPR, or world-overlay
>   listener path; the duplicate detection rounded-rectangle helper and dead
>   tactical compatibility helpers are gone. No temporary dual-renderer flag
>   existed to remove. `activeCameraCardEnabled` remains a product
>   presentation control, and `_detectionUserOverridden` remains the documented
>   style-switch persistence state. Browser/GPU performance comparison remains
>   operator-side; the final accounting records only comparable population
>   reductions and deterministic Node allocation/solve measurements. Those
>   allocation gates are calibrated on Node.js 24.14.x; `package.json` permits
>   supported product runtimes on Node 24 or 26, while the allocation runner
>   separately enforces Node 24 for these two calibrated probes. Each probe
>   compiles synchronously and discards explicit-GC
>   transition chunks before applying the unchanged byte ceilings. The unit
>   runner executes ordinary test files with Node's default parallelism, then
>   runs only the two explicit-GC allocation microbenchmark files sequentially
>   and one at a time with `--expose-gc`, so unrelated tests cannot perturb their
>   calibrated budgets and each isolated test process has the same GC contract
>   as its measurement worker.
>   A worker spawn, exit, output, or availability failure is a failing gate, not
>   a passing skip.
> - **Phase 5 earthquake labels:** Earthquake disc ellipses and pickable
>   entities remain Cesium-native, but their magnitude text is now an
>   `ambient-label` source in the shared world-overlay host. The source formats
>   `M#.#` text and depth-band accent colors, publishes only the 96 largest
>   current events with stable id tie-breaking, and declares a 48-winner
>   ambient-label budget. Host keyhole fading, horizon culling, UI exclusion,
>   and final collision apply. Disable/destroy clear and hide the source; real
>   earthquake entities carry no native label graphic.
> - **Phase 5 bikeshare selection:** The selected station keeps its native cyan
>   point highlight, while its station name, availability counts, capacity, and
>   operational warnings now publish as one protected selected-lane host card.
>   The card reads the point's authoritative Cartesian directly, declares zero
>   ambient quota, and therefore cannot be evicted by ambient budgets. Shared
>   keyhole fading, horizon culling, UI exclusion, and selected-card paint
>   order apply. Clear, disable, and destroy remove the host entry; the selected
>   Cesium entity carries no label graphic.
> - **Phase 5 ISS and tracked-satellite labels:** The ISS path and large red
>   point remain native, while persistent `ISS` text is a one-entry moving
>   ambient-label host source. Its getter reads the already-propagated point
>   cache, preserving the 1 Hz fleet epoch and eliminating the former second ISS
>   propagation. Satellite tracking continues to publish exactly one protected
>   tracked-lane card through `gevLabelModel` and `_trackedDisplayCached`; the
>   tracked entity is point-only. Tracking ISS suppresses the ambient entry and
>   untracking restores it, preventing duplicate ISS text. Disable, orbit-text
>   preference changes, catalog rebuild, and destroy clear/hide the source.
> - **Phase 5 active CCTV projection label:** The active camera's monitor plane
>   remains native Cesium geometry, while its camera-name label is one protected
>   selected-lane host entry. The entry closes over the same cached
>   `positions.label` Cartesian updated whenever the plane geometry moves, so
>   label and plane retain a single placement authority. Only the active,
>   projection-visible camera publishes; hide, disable, runtime destruction,
>   and state clear remove the source. Monitor-plane entities carry no native
>   label graphic.
> - **Phase 5 tracked civil aircraft label:** A tracked flight's Cesium entity
>   is a billboard-only camera target with no native label. The flight source
>   retains callsign/registration fallback, flight-level/altitude, speed, stale
>   state, airline/type, and plausible-route formatting in `gevLabelModel`; the
>   one protected tracked-lane host card renders that complete model. Its
>   position getter reads only `_trackedDisplayCached`, the same authoritative
>   Cartesian already consumed by the tracked visual and camera, and never
>   advances dead reckoning from the host frame.
> - **Aircraft label convention (both flight layers, 2026-08-18):** every civil
>   and military label surface resolves **callsign → registration → icao24**
>   (`_contactLabel()` in `flights.js`; the same chain inline in
>   `militaryFlights.js`) — tracked readout, detection card, `getNearby`,
>   `getDetectableObjects`, `getAllPositions().label`, `getTrackedSubject`, the
>   analyst record, the Context subject/nearest list, the Cockpit signal list,
>   and the `track_entity` voice narration. Registration is aircraft IDENTITY,
>   not route, so unlike origin/destination it is **not** routePlausible-gated.
>   Identity stays `icao24` on every keyed surface (`getNearby().icao24`, the
>   detection `sourceId` declutter hashes, and the `id` that `trackById` and the
>   Context cohorts resolve) — only the displayed string follows the chain.
>   Because adsbdb enrichment can answer *after* selection, the Context subject
>   re-resolves its label each refresh (`resolveSubjectLabel()`) instead of
>   freezing the selection-time snapshot.
> - **Phase 5 tracked military aircraft label:** The military tracking entity
>   is likewise billboard-only and label-free. Its source-owned model retains
>   callsign/registration fallback, stale cue, aircraft type, registration,
>   operator, altitude, and speed, rendered as the sole protected tracked-lane
>   card with the amber military accent. Its getter reads only the military
>   `_trackedDisplayCached` publisher, keeping the host, visual, and camera on
>   one dead-reckoned frame sample.
> - **Phase 5b Space Mission labels:** Launch markers publish through a bounded
>   48-candidate / 24-winner ambient-label source. Selecting a mission clears
>   that overview and publishes its launch-site, stage re-entry, payload
>   position, and orbit annotations as protected selected-lane entries; every
>   source-formatted line and accent remains intact. Static entries reuse the
>   mission geometry Cartesians, the payload getter reads its per-frame live
>   cache, and catalog-backed orbit text reads the cache updated with the ring
>   matrix. Refresh, deselect, disable, and destroy replace or clear the real
>   sources. Mission Cesium entities carry no label graphics, and the shared
>   host replaces the former quadratic label overlap pass.
> - **Phase 5 cable depth-testing decision (2026-08-02, REVISED 2026-08-18 →
>   Option 2):** the 2026-08-02 ruling kept submarine-cable reference labels
>   native (`disableDepthTestDistance: 0`) as the sole approved world-label
>   exception so photorealistic tiles could occlude label text. On 2026-08-18
>   that exception was retired after performance measurement: the native
>   path evaluated 5,258 `CallbackProperty` channels per frame across 2,629
>   reference entities and re-batched a 160-label `LabelCollection` per sweep,
>   costing the layer ~9.5 ms/frame during camera motion (≈42 → ≈59 fps
>   measured headless at a mid-Atlantic orbit). Cable text is now a bounded
>   nearest-160 `ambient-label` host cohort (`telegeographySubmarineCables.js`
>   publishes on the dirty sweep — `moveEnd`/enable plus the 2 s/250 m motion
>   fallback for tracked and orbit cameras — skipping identical
>   cohorts); stems/points stay Cesium-native, depth-tested, and pickable, so
>   only TEXT lost tile occlusion — the same trade every other host label
>   already shipped: labels may render on top of tiles. The dedicated
>   `submarine-cables` allocation row gates
>   the new source at 17,015 B/frame median (106.3 B/candidate, Node 24)
>   under a 19,000 budget, and the all-live aggregate row was recalibrated
>   with the cable cohort folded in (164,711 B/frame median, 190.6
>   B/candidate, 182,000 budget); the intermediate phase rows keep their
>   historical pre-cable composition. `load()` carries a load-generation
>   ownership token (the militaryAwareness activationId pattern): a stale
>   aborted load bails after every await and never clears a successor's
>   lifecycle, so rapid toggle/destroy sequences cannot double-add data
>   sources.
>   The 639-candidate Phase-5b row (353 painted, 133,769 B/frame, 209.3
>   B/candidate) remains as an intermediate historical gate; as of the
>   2026-08-18 recalibration the all-live aggregate — every shared-host
>   source including Radio and the migrated cable cohort — is 864 candidates
>   / 398 painted at 164,711 B/frame (190.6 B/candidate) under a 182,000
>   budget. The image-inclusive ceiling remains attributable to CCTV, while
>   the isolated mission row measures 108.2 B/candidate/frame under the
>   shared 154 ceiling.
>   FIRMS severity/source formatting, its pre-existing 150 px greedy selector,
>   selected-fire semantics, and LOD distance limits stay in `firmsHeatmap.js`;
>   `firmsLabels.js` is formatting-only. FIRMS entries use the host's tactical
>   card painter, vertical above/below placement, severity top rule, shared UI
>   exclusion/clip, horizon culling, distance-alpha channel, and always-on
>   `edgeFade: 'keyhole'` policy. Selected fires are protected in the selected
>   lane and bypass both the 18-card ambient cohort and distance fade while
>   excluding ambient cards from their footprint. Disable and destroy clear
>   the source rather than leaving a stale host entry. This is not a
>   pixel-for-pixel port: global collision/UI avoidance can choose fewer cards,
>   host horizon culling is explicit, and ordinary map mode now retains the
>   shared Outside floor instead of bypassing edge fade through the former
>   cockpit/celestial gate.
> - **Vessel card ownership:** `aisLiveVessels.js` retains the 800 ms visibility
>   pass, 118 px one-winner grid, priority ranking, 150 px greedy separation,
>   type/detail formatting, and the AIS positions produced by its unchanged sea
>   datum path. It publishes ambient tactical cards and one protected selected
>   card into the host. `vesselLabels.js` is formatting/policy-only: no vessel
>   canvas, projection, paint loop, or post-render listener remains. Ambient
>   vessels share `ambient-card`; the selected entry paints in the selected lane,
>   bypasses the ambient cohort/distance fade, and its protected rectangle
>   excludes sibling ambient cards. Tracked readout still excludes AIS, avoiding
>   a duplicate card for the same selection. Disable and destroy clear the host
>   source. This is not a pixel-for-pixel port: shared cross-source collision,
>   UI exclusion, and horizon culling can admit fewer cards than the isolated
>   canvas, and the shared always-on keyhole policy now applies the shipped
>   Outside floor in ordinary map mode instead of using the interim active-mask
>   gate.
> - **Tracked-readout ownership:** `trackedReadout.js` is now a presentation-model
>   bridge only; it owns no canvas, projection, post-render listener, layout,
>   keyhole fade, or paint path. Civilian flights, military flights, satellites,
>   and mapped installations write explicit `gevLabelModel` objects and expose
>   `gevDisplayPosition` getters backed by their layer-owned frame/display cache.
>   Selected AIS vessels continue using the vessel source's protected selected
>   card, so they do not create a duplicate tracked readout. The host registers
>   the active readout in the protected tracked lane with a zero ambient quota;
>   protected semantics bypass that quota and reserve the painted footprint
>   against ambient cards. Moving sources never fall back to a fresh
>   `entity.position.getValue()` in post-render. Annotation fade queries the
>   host's actual `getOverlayPaintRect('tracked', trackedId)` after layout and
>   unions it with the tracked billboard extent. Untrack, context clear, and UI
>   destroy clear/hide the source. This is not a pixel-for-pixel port: placement
>   is host-rounded, cross-source/UI exclusion and horizon culling now apply,
>   accents are source-stable rather than detection-theme-derived, and the old
>   screen-coordinate deadband was removed in favor of the authoritative layer
>   frame cache.
>   Civilian and military poll reconciliation refreshes this model after fresh
>   kinematics and again when a missed poll enters the `STALE` grace period.
>   Satellite pre-render propagation refreshes its altitude line from the same
>   per-frame SGP4 sample used by the tracked dot and camera.
> - **CCTV thumbnail ownership:** `cctv.js` retains the 20/28/40 zoom selection,
>   40-card shipped maximum, 112 px source declutter, eviction grace, frame
>   fetching/cadence/retry, stable slot cache, last-success persistence, hover
>   pinning, and activation. `cctvCards.js` is now source policy plus pure
>   lifecycle helpers only; it owns no canvas, post-render subscription,
>   Cesium projection, layout solve, paint pass, or hit store. The shared host
>   paints its exact 96×54 thumbnail inside the 104×77 shipped chrome, applies
>   the same 1.0→0.45→0.35 altitude scale and 7,500→9,500 m fade, shared
>   keyhole fade, full UI exclusions, and tracked/protected footprint
>   exclusion. Ambient entries paint nothing before their first successful
>   frame; a user-pinned entry retains the documented immediate empty-chrome
>   exception, and later failures never clear the last successful frame. The
>   active camera is excluded from the 40-card ambient quota and has no host
>   card by default: its monitor plane is the active representation. The
>   product option `cctvLayer.setCardPresentationOptions({
>   activeCameraCardEnabled: true })` may publish it through the retained
>   protected path. CCTV leaders use the source cyan, remain vertical at the
>   camera anchor except for the off-card edge clamp, and counter-scale to one
>   CSS pixel through the altitude transform. Card hits come from
>   `hitTestWorldOverlay` after a
>   scene pick miss with no canonical scene-object ID. CCTV billboard ownership
>   is proven by the owning collection/object rather than a bare upstream ID,
>   so an independent sibling with a colliding ID still wins. As a completed,
>   narrowly extended ownership hardening step, property-bearing Entity picks
>   must also be the exact stored CCTV coverage/projection object; copying the
>   `cctvCameraId` property cannot impersonate a camera. Card hits pass through the
>   6 px / 400 ms gesture guard
>   before activation and the existing click-to-fly event. CCTV cards are not
>   sprite-focus-dimmed. Disable/destroy clear and hide the host source, stop
>   pacing, detach in-flight image handlers, and empty source caches.
> - **Cockpit left-panel chrome:** opening any left-stack panel fades the
>   overlapping left pitch-rail glyphs out. The separately right-anchored pitch
>   rail remains visible, and panel/context-card stacking is unchanged.
> - **Cockpit context stacking:** the context card renders above visor glass,
>   pitch/heading instruments, altitude/speed tapes, and the signal window.
>   Topline vision and exit controls retain the highest in-cockpit layer.
> - **Space Missions dependency shutdown:** disabling a mission dependency or
>   leaving the mode closes mission context and restores the exact pre-entry
>   Satellite enabled state and presentation parameters. Restored parameters
>   never re-show primitives while the Satellite layer is disabled.
> - **Flights 3D/cockpit hardening:** the destination-direction cue is an
>   inline SVG rather than a remotely loaded Material Icons ligature, so a
>   blocked or late font can no longer expand the literal word `navigation`
>   across the cockpit. The grounded `airplane.glb` belly offset is calibrated
>   to the current asset's measured Y-up bounds (`0.063` native units).
>   Contact Previous/Next and Live Signals aircraft handoffs now
>   re-seed the first-person camera anchor at the selected flight immediately;
>   bounded feed-correction smoothing remains scoped to the same aircraft.
>   When NEXT has no flight inside the normal 250 km Context window, it searches
>   both civilian and military feeds at successively doubled radii through
>   16,000 km and transfers the cockpit to the closest available aircraft.
>   Tracked cameras now share one ENU frame across Cesium and the close-range
>   guard: switches relocate to the new aircraft, zoom stops 150 m short of
>   crossing the target, and the icon/model, label, trail head, and camera are
>   prepared from the same frame. The guard frames once and then leaves
>   Cesium's EntityView as the sole continuous camera writer. The tracked
>   entity remains a pure position/billboard target with no unused aircraft
>   orientation input; 3D→2D handoffs seed the current screen-projected course,
>   course projection uses the camera's right/up basis so it remains valid
>   through the >180° rear half of a tracked orbit, and the host readout consumes
>   that same settled frame cache without a second dead-reckon. Selected
>   3D models are seeded at the tracked position before scene insertion and
>   update before scene preparation from one frame-cached sample, retain real-world scale at
>   ordinary ranges, cap at 200 px
>   when very close for a continuous 2D→3D handoff, and use a 40 px selected
>   model floor near the long-range 3D→2D cutoff so the glTF silhouette remains
>   comparable to the selected billboard; ambient model sizing is unchanged.
> - **Minimal HUD right rail:** constrained focus layout keeps the collapsed
>   CCTV and Context launchers visible and accessible while the expanded
>   Display panel scrolls inside an explicit remaining-height budget. The rail
>   reserves both launcher heights and inter-panel gaps without a self-reversing
>   layout measurement. Tactical HUD instead gives the expanded Display, CCTV,
>   or Context panel exclusive use of the rail and hides its collapsed siblings
>   until the active panel is collapsed.
> - **Context-flow hardening:** the cockpit left accordion stays below the HUD
>   inside its measured safe top/bottom lane. Global Context focus guards exist
>   only for the synchronous selection window, history survives same-layer
>   reselection, and NEXT availability uses the same UNKNOWN-cohort gate as the
>   navigation action. Contacts entry does not wait for unrelated serialized
>   layer teardown; Space Missions waits for every incompatible live/current
>   layer to settle off before replay data starts. A rejected teardown keeps
>   that layer authoritatively enabled, restores any siblings already stopped,
>   and aborts replay entry; the isolation
>   guard remains active until Rocket Launches finishes enabling. Manually enabling
>   another Data Layer is additive in both an active mode and the neutral shell:
>   it does not exit Context, and the added layer joins the pre-entry snapshot
>   when the session is eventually restored. Manually disabling a required mode
>   dependency still exits and restores that union.
>   While Space Missions is active, direct incompatible enables are refused
>   before initialization or polling and explain that the mode must be exited.
>   User entry alone owns the pre-entry snapshot; programmatic dependencies do
>   not replace it, and rapid re-entry snapshots the pending settled restore
>   target rather than partial manager state.
>   Contacts-mode entry chooses the nearest aircraft to the current camera from
>   one uncapped civilian-plus-military pool (military wins an exact distance
>   tie), then falls back to the nearest AIS vessel. An initially empty set gets
>   one retry on the next Awareness refresh tick rather than permanently losing
>   automatic acquisition. Clearing a manually selected subject cancels that
>   pending retry so an intentional deselection cannot acquire another contact.
>   NEXT keeps a cycle-scoped visited set separate from PREVIOUS history. Once
>   every current target is visited, it starts a deterministic new walk with the
>   current subject retained as visited instead of re-admitting all candidates
>   into a nearest-contact ping-pong. Expanded flight searches use the same reset
>   rule. Vessel focus uses a 3 km bounding sphere at entry and during cycling.
>   The user-facing mode is **CONTACTS**: it cycles the nearest contact of
>   whichever supported type is selected (civilian or military plane, AIS vessel,
>   or mapped installation). Satellites are explicitly outside the Awareness
>   navigation cohorts and retain their independent tracking UX. The cockpit
>   briefing opt-in is labeled `CYCLE OFF` / `CYCLE ON`, with state-specific help
>   that distinguishes page cycling from continuously refreshed live data. The
>   neutral standby summarizes both chooser modes, while the `CONTACTS` and cycle
>   controls keep their short visible state as the accessible name and expose
>   longer help only as a title.
> - **CCTV focus and teardown:** explicit camera choices still activate during
>   cockpit mode, but they retain aircraft tracking, suppress the view flight,
>   and ask the user to exit cockpit. Layer enable is activation-only when a
>   tracked entity or cockpit owns the view, with no flight or cockpit-exit toast.
>   Voice select/next/previous/nearest actions report when tracking or cockpit
>   refuses their requested flight without hiding the successful selection.
>   Camera deactivation and layer disable both clear temporary probe clamps;
>   disable re-arms the active record, re-enable restores nominal geometry without
>   probing, and the next real activation re-runs the obstruction probe. Disable
>   uses a direct hide sweep; obstruction hits retain the field-derived 12 m floor.
>   Geometry-drain progress notifications are coalesced to roughly 300 ms or ten
>   batches, whichever arrives first. Natural completion publishes its final
>   state; disable publishes the terminal state explicitly when it cancels a drain.
>   Coverage polylines are lazy: catalog init creates none, while enable in the
>   default COVERAGE ON mode materializes the active camera and visible neighbor
>   cohort (70 entities at the 14-camera cap). Activation always materializes the
>   selected frustum, including COVERAGE OFF when projection remains on.
>   Empty-space deselection removes the active projection and active-relative
>   coverage emphasis but preserves the layer, coverage mode, ambient cards,
>   catalog, panel settings, and viewer pose. With no active camera the panel
>   exposes no stale dropdown/FOCUS/calibration target; NEXT starts at the first
>   catalog entry and PREVIOUS starts at the last.
>   While aircraft tracking or cockpit mode owns the view, the geometry drain
>   rechecks ownership per batch and drops to two records every 250 ms. Enable
>   focus decisions conservatively combine pre- and post-await ownership.
> - Share-link camera restoration re-applies its settled pose and requests a
>   render after the flight completes, ensuring Google Photorealistic 3D Tiles
>   stream at a deep-link destination without requiring manual camera input.
> - **Reversible Context handoff:** enabling Global Context snapshots the exact
>   enabled-layer set and every runtime parameter it changes, then clears
>   unrelated active Data Layers. Mode switches, required-dependency disables, direct
>   disable, and teardown restore that pre-entry state before control leaves
>   Context. Directly switching between Flights and Space Missions remains
>   supported without losing the original snapshot. Contacts waits for the
>   dependency releases it owns before restoring that snapshot, so the first
>   Space Missions selection completes without a stale teardown superseding it.
> - **Space Mission horizon occlusion:** mission dots and hover reticles apply
>   their surface-anchor horizon state before Cesium draws or picks the frame,
>   while shared-host labels use the same hidden-globe horizon contract. Rear-side
>   markers therefore cannot remain from the prior camera frame, including in
>   request-on-demand photoreal views; the conservative limb margin remains.
>   Graphics that begin with Cesium's implicit visible default are enrolled in
>   that pass on their first frame rather than bypassing the cull.
>   Selecting a mission isolates its launch anchor until Show All / Deselect
>   or the panel close control clears the selection.
> - **Cockpit flight signals:** Live Signals shows the current and nearest
>   flight names as larger clickable controls. Selecting a name transfers the
>   active cockpit tracker to that flight; type and distance remain secondary
>   text without repetitive event-category headings.
> - **Ground-safe cockpit:** the first-person anchor and final camera position
>   are clamped to the shared mesh-first rendered-surface floor with 12 m of
>   clearance. In the photoreal stack, grounded entry keeps the existing safe
>   map camera until that rendered mesh cell resolves instead of trusting a
>   delayed/raw aircraft height as a temporary surface. Successful one-shot
>   model ground snaps populate the same shared mesh cache, and repeated
>   grounded source timestamps lift their stored history when the floor warms.
>   Landing and taxi tracks therefore cannot place the camera below terrain or
>   inside photoreal 3D Tiles.
> - **Display panel width:** across desktop HUD layouts, the expanded right-rail
>   Display panel uses a 272 px glass-backed surface; its collapsed tab and
>   narrow-screen layout retain their existing responsive widths.
> - **Cockpit rolling telemetry:** the central speed, heading, and altitude
>   values use per-digit vertical rolls when their displayed values change.
>   Increasing and decreasing values move in opposite directions, and heading
>   accounts for the 359°/000° wrap.
> - **Cockpit route cue:** when reliable destination coordinates are available,
>   the estimated-destination arrow occupies a fixed centered slot above the
>   lower telemetry, follows the apparent ground-plane perspective, and rotates
>   to show relative bearing within a legible ±120° steering range. Flights
>   without destination enrichment omit the cue.
> - The skylight feature set and six field-test hardening rounds shipped
>   2026-07-03; **CCTV v2** shipped 2026-07-04.
>   Voice tools are **28**. Global Context can be entered or exited directly,
>   and Cockpit voice control supports status, entry from a selected or tracked
>   aircraft (establishing Contacts first), exit, and filtered Previous/Next navigation through the full
>   nearby-contact cohort. Contacts exposes source-honest counts inside its
>   250 km subject window.
> - **Height-datum system (2026-07-08):** Caltrans + TfL camera packs (~900
>   cameras) and the height-datum work fix entity heights on the
>   ellipsoidal globe end-to-end (geoid module, keyless Re:Earth terrain for the
>   OSM stack, ground-floor system with rendered-mesh sampling, always-visible
>   sprites/trails, OpenSky credit governor). The 2026-07-08 CHANGELOG entry
>   records the subsystem's architecture, invariants, residuals, and verification.
> - **Height-datum test surface:** `npm test` 184 unit · `npm run
>   test:track` 43 tracking invariants · headless QA harnesses under
>   `scripts/qa-*.mjs` incl. `qa-height-datum.mjs` (numeric heights) and
>   `qa-floor-verify.mjs` (any-airport ground-truth oracle).
> - **2026-08-19 — display-time ground floor (flights layer).** A grounded
>   contact's render height is picked once per poll from the floor of its FIX
>   cell, but what renders is the dead-reckoned position, which drifts across
>   cells for the whole segment and for hundreds of metres while a contact
>   coasts on a stale feed. On a graded apron that buried sprites under the
>   mesh (measured −15.5 m at KAUS; `qa-floor-verify` reported FAIL). The fleet
>   pass and the tracked display path now re-floor the DISPLAYED coordinate
>   against `cachedGroundFloor` — read-only, grounded contacts only, and never
>   while a 3D model owns the visual (T7 ground-snap one-shot). The poll's floor
>   warm/sample batch additionally collects each grounded contact's display
>   CORRIDOR (the ground it is about to cross — toward its newest fix while
>   interpolating, along its course while coasting), need-ranked and deduped so
>   parked contacts never crowd out moving ones. Budget is charged only for cells
>   with no floor yet — warm cells are still emitted, because the mesh sampler
>   must see a cell again once its DEM prior lands — which gives a service bound
>   that falls out of the policy: every contact is served within
>   `ceil(contacts / budget)` polls. Sample spacing along a projected arc derives
>   from its length (never a fixed count, whose spacing widens with speed), and
>   the cell walk steps at an eighth of a cell, so any cell the path occupies for
>   ~14 m of ground or more is collected. The corridor
>   integrates the SAME constant-rate turn the dead-reckon does, so a
>   sustained-turn taxi warms its arc rather than a straight tangent. Visual
>   ownership — not model existence — decides when the clamp stands aside: a model
>   owns the visual only while it is actually RENDERING (`ready && show`, the
>   pair the billboard handoff itself consults), and the tracked path also
>   requires `_trackedModelRegimeActive()`. So neither a retained-but-hidden
>   model (3D off, zoomed out, cockpit) nor one still loading suppresses
>   flooring while the billboard is what the user sees. **The visual/data split is deliberate**: visual
>   consumers are floored at the per-frame cache, while `_describeFlight` — and
>   so `findByQuery`, `getTrackedInfo`, `getTrackedSubject` — keeps reporting
>   sensor truth (barometric `altitudeM`, fix-time `renderAltitudeM`), because a
>   query or an altimeter should answer what the aircraft reported, not where its
>   icon was nudged to clear the tiles. Residual, unchanged by this
>   work: the floor is a ~111 m cell, so intra-cell relief (terminals, jet
>   bridges) and contacts moving faster than the 30 s warm batch can still read
>   metres low. `qa-floor-verify.mjs` now **exits non-zero on FAIL** (1 = FAIL,
>   2 = INCONCLUSIVE); it previously exited 0 on every verdict, which is how the
>   burial stayed invisible. It also honours `QA_BASE_URL` and puppeteer's
>   pinned Chrome-for-Testing, like the other harnesses.
> - **2026-07-16:** the FIRMS Active Fires layer is **LIVE** —
>   the bundled 2026-05-25 snapshot (58 MB) is deleted; a new `/api/firms` proxy
>   (vite.config.js) merges VIIRS NOAA-20/NOAA-21/Suomi-NPP NRT world CSVs
>   (days=2 → trailing-24h clamp, 30 min memory+disk cache, single-flight,
>   serve-stale-on-failure) behind server-side `FIRMS_MAP_KEY` (keyless → 503 +
>   in-app KEY REQUIRED chip). Client polls 10 min (`src/data/firmsHeatmap.js`;
>   adapter `src/data/firmsAdapt.js`, CSV parser `src/data/firmsCsv.js`).
>   `/api/firms/status` reports cache age + MAP_KEY transaction usage.
> - **2026-07-16:** Traffic supports optional live
>   TomTom flow through the server-side, budget-governed `/api/tomtom` proxy;
>   keyless installs retain the byte-identical white-dot simulation.
> - **2026-07-22 (CCTV v3 Parts A+B):** replay, color-coded viewsheds,
>   save-gated direct-manipulation calibration, `viewshed`/`adjust` voice
>   actions, shared-floor E/N drag grounding, and bounded snapshot requests are
>   integrated. Citywide static-plane LOD/pacing work remains outside runtime.

> **2026-07-02 milestone:** the skylight aircraft/satellite/enrichment work and
> pre-ship hardening fixes landed.
> Runtime changes reflected below: **voice tools 17→20 at the 2026-07-02 milestone** (`next_iss_pass` + the 19 already on
> main), type-aware 8-class aircraft sprites + path-derived rate-limited display heading, adsbdb
> flight enrichment (cached proxy + route-plausibility gate), disk-cached CelesTrak TLE proxy,
> ISS pass prediction, and per-layer data attribution. Gate at close: unit 98/98, build clean,
> track 19/19, + five QA harnesses (heading 16/16, sprites 9/9, cctv 5/5, failstate 5/5,
> attribution 18/18). New modules: `src/data/{motionModel,aircraftMeta,aircraftClass,aircraftIcons,issPass,routePlausible,dataCredits}.js`.
> The live runtime now declares 28 voice tools; the 17→20 count above is retained only as milestone history.

## Canonical Docs Order

Use docs in this order when details conflict:

1. `docs/CURRENT-STATE.md` (this file)
2. `docs/opensky-auth.md` (OpenSky authentication)
3. `CHANGELOG.md` (release history)

Historical planning documents may not match runtime behavior.

## Current Baseline

- Repository metadata and public URLs use the `bilawalsidhu/gods-eye-view`
  project identity. Runtime behavior is defined by this document and the current
  source tree rather than historical branch notes.

## Runtime Stack

- Vite + CesiumJS app with Google Photorealistic 3D Tiles
- Scene/HUD/style systems in `src/ui.js` and `src/hud.js`
- Layer management in `src/data/manager.js`
- Map stack switching in `src/mapStackController.js`
- Voice control in `src/voice/` (OpenAI Realtime over WebRTC)
- Voice map whiteboard annotations in `src/annotations/`
- 3D aircraft/model tracking surfaces in `src/data/flights.js` and `src/data/militaryFlights.js`
- Detection overlay and tracked-target readout in `src/data/detection.js`, `src/data/detectionDraw.js`, and `src/data/trackedReadout.js`
- Proxy middleware and API wiring in `vite.config.js`

### Active Data Layers in Runtime

Qualified Radio playback requests—category, station, country, coordinates, or
nearby place—always use station selection. Unqualified “turn on/start the radio”
requests use Play; a qualified Play-shaped tool call is normalized to Select so
its criteria cannot be silently ignored.

| Layer | Source | File | Proxy | Update Interval |
|-------|--------|------|-------|-----------------|
| Live Flights ✈️ | OpenSky Network; bounded adsb.lol regional fallback | `src/data/flights.js` | `/api/opensky` (OAuth + fallback) | 30s |
| Military Flights 🎖️ | adsb.lol /v2/mil | `src/data/militaryFlights.js` | `/api/adsblol/mil` | 15s |
| Live AIS Vessels 🚢 | AISStream websocket | `src/data/aisLiveVessels.js` | `/api/ais-live` | 60s (+800ms visibility pass) |
| Mapped Installations ⌖ | OpenStreetMap mapped context; on-demand Google Maps Places supplement | `src/data/militaryInstallations.js` | `/api/military-installations`, `/api/google/text-search` | viewport-driven + user search; while unavailable, auto-retry 30 s → 240 s backoff |
| Earthquakes | USGS | `src/data/earthquakes.js` | — | 60s |
| Satellites | CelesTrak | `src/data/satellites.js` | `/api/celestrak` | 120s |
| Space Missions (30d) | Launch Library 2 + CelesTrak | `src/data/rocketLaunches.js` | `/api/launches` + `/api/celestrak/active` | 5 min |
| Traffic | OSM Overpass (+ optional TomTom live flow) | `src/data/traffic.js` | `/api/overpass` + `/api/tomtom` | viewport-driven |
| CCTV | Austin + Caltrans (CA) + TfL London Open Data + Street View fallback | `src/data/cctv.js` | `/api/cctv` | 10s (active) |
| Radio | Radio Browser (public-domain station directory) | `src/data/radio.js` | `/api/radio/stations`, `/api/radio/click/:uuid` | 45 min directory refresh |
| Bikeshare 🚲 | GBFS (Lyft + BCycle) | `src/data/bikeshare.js` | `/api/gbfs` | 60s |
| Datacenters ▣ | OSM extract (bundled) | `src/data/localLayers.js` | — | static |
| Dams ▰ | OpenInfraMap/OSM extract (bundled) | `src/data/localLayers.js` | — | static |
| Submarine Cables ◠ | TeleGeography public map (bundled) | `src/data/telegeographySubmarineCables.js` | — | static |
| FIRMS Active Fires ▲ | NASA FIRMS live (VIIRS ×3 NRT, trailing 24h) | `src/data/firmsHeatmap.js` | `/api/firms` (`FIRMS_MAP_KEY`) | 10 min (proxy TTL 30 min) |

`src/data/militaryAwareness.js` remains registered internally as the Contacts
coordinator, but it is not a user-visible Data Layers entry. Its visible entry
point is the right-side `CONTEXT` chooser's `CONTACTS` mode.

At global scale, ambient Radio cluster badges are hard-opacity shared-host
entries: count/category updates and identity replacement do not run keyhole or
enter/exit ramps. Shared collision, viewport rejection, allocation, and horizon
culling can still remove an invalid placement, and Cesium still owns the cluster
point geometry and picks. Their 50,000 km line-of-sight range covers the
supported full-globe camera above 24,000 km, including farther horizon clusters.
Unclustered visible stations publish nearest-first ambient labels through that
same host, capped at 16 labels globally, 32 at intermediate zoom, and 48 nearby;
cluster and singleton candidates still share the Radio source's 64-entry ambient
cohort. Cesium continues to own each 13 px station point, horizon visibility,
and direct/nearby picking. Native points and shared-host text use one 50,000 km
interaction limit, so a painted singleton or cluster label always retains a
pickable point at its anchor throughout the supported high-global view. No
Radio entity uses native Cesium label text.

Delivery constraint: PR #10 is stack-only and unsafe standalone. PR #11 owns
the required Radio lifecycle/authority repair, so PR #10 must not merge or ship
unless PR #11 is included in the delivered stack.
Selected and singleton globe labels use the same compact 30-character
presentation: a credible explicit or leading-decimal frequency is rendered
first (`93.9 FM — Station`), otherwise the station name is ellipsized. Full
upstream names remain unchanged in the directory, player, and search state.
Fresh Radio sessions open on All stations while enable and restoration remain
silent. Directory refreshes retain cluster overlay identity for unchanged
represented membership and discard only identities containing removed stations.
When the user explicitly clicks Enable inside the expanded Radio section, the
Context panel performs one internal post-render scroll to reveal the station
filter and primary transport together without moving keyboard focus, the page,
or the globe. Compact controls, voice/tools, restoration, Data Layers, and
programmatic activation do not trigger this reveal.

Radio directory admission is atomic on both sides of the proxy boundary. A
refresh is healthy only when it reaches the minimum accepted-query and station
coverage; schema-valid responses with zero normalized stations count as failed
queries rather than inflating refresh health. Each specialist query also needs
an accepted station whose normalized tags match that requested category; rows
tagged only for another category remain usable catalog data but do not earn
specialist health credit. A partial cold result remains
usable but is explicitly `DEGRADED` and has no accepted catalog generation, while a
partial or malformed refresh cannot replace a warm catalog. The client likewise
rejects stale/future freshness metadata, incomplete rows, and empty catalogs as
a whole, preserving its last usable stations with `STALE`/`DEGRADED` state.
Every healthy admission publishes a monotonically increasing generation scoped
to a restart-stable `catalogInstance` token (a new server process starts a
fresh sequence — never read as a repeat or a regression) with a deeply
immutable station snapshot; stale/degraded warm responses retain the same
generation so tuner and cluster consumers can preserve exact station identity.
Generation semantics assume the app's actual single-process dev-server
deployment; concurrent replicas behind one origin are out of scope.
The client snapshot contains only the normalized station-field allowlist,
preserves object identity for an idempotent repeat of the same generation, and
degrades without replacement if a fresh response presents an older generation.
Snapshot records mark community metadata as untrusted, and Radio tool results
omit station names so directory text never becomes model instruction context.
One bounded country parser maps recognized ISO codes and English/common names
through proxy metadata and final station selection, while malformed, non-ISO,
control-containing, and oversized inputs fail closed. Literal or resolved
non-global IPv4/IPv6 targets are refused. Destroy fully releases the Radio audio
session, voice ducking/restoration, request state, filter, selection, volume,
accepted snapshot, and feed telemetry before re-initialization; monotonic
ownership tokens plus the session boundary keep late callbacks from a retired
session inert.
A tuner drag resolves previews against the single accepted snapshot captured at
pointer-down, even while a newer catalog is admitted. Release starts playback
only when the current same-ID record still exactly matches the frozen
presentation and stream metadata; removal or replacement reports the channel as
unavailable and never silently retargets the drag. A cold degraded fallback may
still populate the directory and globe, but its null accepted generation cannot
populate or begin the tuner.

Context entry and exit consider both rejected lifecycle promises and resolved
`false` manager results to be transaction failures. Entry awaits isolation and
restores the exact prior layer snapshot when isolation or activation fails;
when a direct Context shell fails after lifecycle work starts, reconciliation
waits outside the manager notification until that shell's queue settles, then
restores the complete snapshot rather than treating the in-flight layer as an
exclusion. An uncertain shell is retried and incomplete cleanup retains the
snapshot for a later restore. Direct-shell isolation and its compensating
rollback share one operation-scoped notification token, so an inner lifecycle
failure cannot announce separately from the outer blocked action. Context exit
waits for every sibling transition, retains the exact pending snapshot
after failed compensation, and can retry it later instead of silently reporting
a partial restore. User-facing Context chooser, direct Data Layer shell,
mapped-installation Search, rollback/exit, and Radio chip routes settle those
failures through the existing toast surface, release busy controls, and avoid
unhandled promises. A wrapped operation owns exactly one failure or blocked
notification; its synchronous manager event is suppressed only for that
operation, while unwrapped lifecycle failures retain the manager-level fallback.
The toast is a polite atomic status announcement.
When no tracked entity owns the follow camera, Radio Previous/Next and tuner
previews rotate to the requested broadcaster without changing zoom. A local
view whose optical center remains safely over the Earth, or a full globe already
contained in the viewport keyhole, uses one direct station flight and preserves
its initiating view angle. If a fit-capable Earth disc is clipped/off-center, or
a closer oblique view leaves the viewport center outside the Earth disc, Radio
first animates a centered north-up nadir composition, then focuses the latest
station from that canonical frame. Closer views keep their initiating altitude;
an extreme zoom-out is capped at 13,000 km so recovery returns to a useful
whole-globe scale instead of preserving an empty-space view. The two-stage navigation has one generation:
a playback fallback retargets it to the broadcaster that will play, while a newer
Radio action—including direct globe or non-moving voice selection—supersedes
older callbacks, and layer disable/destroy invalidates
the pending stages. While Flights, Military Flights, or any other
`viewer.trackedEntity` is active, Previous/Next and tuner previews continue to
change station and playback without cancelling or flying the camera. Tracking
acquired between the recenter and focus stages suppresses the later stage, and
a delayed fallback rechecks the same live ownership. Voice Radio navigation
remains non-moving; explicit station focus remains a separate user-requested
route and also yields to a live tracked entity.
The Radio tuner exposes the complete current filtered directory, up to 750
stations, in stable catalog and filter order. Needle progress is absolute across
that directory: the left, center, and right of the control resolve to the first,
middle, and last available station. Every position snaps to a real station, so
there are no selectable static gaps. During a drag, the bounded virtual tape
moves left as the needle moves right and travels faster than the needle without
creating DOM nodes for the complete directory. Camera movement never re-ranks or
rebuilds this order. Tuner-owned preview flights remain monotonic on the captured
strip, and release commits the frozen station before selection and playback
settle. That exact release clears older fallback ownership, so a broadcaster
failure cannot silently play a station left over from an earlier non-playing
cycle; the failed target retains its static/error handoff until Stop or another
explicit choice. Pointer cancellation instead cancels the active preview flight and
restores the exact pre-drag station ordering, absolute position, and frozen
presentation-only marker without starting a replacement camera flight,
committing, or autoplaying. That marker is restored even when an
accepted concurrent catalog removes the station or replaces its metadata, but
it never becomes current playback authority. The next accepted healthy catalog
refresh clears that presentation-only marker, including when the accepted
generation repeats and the immutable directory snapshot is intentionally kept
by identity. Every accepted filter action also clears and rebuilds the marker,
including a request for the already-active filter; a lifecycle-rejected filter
event leaves the restored marker and tuner band untouched. An accepted filter
action synchronously rebuilds the complete navigation pool after the layer state
notification, so Previous/Next and the tuner cannot observe an empty interim
directory. This restoration
also holds at either directory endpoint. Previous/Next traverses the same stable
pool and updates the absolute tuner position.
Cluster refresh identity follows the prior cluster contributing the greatest
absolute number of stations to the new cluster. This preserves majority identity
during merges instead of allowing a fully retained minority to win; deterministic
similarity and stable-ID tie breakers cover equal contributors and splits.
Every positive overlap participates in greatest-contributor discovery, so ratio
thresholds cannot discard a diffuse or one-station maximum. Inheritance is
bilateral mutual-best: a current cluster accepts only a greatest contributor and
a prior identity transfers only to a strongest split child. If that identity is
already claimed by an equal or stronger child, the later cluster receives fresh
identity instead of falling through to a historical minority. Disjoint clusters
also receive fresh identity; sequential fresh IDs are allocated in canonical
membership/station order so input permutations do not rename them.

Voice interprets “turn on/start the radio” as Radio Play, including when it is
combined with a camera action. Explicit “show/enable the Radio layer/markers”
remains a silent layer-only action and does not close the voice session.

Successful explicit user playback from Play/Resume, Previous/Next, the tuner,
or a globe station closes an active voice session only after Radio reaches
`playing`; a failed stream leaves voice active.
An interrupted or superseded voice turn aborts pending Radio location resolution
before it can enable the layer or select a station. Radio enable and disable are
abort-aware manager transactions: cancellation restores the authoritative
pre-transaction state only when the compensating lifecycle call succeeds and
emits no settled explicit-intent event for Context persistence. Failed
activation and teardown expose explicit `enabling` and `disabling` lifecycle
states while the manager retains the last authoritative visibility. The public
lifecycle vocabulary is `enabling`, `enabled`, `disabling`, and `disabled`, plus
a separate uncertainty bit. Radio controls present that phase and remain
non-interactive until the lifecycle is certain `enabled`; only a successful
transaction publishes the new `enabled` or `disabled` settlement. Radio's data
layer state, player message, compact status, launch controls, and generic Data
Layers row explicitly show `UNCERTAIN` when cleanup cannot establish authority;
their accessible labels name the uncertainty while Enable/Disable remains
available to reconcile it.
The Radio source, shared overlays, selected marker, and pick handler use the same
manager-owned presentation gate:
they remain hidden and inert throughout enabling, disabling, cancellation,
failure, and uncertain reconciliation, and activate only for certain `enabled`.
The same gate rejects direct station selection, Previous/Next cycling and its
camera/fallback preparation, tuner-static and category-filter mutation, volume
mutation, and every non-Pause playback toggle before fallback, selection, or
audio state changes. Voice volume and station-starting actions require a fresh
manager lifecycle read.
Every returned `control_radio` result, including status, failure,
cancellation, and a missing Radio module, exposes that same authoritative
`lifecycleState` plus `lifecycleUncertain`; the manager lifecycle record takes
precedence over the stable enabled fallback. Status only reads this state and
does not enqueue lifecycle or player work.
Generic `set_layer_visibility` results expose the same atomic `enabled`,
`lifecycleState`, and `lifecycleUncertain` summary for Radio on success,
fulfilled-false failure, rejection, cancellation, reversal, and missing-module
outcomes. Realtime suppression and settlement refresh all three fields together,
so dedicated and generic Radio routes cannot publish mixed lifecycle snapshots.
`disabled` is inert, while a transitional or uncertain shell is reconciled
through the manager and may proceed only after a fresh read confirms certain
`enabled`; false, rejection, or cancellation preserves the prior player state.
The existing immediate Stop/Pause authority is unchanged.
Cancelled-disable compensation reports failure and records whether lifecycle
state remains uncertain. Any same-target request made while state is uncertain
performs the real lifecycle work instead of taking the stable-state no-op, then
clears that reconciliation debt only after a confirmed enable or disable. A module-local
`AbortError` is a cancellation even while the caller signal remains live, while
that settled transaction releases its abort listener so the old caller cannot
disable a later successful retry. A resolved `false` from init, enable, first
update, or disable is a lifecycle
failure. Unrelated sibling tools remain independent, while each Radio control
captures the current playback-handoff epoch. A later Radio
Pause or Stop provisionally freezes prepared or already-started playback
handoff work without aborting active Select/Play auto-enable or an independent
explicit dedicated or generic Radio visibility ON. After semantic success it
cancels the active Select/Play lane and clears the frozen handoff. Semantic
failure leaves active work live and releases and resumes the frozen handoff.
Disable and generic OFF own visibility as well as playback and may cancel both.
These controls commit their authority only after semantic success, so a failed
stronger control cannot suppress a valid completed sibling. Pause uses the
production player's synchronous boolean contract; Stop and Disable additionally
handle their awaited failure paths. The control's function output is sent before a failed reservation releases,
so resumed playback cannot close the voice channel before the failure is
reported. Resumed handoffs own their attempt-scoped cleanup, so a stale predecessor
cannot clear the successor's in-flight result or block a later failed
reservation from resuming it again.
Generic `set_layer_visibility` Radio disable participates in the same ownership
domain as dedicated Radio controls, so an older Select cannot reverse it. Direct OFF
from either Radio control or the Data Layers row publishes intent before joining
the lifecycle queue and aborts in-flight voice work before an intermediate ON
event can settle. Every absolute manager visibility request also advances a
per-layer intent epoch and aborts the older absolute lifecycle transaction,
including a same-target request whose newer origin must own persistence. An
obsolete queued request never starts; obsolete in-flight cleanup keeps
presentation transitional and hidden, and only the latest request may adopt or
reconcile that state and publish settled visibility. The epoch is rechecked
after synchronous lifecycle-presentation callbacks, so a re-entrant newer
request prevents the older transaction from arming a timer or publishing a
settled visibility event. Superseding an uncertain same-target retry also keeps
the last authoritative enabled boolean until cleanup confirms the real module
state. Direct OFF also freezes
prepared or already-started playback handoff
until the manager queue settles; confirmed OFF discards that handoff, while a
failed OFF releases the reservation and resumes the valid prepared result. A
successful Stop cancels stale Radio work across older response ids as well as
its own response. If a Radio action has already completed its station mutation
before the later control succeeds, only its playback handoff is suppressed; its
result reads enabled state from the manager and audio state from the Radio
module. Voice Pause is a playback-only no-op while the layer is disabled; it
never enables Radio and reports a fulfilled-false pause as failure. A
newer-response or user-origin Stop still cancels stale handoff work.
Only a newer user turn or session teardown aborts the complete active-tool set.
A cancelled turn cannot publish a late Radio playback request. Dedicated Radio
controls and generic layer-visibility commands both forward cancellation.
Each explicit Radio play attempt owns one active audio element; replacement
retires the prior element, making its queued callbacks inert. Pause retires the
current stream and fallback attempt, so delayed callbacks from a replaced or
paused stream cannot change current state or start another station.
Pause and Stop settle attempt ownership and authoritative audio state before
synchronous playback-control observers run, so reentrant voice cleanup cannot
overwrite a released stream with a stale paused state. Layer
destruction likewise retains an enabled manager entry when module disable or
destroy fails semantically, preventing an active orphan and allowing retry.
When Context is collapsed, explicitly activating its Radio header icon reveals
the compact transport; hover and focus alone do not open it. When Context is
expanded, the icon instead expands and scrolls to the embedded Radio section.
Its accessible label, controlled region, and expanded state keep describing the
current route throughout enabling, enabled, disabling, and uncertain lifecycle
renders. Both routes preserve Radio power, playback, station, filter, and volume
state.

Bundled datasets live in `src/data/local_data/` with per-folder provenance READMEs; they are lazily loaded via `src/data/localGeojson.js` (Vite `?url` assets) when toggled on.

A bundled dataset that fails to load is a broken install, not a blip, so it is
never swallowed: `localGeojson.js` guards `response.ok`, reports `error` +
`lastUpdate` through `getStats()` (UNAVAILABLE chip, not a green ON over an
empty globe), and commits its Cesium data source only after setup completes so
a partial failure retries on the next enable. The two non-layer packs
(`naturalEarthRegions.js`, `neighborhoodPolygons.js`) have no stats contract to
report into, so they instead refuse to memoize a failure —
`src/data/retryableLoad.js` caches success permanently and retries a failed
load after a doubling cooldown (5 s → 5 min), which keeps one bad load from
silently demoting every later lookup for the session.

### Context / Contacts coordinator (July 2026)

- The internal Context coordinator is available in every visual style. Its dedicated right-side `CONTEXT` chooser exposes the neutral shell; the coordinator is not duplicated in Data Layers and does not enable a live-data dependency until a mode is selected.
- The expanded `CONTEXT` view offers mutually exclusive `CONTACTS` and `SPACE MISSIONS` modes. Selecting `CONTACTS` enables the context-owned Flights, Military Flights, AIS Vessels, and Mapped Installations dependencies only when they are not already user-enabled; selecting `SPACE MISSIONS` enables the recent-launch layer and its Satellite dependency. `CONTACTS` cycles the nearest supported contact of whatever type is selected. Satellites are deliberately excluded from those Awareness cohorts and keep their own tracking UX. Selecting the active mode again returns to the neutral chooser and releases only mode-owned dependencies.
- If a civilian or military aircraft is already tracked when `CONTACTS` becomes operational, that source-owned track is adopted as the Context subject before nearest-contact autofocus. Context rechecks the tracker after its dependencies settle, so a newer selection wins, while an explicit clear during activation prevents fallback from silently selecting a replacement. Cockpit entry remains unavailable until that Context transaction has settled, so its camera takeover cannot clear Cesium tracking before adoption. Adoption does not recreate tracking or transfer camera ownership; it initializes the normal 250 km ring, history, proximity results, and Cockpit Previous/Next state for the original aircraft.
- `SEARCH NEARBY SITES` retains the bounded OSM results and makes one user-initiated, view-biased Google Maps Places text search for “military installation.” Google results are source-stamped, deduplicated against OSM by rounded location/name, and remain mapped context rather than operational claims. If Places is unavailable or the API is not enabled for the supplied key, OSM context remains available.
- The expanded desktop header omits the redundant `ON` label; the active mode button carries state. Expanded Contact results also omit the duplicate `GLOBAL CONTEXT` / `CONTEXT ONLY` status row and begin with the selected subject and its 250 km scope. Global Context does not fabricate a selected-entity model preview: the provisional hand-authored aircraft wireframe was removed because it was not geometry extracted from the selected entity's actual asset.
- Dependency ownership is reversible: disabling Global Context releases only dependencies it enabled, while user-enabled layers remain on. This also removes the Military-layer suppression handoff when Global Context owned Military, allowing an already-enabled civilian Flights layer to resume its normal mixed rendering. If OpenSky is unavailable and has no last-good cache, Flights requests a capped 250 nm adsb.lol point snapshot around the current view anchor and labels that provenance explicitly; it never relabels military-feed rows as civilian data. If both inputs fail, Flights remains `UNKNOWN`.
- Space Missions is replay-isolated: Rocket Launches and Satellites are the only Data Layers permitted while the mode is active. Direct UI and voice entry capture the same pre-entry snapshot; internal dependency and restoration enables do not create a user-owned Context session. Entry waits for incompatible layers to shut down, direct incompatible enables are blocked before lifecycle work, and the entry gate remains active through the complete Rocket Launches enable. A newer same-target ON request takes ownership of the pending entry without releasing its isolation snapshot, including when it arrives while the prior request is awaiting the adoption guard. A caller abort, resource cancellation, newer OFF, or layer teardown waits for exact manager settlement and restores that snapshot without resurrecting Rocket Launches. If an abort lands after only part of a restore settles, Context completes the same exact target without the stale caller signal and then replays newer explicit layer intent. Dedicated Voice Context cancellation reports a stable cancelled result plus the current Context state; generic layer visibility additionally exposes manager phase, reason, successor, and lifecycle details. Once an exact voice visibility intent commits, a newer voice turn cannot relabel it as cancelled while Context settlement completes; pre-commit aborts remain cancellable and final lifecycle mismatches remain failures. Clear Selected Layers reserves its complete captured OFF set before sequential teardown; a newer absolute request of any origin supersedes only its layer reservation and remains authoritative. A rejected layer teardown retains the truthful enabled state, rolls already-stopped siblings back to the captured pre-entry set, and aborts replay; rapid exit/re-entry serializes the full Satellite enabled-state and parameter restore before a new snapshot is taken. Contacts remains additive and restores user-enabled layers normally.
- Enabled Data Layer controls report normalized feed health on the button (`LOADING`, `DEGRADED`, `STALE`, `FALLBACK`, or `UNAVAILABLE`) while the metadata line retains the source and reason. A partial CelesTrak group failure keeps the usable catalog and reports `DEGRADED`; a total outage keeps last-good catalog data visible but reports `UNAVAILABLE`.
- On activation it focuses the nearest currently observed aircraft across the civilian and military feeds, with military winning an exact distance tie; if none are available, it focuses an observed AIS vessel. The aircraft search is deliberately uncapped and one refresh-tick retry handles initially empty feeds. This is an attention-priority navigation shortcut, not a high-risk, affiliation, or threat classification.
- A selected aircraft, AIS vessel, or mapped installation gets a 250 km **context window** with nearby cohort counts, nearest examples, source labels, and stale/unavailable reasons. It emits `NEARBY` or `UNKNOWN`; no detection, engagement, affiliation, or sensor-activity conclusion is calculated.
- For a selected live aircraft or vessel, the context window refreshes from the existing tracker/feed position every 750 ms, so nearest distances and cohort counts follow the subject without introducing a duplicate poll loop.
- Aircraft cohort membership uses every locally loaded, selectable contact inside the 250 km window, including a plane hidden only by horizon culling or because its 3D model owns the visual. Counts and navigation therefore do not change with the current camera angle or billboard/model handoff.
- Nearby examples in the context panel are focus controls: they use their owning layer's existing selection/tracking path, then frame that contact. Static-installation distances use ellipsoidal surface distance so the count matches the ground-projected context disk.
- Context selection transfers camera ownership by subject type: selecting a civilian or military flight keeps that layer's moving follow camera, while selecting an AIS vessel or mapped installation first releases any prior aircraft tracker and performs only the source layer's one-time framing. The camera therefore remains user-controlled after non-aircraft selection instead of continuing to move with the previously selected plane.
- Selected AIS vessels use their layer-owned full-detail presentation model in the shared world-overlay host; mapped installations use the tracked-readout aesthetic. Both remain crisp above post-processing without duplicate selected labels; non-selected AIS cards retain their source-owned grid/visibility selection and are host-batched with other world cards.
- Space Mission ascent replay uses the compact rocket/thrust overlay only through orbit insertion. Once the replay enters its orbit phase, that vehicle glyph is replaced by a fixed-size cyan dot following the same orbit path and callout.
- While a subject is selected, an inner keyhole compass rotates against camera heading and up to three cyan shafted bearing arrows lock to its single faint tick-marked rim, with their labels inset just inside the circle. Labels explicitly separate the geographic bearing (`BRG`) from the contact's reported course (`CRS`) so the pointer direction is not confused with aircraft heading. They point toward the nearest observed/mapped examples; each cohort displays up to ten examples while retaining the complete locally loaded in-range cohort for navigation, with three visible at a time and a ten-second page rotation shared by the panel and arrows. This distinct neutral-context color avoids implying that all context indicators are military-flight symbols. `PREVIOUS`, `FOCUS`, and `NEXT` controls navigate selection history or the next nearby cohort example through the existing tracker. NEXT uses a cycle-scoped visited set and starts a deterministic new walk after exhausting the current candidates instead of re-admitting the nearest visited contact.
- Installations are viewport-bounded OSM map features (`military=airfield|naval_base|range|barracks|base` and `landuse=military`), capped to a 10° non-dateline request and 700 upstream features. The proxy caches five minutes and serves a one-hour stale fallback. Empty, stale, unavailable, and zoom-too-wide states remain visibly distinct.
- The selected-only visual is one static, unfilled blue circle. It marks the 250 km proximity context window only; it is not coverage or a radar/weapon envelope. Missing broadcasts and unmapped sites are explicitly not evidence of absence.
- The right rail's collapsed Display, CCTV, and Context controls use the same compact sizing language as the left rail's collapsed Data Layers and Scenes controls. These compact-state widths do not constrain expanded panel or child-content widths.

### Motion & Symbology Correctness (June 10, 2026)

- **Flights (commercial + military)** render one poll interval behind real time (30s/15s) and interpolate between two known feed-stamped fixes (OpenSky `time_position`; adsb.lol `receipt − seen_pos`). The display latency is an intentional product decision — do not "fix" it away. The whole fleet dead-reckons at ~12Hz (1m² write gating); aircraft get a 3-poll grace period (faded icon) before removal. When a position epoch pauses, both layers coast for at least 60 seconds of contact grace with an absolute five-minute ceiling. Source backoff marks each contact and the cockpit `STALE`; the cockpit then holds the exact layer position instead of continuing inertial flight. Repeated-position kinematic changes create a forward-only synthetic fix rather than mutating history, and grounded history is lifted only when no owned 3D model already controls its datum. A nominally successful worldwide OpenSky response whose own snapshot epoch is more than two minutes old prefers the existing 250-nm viewport-scoped adsb.lol fallback and labels the source/coverage accordingly when that upstream is available. If the fallback is also unavailable, the layer's freshness/error fields use the source epoch—never the cache receipt time—so the UI reports an old snapshot rather than “just now.”
- **World-space headings at every angle** (`src/data/iconOrientation.js`): aircraft/vessel icon rotation uses the camera right/up basis per tick (alignedAxis always ZERO), which is exact at screen center and for orthographic/nadir views and remains stable through >180° tracked orbits. Perspective rays vary across the viewport, so off-center contacts at oblique pitch can diverge from an exact finite-difference window projection; a regression test pins that known regime, and field evidence decides whether to adopt exact projection with the basis method as fallback. Fleet rotations refresh on camera-pose change; tracked entities per frame. Billboards are horizon-culled via a shared EllipsoidalOccluder.
- **Military/OpenSky reconciliation** (`src/data/militaryRegistry.js`): known-military ICAOs render amber in the flights layer (60s self-poll of the cached mil endpoint when the military layer is off) and are suppressed there while the military layer renders them.
- **Satellites**: 838-sat core catalog (stations/visual/GPS/GLONASS/Galileo/GEO), tracking lands ~726km out via `viewFrom` (tracked entity owns a point graphic so the tracking camera engages), rings realign via primitive modelMatrix (no per-second rebuild flicker), optional `setParams({catalog:'dense'})` Starlink mode.
- **Satellite classes** (`src/data/satelliteClass.js`): every satellite is classified from the CelesTrak group it was ingested with — no extra fetch and no heuristics — into STATION (warm white), NAV (cyan; GPS/GLONASS/Galileo deliberately share one color so the GNSS family reads as one thing), GEO (violet), VISUAL (muted blue-gray catch-all), and COMMS (dim slate, dense Starlink shell only). That module is the single source of truth for class, label, and color, so the dot, the card, and the legend swatch cannot disagree. Two deliberate palette rules: no class may sit in the 40–48° amber band, which is the app-wide known-military convention; and COMMS stays far below VISUAL in Rec.601 luminance so the dense shell stays separable when NVG/FLIR collapse the scene to one channel. The ISS keeps its long-standing red hero dot rather than the STATION color — it carries a permanent name label and its card still reads `STATION · ISS`. `satelliteClassOf` is the single owner of that ISS rule, so the card label and the legend tally can never disagree: during a stations-feed outage the ISS is ingested as `visual`, and both surfaces still file it under STATION.
- Class is also a **text field**, not just a color: `NAV · GPS` / `GEO` / `COMMS · STARLINK` / `STATION · ISS` leads the tracked card's detail block and replaces the raw CelesTrak tag on the detection-overlay label. Because that canvas composites above the post-FX chain, the class stays readable in NVG/FLIR after the in-scene dot colors are flattened.
- The satellites row in DATA LAYERS carries per-layer sub-controls (`DataLayerManager._syncRowControls`, the first consumer of the optional `getRowControls()` layer hook): a **DENSE** chip exposing the existing `catalog` param, and a swatch legend with live per-class counts. Default is the sparse core catalog. The chip is stateless — it declares the params to apply and the manager owns the write — so the Space Missions capture/restore path over the same param stays authoritative. Controls stay hidden while the layer is off. An explicit CORE or DENSE choice participates in versioned local and share-link state; temporary Space Missions overrides do not.
- **The DENSE chip reports the dense LOAD, not the catalog param.** The param flips synchronously while the Starlink shell takes seconds to arrive over a chunked load, and CelesTrak 502s that feed regularly. So the chip reads `DENSE ···` (busy, disabled) while loading, ACTIVE only once dense points are actually on screen, and `DENSE ✕` with the reason on hover when the load fails — a failure also reverts `catalog` to `core`, drops any partial chunk, and leaves the chip clickable to retry. A load is judged by points added, not by HTTP status: a 200 carrying an empty body, a passed-through HTML error page, or only TLEs the core catalog already owns fails with the same revert semantics as a 502. Any explicit request for `core` clears a latched error even when the mode does not change, so a Space Missions restore of an already-core snapshot never leaves the user with a failure they did not cause. Because the load settles asynchronously, the layer pushes a re-render through the optional `setRowControlsListener()` hook; nothing else would repaint that row before the 5-minute catalog refresh, so the count and legend would otherwise sit stale.
- **A dependency owner takes the row with it.** Space Missions borrows this layer for TLE lookup with `showPoints:false`; while points are hidden the layer returns empty row controls, so the legend never describes an empty sky and the chip cannot accept a write that the owner's restore would silently revert.
- The detection-overlay record cache (`_detectionObjects`) is cleared with the catalog on every rebuild: it stamps id/class at creation only, and a rebuild can re-tag a satellite when a partial CelesTrak outage changes which group wins dedupe.
- **FIRMS**: no ground clamping (zero 3D-tiles height sampling), ≤18 screen-decluttered ambient labels, click-to-inspect detail card, 2.5k/3k sprite budgets viewport-clipped by FRP.
- **CCTV v2 foundation:** a pitched
  frustum wireframe (4 corner rays + far-cap rectangle) with a monitor plane at the frustum's
  far cap, retargeting the existing video/canvas texture pipeline. Manual calibration only —
  auto-calibration and the drape mesh pipeline are deleted. A one-shot activation obstruction
  probe (`pickFromRay` on camera activation, clamping the plane short of the first hit) remains;
  ground placement is superseded by the shared-floor v3 behavior below. Calibration persists to
  `godsEyeView.cctv.calibration.v2` (wiped clean, no v1 import); a panel-only CAL badge shows
  `CALIBRATED`/`CURATED`/`RAW PRIOR` (no in-world tint). Panel is titled "CCTV" (not "CCTV
  MESH"). Staggered geometry/frame loading is active-first and uses 4 records per 120 ms normally,
  or 2 per 250 ms while tracking/cockpit owns the view (re-evaluated each batch), with coalesced progress
  notifications (roughly 300 ms or ten batches; natural completion and disable each publish their
  terminal state through their own completion paths) and a LOADING FRAMES
  chip and the preview-first auto-expanding panel are unchanged. Coverage polylines are created
  lazily instead of inserting five entities for every catalog camera during initialization: default
  COVERAGE ON enable creates the active/visible 14-camera cohort, and activation always creates the
  selected frustum even with COVERAGE OFF. **Field validation passed
  2026-07-04** (core look + downtown no-clip confirmed); that round fixed three findings: the
  ground clamp now lifts the cap *center* only so the wireframe stays a true pyramid welded to
  the plane (was a flattened fan / the ~47.5 m divergence — RESOLVED), re-selecting the active
  camera is a no-op (killed a click-flash), and texture swaps gate on canvas content (killed a
  periodic white flash). Coverage is now **metro-wide: 250 cameras** (`CCTV_AUSTIN_MAX_SOURCES`
  default 36 → 250, hard bound 300), filtered to `camera_status === TURNED_ON` (~815 live of
  1,003 rows). City packs (2026-07-04): Caltrans (districts 4/7/11/3 — SF, LA, San Diego,
  Sacramento; cap 300) and TfL London JamCams (cap 250) join Austin (cap 250) as keyless default
  sources — ~800 cameras total, all RAW PRIOR poses, stills-first.
- **CCTV v3 UX — viewshed + calibration gizmo** (built 2026-07-05 and field
  validated 2026-07-21): the COVERAGE toggle is a
  tri-state cycle `OFF → ON → VIEWSHED`; viewshed mode renders each visible camera's frustum
  as a translucent **color-coded volume** (golden-angle hue per camera, `cctvViewshed.js`)
  welded to the same 5 points as the wireframe — zero new scene queries or update cadences.
  The 7 calibration sliders are **deleted**: ADJUST mode puts a direct-manipulation **gizmo**
  on the active camera (`cctvGizmo.js` — heading/pitch rings, E/N/U arrows, range handle at
  the cap center, FOV handles on the cap edges; all 7 offset DOF), plus a click-to-edit
  **effective-pose readout** (HDG/PITCH/FOV/RANGE/HGT/ΔN/ΔE, absolute values). Persistence is
  now **save-gated**: edits are live but unsaved (`CAL · EDITED` chip) until SAVE CAL writes
  the v2 store. Do not add
  Translation arrows use a depth-test-free pickable tip so E/N/U ownership remains unambiguous even where shafts overlap
  other handles. Avoid hover effects that mutate gizmo polyline geometry (width) — the primitive rebuild blanks the pick buffer and eats the
  following click (root-caused 2026-07-05). Gizmo input checks the topmost, depth-test-free
  handle with `scene.pick` first and uses `drillPick` only as an overlap fallback; this keeps
  hover and press responsive on software GL without changing the real-GPU interaction. Frame serving is bounded independently from the
  10-second active refresh: upstream and Street View attempts abort after 8 seconds, and the
  panel/monitor plane keep at most one same-camera image request in flight. This prevents a
  slow provider from being cancelled and restarted forever while stale `SNAPSHOT · OK` health
  remains beside a pending preview. Grounding is shared with every other height consumer:
  CCTV warms/resolves `groundFloor.js` cells, reads `cachedGroundFloor()`, and delegates optional
  Google 3D refinement to the unchanged `meshFloorSampler.js`. During E/N gizmo movement the
  prior floor is frozen (constant elevation and zero transient samples); release or reset makes
  one resolution request at the committed anchor. U edits remain pure geometry and enforce the
  2 m minimum mount height above whichever shared floor wins, including a rooftop. Public camera
  state exposes `groundPriorM` as the immutable Re:Earth ellipsoidal datum reference; it is kept
  separate from live frustum geometry because Google-3D can refine the rendered ground to the
  photogrammetric mesh.
- **CCTV citywide ambient cards** (built 2026-07-29; shared-host migration
  2026-08-02): the LOD-selected nearby static cameras (20/28/40 by zoom,
  `cctvLod.js`) get **screen-space thumbnail cards** through the shared world-overlay host
  showing paced static frames — reselection on `camera.moveEnd` only, at most one frame fetch
  per second layer-wide, per-source cadences (Austin 5 min, TfL/Caltrans 3 min). Zero-flicker:
  a card renders nothing until its first frame, a drawn frame persists through failed fetches,
  and eviction grace (2-pass/5 s) stops budget-edge churn. Camera icons stay visible at every
  zoom. Eligible candidates are filtered to in-view stills with valid IDs,
  finite distances, and one deterministic representative per camera before
  ranking; videos, hidden/malformed rows, and duplicate outliers cannot alter
  the density scale or displace a valid winner. They are ranked with a
  deterministic 50/50 blend of eye distance and normalized screen-center offset
  before the existing 5×4 distribution pass, so the center wins contested
  density without removing peripheral coverage or changing the bounded count.
  The active camera keeps the v3 monitor plane and is excluded from the
  40-card ambient ring with no thumbnail by default. An explicit
  `activeCameraCardEnabled` presentation option can publish the retained
  protected-card path. Disable tears the tier down completely.
  Coverage/viewshed semantics unchanged.
- **Satellites**: orbit rings rotate about Earth's Z by ΔGMST every ~1s (exact inertial→ECEF compensation; no SGP4 re-runs); the tracked satellite propagates per frame with one shared epoch for dot/label/camera. Verified: ISS holds <1km perpendicular to its ring while tracked.
- **Space Missions (30d)**: recent launches render as bounded shared-host, horizon-occluded mission markers using Launch Library 2 v2.3 detailed records. Enabling the layer selects the unified right-side Context panel's Space Missions mode and enables the required satellite layer. Before applying its temporary dense/hidden Satellite mode, Space Missions snapshots the complete standalone Satellite parameter set and exact enabled-layer set. Disabling Space Missions from either Context or the left Data Layers rail restores those parameters and the exact prior enabled state, so a Satellite layer that was already on stays on while a mode-owned dependency returns off; enabling Satellites by itself remains independent. Selecting a mission isolates its launch-to-orbit transfer and dashed satellite orbit, fills that same panel with navigation/details, and animates a small phase-colored marker along the exact displayed Cartesian samples. Marker hit testing drill-picks through photorealistic tiles so the depth-test-free tactical dot remains reliably selectable; its text is non-interactive shared-host presentation. The selected pad is the camera's zoom pivot: the overview remains centered on its launch site, wheel zoom approaches that site instead of drifting elsewhere, and camera pitch progressively changes from global nadir to an oblique close 3D view. Its protected shared-host callout remains visible and expands to include both mission and launch-site names. `FOCUS` flies directly to a 12 km oblique frame around the selected launch site and retains the same anchored zoom/orbit behavior. `REPLAY ASCENT` resets the selected marker at the pad, frames it from an oblique third-person angle, and follows it through the mission-specific compressed ascent directly into one orbital lap at the default `1×` rate. A live `0.25×`–`4×` slider changes ascent and orbit playback speed; adjusting it mid-replay preserves the current path position and historical mission timestamp. Re-entry/recovery cannot be inserted into replay. At orbit insertion the camera smoothly pulls back over the first fifth of the orbital replay and pitches to a globe-scale nadir view while continuing to target the moving replay point. Replay Cancel, mission navigation, deselection, layer disable, and data refresh all release camera ownership. Reconstructed paths are one continuous 128-sample geodetic curve: horizontal departure begins near zero while altitude rises quickly, then the climb progressively bends toward insertion without the former hard 120 km corner. Unmatched orbit fallbacks are smooth planar inclined rings rather than longitude/latitude ground-track curves. The panel lists disclosed payload names, types, operators/manufacturers, mass, multiplicity, and destination when supplied; an empty LL2 payload collection is shown as `CLASSIFIED / MULTI-PAYLOAD`. Launcher, spacecraft, and recoverable payload stages appear in a compact stage table with serial/flight/reuse details, recovery outcome/type, destination, and final coordinates when those records exist; an empty recovery collection omits the section. Stage recoveries with confirmed coordinates use those coordinates; return-to-launch-site records use the pad; downrange-only records receive an explicitly labeled estimated endpoint along the ascent azimuth. Available endpoints render as static 2 px dashed descent/recovery paths with a fixed final-position dot and an estimated atmospheric-interface segment when applicable. The ascent is geodetically densified above the ellipsoid toward the orbit's nearest insertion point, then rendered with `ArcType.NONE`, so it neither cuts through Earth nor separates from the marker. Because LL2 does not normally supply continuous ascent telemetry, pad-to-insertion paths without upstream trajectory samples are labeled `RECONSTRUCTED ESTIMATE` / `ASCENT ESTIMATE`; only supplied trajectory samples receive the replay wording. Selected-orbit framing fits the complete ring, rear-side linework uses normal scene depth occlusion, and current distance, speed, and callout data come only from a launch-year-validated satellite match. Speed is the magnitude of the SGP4 inertial velocity vector at the same propagation epoch as position, displayed in km/s with km/h available as hover detail. Unavailable operator, site, launch-time, orbit, current-altitude, and speed values omit their detail rows instead of reserving panel space with placeholders. Newly launched payloads absent from the core operational groups use CelesTrak's cached active TLE feed as a lookup-only fallback; weak constellation-name matches are rejected. The replay callout maps compressed animation progress onto Launch Library's mission-relative timeline, showing the historical UTC date/time at the marker's current path position; unavailable timelines remain explicit. Matched live satellite positions propagate at one-second cadence and use a distinct green dot/callout with the current UTC date/time.
  When no mission is selected, the Context panel presents a scrollable newest-first roster of every launch in the rolling window, including the smaller 5 px operator-colored marker, provider, and launch date. Hovering or keyboard-focusing a row shows four compact cyan corner brackets on both that roster row and its corresponding globe dot, rotates the globe at the current zoom to center it, and gives its label declutter priority without selecting it; the globe label remains unbracketed. Selecting a roster row invokes the same mission isolation and full-orbit framing as clicking its globe marker. The replay vehicle is one screen-space SVG/CSS HUD overlay rather than separate Cesium billboard, label, and reticle graphics. It is hidden during ordinary Focus and manual close views, where the standard selected launch-site label remains visible, and exists only while ascent replay is active. Its fixed pixel scale is shared by ascent and insertion, so camera range never resizes the rocket on screen before the phase boundary. Generic Launch Library pad names are reduced to their identifying suffix, and replay timestamps use a cyan state title over unprefixed white UTC date/time values. `REPLAY ASCENT` holds the unframed cyan/white rocket at the pad for a real-time `T−10` countdown, transitions through `LIFTOFF`, and attaches six tapered cyan/white ellipse waves directly below it from liftoff through insertion to convey thrust without adding scene geometry. While replay is active, the single start button is replaced by compact Play, Pause, and Cancel icon controls. Pause freezes countdown or mission time, vehicle/stage positions, camera target, labels, and thrust-wave animation; Play resumes from that exact frame, and Cancel releases replay camera ownership. The rocket and thrust group rotates from the path's live screen-space tangent, so its nose follows the visible ascent curve while the adjacent text remains upright. The camera begins as a close oblique launch chase, then smoothly widens between roughly 120 and 420 km vehicle altitude into a higher oblique context view that keeps the moving rocket targeted while exposing the ascent bend and orbit connection. At insertion the rocket/thrust glyph is replaced by the fixed-size cyan orbit dot, which the camera follows through the existing globe-scale orbit pullback. The chase camera limits per-frame yaw changes across heading wraps so it cannot abruptly cross in front of the vehicle and make ascent read in reverse; the replay-speed slider affects mission playback but not countdown duration.
  Mission world text has no native `LabelGraphics`: overview launch markers publish at most 48 ambient candidates for a 24-winner budget, while selecting a mission clears that overview source and publishes its launch-site callout, stage re-entry annotations, live/estimated payload-position readout, and orbit annotation as protected selected-lane entries. The source retains the exact former strings and colors. Static anchors reuse the Cartesian values used to build their mission geometry; the moving payload entry reads the layer's per-frame live-position cache; catalog-backed orbit annotation positions are cached in the same one-second matrix update that realigns the orbit primitive. Keyhole edge fade, horizon culling, final collision placement, and UI exclusion are owned by the shared host. Deselect restores the bounded overview, and refresh, disable, and destroy replace or clear both mission sources.
  A selected mission renders its orbit as four repeating tactical sectors, each containing one prominent cyan dot followed by one hundred thin translucent dashes. The bright dots act as orbit anchors while the subdued dash field remains depth-tested against the globe and is shown only for the selected mission.
  Close selected-pad views add one static 500 m-radius cyan launch-zone ring with a low-opacity translucent fill over the sampled photoreal launch-site surface. The single scene primitive is created only for the visible selected site and is otherwise dormant. It appears during Focus, sufficiently close manual zoom, and the replay countdown, but is suppressed above 120 km camera altitude, beyond 180 km direct camera-to-pad range, for unselected missions, and whenever Space Missions is inactive. Focus establishes a launch-site-centered camera transform once; subsequent manual heading and pitch changes remain centered on that site without an automated per-frame correction. Surface mission markers and labels use an additional conservative globe-limb margin before the exact ellipsoid occluder boundary, preventing near-horizon visibility from alternating between frames.
- **AIS vessels**: chevron symbology (naval cyan base, type tints), world-space headings, MMSI-keyed reconciliation (selection survives refreshes; pinned 3 refreshes with STALE marker when absent), detection-overlay integration (`type: 'SEA'`), contextStore registration for voice Q&A. Empty-space clicks, id-less photorealistic-tile picks, and Escape dismiss the vessel card/HUD/context and clear its trail; picks owned by another layer (including `gev-trail:*`) and raw vessel-record picks without a live MMSI key are no-ops for vessel selection. Click and key handlers detach while the layer is disabled and reinstall on enable. Selecting another vessel replaces the selection and trail, and reconciliation clears a trail if its owning vessel is evicted.
- **Track trails**: server accumulates per-MMSI ring buffers (`/api/ais-live/track?mmsi=`, Float32+Uint32, 64 samples, 30s/25m thinning); aircraft backfill proxies `/api/opensky-track` (OAuth, own credit bucket) and `/api/adsblol/trace` (tar1090 readsb, ~24h history, ODbL — credit adsb.lol).
- Shared `src/data/pickRegistry.js` stops the two flight layers' click handlers from fighting over the camera.

### Share-link v2 layer state (August 2026)

- Generated share links use a deterministic v2 hash. Existing camera, visual,
  HUD, detection, post-processing, celestial, scope, and map-stack fields remain,
  with compact fields for enabled layers, allowlisted layer options, panel state,
  and the active preset's allowlisted shader controls. An absent layer field uses
  deterministic defaults; an explicit empty field means no enabled layers.
- The registry seals only after all 16 production layers register, and every
  layer has an explicit serialization disposition. Unknown enabled-layer tokens
  reject the layer payload; unknown option tokens are ignored. Restoration
  settles independently per layer so one failed or unavailable source cannot
  block its siblings.
- Stable visible options are limited to aircraft 3D mode, selected civilian and
  military flight IDs, Satellite catalog and selection, CCTV coverage/projection/
  auto-hop, and Radio filter/volume. Playback and tuning, live-data health,
  calibration, caches, lifecycle state, temporary Context ownership, and derived
  effects are deliberately excluded. Radio restore never selects or plays a
  station.
- Normal loads restore the last successful explicit UI, voice, or tool choice
  from versioned local storage. Any valid camera share wins for the current load
  without overwriting recipient preferences. Restore ownership is split by
  visibility, option/selection, camera, visual, map, and individual panel lane:
  a newer explicit action supersedes only the field it owns. In particular,
  navigation cannot turn unrelated layers off, and an option change cannot
  cancel the same layer's visibility transition. Every explicit HUD, detection,
  post-processing, scope, or celestial action from the UI, keyboard, voice, or
  public tool facade claims the visual lane before mutation. Invalid requests do
  not claim that lane or partially change controls.
  Direct globe pointer and wheel gestures supersede the delayed shared camera
  and selected-subject Follow without aborting unrelated layer visibility or
  display-option restoration.
- The initial restore has one terminal promise spanning the camera flight,
  visual/map/panel callback work, every production layer result, and the
  destination-scoped selected-subject Follow result. Hash writes remain
  suppressed and the startup screen continues to read `Restoring shared view...`
  until that aggregate settles. Destroy settles it as destroyed rather than
  permitting late mutation. A superseded shared visibility intent follows
  the authoritative successor chain to a terminal lifecycle result, including a
  same-target re-enable or opposite-target disable, before releasing the layer
  barrier. Flights, Military, and Satellite first-update
  fetches consume the manager AbortSignal; disable and destroy also abort their
  module-owned feed or dense-catalog requests.
- Only one Flights, Military, or Satellite tracking ID can be durable at once.
  Explicit selection clears the other families, Stop Tracking clears active and
  pending IDs, and ambiguous incoming multi-family selections fail closed rather
  than letting feed arrival order choose the camera owner.
- An explicit aircraft selection made inside Contacts promotes the owning
  Flights or Military layer from a mode-owned dependency into durable state, so
  leaving Context, reloading, or opening the link can restore it. Passive
  Contacts autofocus does not revoke a pending selected aircraft; the exact
  shared/local target wins when its feed row arrives.
- A shared Flights, Military, or Satellite subject that has not arrived yet
  publishes a persistent top-center `ACQUIRING` progress state while the
  existing deferred-restore latch and source-specific deadline remain active.
  Success, expiry/failure, cancellation, superseding intent, owner-layer
  disable, explicit navigation, and teardown all settle and clear that state;
  caller abort remains authoritative after the pending handoff. A latch that
  rejects its deferred selection emits only the terminal failure and never a
  false acquisition state. An unrelated manager failure preempts `ACQUIRING`
  for its full visible dwell; if acquisition is still owned afterward, the
  progress state resumes. A share-specific terminal failure that arrives while
  another failure is visible is queued, and its own fixed dwell starts only
  when that message reaches the screen. Only terminal failures use the existing
  fixed-dwell error presentation.
- Radio category persistence shares the live directory's bounded normalizer,
  including generated genre identifiers with spaces or `&` such as `Hip Hop`
  and `R&B`.
- Shared panel state starts from deterministic defaults and excludes responsive
  auto-collapse. Partial or malformed panel fields cannot import or overwrite
  recipient-local layout preferences.
- A fresh Cockpit entry temporarily collapses the standard left/right map
  panels and opens Cockpit's own Contact and Live Signals rails. This runs only
  on entry: Previous/Next preserves any panel the operator opens while already
  inside. Exit restores the exact standard-panel open/collapsed snapshot from
  before entry; Cockpit-only disclosure changes do not replace that map layout.
  Opening Data Layers while inside Cockpit temporarily collapses the Contact
  panel to prevent overlap. Closing Data Layers restores Contact only when that
  accordion action collapsed it; an operator's own Contact collapse remains
  authoritative.
  Voice selection of the nearest aircraft near a named place follows
  the requested-layer enable → location arrival → destination refresh → nearest
  airborne lookup → aircraft selection path, excludes on-ground records, and
  never enters Contacts or Cockpit unless either mode is named explicitly. The
  destination refresh also runs when the requested layer was already enabled.
  The lookup inspects the full loaded fleet and tracks by stable ICAO identity.
  That complete route is one atomic voice action, so Realtime sibling calls
  cannot race the nearest-aircraft query ahead of layer enablement. A healthy fallback feed is
  queried normally and its source is returned with the selection; fallback with
  no airborne records remains an honest no-data result, not an enable failure.
- Voice treats the parent Context panel and Contacts as separate intents. An
  explicit request to open Context expands only `global-context-panel`; it does
  not choose a mode. An explicit request to open Contacts expands that parent
  first, activates the Contacts sub-view, and returns the settled 250 km window.
  Its `aircraft` count is the exact civilian-plus-military total when both feeds
  can answer, or `unknown` when either component is unavailable.
- Cockpit's top vision switch cycles five rendered looks: the inherited map
  style, CRT, NVG, FLIR, and Noir. There is no empty `NONE` entry.

### Live AIS Vessels (June 2026)

- Server-side `ws` websocket to `wss://stream.aisstream.io/v0/stream` maintained by Vite middleware; `AISSTREAM_API_KEY` never reaches the browser (AISStream has no browser CORS). The `ws` package is used rather than Node's built-in WebSocket specifically because only it can hard-abort a wedged socket (see the watchdog note in the delta block at the top).
- Browser polls same-origin `/api/ais-live` cache every 60s.
- The first enable in a session starts one 30-second client grace timer. Until
  an accepted vessel position arrives, `live`/`open`/`connecting` transport reports
  `LOADING`; the timer is not restarted by the 60-second poll. Expiry or a
  definitive transport/credential failure reports `UNAVAILABLE`. Accepted
  warm vessels survive later zero-position refreshes as stale/degraded data,
  while disable/re-enable owns a new timer and superseded responses remain
  inert.
- Client render cap `VITE_AIS_LIVE_MAX_ROWS` (default 12,000); type-colored ship icons (tanker/cargo/passenger/fishing/tug); screen-space label clustering caps active labels at `VITE_AIS_LIVE_LABEL_MAX_ROWS` (default 900).
- Click-to-inspect wired into the voice context store.

### Voice Control (June 2026)

`GEV MIC` button (bottom UI) starts an OpenAI Realtime session over WebRTC:

- **Token flow**: browser fetches a short-lived client secret from `/api/realtime/token`; the Vite middleware holds `OPENAI_API_KEY` and posts the full session config (instructions, tool schemas, VAD, truncation) to `api.openai.com/v1/realtime/client_secrets`. SDP exchange goes directly to `api.openai.com/v1/realtime/calls` with the ephemeral token.
- **Session defaults** (env-tunable): model `gpt-realtime-2` (or `gpt-realtime-2.1-mini` when the MINI tier is selected — see the model-tier entry below), voice `marin`, reasoning effort `low`, semantic VAD with low eagerness, no response interruption, context window truncated to ~3,000 post-instruction tokens with 0.5 retention ratio — the conversational window stays short because map state is fetched live per turn.
- **Twenty-eight tools** (schemas defined server-side in `vite.config.js`, executed client-side in `src/voice/gevActions.js`): `fly_to_location`, `select_nearest_aircraft`, `adjust_camera_zoom`, `zoom_to_globe`, `set_layer_visibility`, `show_data_layers_menu`, `set_panel_open`, `set_visual_style`, `get_entity_context`, `get_current_view_state`, `set_hud`, `set_detection`, `set_map_stack`, `set_post_processing`, `control_scene`, `control_cctv`, `set_context_mode`, `control_cockpit`, `control_radio`, `track_entity`, `stop_tracking`, `frame_overhead`, `annotate_map`, `clear_annotations`, `move_camera`, `fly_route`, `analyst_query`, and `next_iss_pass`.
> **Reading `npm test` totals:** the count depends on the Node major. The two
> GC-bracketed allocation microbenchmarks (`src/data/focusAllocations.test.mjs`
> = 1 test, `src/overlays/worldOverlayAllocation.test.mjs` = 13) only RUN on the
> calibrated Node 24 runtime; on any other major the runner skips both files and
> their 14 tests are absent from the total. A branch total quoted without its
> Node version is therefore not reproducible. As of the fly_route cinematic
> branch: **2,281 on Node 25.6.1** (allocation suites skipped) = 2,255 on
> `main` + 26 route pins; the same tree on Node 24 reports 2,295.

- **Camera verbs** (`src/cameraVerbs.js`) — one motion slot, driven per clock tick. `move_camera` orbits/pans/tilts/rotates; `fly_route` is a cinematic dolly along an existing route annotation.
  - **The route dolly is shaped, not linear** (2026-08-20). A trapezoid speed profile (smoothstep up, cruise, smoothstep down, distance taken as the closed-form integral) eases both ends without changing the pace — duration is still `totalM / ROUTE_M_S[speed]`, with one exception: a 0.5 s minimum keeps a degenerate route from being an instant teleport, so routes under 10 m (slow) / 20 m (normal) / 45 m (fast) fly SLOWER than the speed word, never faster. Turns bank up to **10°** (a 90° street corner settles near 7.5°), measured as a triangular pulse over a 4 s window centred on the camera so the roll leads in and unwinds after. Altitude breathes ±20 m around the 260 m mean and lifts up to 26 m into turns. Pitch is LOCKED at −32°; heading comes from a gaze that leads the path by 6.5 s of travel. `prefers-reduced-motion` zeroes the roll and the altitude shaping and keeps the easing.
  - **Invariants — do not "fix" these.** (1) **Every** release levels the roll: completion unwinds it through the ease-out envelope, and `interruptCameraMotion` zeroes it synchronously (heading/pitch/position preserved). Cesium keeps the last up vector it was handed, so skipping this leaves the user holding a tilted horizon. (2) Heading is interpolated as an ANGLE about the local up, never as a Cartesian lerp — a lerp cannot cross an antipodal pair, so an out-and-back route looked backwards for the entire return leg; `signedTurnRad` branches the exact-180° case deterministically because the cross product's sign there is a floating-point coin toss. (3) A COLD floor cell is missing data, not flat ground: route vertices carry height 0, so trusting them flew a mountain corridor at 260 m above the ELLIPSOID. The corridor warm is fire-and-forget, so the dolly ARMS — camera untouched, no teleport onto the route — for up to 1.2 s waiting for real floor data, falls back to a rendered-mesh probe (`scene.sampleHeight`) when the DEM stays cold — latched to ONE firing per flight, for exactly the cells the cache could not answer, so a route costs at most 8 `sampleHeight` calls however long it arms — and otherwise holds the launch altitude for the whole route. A corridor is only RESOLVED when every cell is accounted for: one warm cell says nothing about the ground under the other seven, and treating it as an answer let the dolly descend to 460 m over a 1,600 m rendered surface. The probe reads the rendered surface at the current LOD (rooftops and primitives included) — a better estimate than nothing, not a guaranteed upper bound. Never descend blind. The floor is SMOOTHED in both directions for the ride while the hard clearance clamp reads the RAW sample, so a cell boundary cannot pop the eye but a cliff is still cleared on the frame it is seen. A pre-departure floor is adopted whole; one arriving mid-flight is eased onto, and the eye's descent rate is capped.
  - Pins: `src/routeCinematics.test.mjs` (26 tests), with `scripts/qa-flyroute-mutations.mjs` reverting each fix individually to prove they are load-bearing (19 named defects); rendered proof `scripts/qa-flyroute-cinema.mjs` (drives the real voice runner, measures the real Cesium camera every frame, writes a labelled contact sheet).
- **Public control facade** on StyleManager (`setHudVisible/setHudLayout/setDetection/setMapStack/setBloom/setSharpen/setOrbit/setCleanView/getControlState` plus `runImmediateNavigation`): every setter syncs DOM sliders + share links + scene snapshots and returns `{ok, ...state}` — voice confirms only what actually happened. Validated `move_camera`, `fly_route`, `frame_overhead`, strongest-fire focus, and entity tracking use the shared navigation transaction, which refuses Cockpit before mutation, advances authority, releases follow owners, cancels stale work, and only then starts the requested action. All four entity layers expose `findByQuery/getNearby/getAllPositions/trackById|selectById/stopTracking/getTrackedInfo`.
- **Scene context** (`get_entity_context`): selected entity from the context store, or visible entities ranked by distance to the view target (≤100km altitude); plus basemap context — view-target picking, 7-point viewport sampling, view-scale classification (global/continental/regional/metro/city/local), reverse geocoding (center ≤750km, viewport samples ≤3,000km), Google Places Nearby via `/api/google/nearby-places` (≤25km), known-landmark matching against `CITY_POIS`, coarse country inference fallback. Context assembly is capped at 1.5s with cache fallbacks; caches are deduped in-flight.
  - **Every selectable layer writes that one slot** (2026-08-21). The tracking layers — flights, military, satellites — publish selection on their own awareness lane (`gev:awareness-subject-selected`, consumed by the readout card and the Contacts panel) and for the life of the voice tools never wrote the shared slot, so `scope:'selected'` silently answered `in_view` with a contact plainly selected on screen. They now call `selectTrackedSubjectContext` / `refreshTrackedSubjectContext` / `clearTrackedSubjectContext` (`src/data/contextStore.js`) on select / poll / deselect. **Invariants: (a)** that write path must NOT dispatch `gev:entity-selected` — tracking layers already own an event lane and a second one makes two surfaces fight over one subject; **(b)** exactly one record per tracking layer, because a frozen snapshot of a moved contact must never reach the visible-entity scan; **(c)** precedence is recency, not layer — one slot, last selection wins, so clicking an overlay entity supersedes a tracked plane as the voice subject while the plane stays tracked. Satellites refresh on the 1 s propagation beat, not per frame.
  - **Context-mode vocabulary is symmetric** (2026-08-21). `set_context_mode` accepts `contacts`; the internal id is `flights`. Every model-readable field (`mode`, `entering`, `priorMode`, nested `context`/`contextRollback`, and the transition diagnostic text) is reported in the accepted vocabulary, with the internal id preserved as `<field>Internal`; an absent secondary mode stays `null` rather than claiming to be `off`. Mapping lives in `src/contextModePolicy.js` so UI text and voice payloads cannot drift. Reporting the internal id made the model read `mode:'flights'` as "Contacts is off" and refuse to answer from the `contactsWindow` counts in the same payload.
  - **Analyst → track handoff carries a key, not just a label** (2026-08-21). `analyst_query` items include `icao24`/`mmsi` alongside the display `id`, and contact lookup uses the shared tiered ranking in `src/data/contactMatch.js`: hex exact → callsign exact → registration exact → callsign prefix → registration prefix → callsign substring → registration substring. The tiers keep an exact callsign ahead of a colliding registration regardless of feed order, and registrations compare separator-insensitively (`G-ABCD`/`GABCD`, `05-8152`/`058152`, `N123AB`/`N-123AB`).
  - **A typed command supersedes the turn it interrupts** (2026-08-21). `sendTextCommand` defers its `response.create` behind an active response instead of colliding with it, marks that response superseded so a late function call from it is refused rather than dispatched, and drops the old turn's queued follow-up. A refused call is still ANSWERED — a terminal `{ok:false, superseded:true}` `function_call_output` — because an unanswered `function_call` strands a pending call and deadlocks the model; the refusal creates no response of its own. A burst of typed commands coalesces into one response while keeping both conversation items.
  - **Subject reconciliation across satellite catalog rebuilds** (2026-08-21). A dense↔core toggle or TLE refresh clears and repopulates the catalog, so the published subject is re-resolved against the new satrec; a subject that did NOT survive releases the slot. The per-frame refresh cannot do this itself — `_getTrackedFramePosition` returns early once the satellite has no catalog entry — so the reconcile runs at rebuild completion. An empty catalog is a rebuild in flight, not a disappearance.
  - **One aircraft-proximity engine** (2026-08-22). `collectAircraftProximityWindow` (`src/data/militaryAwareness.js`) is the single computation behind both the Contacts panel window and the voice analyst's entity-centred "how many nearby", so the panel readout and the spoken count for one centre are identical by construction. **Invariant: do not re-derive a proximity count anywhere else.** They diverged before because the panel read live billboard positions (20,000 cap) while the analyst used last-fix coordinates over a 2,000-record slice — 111 on screen, 15 spoken. Explicit regions and arbitrary points deliberately keep the general record engine. Entity-centred results carry `window: {engine:'contacts-window', centeredOn, radiusKm, flights, military, aircraft}`.
  - **Centre precedence for nearby asks**: explicit place in the question > Contacts subject (a selected non-contact entity never silently becomes the centre) > an entity the user names > the current view, said aloud. Contacts active with no subject uses the view rather than reading an empty panel.
  - **Contact-match ties break on hex ascending.** `track_entity` is a mutation fulfilling "follow that one", and the model's observed answer to a non-ok track result is to retry with guesses rather than ask, so the lookup always commits rather than returning an ambiguity. What it owes the caller is stability: hex is unique and always present, so the same query resolves to the same contact for as long as both are loaded.
- **Visual grounding**: at `local` view scale with no structured identity, the client captures the Cesium canvas (≤1200px JPEG, black-frame detection, double-render for freshness) and sends it as `input_image` with a strict "do not invent labels" instruction.
- **Context window**: only the latest viewport screenshot stays in context — the client deletes the prior image item (`conversation.item.delete`) before adding a new one (images are the most expensive item, re-billed every turn). Text history is bounded by the **server-side** `truncation: { type: 'retention_ratio', retention_ratio, token_limits.post_instructions }` set in `/api/realtime/token` (cache-friendly batched truncation). There is intentionally **no** client-side per-turn conversation-item cap — deleting from the front of history each turn busts the Realtime prompt cache. A spatially-aware summarize-and-prune policy is specced for a future iteration.
- **Model tier + spend guard** (`src/voice/voiceCost.js`, August 2026): the voice heading row carries a `STD`/`MINI` toggle and a running session-cost readout (`~$0.42`).
  - **Tier selection.** `standard` = `gpt-realtime-2` (default), `mini` = `gpt-realtime-2.1-mini` (~3× cheaper per audio token). The client sends `?tier=` to `/api/realtime/token`; the endpoint resolves it through the shared registry, so an unknown, empty, or hostile value falls back to `standard` rather than reaching OpenAI as a model id. Responses echo `X-GEV-Voice-Tier` / `X-GEV-Voice-Model` (plus `X-GEV-Voice-Tier-Fallback: 1` when a bogus tier was downgraded). Persisted at `godsEyeView.voiceCost.tier`.
  - **Applies NEXT session.** The model is fixed when the ephemeral token is minted, so a live session always keeps the model it connected with; toggling mid-session only records the preference (the button title says so). The cost tracker's lifetime is the session's lifetime and its model binding is immutable from `start()` to `stop()` — rebuilding it on toggle would erase accrued spend and let repeated toggles bypass the cap. The tracker may only be replaced once the session is FULLY SETTLED (`isVoiceSessionSettled()`: not active **and** no data channel **and** no peer connection) — `!isActive()` alone is not enough, because the `error` status reports inactive while the transport can still deliver a late `response.done`. The toggle itself reads and writes only the persisted preference, never the live tracker.
  - **Env overrides.** `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_MODEL_MINI` remain authoritative per tier, so a drifted upstream model id is a `.env` fix rather than a code change. Because an override can point a tier at any model, the client prices against the model id the server actually echoed, **not** the tier it requested. An unrecognised id is billed at the most expensive known rates plus one console warning — under-metering is what lets a cap be overrun.
  - **Metering.** Token usage from each `response.done` is folded into a per-session estimate. Cached tokens are subtracted from their modality totals; any aggregate-minus-details residual (and any payload with no detail at all) is attributed to audio rates, so uncertainty always resolves *upward*.
  - **Thresholds** (one object, persisted at `godsEyeView.voiceCost.limits`): soft warning at **$2** — amber readout plus exactly one console line; hard cap at **$5** — the session ends through the ordinary stop path (data channel and peer connection closed, mic tracks stopped) and the readout reads `Session ended — cost cap`. `0`/negative disables a threshold and round-trips through storage as an `'off'` sentinel (raw `Infinity` would JSON-serialize to `null` and silently restore the default); a corrupt entry falls back to the defaults rather than disarming the cap.
  - **Cap semantics — in-flight tools COMPLETE and are NOT rolled back.** A session-ending latch (`isSessionEnding()`) is checked at the tool-dispatch site, so no *new* tool is dispatched once the cap trips. `extractFunctionCalls` yields at most one call per event, so that single check covers the whole batch. A tool already executing may still finish its map mutation (a camera flight, a layer toggle, an annotation). This is deliberate: unwinding a partially applied map change has no safe general implementation, and a half-reverted camera/layer/annotation state is worse than a completed one.
  - **In-flight response at teardown → the accounting is INCOMPLETE.** Usage only arrives with `response.done`, which never comes for a response cut off by teardown (`stop()` closes the peer connection, and the server cancels rather than completes it). Rather than invent a token count for it, the tracker is marked `incomplete`: the chip shows a trailing `*` (`~$1.00*`) as a see-note mark and the tooltip carries the reason. Deliberately **not** presented as a lower bound — the estimate can also run high (residuals and unrecognised models bill at worst-case rates, and sub-cent totals round up), so it is partial rather than directional. (A bounded teardown drain was tried and removed: `pc.close()` closes the data channels a drain would listen on, so it was structurally dead.)
  - **⚠️ Model ids and rates are external facts** read from OpenAI's model + pricing pages on 2026-08-18 and marked VERIFY-AT-RELEASE in `voiceCost.js`.
- **Reliability**: tool-call dedupe (2.5s window across call/item/args keys); response-create queueing that respects active responses and defers follow-ups when the user starts speaking; per-tool follow-up instructions so the agent confirms only what actually happened (zoom confirms only on `ok=true`).
- **Aircraft identity honesty:** “What is this aircraft?” reads callsign, operator, registration, type, and route only from the selected contact context. Missing operator, route, or type enrichment is named explicitly rather than silently omitted or inferred from the callsign.
- **Diagnostics**: every client/server event is posted to `/api/realtime/debug-log` and appended to `.gev-logs/realtime-conversations.jsonl` (gitignored) with secret/image redaction; last 30 errors persist in `localStorage` (`gev-realtime-errors`); `window.__gevVoiceCommands.getDiagnostics()` in the console.
- **Counting semantics ("near")** — a CONTRACT; new count-bearing tool work inherits it. Three honest numbers exist for one question: the Contacts cohort (250 km around the subject, what the panel shows), `analyst_query`'s count of *currently-loaded* records for the requested scope, and the layer-wide loaded total in `coverage.layersQueried[].records`. They diverge legitimately — the flights layer loads by viewport, so after a camera dive the loaded set can hold a fraction of the cohort (field case: panel 42, analyst 8). The contract:
  1. **Contacts ACTIVE** → "near / nearby / how many aircraft" means the **Contacts window** — the panel's numbers, spoken verbatim. Mechanism: `contactsWindow` (`{centeredOn, radiusKm, flights, military, vessels}`), carried by both `analyst_query` and `get_current_view_state`, derived by `contactsWindowFromSnapshot()` from the same snapshot the panel renders so the two cannot drift. A cohort whose feed cannot answer reports `'unknown'`, never a confident zero.
  2. **Contacts OFF** → "nearby" means **in view**; "near \<place\>" means a radius around that place. A radius query with Contacts active and no explicit centre is centred on the **active contact**, not the camera.
  3. **Every count names its scope in words** — "42 in your window", "8 in view", "about 30 within 250 km of Austin" — never a bare number. `analyst_query` returns `scopeLabel` so this is mechanical. Two different numbers with named scopes are not a contradiction.
  4. **The loaded-data caveat is stated once when relevant**: counts cover loaded data, and the flights layer loads where you look (appended to `coverage.note` for radius/view scopes over viewport-loaded layers).
- **Degradation**: without `OPENAI_API_KEY`, `/api/realtime/token` returns 503 and the mic button surfaces the error; the rest of the app is unaffected.

### AI HUD Summary (June 2026)

- HUD `SUMMARY` readout requests a five-word intelligence-style summary from `/api/openai/hud-summary` (model `OPENAI_HUD_SUMMARY_MODEL`, default `gpt-5-nano`, minimal reasoning).
- Input is the live basemap label context (place/street/nearby-place labels + enabled layers) — the model is instructed not to infer from coordinates.
- Output is sanitized to exactly five words; falls back to the deterministic telemetry summary on error/timeout (5s abort); typewriter animation on update.

### Map Stack Switcher (June 2026)

- `src/mapStackController.js` switches between Google Photorealistic 3D (`photoreal`, default), Bing Aerial / Aerial-with-Labels via Cesium ion world imagery (require `CESIUM_ION_TOKEN`), and OSM tile fallback. Bing Road is **retired**: it is gone from `MAP_STACKS`, from the `set_map_stack` enum, and from the voice aliases (road phrasings now resolve to OSM, the one shipped road basemap). An old `map=bing-road` link is simply an unknown id and takes `setStack()`'s existing photoreal fallback with the Google 3D tile lit — pinned live in `scripts/qa-map-source-tray.mjs`.
- The bottom Visual Presets tray presents a **four-tile MAP SOURCE row** (`#map-stack-chips`, `src/mapStackChips.js`): Google 3D, Bing Aerial, Bing Labels, and OSM. The duplicate left `#stack-panel` is retired. The four tiles share one row on desktop and two rows on narrow screens, carry `aria-pressed` on the active source, and remain keyboard-reachable with a visible focus outline.
- The lit tile follows controller state, not the click: a rejected switch (no ion token) or a superseded one (rapid A→B) leaves the genuinely active source lit, and the tray heading keeps its short-label status readout (`...` while switching, amber on `lastError`).
- Ion stacks remain visible and keyboard-focusable when no ion token is configured, but expose `aria-disabled="true"` and do not switch. Their accessible label and tooltip quote `getStacks().unavailableReason` — the same string `setStack()` puts in the toast. OSM works keyless. The `ION` badge is gated on the stack's own `requiresIon`, so a `photoreal` chip unavailable because the Google tileset failed says so instead of falsely demanding an ion token.
- Stack choice participates in share links (`src/sharelink.js`) and falls back to OSM when Google 3D tiles fail to load. Share-link restore, the `set_map_stack` voice tool, and the chip row all land on the same `_setMapStack()` path.

### Voice Map Whiteboard / Annotations (June 2026)

- Runtime entry: `src/main.js` calls `initAnnotations({ viewer, tileset })`, exposes `window.__gevAnnotations`, and passes the engine into the voice action runner.
- Engine contract: `src/annotations/annotationEngine.js` owns annotation state, TTL/fade lifecycle, concurrent anchor resolution, duplicate detection keyed on geometry, cancellation on clear/newer generations, and a hard cap of 120 live marks. Deferred outline upgrades drain FIFO at concurrency 2; queued work retains the owning abort controller and is discarded on a generation change before it can fetch.
- Resolver contract: `src/annotations/annotationResolver.js` converts names/coords/screen pixels into world anchors and optional geometry. The resolver is type-aware: Google Geocode/Places gives a centroid + scope, OSM/Overpass supplies admin/place/footprint/street/enclosing-area geometry, route requests use `/api/route`, and ambiguous/far results are rejected or recovered near the current view instead of drawing misleading blobs. Only explicitly country/state/county-scoped asks bypass near-view recovery and proximity gating; state scope requires a leading `state of …`/`the state of …` phrase, while bare names, proper names ending in “State,” and administrative geocode result types alone remain guarded. Overpass throttles remain distinct from normal transients: `Retry-After` is honored for one retry, and a repeated throttle ends only that mark's outline upgrade.
- Renderer contract: `src/annotations/hybridAnnotationRenderer.js` routes draped `area`/`route` geometry to world-space Cesium rendering and reticles/pins/arrows/callouts to the screen-space SVG renderer. Area labels are screen-space callouts so all captions share one visual language; progressive outline upgrades convert the existing screen group in place when the anchor snaps to the resolved centroid.
- Tooling: voice has `annotate_map` and `clear_annotations` tools. Annotations accumulate and persist by default; clearing is explicit only. Partial failures, approximate synthesized zones, and route fallbacks are returned as structured tool results so the voice layer can be honest.
- Console/dev API: `window.__gevAnnotations.tour()`, `.demo()`, `.annotate()`, `.clear()`, `.count()`, and `.list()` are the deterministic no-mic test surface.
- Current known resolver gap: mall/lifestyle districts such as "The Domain, Austin" can prefer a named building over the broader retail envelope. Product decision is that districts should become envelope + key buildings, but the scoring change still needs a careful multi-case validation pass.

### 3D Aircraft + Tracking (June 2026)

- **The TRACKED contact's 2D↔3D handoff is DEFAULT behaviour (2026-08-19), driven by camera distance alone.** It does NOT consult the DISPLAY-rail `3D` toggle, which continues to own the FLEET (the un-instanced draw-call budget stays the operator's decision). Policy lives in `src/data/trackedModelRegime.js` and is shared by both layers: enter below `TRACKED_MODEL_ENTER_ALT_M` = 150,000 m and hand back to the billboard only above `TRACKED_MODEL_EXIT_ALT_M` = 172,500 m. **The swap distance was set by playtesting on 2026-08-20:** a first pass at 1,000,000 m switched too early; 2D reads correctly at ~600 km and the handoff belongs at ~150 km. **Consequence, recorded on purpose:** the tracked contact now enters 3D NEARER than the FLEET does (`MODEL_ALT_CEIL_M` = 800,000 m, unchanged), so with the DISPLAY-rail `3D` toggle on, 150–800 km draws surrounding contacts as models while the selected one is still a glyph. Nothing double-draws (the fleet pass skips the tracked icao) and aligning the two is a fleet-side decision, deliberately out of scope. **The two thresholds are asymmetric on purpose:** a single threshold makes a tracked orbit sitting ON the boundary strobe billboard↔model as the camera's altitude wobbles across it. Do not collapse them. The latch is scoped per selection, so a new target re-evaluates against the ENTER ceiling rather than inheriting the previous target's exit band. Exactly ONE model is involved; it loads on demand when the regime opens, is HIDDEN (not released) on regime exit so re-entry has no load gap, and is released by the existing teardown on deselect/re-track/destroy. Cockpit and TR-3B suppression are unchanged. **Two invariants around it:** (a) the hysteresis latch AND the load-failure latch are per-selection state cleared by `_resetTrackedSelectionState()` in the tracking lifecycle (deselect / re-track / cross-layer / init / destroy) — the predicate's icao-change guard is defence only, since it needs a drawn frame while nothing is selected and the render governor's idle mode does not promise one; (b) on-demand loading is bounded at 3 attempts per selection with a 1.5 s backoff and one console warning naming the asset — the driver runs every `scene.preUpdate`, so an unbounded catch means a missing GLB spins load→reject at frame rate. The billboard stays the visual throughout a failed load.
- **Grounded 3D handoff is terrain-validity gated (2026-08-23).** A ready civilian or military glTF does not own the visual until `groundSnap` (`src/data/groundSnap.js`) can answer with a MEASURED photoreal-surface height. On success the layer writes `height + the model's measured belly offset` before revealing the model. Cache movement is measured on the WGS84 surface, not across altitude, so a stationary contact keeps its snap through poll-time vertical-datum changes. Model existence or GPU readiness alone never suppresses the billboard floor, and ordinary zoom/style/deselect transitions preserve a valid snap cache. **Two states, and the difference is the whole design.** COLD — nothing has ever resolved for this icao (tiles still streaming on first sight, sample failure, backoff after a first miss): there is no evidence of where the ground is, `heightFor` returns null, the model stays hidden and the depth-test-free 2D billboard remains opaque and floored. WARM — a snap resolved and then a >`MOVE_INVALIDATE_M` (50 m) taxi move stopped it answering directly: the measurement is DEMOTED to a bounded last-known rather than deleted, and it keeps answering while the resample is outstanding, so a taxiing aircraft does not pop 3D→2D→3D across a 2–30 s retry backoff. The bound is `HELD_SNAP_MAX_DRIFT_M` = 250 m from the spot the value was measured at, past which the hold is dropped rather than stretched and the contact is COLD again. It is spatial with no timer beside it (ground under a contact that has not moved does not change; what invalidates the value is the contact MOVING) and deliberately a quarter of the billboard chain's `HELD_FLOOR_MAX_DRIFT_KM` — that hold only ever RAISES a sprite, while a held snap IS the model's placement, so its error shows in both directions. A fresh sample releases the hold, and so does a ground flip (which already calls `forget`). **A loading model is HIDDEN, never zero-scaled:** admission sets `show = false` (Cesium's default is `true`, and an unplaced primitive would claim the visual at the identity matrix), and ownership is `ready && show` — Cesium 1.138's `Model.update` has no `show` guard, so hiding a primitive costs its load nothing.
- Commercial and military aircraft use the same high-level FLEET model regime: 2D billboards when zoomed out, optional glTF models when closer, controlled by the DISPLAY rail `3D` toggle and `Proximity` / `All` modes. Since 2026-08-16 (Hangar fleet) models are PER-CLASS: real CC-BY GLBs for light/bizjet/turboprop/widebody/helicopter/uav (`CLASS_MODEL_REAL` in `src/data/aircraftClass.js` — meters-baked, scale 1, per-model belly/radius; provenance in `public/models/README.md`), the shared `airplane.glb` for the remaining civilian classes, and the military layer maps weight classes (real GLBs / 747 heavies / `jet.glb` fastjets, per-model heading offsets, always flat amber). Textured civilians carry a HEAVY tint, not a light one: `MODEL_COLOR_BLEND_AMOUNT` is `0.94` in BOTH layers under Cesium's `ColorBlendMode.MIX`, so the class colour supplies 94% of the surface and the asset's own texture ~6%. The visual direction is clean light silhouettes with only a weak diffuse contribution from the approved textures, so liveries deliberately do NOT read. IR boost raises the blend to a full `1.0`. Under NVG/FLIR (map preset or Cockpit vision) models render unlit flat-white at full alpha and scene fog is disabled (fog otherwise blacks out distant models with the globe hidden); state restores on exit.
- The DISPLAY-rail `3D` toggle is the user-facing activation path for both aircraft layers. Their small approved GLBs build their render resources without Cesium's frame-spread job queue, preventing continuous Photorealistic 3D Tiles streaming from starving model readiness; model caps, tracking, camera, and fallback billboards are unchanged.
- **The `3D` toggle DEFAULTS ON in `proximity` on a first run.** Proximity is itself the budget — models appear only below `MODEL_ALT_CEIL_M` and only for the nearest `MODEL_MAX` in view — so the default costs nothing at globe scale, and `all` remains a deliberate opt-in. A fresh boot runs NO layer-state restoration (`LayerStateCoordinator.start()` returns early with neither a share payload nor stored state), so four independent initializers decide what a first-run operator sees and must agree: `booleanOption('models3d', 'e', true)` in `src/data/layerState.js`, `_models3dEnabled = true` in BOTH flight layers, `this._models3dEnabled = true` in `src/ui.js`, and the `active` / `visible` classes on `#models3d-toggle` / `#models3d-mode-row` in `index.html`. All four are pinned together in `src/data/layerState.test.mjs`. Explicit state still wins: because the codec omits default-valued options, `models3d: false` is now what travels in a link (`lo=…f.e.0`) and restores OFF at both aircraft layers. **Consequence for returning users:** a stored `gev:layer-state:v2` blob is a FULL options snapshot, so a session that wrote one before this change carries `models3d:false` and keeps 3D off until the operator flips it (or clears the key) — the durable snapshot is treated as the recipient's own state, by design.
- **Consequence of the flip on the recorded tracked/fleet inversion:** the 150–800 km band where surrounding contacts draw as models while the SELECTED one is still a glyph is now what an operator sees WITHOUT arming anything. The inversion itself is unchanged and still deliberate (see `src/data/trackedModelRegime.js`); only its reachability changed.
- Civilian and military 2D aircraft use the established distance scale: `3×` near
  the camera and a `0.5×` floor from 8,000 km outward. A standard 20 px ambient
  icon therefore remains about 10 px at globe altitude while retaining the
  established close-range silhouette. Any compact alternative requires
  before/after visual evidence.
- Fleet model eligibility is distance-based with on-screen priority and hard caps (`MODEL_MAX`, `MODEL_MAX_ALL`) to avoid draw-call explosions. Each model owns its own `modelMatrix`; shared scratch matrices are forbidden because they caused stacking/flicker.
- Tracked aircraft use standalone model primitives driven from the already-settled dead-reckoned display position, while the tracked Cesium entity remains billboard-backed so `viewer.trackedEntity` always has a ready bounding sphere.
- Flights and military layers mirror the same tracking invariants: no warm-up freeze/jump, altitude-scaled framing, trail head glued to the displayed plane, no pull-out when switching targets, and no cross-layer orphan when switching between commercial and military tracks.
- Regression surface: `npm run test:track` drives the real app headless with synthetic aircraft feeds and asserts the tracking invariants without depending on live OpenSky/adsb data. `src/data/trackedModelRegime.test.mjs` pins the tracked contact's threshold math, the enter/exit asymmetry, and the default-on / cockpit / TR-3B / deselect wiring in both layers.

### TR-3B conversion Easter egg (August 2026)

- With a contact tracked, CONTEXT ▸ CONTACTS shows a small 🛸 chip beside COCKPIT (`#tr3b-toggle`, gated by `CockpitView.syncTr3bToggle()` on a tracked contact — not on the cockpit entry policy). Pressing it converts that contact into a TR-3B and pressing it again restores the real aircraft. State lives in `src/data/tr3bRegistry.js`: a session-scoped module-level `Set` keyed by ICAO 24-bit address, shared across both flight layers the same way `militaryRegistry.js` is, so a conversion holds through a civil↔military handoff. It is deliberately NOT persisted (no localStorage, no share-link param, no schema change) and layer teardown deliberately leaves it intact — only a page reload clears conversions.
- The sprite is two hidden kinds (`tr3b`, `tr3bHot`) in `src/data/aircraftIcons.js`, authored in the same 96×96 nose-up pipeline as the eight class silhouettes, so the triangle points along the display course through the existing screen-projected rotation path with `alignedAxis` still `ZERO`. They are unreachable from `classifyAircraft()`. Variant selection rides the existing `irBoost` layer param, so under NVG/FLIR/surveillance the hull stays cold and the four emitters render hot; a style switch re-images only converted contacts, never the rest of the fleet.
- Both layers resolve every `aircraftIcon()` call through a local `_iconKind()` shim (identity for unconverted contacts), so no refresh path — poll reconciler, two-tier raster swap, presentation pass, tracked entity — can revert a conversion.
- The class label follows the conversion across every surface that reports one: tracked card, cockpit/`getTrackedInfo`, Contacts, and the analyst record's `aircraftClass` (`tr3b`, the style-independent id, so a query answers the same in FLIR as in Normal). Callsign, flight level, speed, and route stay live-feed truth.
- A converted contact is billboard-only. It is excluded from model eligibility at SELECTION time, so it never consumes a `MODEL_MAX` cap slot, with the handoff guard and the tracked-model regime guard kept as defence. The billboard stays shown, so the contact keeps satisfying the `getNearby` / `getDetectableObjects` visibility guards and still works in Contacts and Cockpit.
- Regression surface: `src/data/tr3bRegistry.test.mjs`.

### Split-flap status chips (August 2026)

- The three status chips flip their LABELS over character by character when the text changes, like a departure board: `#global-loading-label` ("LOADING LIVE DATA" → "LOAD COMPLETE"), `#traffic-sync-label`, and `#cctv-sync-label` ("loading frames" → "camera grid ready"). All three route through `setSplitFlapText()` in `src/splitFlap.js`; there is no other writer of those three elements. The progress counters (`#*-sync-progress`, `#global-loading-detail`) are deliberately left as plain `textContent` — they tick several times a second, and flapping them reads as a slot machine.
- `#global-loading-label` doubles as the universal top-center status banner, so anything routed through `_showGlobalStatusNotice()` flaps as well — in particular the share-link restore notices, of which "Shared military flight could not be restored — feed unavailable" is the longest at 63 characters. That needs no special case: `planSplitFlap()` compresses the stagger to hold the 620 ms budget (26 ms → 6.9 ms per column at that length), every column is reserved for the whole cascade, and `element.textContent` is the complete notice at every instant, so the `aria-live` region announces the whole sentence rather than a fragment. A notice deferred minutes past boot is equally safe: `ensureHost()` re-validates the shell on every call, and the long-lived `Text` node is never replaced.
- **DOM text is the truth, and its node NEVER moves — do not "fix" this.** The first call upgrades a chip label into a permanent shell (`ensureHost`): a `.gev-flap-text` span holding one long-lived `Text` node, plus an `aria-hidden` `.gev-flap-cells` sibling. After that the ONLY text operation for the life of the chip is `node.data = next`. Nothing is reparented, so the label is never transiently empty and the `aria-live` region never sees a removal/reinsertion pair it could announce twice. `element.textContent` is the settled string at every instant, because the cells carry no text at all: both glyphs are CSS generated content (`::before` from `data-flap-prev` = outgoing, `::after` from `data-flap-next` = incoming), which never reaches `textContent`. This keeps QA pins honest and lets `_updateTrafficSyncChip`'s own `textContent !==` guard keep working. The shell is built on a tick where the text is NOT changing, so no real label change ever carries a structural mutation.
- **No animation loop, and exactly ONE `setTimeout` per change.** CSS `animation`/`transition` only, triggered once per text change and staggered through a per-cell `--gev-flap-delay`. The single timer is the settle that strips the cells; the width ease ends on a `transitionend`/`transitioncancel` listener, never a second timer. Idle cost is zero, there is no periodic work, and nothing requests a Cesium render or takes a render-governor hold. `setSplitFlapText` is a no-op on unchanged text, which is required — the chips are repainted by a 60 ms and a 500 ms ticker.
- **Only what was visible flaps away.** An interrupted cascade (A→B cut short by C) derives each column's outgoing glyph from `visibleGlyphs()` — what that column is actually SHOWING at that instant, which for a column whose stagger has not elapsed is still A, not the pending B. `FLAP_TURN_RATIO` must track the `gev-flap-out`/`gev-flap-in` keyframe crossover in style.css.
- **Columns never renumber mid-cascade — do not "optimise" this away.** For the whole cascade the board keeps one column per index of the LONGER string, each holding its own width; a column the new string does not reach flaps to a BLANK in place (`data-flap-next=" "`) rather than collapsing. Collapsing stacks the absolutely-positioned outgoing glyphs on one x AND lets a later glyph slide into an earlier column, which makes `visibleGlyphs()` lie and the interrupt rule flap the wrong glyph away. Pinned by "a cleared column holds its place instead of letting later glyphs slide left".
- Length changes are eased, never snapped, and the ease is placed so it never fights the flaps (`.gev-flap-sizing`): a GROWING label reserves its columns as the cells go in and eases at the START; a SHRINKING one holds full width for the whole cascade and eases at SETTLEMENT.
- Accessibility: the cells sit in an `aria-hidden` wrapper and the settled string is real text in the a11y tree, so the `aria-live` chips announce the label once per change rather than character fragments. No `aria-label` is used — ARIA prohibits naming a generic `<span>`. Because the text node is permanent and only its data changes, a label update is a single `characterData` mutation and settlement is none — node churn in a live region can double-announce.
- A chip hidden by clean-UI, recording mode, or an un-`.visible` (`opacity: 0`) traffic/CCTV chip swaps instantly instead of animating where nobody can see it; `prefers-reduced-motion: reduce` does the same.
- Kill switch: `SPLIT_FLAP_ENABLED` in `src/splitFlap.js`. Set it `false` and every chip returns to a plain instant swap with no other change.
- Regression surface: `src/splitFlap.test.mjs`.

### Panoptic Detection + Tracked Readout (June 2026)

- `src/data/detection.js` samples enabled layers through each layer's `getDetectableObjects()` contract and renders bounding boxes/labels from the shared host's sole Cesium post-render callback so boxes align with the final camera frame.
- Detection diagnostics count fading labels from the arbiter rows that are
  actually rendered. The label QA harness uses time-weighted label exposure for
  churn and requires conclusive solve/frame samples at both its 12,000-object
  pathological field and 5,200-object normal field without relaxing budgets.
- `src/data/detectionDraw.js` performs the batched, DPI-crisp canvas drawing for tier-colored labels, corner brackets, callouts, and distance-scaled tracked boxes. Unit tests cover label measurement and draw geometry.
- `src/data/trackedReadout.js` publishes a protected shared-host callout above tracked aircraft and satellites or selected mapped installations. It reads only each layer's cached display position—never a fresh entity position evaluation—preventing readout jitter against the rendered target. AIS selection remains in the vessel source's protected card path.

### Not Currently in Runtime

- Weather radar (removed before OSS v1 after QA; no reliable visible payoff)
- General replay/timeline systems outside the Space Missions experience
- LiDAR explorer and paired-point CCTV calibration experiments

## Auth + Launch

- Recommended launcher: `./scripts/dev-fresh.sh` (also: `dev-secure.sh` for stricter bindings, `dev-cctv.sh` for CCTV source-pack tuning)
- Build gate: `npm run build`
- Network access: local-only by default (`HOST=localhost` in dev-fresh.sh); LAN is an explicit opt-in via `HOST=0.0.0.0` (launcher prints a key-exposure warning + LAN URL; see SECURITY.md)
- OpenSky default mode: OAuth (`OPENSKY_AUTH_MODE=oauth`; `anon` works without credentials)
- Google key expected in Keychain service `google-maps-api` (or `GOOGLE_MAPS_API_KEY`, or `.env`)
- OpenSky credentials expected in Keychain service `opensky-network` (or env, or `.env`); `OPENSKY_AUTH_MODE` and `OPENSKY_CREDENTIALS_FILE` read from `.env` too
- Optional-key precedence in `dev-fresh.sh` is uniform — explicit shell env, then `.env`, then Keychain: `OPENAI_API_KEY` (Keychain `openai-api`/`api-key` — voice + HUD summary), `AISSTREAM_API_KEY` (`aisstream-api`/`api-key` — live vessels), `CESIUM_ION_TOKEN` (`cesium-ion`/`token` — Bing stacks), `TOMTOM_API_KEY` (`tomtom-api`/`api-key` — live traffic flow), `FIRMS_MAP_KEY` (`firms-map`/`map-key` — live fires), `LL2_API_TOKEN` (`.env` only)
- An empty string is not "unset" on either side of the launcher, and both sides are handled. `scripts/read-dotenv-value.mjs` hides the requested key from `process.env` for the duration of the read (Vite's `loadEnv` otherwise lets an inherited empty export win over the parsed files) and restores it after. A key the launcher resolves to nothing is then removed from the dev server's environment outright (`env -u`), not merely omitted — the child inherits this shell's environment, and Vite backfills `.env` only over undefined variables, so an empty export in either place would shadow a configured key. `CCTV_CALTRANS_DISTRICTS` is the deliberate exception: empty is its documented Caltrans kill switch and is passed through as-is
- `.env` supported via `.env.example` template

### Proxy/Security Baseline

- CCTV proxy rejects client-specified upstream URLs (server-side source allowlist only).
- CCTV upstream still-image fetches use an explicit abort controller with an
  eight-second timeout; the timer is cleared on every success or failure path.
- OpenSky response cache stores successful upstream responses only; OAuth token refresh calls are coalesced.
- A cold OpenSky failure uses the current camera subpoint only to request a cached adsb.lol point fallback capped at 250 nm. A fresh OpenSky response or last-good cache wins; a nominally successful worldwide snapshot more than two minutes old prefers viewport-scoped adsb.lol when available, otherwise the stale source is reported honestly. The fallback is visibly source-labeled and is never presented as a worldwide snapshot.
- GBFS response size is capped; CCTV health map is bounded.
- Proxy error payloads are sanitized (no internal error details returned to clients).
- `OPENAI_API_KEY` is server-side only; the browser receives ephemeral Realtime client secrets from `/api/realtime/token`.
- `AISSTREAM_API_KEY` is server-side only; the browser reads the same-origin `/api/ais-live` cache.
- `/api/google/nearby-places` keeps the Google key out of Places requests issued for voice scene context.
- `/api/google/text-search` keeps the Google key server-side for view-biased Places recovery used by annotation resolution.
- `/api/overpass` is bounded by body/response caps, per-client/global rate limits, concurrency limits, mirror fallback, in-flight dedupe, cache bounds, and static validation that every selector is spatially bounded.
- `/api/military-installations` uses an independent limiter with the same 90-per-client/300-global one-minute bounds, so viewport installation refreshes never consume `/api/overpass` annotation/traffic capacity.
- `/api/route` proxies bounded OSRM route requests for annotation routes, with profile allowlisting, distance caps, response caps, caching, and sanitized "no route found" errors.
- Track endpoints: `/api/ais-live/track?mmsi=` (server-accumulated ring buffers; sub-route handled before the rows snapshot), `/api/opensky-track?icao24=` (OAuth, 60s cache, sanitized errors, independent OpenSky credit bucket), `/api/adsblol/trace?hex=` (60s cache, 5MB cap, ODbL attribution required in UI).
- Realtime debug logs redact API keys, bearer tokens, client secrets, and image data URLs before writing to disk; request bodies are size-capped.

## UI/UX Runtime Defaults

- Z ladder: panels promote within 100–139 (renormalized on wrap), voice pill 150, toast 200, clean-view exit 300.
- Panel POSITION keys are versioned `v8` (`godsEyeView.v8.panelPos.<id>`); collapsed-state keys remain `v6`. The one-time position reset clears stale DISPLAY placements that could overlap the Context rail.
- Map Source lives in the bottom Visual Presets tray. The left accordion contains no MAP STACK panel, and the `k` panel token that addressed it is gone from the share registry, so legacy `ui=k...` state takes the ordinary unknown-token skip.
- A dock popover (Visual Presets, Location) auto-dismisses on mouse-away unless pinned. Focus inside the tray defers that dismissal only when the browser reports `:focus-visible` — keyboard focus and typed-into fields hold the tray open; a mouse-clicked tile does not, because Chromium focuses a `<button>` on press.
- GEV MIC control is a glass capsule (var(--glass-bg), blur(24px) saturate(1.4), 999px radius; panel radius in error state).
- The desktop right rail (`#right-context-rail`) owns `DISPLAY`, `CCTV`, its active parameter controls, and `GLOBAL CONTEXT` as one fixed responsive stack in that order. Its compact buttons use the same 176 px width as the left accordion and one consistent 50 px height, share the left stack's 52 px edge inset and measured top baseline across HUD variants, then constrain themselves against visible HUD/chrome rectangles and the remaining vertical corridor. `DISPLAY` is no longer draggable and legacy saved coordinates are ignored.
- The right rail is labeled **DISPLAY** (formerly "MOVE") and groups, in order, HUD, DETECT, Bloom, Sharpen, 3D, Clean-UI (HUD + DETECT promoted to the top). Its expanded controls retain the same compact 176 px width as the right-side tabs instead of growing to the wider Context detail-card width. It starts expanded on first run and respects the user's later `v6` collapse choice. Collapses/expands with directional chevrons (`◀` collapsed, `▶` expanded).
- Display and Context use matching 330 px expanded widths and matching compact tab dimensions. The parameter panel is part of Display's expanded content. DISPLAY may remain open beside one contextual panel; CCTV and Context are mutually exclusive. In Tactical HUD, expanding CCTV or Context hides the other contextual launcher while DISPLAY remains independently available. The most recently opened right-rail panel owns the constrained lane even when it appears later in DOM order; passive restoration and automatic disclosure do not replace that explicit owner. Minimal and other HUD layouts retain the collapsed launchers; when their active panel exceeds the measured corridor, the rail reserves sibling heights and gaps and scrolls the active panel internally.
- `STYLE PRESETS` and `LOCATIONS` start collapsed, expand on intentional hover/click, and auto-collapse after hover leave delay.
- Collapsed mini-status indicators show active style and active location/landmark.
- Detection mode is user-controlled and should persist when switching styles. Since 2026-08-22 it also STARTS on — Dense @ 75% for every style on a first run, Normal included — as a `GLOBAL_POST_DEFAULTS` baseline that does NOT set `_detectionUserOverridden`. Exception (unchanged): selecting a military style (CRT/NVG/FLIR) auto-enables the same Dense preset, but only until the user manually changes detection this session (`_detectionUserOverridden` gate), after which style switches never touch it.
- Detection runs in the bottom lane of the shared host's single world-overlay `postRender`
  listener (not `preRender`) to eliminate bounding-box drift at close zoom.
- **Detection takes NO continuous-render hold (2026-08-22, `src/data/detectionRenderDemand.js`).**
  It repaints on CHANGE and asks the governor for exactly one more frame while work that spans
  frames is still outstanding. This is load-bearing for the detection-on-by-default flip: the old
  unconditional `holdContinuousRender('detection')` would have pinned every idle first-run tab at
  60 fps, defeating the render governor. Measured on a parked scene with zero layers: **0 renders
  per 5 s with detection ON, identical to OFF**; reinstating the hold gives 301. Gated by
  `scripts/qa-perf.mjs` §1b, which also counts the PAINTER's own frames so a painter that had been
  disabled outright could not score a perfect idle. The invariants — each of which a live
  adversarial review found broken in the first cut:
  - **Every kind of outstanding work must terminate.** A predicate that can stay true forever is
    the hold under another name. Three qualify: the enable fade-in, label fades, and a solve the
    frame could not run.
  - **Label fades count in BOTH directions.** A newly selected label is `selected`; counting only
    the fade-out tail left it invisible on a parked scene until an unrelated frame arrived.
  - **Paint and demand share ONE monotonic timestamp** — the host frame's `frame.timestamp`
    (`performance.now()`, sampled once per frame). Re-sampling dropped the terminal frame of a fade
    (paint at 219 ms drew alpha 0.99545; a policy re-reading at 220 ms said "done"), and a wall
    clock that jumps backwards keeps demand alive until it catches up. Nothing in the draw pass may
    use `Date.now()`.
  - **A skipped paint DEFERS, never cancels.** The relief valve's skip and its follow-up request
    come from one decision (`detectionPaintSkipDecision`), so it cannot drop the only frame that
    was requested.
  - **A changed detectable set dirties the solve.** Detection PULLS candidates per paint but
    re-solves on a private 125 ms throttle, so a layer tick that swapped contact A for B could be
    spent on a paint that declined to re-solve. `markDetectionSourcesChanged()` is called from the
    manager's layer tick and visibility change, next to the render request each already makes —
    discrete events seconds apart, never per frame — and it deliberately does not request a frame
    itself, because the caller already did.
  - **AIR brackets stay prompt because the AIRCRAFT LAYERS hold the loop, not detection**
    (verified live 2026-08-23). Brackets — including the alpha-floored ones — are painted inside
    `_drawOverlay` from live positions and take no part in the sources-changed notification, so the
    obvious worry is a floored bracket sitting stale on a parked scene. It cannot: an AIR bracket
    exists only while an aircraft layer is enabled, and `flights.enable()` /
    `militaryFlights.enable()` each take a continuous-render hold for their own per-frame fleet
    animation. For exactly as long as there is anything to bracket, the scene renders every frame.
    Measured on a parked camera: `holds: ["flights"]`, `requestRenderMode: false`, and an
    outside-aircraft population change moved the painted bracket count with no camera input. This
    is a COUPLING, so `detectionRenderDemand.test.mjs` pins it — a later perf pass that strips those
    holds the way it stripped detection's would take bracket promptness with it, silently.
  - Known, pre-existing, and deliberately out of scope here: the overlay's backing store does not
    re-derive on a DPR change mid-session (`worldOverlay` sizing — untouched by this work).
- The detection MODE BANNER (`DENSE VIS:… SRC:… DENS:…% ELASTIC …ms`) is
  developer telemetry and is HIDDEN by default. It paints only under
  `?detectDebug=1` (the `trafficDebug` convention), resolved once per
  `initDetection`. The same numbers are always available from
  `getDetectionDiagnostics()`. On a zero-object frame the "armed, nothing in
  view" signal is carried by the scanlines and sparse focus ring, not the banner.
- The HUD summary's `NEAR <landmark>` callout is capped at 150 km (metro scale).
  Beyond that it falls through to the `SECTOR <lat> <lon>` readout. The POI
  catalogue covers eight cities, so a looser bound made the HUD announce
  landmarks on other continents.
- Panoptic mode shows labels on ALL items (no stride skipping). Tracked/selected items keep bounding box but suppress label (skipLabel flag). Tracked items get enlarged bounding boxes (56×44 vs default 22×14).
- The 3D aircraft toggle reveals `Proximity` and `All` modes and drives both commercial and military aircraft layers. It ships ON in `Proximity`, so the button paints lit and the mode row paints open from markup; the panel is therefore ~36 px taller than before, which Cockpit's Display/Radio strip absorbs through its existing primary-only corridor solver.
- The host-painted tracked-target readout sits above the post-FX layer and follows tracked aircraft/satellites or selected mapped installations using each layer's display-position contract.
- Cockpit entry is gated to the operational Contacts context bundle. The
  Context chooser must be in Contacts mode, Live Flights and Military Flights must both
  be enabled, and a civilian or military aircraft must be tracked. The visible
  Cockpit actions and the `C` shortcut use the same gate, so ordinary standalone
  flight-layer selection cannot enter a context-dependent cockpit.
- **Aircraft cockpit view:** selecting a commercial or military aircraft reveals a `COCKPIT` action (`C`). Cockpit mode temporarily releases Cesium's orbit-follow transform and drives a first-person camera from the tracked aircraft's existing smoothed display position and course. Its concave helmet-visor HUD shows callsign, UTC time, coordinates, curved roll/pitch guides, and a seven-division heading tape. Ambient commercial and military AIR contacts use a Cockpit near/far band selected by the shared Display 3D mode: Proximity admits at 150 km and retains to 185 km; All admits at 400 km and retains to 450 km. The shared 3D toggle now applies in Cockpit: Off keeps in-range contacts as rotating 2D aircraft silhouettes, while On lets a ready admitted glTF take over without a drawing gap. The Cockpit model cap remains 60 and can only lower the map budget; in-range contacts that are capped or still loading remain 2D silhouettes instead of degrading to out-of-range dots. Contacts outside the selected band use small rotation-free cyan-white pips for civilian aircraft and amber pips for military. The pilot's own airframe is not drawn in first person, and exiting clears the Cockpit band and restores normal map silhouettes/models. The normal left accordion remains available for Layers and Scenes and keeps the same 26vh HUD-aligned anchor used in map mode, independent of whether the bottom-left Contact card is expanded or collapsed; the right-rail CCTV and Context chooser are hidden to avoid duplicating or overlapping the cockpit presentation. When the intelligence HUD is enabled, its classification, scene summary, collection/orbit metadata, coordinates, and imaging-status text remain visible as reduced peripheral cockpit telemetry; the optical center and flight instruments stay clear, and turning the HUD off still hides it. Ground speed, exact heading, and rendered altitude form one compact lower-center instrument cluster, keeping the horizon and peripheral view open. A second live altitude tape hugs the inside-right visor rim: its rail and nine moving ticks are derived from the same responsive keyhole radius, remain 20 px inside the circular edge even on wide displays, fade deeply at both vertical ends, and move continuously behind a fixed current-altitude pointer; its interval tightens automatically near the surface and it is suppressed on narrow screens. Cockpit mode also has a weather-backed transparent volumetric-cloud pass derived from the supplied FBM/domain-warped R&D shader. It renders at no more than 520×320, uses 24 ray steps/three FBM octaves at 12 FPS, is clipped to the visor, fails clear when Open-Meteo is unavailable, and stops its animation completely on cockpit exit. It does not restore the prior CPU weather canvases, precipitation, scene fog, or any map-mode effect. When Contacts is active for the tracked aircraft, the compact `CONTACT` rail adds the 250 km subject window, four cohort counts, nearest observed/mapped example with relative bearing and distance, freshness, explicit uncertainty, and Previous and Next controls plus its own collapse control. The mirrored right rail is a three-page **cockpit briefing carousel**: source-backed live signals, location-matched regional headlines, and local place/current-weather context from OpenStreetMap Nominatim and Open-Meteo. It is manual-first: Previous, Next, and direct page controls are always available, and the visible `CYCLE OFF` / `CYCLE ON` control starts or stops the nine-second page cycle. The cycle pauses on hover or keyboard focus and stops while collapsed, hidden, or outside cockpit mode; live signal data continues refreshing either way. Empty news matches and unavailable news use compact text states rather than reserving an empty media frame; partial local data remains explicit. Article links open their original publisher, and no headline is treated as verified risk intelligence. On desktop both cockpit rails use the same width and share a bottom-aligned safe baseline in opposite corners above the peripheral MGRS/GSD/time telemetry, leaving both that text and the lower-center instrument cluster readable. They collapse independently to slim tabs without stopping live data updates. Narrow screens use separated top/bottom fallbacks. Empty-space globe clicks are inert while cockpit owns the camera; `C`, `Escape`, or `EXIT COCKPIT` explicitly exits and restores the same tracked entity and standard follow camera. Unknown feeds remain unknown, selection loss still exits safely without inventing a replacement track, and the cockpit never presents the summary as threat scoring or an all-clear. This is a desktop first-person presentation, not a WebXR session.
- **Cockpit left-panel clearance:** the Cockpit Contact card and peripheral HUD participate in the adaptive left accordion's live obstacle measurements, including live viewport-height changes. Expanding Layers or Scenes keeps the active panel in the available upper-left corridor with internal scrolling; it does not cover the Contact card, lower Cockpit controls, or Cesium credit line. Outside Cockpit the hidden card does not alter the normal corridor.
- **Cockpit Context scope:** the 250 km radius applies to the air/sea proximity cohorts. Installation counts come only from the currently loaded viewport and are labeled `CURRENT VIEWPORT ONLY` in the cockpit as well as the normal Context panel; neither surface presents them as a complete 250 km installation survey.
- **Cockpit camera anchor:** first-person mode does not write feed-boundary corrections directly into the camera. A cockpit-only inertial anchor advances from the selected aircraft's displayed course and speed, then converges toward the authoritative delayed track with correction capped below forward motion. The displayed kinematics are derived from the same consecutive fix segment as the rendered position, with raw feed speed/course used only as fallback; a transient zero/missing feed speed therefore cannot freeze a visibly moving aircraft after layer enable or a map/cockpit handoff. Rendered altitude continues to come from that interpolated track position. Late ADS-B fixes and short render stalls can remove drift without accelerating or reversing the view. Camera placement runs before scene update/culling at a bounded 20 Hz so a moving cockpit does not force Photoreal 3D Tiles to retraverse on every display frame; textual instruments update at 10 Hz and context/layout work at 4 Hz. Every far Cockpit contact pip shares one stable Cesium texture-atlas entry and skips unused screen-projected course calculations, while only in-range 2D aircraft silhouettes pay the screen-projected rotation cost; ambient glTF collections are hidden/retained rather than synchronously destroyed at cockpit entry, and context rails lay out only on explicit content/state changes and viewport resize. The deliberate 15/30-second layer interpolation delays and per-Cesium-frame position caches remain unchanged.
- **Cockpit route, vision, and view controls:** visible on-screen `COCKPIT`, `RESET`, and `EXIT COCKPIT` controls replace reliance on the `C` shortcut. RESET uses the same canonical globe route as the map and voice actions, exits Cockpit, and releases its camera ownership rather than exposing the hidden map-style top action. When the tracked commercial flight has a plausible ADSBDB route, the top of the right briefing rail shows a compact `FROM → TO` airport strip and the visor shows a centered estimated-destination chevron with its relative bearing; absent or implausible route data hides the strip and cue rather than guessing. The cockpit-local vision control is an interactive `PREV / CURRENT / NEXT` carousel over the inherited map preset, `CRT`, `NVG`, `FLIR`, and `NOIR`; its previous/next actions wrap, and activating the current value advances to the next style. The inherited entry is named directly, such as `NOIR`, and retains that map shader. There is no empty `NONE` entry. CRT, NVG, FLIR, and NOIR temporarily activate the existing Cesium post-process stages, while returning to the inherited entry or exiting Cockpit restores the pre-entry visual style. The regional-news page uses a free Google News RSS locality query first, with the existing GDELT query retained only as a fail-soft fallback; linked headlines remain reporting, not verified incidents or risk intelligence.
- **Cockpit weather status:** the earlier multi-canvas atmospheric compositor remains fail-closed and is not attached to the live viewer. Cockpit clouds are a separate transparent WebGL pass with a capped 520×320 framebuffer, 24 ray steps, three FBM octaves, and a 12 FPS ceiling. It defaults off and starts only when local storage explicitly contains the persisted `WX ON` opt-in (`'1'`). When opted in, observations refresh after five minutes or 25 km of aircraft movement, fail transparent when unavailable or clear, and stop on exit or disable. `WX OFF` governs atmospheric rendering only: the briefing still fetches source-backed Nominatim, headline, and Open-Meteo local-information data, aborting and replacing any in-flight request when the selected aircraft changes. No weather effect runs in map mode and no synthetic fallback is shown.
- **Cockpit trail visibility:** entering cockpit hides the selected aircraft's trail body and head so they cannot cross the first-person view; exit restores them. This cockpit-only presentation change does not alter the normal map-mode invariant that aircraft trails render through terrain using their depth-fail material.
- **Aircraft course slew:** civilian and military 3D models retain the 60°/s course limiter, but each rendered frame can consume at most 250 ms of accumulated slew time. A long tile/render stall therefore catches up over multiple visible frames instead of turning one delayed frame into a heading snap.
- **Manual-first cockpit briefing:** the right-side Live Signals / Regional News / Local Info carousel does not advance automatically on page load. Previous, Next, and direct page controls remain available; the visible `CYCLE OFF` / `CYCLE ON` toggle explicitly starts or stops the nine-second page cycle, which still pauses on hover/focus and while collapsed, hidden, or outside cockpit mode. Live signal data continues refreshing in either state.
- **Photoreal horizon blend:** Cesium's sky atmosphere remains enabled behind the hidden base globe, but its light intensity, saturation, and brightness are reduced from the library defaults so the distant Google Photorealistic 3D Tiles boundary blends into the sky instead of producing a bright cyan horizon seam.
   - **Cockpit direction and speed tapes:** plausible destination metadata now drives one translucent, isometric visor chevron labeled directly below with the estimated geographic bearing; the prior full geodesic dashed path is not rendered. A mirrored live ground-speed tape follows the inside-left keyhole rim using the same responsive curve, end fades, fixed pointer, and fractional tick motion as the altitude tape on the right. Speed values scroll upward as they increase while altitude values scroll downward. Its tick endpoints and current-speed pointer share the rail's inset-circle origin, so the markings stay attached to the visible curve rather than drifting inward with the text-label gutter.
- Voice control UI (`#gev-voice-control`) shows status states OFF / CONNECTING / LISTENING / EXECUTING / ERROR.

### Current Global Post Defaults

**Reasonable-defaults batch (2026-08-22), extended and partly revised
2026-08-23.** First-run defaults move together as one coherent console
presentation. Every one is a FIRST-RUN baseline only: a
share link or the operator's own hand still wins over it, and none of them sets
the `_detectionUserOverridden` / explicit-intent flags that would suppress a
separate landed behaviour. Pinned in `src/reasonableDefaults.test.mjs` (feather,
detection, OUTSIDE opacity) and `src/data/layerState.test.mjs` (3D).

**The 2026-08-24 defaults** (superseding the interim 08-23 values of 8%/3%):
the first-run look is Detection DENSE
`75%`, ELASTIC allocation, Fade `7%`, OUTSIDE opacity `1%`, scope feather `11%`,
and 3D fleet mode PROXIMITY, with `AIRCRAFT_BRACKET_FLOOR_ANCHOR` at `0.01` so
brackets keep their approved brightness exactly at the new OUTSIDE default. Two
terms that must never be conflated: scope FEATHER softens the black scope-mask
edge; detection FADE is the label/card fading band around the keyhole. The
OUTSIDE slider's `step` stays `1` so every low stop is reachable.

**Allocation, defined precisely** (matches
`src/data/labelArbiter.js` `allocateLayerQuotas`): **ELASTIC** begins with
roughly equal capacity across active layers and redistributes unused
entitlement (`labelArbiter.js:170`); **WEIGHTED** allocates using visible
demand with square-root demand scaling and semantic layer weights
(`labelArbiter.js:181`). First-run default: ELASTIC.

**A default has THREE surfaces, and a PARSE fallback that is not one of them.**
The value literals (engine constant, markup value, markup readout, `ui.js`
`GLOBAL_POST_DEFAULTS`, the share generator's starting state) must all move
together, because a fresh boot runs no restore and those literals ARE the startup
state. The `scf` / `ko` PARSE fallbacks deliberately do NOT move: they answer
what an OLD LINK that omits the field meant, and such a link was authored under
that era's default (`scf` → 35, `ko` → 5). Every link since carries both fields
explicitly, because the generator always writes them, so no era whose default
later changed depends on a fallback either way.

**They do NOT all persist the same way, and only one of them persists at all.**
Worth stating plainly, because "a default you can override" and "a default that
remembers" are different promises:

- **3D models** have durable storage — `gev:layer-state:v2` in local storage,
  written by `LayerStateCoordinator` on explicit intent. A session that stored a
  snapshot keeps whatever it stored, across tabs and restarts.
- **Detection mode/density and scope feather have NO storage key at all.** Their
  only durable carrier is the URL hash (`dm`/`dd`, `scf`), written on a 500 ms
  debounce. A same-URL reload therefore keeps them only if that debounce already
  fired; a bare URL or a new tab returns to these defaults. That is unchanged by
  this batch — it is simply what these controls have always done — but it is the
  reason "stored state wins" is true of the 3D toggle and not of the other two.

**Known edge (detection, pre-existing, deliberately not redesigned here):** a
hash-restored `dm=OFF` restores the MODE but not `_detectionUserOverridden`,
which is session-scoped. A recipient of an OFF link who then selects a military
style therefore gets the style's auto-enable, where the original author — who had
turned detection off by hand — would not have. The default flip makes this edge
easier to meet (detection is now on more often), but does not create it.

- Bloom: `OFF`, intensity slider at `100%`
- Sharpen: `ON`, intensity slider at `49%`
- HUD: `ON`, layout `tactical`
- **Detection: `DENSE` @ `75%`** — ON for EVERY style on a first run, Normal
  included (was `OFF` @ `50%`). It is literally the same frozen
  `MILITARY_DETECTION_PRESET { mode:'dense', densityPct:75 }` object the military
  styles and the Contacts context mode already apply (Contacts OWNS detection
  while active and restores the prior state on exit — `contactsDetectionPolicy.js`;
  Cockpit deliberately does not touch detection at all), read by
  `GLOBAL_POST_DEFAULTS`, so there is one tactical look rather than several that
  can drift. Fade opens at `7%` since the 2026-08-24 final lock (`16%` before it). Style-switch semantics are
  unchanged: CRT/NVG/FLIR still carry `detection: MILITARY_DETECTION_PRESET` and
  still yield to `_detectionUserOverridden`; Normal still has no
  `STYLE_PRESET_DEFAULTS` entry, so switching TO Normal touches nothing. A share
  link carrying `dm=OFF` still restores OFF.
- **Detection OUTSIDE opacity: `1%`** (moved `5% → 3% → 1%` on 2026-08-24).
  `KEYHOLE_OUTSIDE_OPACITY_DEFAULT` in `src/celestialRing.js`, mirrored by
  `#detection-opacity-slider`'s markup value AND readout,
  `GLOBAL_POST_DEFAULTS.detectionOutsideOpacityPct` in `ui.js`, and
  `_detectionOutsideOpacityPct` in `sharelink.js`. The slider's `step` is now
  `1`, so 1–4 % are reachable at all (at the previous step of 5 the entire
  sub-default range was one stop wide). `AIRCRAFT_BRACKET_FLOOR_ANCHOR` in
  `src/data/detectionPolicy.js` MOVES WITH IT — the AIR bracket floor is
  calibrated so `AIRCRAFT_BRACKET_ALPHA_FLOOR` (0.35) lands exactly at the
  default, and the mapping follows bracket brightness rather than slider
  position. The `ko` PARSE fallback stays at `5`.
- **Scope feather: `11%`** — a soft scope-mask edge (moved `0% → 8% → 11%`; `0%` hard crop for one day,
  `35%` before that). `SCOPE_FEATHER_RATIO_DEFAULT` in `src/scopeMask.js`,
  mirrored by `#scope-feather-slider`'s markup value AND readout and
  `_scopeFeatherPct` in `sharelink.js`. The slider is untouched and still spans
  0–100, and an explicit `0` is still the hard-crop path — pinned, so moving the
  default cannot quietly delete it. The `scf` PARSE fallback deliberately stays
  at `35`: a link predating `scf` was authored when 35 was what its author saw,
  and restoring the author's view is what a share link is for.
- **3D aircraft models: `ON`, mode `proximity`** — see the 3D Aircraft section
  above and the DISPLAY-rail entry below (was `OFF`).
- Style shader starting params: CRT/NVG/FLIR pixelation `1.2` (just above the native `1.0` floor); thermal/FLIR ships an optional Ironbow "Predator" palette (`palette` uniform, default `0` = accurate grayscale).

## Operational Notes

- **Earthquake discs are STATIC geometry.** Every quake is a `CLAMP_TO_GROUND`
  ellipse; a `CallbackProperty` axis re-tessellates its ground primitive every
  frame, which cost 32.4 ms/frame and 30 fps on the shipped 58-event feed. The
  axes are plain numbers, redefined only when a poll brings new data, and the
  former ±15% radius pulse is gone. Because nothing in the layer animates
  per frame, it holds NO continuous-render hold — the governor stays idle with
  earthquakes on, and the manager's `layer-tick` / `layer-visibility` requests
  carry new data to the screen. Pinned in `src/data/earthquakes.test.mjs`.
- **Geocode framing has an off-centre sanity gate.** A viewport that is both
  bigger than any city (>300 km diagonal) and not centred on its own geocoded
  location (anchor >15% of the diagonal from the centroid) is replaced by a
  40 km metro box on that location. This is what stops "Tokyo" — which geocodes
  as the PREFECTURE, islands and all — from framing open Pacific. `country`
  results are EXEMPT by decision (several have the same pathology from overseas
  territories; reframing a country is a product decision, not a bug fix), and an
  explicit `viewMode: 'overview'` ask bypasses the gate entirely so "show me an
  overview of Hawaii" still frames the whole administrative area.
- **Viewport framing is antimeridian-safe.** `flyToViewportBounds` pads from the
  short-way-round longitude span and wraps the padded edges, so a dateline-
  crossing box stays its true width. Raw subtraction inflated a 0.41° metro box
  to 86.7° and a 60° territory to 132°.
- CCTV calibration persists at `godsEyeView.cctv.calibration.v2` (v2 rebuild;
  the store was wiped clean, no import from the old `v1` key).
- CCTV v3 floor QA pins are: zero samples for heading-only edits; zero transient
  samples and constant elevation during E/N drag; one shared-floor resolution on
  release; late one-shot shared-cell work is permitted during viewshed idle. The
  A+B harness intentionally excludes citywide LOD assertions.
- Draggable panel positions persist at `godsEyeView.v7.panelPos.<panel-id>` (collapsed states at `godsEyeView.v6.panelCollapsed.<panel-id>`).
- Legacy draggable-panel position keys may remain in local storage for backward compatibility, but the map-mode right rail ignores them; collapsed states still persist at `godsEyeView.v6.panelCollapsed.<panel-id>`.
- Flight/military tracked entities cache dead-reckoned positions per frame to avoid callback desync flicker.
- Aircraft 3D-model and tracking invariants are covered by `npm run test:track`; run this before touching `flights.js`, `militaryFlights.js`, `detection.js`, or `trackedReadout.js`.
- Annotation resolver behavior is pinned by `src/annotations/annotationResolver.test.mjs`; re-run that suite before changing place-resolution scoring.
- Layer input handlers (click + keydown) are detached on disable for flights/military/satellites/AIS vessels.
- Traffic tile cache is capped and traffic layer supports explicit destroy cleanup.
- Traffic feed state is honest about simulation. `getStats().mode` is the
  CONFIGURED source ('live' = a TomTom key is present, 'sim' = keyless), NOT
  this instant's health — health rides on `error`. Keyless reads FALLBACK with
  `SIMULATED — add TomTom key for live` in both the sync chip and the panel
  meta line; an unreachable `/api/tomtom/status` reads
  `SIMULATED — traffic service unreachable`; a total flow-fetch failure in live
  mode sets `error` (DEGRADED · `SIMULATED — <reason>`) and zeroes the stale
  coverage number. `stats.loading` covers outstanding flow work as well as the
  road fetch, so a failure landing after the 250 ms paint race still ends the
  shared loading batch as LOAD FAILED. Harnesses must gate on `!stats.error`,
  never on `mode === 'live'` alone.
- Traffic runs in `sim` mode (white dots, hardcoded speeds) unless `TOMTOM_API_KEY`
  is configured (env or Keychain `tomtom-api`/`api-key`), which enables `live` mode:
  TomTom flow vector tiles via the budget-governed `/api/tomtom` proxy
  (`.gev-cache/tomtom/`, 120 s TTL, `TOMTOM_DAILY_TILE_BUDGET` default 40k/day),
  decoded client-side (`flowTiles.js`), matched onto Overpass roads
  (`flowMatch.js`), and rendered as green/amber/red dot color + speed/density
  scaling (`trafficFlowStyle.js`); closures spawn no dots; unmatched roads stay
  white. Road fetch bounds center on the camera look-at point (`trafficBounds.js`).
- Development captures opened with `?trafficDebug=1` mint an interaction anchor
  from the exact `camera.changed` event that arms each debounced load, then emit
  scheduling-correlated User Timing entries for production `response.json`, road
  parse, flow-race, dot construction, heat-line rebuild, and next-post-render
  boundaries. Every trace is paired with the exact camera-change that scheduled
  its load; mismatches are counted drops. Cesium's `moveEnd` remains a diagnostic
  mark only: it arrives about 500 ms after stillness, typically after fetch has
  begun, and fetch never waits for it. Production builds remove the flag, hooks,
  counters, and timing labels.
- Voice debug log: `tail -f .gev-logs/realtime-conversations.jsonl` (gitignored).

Replay chase-camera updates run in Cesium `preUpdate` before scene traversal, preventing 3D-tile refinement stutter when the mission replay speed is reduced. Replay Ascent first gives the selected launch site a five-second tile-preparation hold before displaying the T-minus countdown. Replay ascent duration is mission-specific: disclosed insertion, SECO, or separation timing is compressed into the replay, while sparse records use reconstructed path length with bounded fallback timing instead of a universal fixed duration. Replay transitions directly from ascent to orbit; stage re-entry/recovery remains static contextual linework and is never a camera-tracked playback phase. The screen-space rocket/thrust symbol renders at 50% of its 92 × 138 px design box, while the separate callout text remains unchanged. Successful/upcoming selected missions show a current orbit marker: green for a reliable TLE match or amber and explicitly estimated when no live match exists. Failed launches show their source status and suppress live/estimated orbit markers and fallback rings. A retained Launch Library orbit is labeled as the planned target, an absent ascent is reported as unavailable, and replay-only controls remain hidden unless the selected mission has a rendered track; authoritative supplied trajectory points remain visible when present. Mission orbit primitives realign by model matrix each tick from the same current-GMST frame as their marker, preventing ring/marker drift; their host annotation reads the position cache updated in that same tick. During depth-dominant ascent segments, the replay rocket retains its last valid path-facing rotation rather than snapping toward the camera. Mission selection and replay overlays never call photoreal `sampleHeight()` from the render loop; the launch-zone ground primitive and precomputed surface-safe replay path avoid remote tile-refinement probes that previously caused a one-second globe texture pulse. The shared host replaces the former mission-label visibility churn and quadratic overlap loop; the layer's remaining frame sweep only culls native point/billboard geometry and refreshes selected UTC copy when its displayed second changes. Replay samples uneven path vertices by cumulative distance and normalizes camera-yaw easing to frame time.

Orbit replay framing uses one combined bounding sphere for Earth and every sample of the selected orbit. The camera derives its final range from that full envelope, while its look-at target retains a radial bias toward the moving vehicle rather than collapsing onto the singular Earth-center frame. Compact-orbit launchers therefore remain tracked during camera rotation, and highly eccentric transfer orbits still keep both the globe and their distant apogee arc visible. The orbital camera stays on one side of the mission's 3D orbit plane and uses the vehicle radial as visual up, so forward motion remains screen-left through polar/local-heading wraps instead of alternating left and right. The fixed-size cyan orbit dot retains one pixel scale throughout the pullback. While replay owns the camera, the selected launch-site host label is suppressed so it cannot duplicate or overlap the replay vehicle's DOM callout; cancel/completion restores it.

Mission ascent paths use a long cubic insertion transition that matches the incoming climb direction and the sampled orbit tangent. Because a Cartesian cubic can otherwise chord through the ellipsoid for some inclined insertion geometries, every blended sample preserves the original climb's smooth minimum-altitude envelope. This removes the artificial right-angle insertion corner and corresponding rocket heading snap without allowing the ascent path to enter the globe.

Insertion is source-aware: catalog-backed missions propagate the matched satellite to the historical insertion epoch. Projected missions have no authoritative historical phase, so their orbital plane starts over the launch site and follows a plausible launch azimuth—south-southwest for western North American sites and polar missions, eastward otherwise. The projected insertion advances only by the disclosed ascent duration or a ten-minute fallback, producing one continuous downrange climb into the forward orbit tangent instead of using UTC as an arbitrary phase and correcting through a 180-degree hook.

The reconstruction does not add a full revolution around Earth: ordinary launch vehicles use a gravity turn and downrange acceleration before orbital insertion, rather than spiraling around the planet during powered ascent.

At close range, the selected launch site's 500 m highlight is a single material-backed `GroundPrimitive` classified against both terrain and photoreal 3D Tiles. It has no fixed world-space height offset, so the translucent disc and rim remain draped across the rendered launch-site surface during tile refinement. A small render-state polygon depth bias keeps coplanar ring fragments above the photoreal mesh at low oblique angles without making the geometry float or drift.

The Space Missions roster prioritizes data-rich records using available mission, orbit, payload, trajectory, timeline, and recovery fields; launch time remains the tie-breaker.

When no live catalog track is available, the mission view marks the approximate orbital ring as `PROJECTED ORBIT` in purple and renders the ascent-to-insertion transfer in green; catalog-backed satellite orbits remain cyan.

The replay vehicle is a smaller solid cyan silhouette without the former orange flame; its initial pad anchor uses photoreal terrain, globe height, or launch elevation fallback so it remains above the surface during tile loading. Replay begins at a close launch-complex range so pad detail remains visible before the camera widens into the ascent context view. Its initial camera heading is perpendicular to the ascent/orbit direction for a profile view, then eases into tangent tracking. Small screen-space reprojection changes are damped for the animated marker on both ascent and orbit, while large camera or phase changes snap to the authoritative path position.
Space Missions keeps the Satellite layer available for catalog/TLE matching but suppresses its standalone fleet points and orbit rings. While those visuals are hidden, their per-frame dense propagation, one-second core point-buffer rewrite, and one-second orbit-matrix rotation are suspended; selected mission telemetry continues to propagate independently. The selected mission's live or estimated satellite marker uses fractional wall-clock time, so it moves continuously rather than creating a once-per-second position discontinuity and one-frame photoreal globe LOD pulse.

During ascent replay, the camera, Cesium callbacks, and HTML vehicle overlay share one replay sample per rendered frame. The tracked overlay is projected directly from that shared position instead of applying a second screen-space lag filter, preventing the vehicle and globe from repeatedly advancing and snapping back.

After the initial broadside launch profile, the ascent chase camera stays in a rear-quarter view about 30 degrees off the vehicle's forward path bearing, widening smoothly toward 45 degrees as orbit context appears. Cesium's `HeadingPitchRange` already places the camera opposite the supplied heading vector, so replay does not add a second 180-degree inversion; the trajectory therefore travels away toward the horizon while remaining visibly offset from the screen centerline.

During orbit replay, the camera continues following the selected vehicle but eases its look-at target down toward the vehicle's sub-satellite globe anchor. The range expands when necessary for high-altitude missions, keeping both Earth and the tracked label visible through the full revolution. The active replay clock clamps at the final orbital sample rather than wrapping to ascent progress zero; replay completion therefore leaves the final globe/orbit framing in place and does not return to the launch site.

Reconstructed mission orbits use a small downrange launch-to-insertion arc, so their estimated ground track is not artificially drawn directly over the launch pad in top-down views. The ascent remains connected to the ring at its selected insertion point.
Collapsed right-rail controls use the same 176 px width as collapsed left-rail controls, while expanded right-side detail panels retain their independent widths. DISPLAY starts expanded only on first run and then respects persistence; DISPLAY may remain open beside CCTV or Context, while CCTV and Context remain mutually exclusive without persisting forced collapses. Selecting a dedicated Context mode opens its right-side surface and clears unrelated layers after first snapshotting their exact state. Final exit restores the original enabled set and changed parameters. Cockpit View hides the right-side CCTV control because CCTV is not part of the cockpit rail. Airborne cockpit altitude uses the tracked aircraft's reported aviation MSL altitude, never the potentially negative Cesium terrain/ellipsoid render height; confirmed grounded contacts display `0 ft` without rewriting that source field. A cold photoreal floor shows `ACQUIRING SURFACE` for at most five seconds, then uses the source target-height fallback instead of freezing the camera indefinitely.
Replay transport uses one Play/Pause toggle plus Cancel. During ascent only the active thrust ring is visible; stage-recovery handoff uses a pulsing dot.

## Tooling Snapshot

- `tools/cesium-render.mjs`: headless Cesium render capture via Puppeteer.
- `tools/streetview-panorama.mjs`: Street View tile panorama stitcher.
- `tools/streetview-headings.mjs`: heading sweep capture; supports neighbor traversal.
- `tools/pano-pinhole.mjs`: equirectangular-to-pinhole reprojection.
- `tools/sat-ortho.mjs`: Map Tiles ortho stitch and centered crop with georef corners.
- `scripts/track-regression.mjs`: headless real-app regression harness for aircraft tracking/model/detection invariants (`npm run test:track`).
- `scripts/qa-map-source-tray.mjs`: browser proof for the four-source Map Source
  tray — presentation, keyboard disclosure, responsive bounds, unpinned
  auto-dismiss, ACQUIRING status, and retired/unknown stack-id restore
  (`QA_BASE_URL=http://localhost:4173 npm run qa:map-source-tray`). Add
  `-- --keyless` to force the no-ion-token expectations on a keyed server; both
  invocations are gates.
- `scripts/qa-l9-matrix.mjs`: the L9 release-candidate QA matrix in one command
  (`node scripts/qa-l9-matrix.mjs --url http://localhost:4173`). Orchestrates
  the `qa-*.mjs` fleet plus `track-regression` as subprocesses and adds
  repo/feed/in-browser probes; a check whose key the target lacks is SKIPPED
  with an OWNER-RUN tag rather than failed. Run with `--list` to print the
  manual checks it cannot automate.

## Maintenance Rule

When runtime behavior or architecture changes, update this file in the same change set as code updates.
