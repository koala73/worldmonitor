import * as Cesium from 'cesium';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { isRateLimitedOutcome, resolveAnnotationTarget } from './annotationResolver.js';

// Dev convenience: expose the app's Cesium instance for console/preview probing
// (single shared module instance — avoids dual-Cesium state bugs when testing).
if (typeof window !== 'undefined' && !window.__CESIUM__) window.__CESIUM__ = Cesium;

/**
 * Annotation engine — the voice agent's "whiteboard" over the 3D world.
 *
 * Responsibilities:
 *   - resolve voice annotation requests (names → world anchors + footprints)
 *   - own annotation state and the ephemeral fade-out lifecycle
 *   - delegate drawing to a pluggable renderer (world-space or screen-space)
 *
 * The data model is always world-anchored (lon/lat), so annotations track the
 * camera and persist across moves regardless of which renderer draws them.
 */

let _seq = 0;
const COLORS = new Set(['primary', 'amber', 'cyan', 'green', 'red']);
// Entity FACTS the voice model may attach to an annotation (annotate_map.entityKind) —
// what kind of thing the target IS, routing the resolver (e.g. point_feature keeps a
// monument point-first). Unknown values are dropped, never guessed.
const ENTITY_KINDS = new Set(['building', 'compound', 'district', 'street', 'point_feature']);
const DEFAULT_TTL_MS = 22_000;
const FADE_MS = 1200;
// Hard ceiling on simultaneously-live marks. Protects against a runaway voice
// session (or a bad model call that keeps appending) from accumulating unbounded
// Cesium entities + SVG nodes. Persistent marks accumulate until cleared.
const MAX_LIVE_ANNOTATIONS = 120;
// Deferred-outline retry backoff. A TRANSIENT Overpass failure (slow mirror, network
// blip) aborts the client fetch, but the /api/overpass proxy keeps the upstream
// request going and caches the late completion — so a re-run ~8 s later is usually a
// warm cache hit, and one more at ~25 s covers a genuinely slow mirror. A DEFINITIVE
// no-polygon answer is never retried.
const OUTLINE_RETRY_DELAYS_MS = [8000, 25000];
const OUTLINE_UPGRADE_CONCURRENCY = 2;

/**
 * Run a deferred-outline resolver with transient-retry backoff. Tri-state contract
 * (same as resolveAnnotationTarget's resolveOutline):
 *   footprint object — resolved;
 *   null            — DEFINITIVE no-polygon (never retried; the honest point stands);
 *   undefined       — TRANSIENT failure (re-run once per delaysMs entry, then give up);
 *   rate-limit object — OVERPASS THROTTLE (one retry, honoring Retry-After + ladder).
 * `isStale()` is consulted after each backoff wait so a cleared/superseded board stops
 * retrying immediately. A thrown resolver counts as definitive — the pre-retry
 * catch→point behavior. Exported for tests.
 */
export async function resolveOutlineWithRetry(resolveOutline, {
  delaysMs = OUTLINE_RETRY_DELAYS_MS,
  isStale = () => false,
  waitFn = wait,
} = {}) {
  let retriedRateLimit = false;
  for (let attempt = 0; ; attempt += 1) {
    let fp;
    try {
      fp = await resolveOutline();
    } catch {
      fp = null; // hard failure — definitive, keep the honest point
    }
    if (isRateLimitedOutcome(fp)) {
      // A throttle gets one deliberately spaced retry. If that retry is throttled
      // too, stop this mark's outline task instead of replaying the batch storm.
      if (retriedRateLimit || attempt >= delaysMs.length) return undefined;
      const retryAfterMs = Number.isFinite(fp.retryAfterMs) ? fp.retryAfterMs : 0;
      await waitFn(Math.max(retryAfterMs, delaysMs[attempt]));
      if (isStale()) return undefined;
      retriedRateLimit = true;
      continue;
    }
    if (fp !== undefined) return fp;
    if (attempt >= delaysMs.length) return undefined; // transient budget exhausted
    await waitFn(delaysMs[attempt]);
    if (isStale()) return undefined; // board cleared/superseded mid-backoff
  }
}

/**
 * Pending-phase dedup key for a NAMED target: lowercased, trimmed, and stripped of
 * trailing comma-separated locality qualifiers — so "California" and "California,
 * United States" are the same asked-for THING while their outlines resolve. Identity
 * becomes GEOMETRY the moment the outline lands; this key is only the stand-in while
 * geometry is unknown. Exported for tests.
 */
export function normalizeTargetKey(target) {
  const raw = String(target ?? '').trim().toLowerCase();
  if (!raw) return null;
  const head = raw.split(',')[0].trim();
  return head || raw;
}

export function createAnnotationEngine({
  viewer,
  renderer,
  outlineRetryDelaysMs = OUTLINE_RETRY_DELAYS_MS,
  resolveTarget = resolveAnnotationTarget,
}) {
  /** @type {Map<string, object>} live annotations keyed by id */
  const annotations = new Map();
  let tickHandle = null;
  let assistFlightUntil = 0; // camera-assist debounce (see ensureMarksVisible)
  // Generation token + in-flight fetch controllers guard against clear / new-topic
  // races: a slow resolve belonging to a superseded annotate() call must never
  // draw after a clear() (or after a newer clearPrevious) has wiped the board.
  let generation = 0;
  const activeControllers = new Set();
  // Outline upgrades are intentionally narrower than the concurrent anchor phase:
  // points render immediately, then expensive Overpass continuations drain FIFO.
  const outlineQueue = [];
  let activeOutlineUpgrades = 0;
  // Deferred-outline lifecycle listeners (the voice layer): notified ONCE per upgrade
  // task with the FINAL outcome — resolved or failed — so narration that said
  // "tracing the boundary now" can later honestly confirm or correct itself.
  const outlineListeners = new Set();

  function emitOutlineEvent(evt) {
    for (const listener of outlineListeners) {
      try { listener(evt); } catch { /* a listener error must never break the upgrade */ }
    }
  }

  function abortPending() {
    for (const c of activeControllers) { try { c.abort(); } catch { /* no-op */ } }
    activeControllers.clear();
  }

  function dropQueuedOutlineUpgrades() {
    while (outlineQueue.length) {
      const task = outlineQueue.shift();
      if (task.anno._outlineTask === task) task.anno._outlineTask = null;
      releaseController(task.controller);
    }
  }

  // A controller stays abortable (in activeControllers) while its annotate() call OR any
  // progressive outline-upgrade task it spawned is still running — clear() must be able to
  // abort in-flight Overpass fetches even after the tool result has already returned.
  function retainController(c) {
    c._retain = (c._retain || 0) + 1;
    activeControllers.add(c);
  }
  function releaseController(c) {
    c._retain = (c._retain || 0) - 1;
    if (c._retain <= 0) activeControllers.delete(c);
  }

  // World annotations carry persistent per-frame scene animation (pulsing
  // live colors, camera-scaled rings, route-flow uniforms in the renderer),
  // so the scene must render continuously while any mark exists. (perf wave 2)
  function syncAnnotationHold() {
    if (annotations.size > 0) holdContinuousRender('annotations');
    else releaseContinuousRender('annotations');
  }

  /**
   * Undo a renderer add that threw PART-WAY through. The renderers build a mark
   * across two sub-renderers / several DOM inserts, so a throw can leave world
   * geometry or an SVG group behind that the engine's map rollback alone cannot
   * reach — and the next annotate of the same geometry would then stack a fresh
   * mark over the orphan. remove() tolerates partial and absent state, so this
   * is safe to call unconditionally; it must never mask the original failure.
   * (second review)
   * @param {object} anno
   * @returns {void}
   */
  function rollbackRendererState(anno) {
    try {
      renderer.remove(anno);
    } catch { /* the renderer is already in a bad way; the original error wins */ }
  }

  function ensureTicking() {
    if (tickHandle != null) return;
    const tick = () => {
      const now = performance.now();
      let changed = false;
      let pending = false; // any mark still fading in / out, or with a TTL fade ahead
      for (const anno of annotations.values()) {
        const next = computeAlpha(anno, now);
        if (next !== anno.alpha) {
          anno.alpha = next;
          changed = true;
        }
        if (anno.alpha <= 0 && anno.expiring) {
          annotations.delete(anno.id);
          renderer.remove(anno);
          changed = true;
          continue;
        }
        if (pendingAnimation(anno, now)) pending = true;
      }
      if (changed) {
        renderer.sync(annotations);
        syncAnnotationHold();
      }
      // Stop once the board is STABLE — persistent marks (persist=true is the default)
      // finish fading in after ~260ms and never change again, so without this the loop
      // would spin O(N) every frame forever. ensureTicking() restarts on the next
      // add() or fadeOutAll().
      if (annotations.size === 0 || !pending) {
        cancelAnimationFrame(tickHandle);
        tickHandle = null;
        return;
      }
      tickHandle = requestAnimationFrame(tick);
    };
    tickHandle = requestAnimationFrame(tick);
  }

  /**
   * Draw one or more annotations.
   *
   * @param {Array<object>} requests  Raw annotation specs from the voice tool.
   * @param {object} [opts]
   * @param {boolean} [opts.clearPrevious]
   * @param {boolean} [opts.persist]  Keep until cleared (default true).
   * @param {boolean} [opts.flyTo]    Frame the first resolved annotation.
   * @returns {Promise<{ok, drawn, failed, ids, results}>}
   */
  async function annotate(requests, opts = {}) {
    const list = Array.isArray(requests) ? requests : [requests];
    if (opts.clearPrevious) clear(); // bumps generation + aborts older pending work

    const persist = opts.persist !== false;
    // Per-call cancellation: bumped/aborted by any later clear() or destroy().
    const controller = new AbortController();
    retainController(controller);
    const myGen = generation;
    const superseded = () => myGen !== generation || controller.signal.aborted;

    const results = [];
    const ids = [];
    let firstAnchor = null;
    let capped = false;

    // Resolve ALL items CONCURRENTLY (each resolveSpec is a chain of slow geocode/Overpass/Places
    // fetches). Serial awaits made a list of monuments take ~a minute and time out the voice call.
    // allSettled gives per-item error isolation (one failed item never aborts the batch); the
    // mutation pass below then runs in ORDER, so de-dup, the synchronous live-cap check, and output
    // order are all preserved exactly as the old serial loop had them.
    const settled = await Promise.allSettled(list.map((spec) => resolveSpec(spec, controller.signal)));

    try {
      for (let i = 0; i < list.length; i += 1) {
        const spec = list[i];
        const outcome = settled[i];
        if (superseded()) break;
        try {
          if (outcome.status === 'rejected') throw outcome.reason; // resolution threw → same path as before
          const resolved = outcome.value;
          if (!resolved) {
            results.push(failResult(spec, 'could not resolve location'));
            continue;
          }
          const anno = buildAnnotation(spec, resolved, persist);
          // De-dup: the voice model re-narrates the same places across turns, and
          // annotations now accumulate by default — so without this, "Presidio" / "Marina"
          // pile up into duplicate stacked labels. A live mark that is semantically the SAME
          // (same type+anchor AND equivalent geometry — keyed on GEOMETRY, not label/color, so
          // "Marina" and "Marina District" collapse) is refreshed or replaced in place, never
          // stacked. De-dup runs BEFORE the cap so a re-narration still refreshes when full.
          const dup = findDuplicate(anno);
          if (dup) {
            const labelChanged = String(dup.label || '').trim().toLowerCase() !== String(anno.label || '').trim().toLowerCase();
            const colorChanged = (dup.color || 'primary') !== (anno.color || 'primary');
            if (labelChanged || colorChanged) {
              // Same place + shape, but a NEW label and/or color ("Marina" → "Marina District",
              // or a recolor) → replace in place so the latest caption/color wins (count
              // unchanged, so no cap concern; no stale copy stacked underneath).
              // A progressive replacement inherits the dup's already-resolved geometry so an
              // outline never visibly vanishes during a recaption; its own upgrade (below)
              // refreshes it — usually instantly from the footprint cache.
              if (anno.pendingOutline && !anno.ring && dup.ring) {
                anno.ring = dup.ring;
                anno.footprintKind = dup.footprintKind || null;
                anno.buildingHeight = dup.buildingHeight || null;
                anno.synthesized = Boolean(dup.synthesized);
                anno.anchor = { ...dup.anchor };
              }
              annotations.delete(dup.id);
              annotations.set(anno.id, anno);
              syncAnnotationHold();
              try {
                renderer.remove(dup);
                renderer.add(anno);
              } catch (swapError) {
                // Same contract as the fresh path: a renderer/WebGL throw must
                // not leave a phantom annotation behind — and with it a
                // PERMANENT 'annotations' hold that defeats the idle governor
                // until an explicit clear. Roll the map back and re-sync.
                rollbackRendererState(anno);
                annotations.delete(anno.id);
                syncAnnotationHold();
                throw swapError;
              }
              ids.push(anno.id);
              if (!firstAnchor) firstAnchor = anno;
              if (typeof resolved.resolveOutline === 'function') {
                startOutlineUpgrade(anno, resolved.resolveOutline, myGen, controller);
              }
              results.push({ ...okResult(anno, resolved, anno.id), duplicate: true });
            } else {
              // Identical re-narration → refresh the existing mark's lifecycle in place (keep
              // it visible whether persistent or TTL-based, and revive a fading-out one).
              if (persist) { dup.ttlMs = null; } else { dup.createdAt = performance.now(); dup.ttlMs = anno.ttlMs; }
              dup.expiring = false;
              dup.fadeStart = null;
              ids.push(dup.id);
              if (!firstAnchor) firstAnchor = dup;
              // A re-narration is also a RETRY: if the existing mark never got its outline
              // (transient Overpass miss), attach this call's deferred resolver to it.
              if (!dup.ring && typeof resolved.resolveOutline === 'function') {
                startOutlineUpgrade(dup, resolved.resolveOutline, myGen, controller);
              }
              // Same result builder as the fresh path (full metadata) but the existing id —
              // route fallback / approximate honesty fields survive a re-narration.
              results.push({ ...okResult(anno, resolved, dup.id), duplicate: true });
            }
            continue;
          }
          // NEW mark — enforce the HARD live cap here, synchronously immediately before the
          // set (no await in between), so overlapping annotate() calls can't both slip past.
          if (annotations.size >= MAX_LIVE_ANNOTATIONS) {
            capped = true;
            results.push(failResult(spec, 'annotation limit reached'));
            continue;
          }
          annotations.set(anno.id, anno);
          syncAnnotationHold();
          try {
            renderer.add(anno);
          } catch (addError) {
            // A failed renderer add must not retain a phantom annotation (and
            // with it a phantom continuous-render hold). (perf wave 2 fix)
            rollbackRendererState(anno);
            annotations.delete(anno.id);
            syncAnnotationHold();
            throw addError;
          }
          ids.push(anno.id);
          if (!firstAnchor) firstAnchor = anno;
          // Progressive: the point is on the board; trace the outline behind the narration.
          if (typeof resolved.resolveOutline === 'function') {
            startOutlineUpgrade(anno, resolved.resolveOutline, myGen, controller);
          }
          results.push(okResult(anno, resolved, anno.id));
        } catch (error) {
          if (superseded()) break;
          results.push(failResult(spec, error?.message || 'annotation failed', Array.isArray(error?.failedTargets) ? error.failedTargets : null));
        }
      }
    } finally {
      releaseController(controller);
    }

    // A clear/new-topic landed mid-flight: drop everything this call produced and
    // do not touch the renderer or camera — the board now belongs to a newer call.
    if (superseded()) {
      return { ok: false, drawn: 0, failed: results.length, ids: [], results, aborted: true };
    }

    if (ids.length) {
      renderer.sync(annotations);
      ensureTicking();
    }
    if (opts.flyTo && firstAnchor) frameAnnotation(firstAnchor);
    else if (ids.length) ensureMarksVisible(ids);

    const drawn = results.filter((r) => r.ok).length;
    return {
      ok: drawn > 0,
      drawn,
      failed: results.length - drawn,
      ids,
      results,
      capped,
    };
  }

  async function resolveSpec(spec, signal) {
    const type = normalizeType(spec?.type);
    if (type === 'route') {
      const points = Array.isArray(spec.points) ? spec.points : [];
      if (points.length < 2) throw new Error('a route needs at least 2 waypoints');
      const resolvedPts = [];
      const failed = [];
      for (const pt of points) {
        const name = pt.target ?? pt.name ?? null;
        const r = await resolveTarget({
          viewer,
          target: name,
          latitude: pt.latitude,
          longitude: pt.longitude,
          screenX: pt.screenX,
          screenY: pt.screenY,
          footprint: false,
          signal,
        });
        if (r) resolvedPts.push(r);
        else failed.push(name || 'a waypoint');
      }
      // Honesty: never silently drop waypoints. If any fail to resolve, this is not
      // the route the user asked for (A→B→C must not become A→C), so fail loudly
      // with the specific waypoint(s) so the agent can say what it couldn't find.
      if (failed.length) {
        // Static message (no raw place text in prose — names live in failedTargets,
        // a structured DATA field, to avoid a prompt-injection surface in tool output).
        const err = new Error('could not locate one or more route waypoints');
        err.failedTargets = failed;
        throw err;
      }
      // Real street-following route (OSM/OSRM), mode-aware.
      const mode = normalizeMode(spec.mode);
      const routed = await fetchRoute(resolvedPts.map((p) => [p.lon, p.lat]), mode, signal);
      if (routed) {
        return {
          path: routed.geometry.map(([lon, lat]) => ({ lon, lat, height: 0 })),
          distanceM: routed.distanceM,
          durationS: routed.durationS,
          mode,
          source: resolvedPts[0].source,
          fallback: false,
        };
      }
      // Routing unavailable: do NOT pass off straight segments as a real route. Draw
      // a clearly-labeled direct line with great-circle distance and NO travel time.
      let straight = 0;
      for (let i = 1; i < resolvedPts.length; i += 1) straight += greatCircleM(resolvedPts[i - 1], resolvedPts[i]);
      return { path: resolvedPts, distanceM: straight, durationS: null, mode, source: resolvedPts[0].source, fallback: true };
    }
    if (type === 'arrow') {
      const from = await resolveTarget({
        viewer,
        target: spec.target,
        latitude: spec.latitude,
        longitude: spec.longitude,
        screenX: spec.screenX,
        screenY: spec.screenY,
        footprint: false,
        signal,
      });
      const to = await resolveTarget({
        viewer,
        target: spec.toTarget,
        latitude: spec.toLatitude,
        longitude: spec.toLongitude,
        screenX: spec.toScreenX,
        screenY: spec.toScreenY,
        footprint: false,
        signal,
      });
      if (!from || !to) {
        // Name the endpoint(s) that actually failed so the partial voice path can't
        // blame the wrong place (a valid origin → unresolved destination must report
        // the destination, not the origin/caption).
        const failed = [];
        if (!from) failed.push(spec.target || 'the origin');
        if (!to) failed.push(spec.toTarget || 'the destination');
        // Static message; names go only into failedTargets (structured DATA).
        const err = new Error('could not locate one or both arrow endpoints');
        err.failedTargets = failed;
        throw err;
      }
      return { from, to, distanceM: greatCircleM(from, to), source: from.source };
    }
    const wantFootprint = type === 'area' ? spec.footprint !== false : Boolean(spec.footprint);
    return resolveTarget({
      viewer,
      target: spec.target,
      latitude: spec.latitude,
      longitude: spec.longitude,
      screenX: spec.screenX,
      screenY: spec.screenY,
      footprint: wantFootprint,
      intent: spec.intent === 'around_the_thing' ? 'around_the_thing' : 'the_thing',
      entityKind: ENTITY_KINDS.has(spec?.entityKind) ? spec.entityKind : null,
      // The label often carries the ask's true shape when the target omits it
      // ("target: Texas State Capitol" + "label: Capitol grounds") — a resolver HINT only.
      labelHint: typeof spec?.label === 'string' ? spec.label : null,
      // PROGRESSIVE resolution: anchor now (~100-400 ms Places/Geocode), outline later.
      // Footprint fetches are the slow, flaky leg (Overpass p50 ≈ 1-3 s, p90 ≈ 12 s
      // timeout — field test 7 logs); deferring them lets the mark appear and the tool
      // result return while the outline resolves, then upgrades the mark in place.
      deferFootprint: wantFootprint,
      signal,
    });
  }

  /**
   * PROGRESSIVE outline upgrade: the mark is already on the board as a point; when the
   * deferred footprint resolves, mutate the SAME annotation in place (ring/kind/height +
   * recentred anchor) and re-route it through the renderer (a ring moves an area from the
   * screen-space callout to the world-space drape). The mark never disappears here: on a
   * failed / aborted / superseded resolution it simply stays an honest point (marks are
   * only ever removed by an explicit clear — the no-auto-clear invariant).
   */
  function startOutlineUpgrade(anno, resolveOutline, myGen, controller) {
    if (anno._outlineTask) return; // one upgrade per mark at a time
    anno.pendingOutline = true;
    retainController(controller); // keep the outline fetches abortable by clear()
    const task = { anno, resolveOutline, myGen, controller };
    anno._outlineTask = task;
    outlineQueue.push(task);
    drainOutlineQueue();
  }

  function drainOutlineQueue() {
    while (activeOutlineUpgrades < OUTLINE_UPGRADE_CONCURRENCY && outlineQueue.length) {
      const task = outlineQueue.shift();
      const stale = task.myGen !== generation
        || task.controller.signal.aborted
        || !annotations.has(task.anno.id);
      if (stale) {
        if (task.anno._outlineTask === task) task.anno._outlineTask = null;
        releaseController(task.controller);
        continue;
      }
      activeOutlineUpgrades += 1;
      runOutlineUpgrade(task);
    }
  }

  async function runOutlineUpgrade(task) {
    const { anno, resolveOutline, myGen, controller } = task;
    try {
      let fp = null;
      // Geometry upgrade is best-effort — the point stays on any failure. A TRANSIENT
      // failure (slow Overpass mirror) re-runs on a short backoff: the /api/overpass
      // proxy caches the late completion, so the retry is usually a warm cache hit.
      fp = await resolveOutlineWithRetry(resolveOutline, {
        delaysMs: outlineRetryDelaysMs,
        isStale: () => myGen !== generation || controller.signal.aborted || !annotations.has(anno.id),
      });
      if (myGen !== generation || controller.signal.aborted) return; // board superseded
      if (!annotations.has(anno.id)) return; // mark replaced/removed while resolving
      anno.pendingOutline = false;
      if (fp) {
        anno.ring = fp.ring;
        anno.footprintKind = fp.footprintKind || null;
        anno.buildingHeight = fp.buildingHeight || null;
        anno.synthesized = Boolean(fp.synthesized);
        // Re-center on the footprint centroid, as the inline path always did.
        if (Number.isFinite(fp.lat) && Number.isFinite(fp.lon)) {
          anno.anchor = {
            lon: fp.lon,
            lat: fp.lat,
            height: Number.isFinite(fp.height) ? fp.height : anno.anchor.height,
          };
        }
        // Re-route: ring presence decides world-drape vs screen-space in the renderer.
        renderer.update(anno);
        // GEOMETRY dedup, now that geometry is known: two DIFFERENT targets can resolve
        // to the SAME polygon ("Marina" / "Marina District") — the identity-is-geometry
        // invariant says they are ONE mark. The pending-phase dedup keys on target (it
        // can't see geometry yet), so enforce the invariant here: collapse any other
        // resolved area with the same anchor + ring, keeping THIS mark (latest caption
        // wins, exactly like the add-time replace path). Not an auto-clear — it removes
        // a second representation of the same mark, never a distinct one.
        for (const other of annotations.values()) {
          if (other.id === anno.id || other.type !== 'area' || other.pendingOutline) continue;
          if (!other.anchor || Math.abs(other.anchor.lon - anno.anchor.lon) >= 5e-4
            || Math.abs(other.anchor.lat - anno.anchor.lat) >= 5e-4) continue;
          if (Boolean(other.synthesized) !== Boolean(anno.synthesized)) continue;
          if ((other.footprintKind || null) !== (anno.footprintKind || null)) continue;
          if (!ringsEqual(other.ring, anno.ring)) continue;
          annotations.delete(other.id);
          renderer.remove(other);
        }
      }
      renderer.sync(annotations);
      // Final outcome → the voice layer (place names ride as structured DATA fields).
      // 'failed' covers both the definitive no-polygon and an exhausted transient
      // retry — either way the mark honestly stays a point.
      emitOutlineEvent({
        id: anno.id,
        label: anno.label || null,
        target: anno.targetKey || null,
        status: fp ? 'resolved' : 'failed',
        ...(fp && anno.synthesized ? { approximate: true } : {}),
      });
    } finally {
      if (anno._outlineTask === task) anno._outlineTask = null;
      releaseController(controller);
      activeOutlineUpgrades -= 1;
      drainOutlineQueue();
    }
  }

  /** Build the success result for an annotation (fresh or duplicate), keeping the route
   *  fallback + synthesized-area honesty fields the voice layer relies on. */
  function okResult(anno, resolved, id) {
    return {
      ok: true,
      id,
      type: anno.type,
      label: anno.label,
      latitude: round5(anno.anchor.lat),
      longitude: round5(anno.anchor.lon),
      resolvedVia: resolved.source,
      outline: Boolean(anno.ring),
      // The anchor is placed and returned fast; the footprint is still being traced and
      // will appear on its own (or the mark honestly stays a point). Lets the voice
      // layer narrate without waiting out a slow Overpass — and without calling the
      // missing outline a failure.
      ...(anno.pendingOutline ? { outlinePending: true } : {}),
      // approximate=true means the area was SYNTHESIZED (a buffered blob around a label
      // point), not a real OSM boundary — so the voice layer can be honest.
      ...(anno.synthesized ? { approximate: true } : {}),
      // Route-specific signal so the voice layer can be honest about an OSRM outage:
      // fallback=true means a straight direct line, not a real route.
      ...(anno.type === 'route'
        ? { fallback: Boolean(anno.fallback), mode: anno.mode, distanceM: anno.distanceM, durationS: anno.durationS }
        : {}),
    };
  }

  /** A live mark that is the SAME annotation as `anno`, or null. For shapes with real geometry
   *  (area/arrow/route) identity is GEOMETRY, not label/color — so "Marina" and "Marina District"
   *  (same polygon) collapse to one mark, while a same-anchor DIFFERENT shape ("the Capitol"
   *  building vs "around the Capitol" buffer) is NOT collapsed; the caller replaces label/color in
   *  place so the latest caption wins. For BARE POINTS (pin/highlight/label) there is no geometry
   *  to compare, so identity also requires the LABEL to match — otherwise distinct things that a
   *  degenerate geocode stacks on one point (several Capitol monuments) would erase each other. */
  function findDuplicate(anno) {
    if (!anno.anchor) return null;
    const near = (a, b) => a && b && Math.abs(a.lon - b.lon) < 5e-4 && Math.abs(a.lat - b.lat) < 5e-4;
    // FULL per-vertex geometry comparison (the live cap is only 120 and this runs solely for
    // candidates that already matched type+label+anchor, so it's cheap) — so two DIFFERENT
    // same-length rings/paths at the same anchor are never falsely merged.
    const ringSame = ringsEqual;
    const pathSame = (a, b) => {
      const la = a ? a.length : 0; const lb = b ? b.length : 0;
      if (la !== lb) return false;
      for (let i = 0; i < la; i++) if (!near(a[i], b[i])) return false;
      return true;
    };
    for (const ex of annotations.values()) {
      if (ex.type !== anno.type || !ex.anchor) continue;
      // Identity is GEOMETRY, not label: "Marina" and "Marina District" resolve to the SAME
      // polygon/anchor and must collapse to one mark (the caller replaces label/color in place
      // so the latest caption wins). Resolution is deterministic, so the same place re-resolves
      // to the same centroid; a ~50 m epsilon absorbs any rounding.
      if (!near(ex.anchor, anno.anchor)) continue;
      // Geometry equivalence per type — distinct shapes at the same anchor are NOT dupes.
      if (anno.type === 'area') {
        if (anno.pendingOutline || ex.pendingOutline) {
          // Progressive outline still resolving on one side → geometry is unknowable yet,
          // so identity falls back to the asked-for THING: same normalized target + same
          // shape intent. This collapses a literal re-narration ("the Presidio" again)
          // without collapsing different asks at one anchor ("the Capitol" vs "the
          // Capitol grounds" pend ~the same point but are different targets). Same-place
          // DIFFERENT-target asks ("Marina" / "Marina District") are collapsed later by
          // the post-resolution geometry dedup in startOutlineUpgrade — geometry stays
          // the identity; the target is only the stand-in while geometry is unknown.
          if (!anno.targetKey || !ex.targetKey) continue;
          if (anno.targetKey !== ex.targetKey) continue;
          if ((ex.intentKey || 'thing') !== (anno.intentKey || 'thing')) continue;
        } else {
          if (Boolean(ex.synthesized) !== Boolean(anno.synthesized)) continue;
          if ((ex.footprintKind || null) !== (anno.footprintKind || null)) continue;
          if (!ringSame(ex.ring, anno.ring)) continue;
        }
      } else if (anno.type === 'arrow') {
        if (!near(ex.to, anno.to)) continue;
      } else if (anno.type === 'route') {
        if ((ex.mode || null) !== (anno.mode || null)) continue;
        if (!pathSame(ex.path, anno.path)) continue;
      } else {
        // pin / highlight / label = a bare POINT with no distinguishing geometry. Two DIFFERENT
        // labels at the same spot are two different things a degenerate geocode stacked on one
        // point (e.g. several Texas Capitol monuments all geocoding to the dome centroid) — NOT a
        // duplicate. Only collapse a genuine re-narration of the SAME point (same label); distinct
        // labels stay as separate marks (their callouts de-collide in the renderer).
        const sameLabel = String(ex.label || '').trim().toLowerCase() === String(anno.label || '').trim().toLowerCase();
        if (!sameLabel) continue;
      }
      return ex;
    }
    return null;
  }

  function buildAnnotation(spec, resolved, persist) {
    const type = normalizeType(spec?.type);
    const id = `anno-${++_seq}`;
    const color = COLORS.has(spec?.color) ? spec.color : 'primary';
    const label = cleanLabel(spec?.label) || resolved?.label || resolved?.from?.label || null;
    const now = performance.now();

    const base = {
      id,
      type,
      color,
      label,
      createdAt: now,
      ttlMs: persist ? null : (Number(spec?.ttlMs) || DEFAULT_TTL_MS),
      alpha: 0, // animate in
      bornAt: now,
      expiring: false,
    };

    if (type === 'route') {
      const path = resolved.path.map((p) => ({ lon: p.lon, lat: p.lat, height: p.height }));
      return {
        ...base,
        label: composeRouteLabel(base.label, resolved.distanceM, resolved.durationS, resolved.mode, resolved.fallback),
        anchor: path[0],
        to: null,
        path,
        ring: null,
        mode: resolved.mode || null,
        distanceM: resolved.distanceM ?? null,
        durationS: resolved.durationS ?? null,
        fallback: Boolean(resolved.fallback),
      };
    }

    if (type === 'arrow') {
      return {
        ...base,
        label: appendDistance(base.label, resolved.distanceM),
        anchor: { lon: resolved.from.lon, lat: resolved.from.lat, height: resolved.from.height },
        to: { lon: resolved.to.lon, lat: resolved.to.lat, height: resolved.to.height },
        ring: null,
      };
    }

    return {
      ...base,
      anchor: { lon: resolved.lon, lat: resolved.lat, height: resolved.height },
      to: null,
      ring: resolved.ring || null,
      footprintKind: resolved.footprintKind || null, // 'building' | 'area'
      buildingHeight: resolved.buildingHeight || null, // meters, for extruded volume
      synthesized: Boolean(resolved.synthesized), // approximate buffered area → dashed render
      // Progressive outline: the anchor is placed, the footprint is still resolving —
      // the upgrade task fills ring/kind in place when it lands. Transient render state
      // (not serialized to GeoJSON).
      pendingOutline: typeof resolved.resolveOutline === 'function',
      // Which THING + SHAPE was asked for — the dedup identity while geometry is still
      // pending (see findDuplicate). targetKey is the normalized place name with trailing
      // locality qualifiers stripped ("California, United States" ≡ "California"; null for
      // coord/pixel specs, which never pending-collapse).
      targetKey: normalizeTargetKey(spec?.target),
      intentKey: spec?.intent === 'around_the_thing' ? 'around' : 'thing',
      // Places viewport (lat/lng box framing the feature) — sizes the flyTo range while
      // no ring exists yet.
      viewport: resolved.viewport || null,
    };
  }

  function clear() {
    // Bump first so any in-flight annotate() sees itself as superseded, and abort
    // its pending fetches so a slow resolve can never redraw onto the cleared board.
    generation += 1;
    abortPending();
    dropQueuedOutlineUpgrades();
    if (!annotations.size) return;
    for (const anno of annotations.values()) renderer.remove(anno);
    annotations.clear();
    renderer.sync(annotations);
    syncAnnotationHold();
  }

  /** Begin a graceful fade-out of everything, then remove. */
  function fadeOutAll() {
    const now = performance.now();
    for (const anno of annotations.values()) {
      anno.expiring = true;
      anno.ttlMs = 0;
      anno.fadeStart = now;
    }
    ensureTicking();
  }

  /**
   * Camera assist (field test 8): the voice model leaves flyTo false when it believes the
   * user is already looking at the subject — but after a fly_to elsewhere, a fresh mark can
   * land entirely OFF-SCREEN and the user sees nothing happen (Lady Bird Lake → SRV statue).
   * When NOTHING this call drew or refreshed is visible, gently frame those marks. Never
   * fires when at least one mark is already in view (don't fight the user's camera), and
   * never on a later outline upgrade (no mid-narration yanks).
   */
  function ensureMarksVisible(markIds) {
    try {
      // One assist at a time: the model often issues annotate calls ~1 s apart, and
      // re-checking mid-flight would see still-off-screen marks and restart the flight
      // (a visible stutter). While an assist flight is presumed in progress, stand down.
      if (performance.now() < assistFlightUntil) return;
      const marks = markIds.map((id) => annotations.get(id)).filter(Boolean);
      if (!marks.length) return;
      const points = [];
      for (const m of marks) {
        if (m.anchor) points.push(m.anchor);
        if (m.to) points.push(m.to);
      }
      if (!points.length || points.some((p) => isPointOnScreen(p))) return;
      console.log(`[Annotations] auto-framing ${marks.length} off-screen mark(s)`);
      assistFlightUntil = performance.now() + 2600; // ~flight duration + settle
      if (marks.length === 1) {
        frameAnnotation(marks[0]);
        return;
      }
      const cart = points.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0));
      const sphere = Cesium.BoundingSphere.fromPoints(cart);
      viewer.camera.flyToBoundingSphere(sphere, {
        offset: new Cesium.HeadingPitchRange(
          viewer.camera.heading,
          Cesium.Math.toRadians(-35),
          Math.max(900, sphere.radius * 2.6),
        ),
        duration: 1.6,
      });
    } catch {
      /* camera assist is best-effort */
    }
  }

  /** Whether a lon/lat point is inside the camera frustum AND on the near side of the
   *  globe. On any API hiccup, report visible — bad data must never move the camera. */
  function isPointOnScreen(p) {
    try {
      const camera = viewer.camera;
      const pos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0);
      const cv = camera.frustum.computeCullingVolume(camera.position, camera.direction, camera.up);
      if (cv.computeVisibility(new Cesium.BoundingSphere(pos, 1)) === Cesium.Intersect.OUTSIDE) return false;
      const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera.position);
      return occluder.isPointVisible(pos);
    } catch {
      return true;
    }
  }

  function frameAnnotation(anno) {
    try {
      const target = anno.to
        ? { lon: (anno.anchor.lon + anno.to.lon) / 2, lat: (anno.anchor.lat + anno.to.lat) / 2 }
        : anno.anchor;
      // No ring yet (progressive outline still resolving) → size the flight from the
      // Places viewport box when we have one, so a big compound isn't framed at
      // building scale while its outline is traced. Never re-fly when the ring lands.
      const range = anno.ring ? ringRange(anno.ring) : (viewportRange(anno.viewport) || 600);
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          Cesium.Cartesian3.fromDegrees(target.lon, target.lat, anno.anchor.height || 0),
          range,
        ),
        {
          offset: new Cesium.HeadingPitchRange(
            viewer.camera.heading,
            Cesium.Math.toRadians(-35),
            range * 2.4,
          ),
          duration: 1.8,
        },
      );
    } catch {
      /* framing is best-effort */
    }
  }

  const engine = {
    annotate,
    clear,
    fadeOutAll,
    count: () => annotations.size,
    list: () => Array.from(annotations.values()),

    /**
     * Subscribe to deferred-outline outcomes. Listener receives
     * `{ id, label, target, status: 'resolved'|'failed', approximate? }` once per
     * upgrade task, AFTER the mark was mutated in place. Returns an unsubscribe fn.
     */
    onOutlineEvent(listener) {
      if (typeof listener !== 'function') return () => {};
      outlineListeners.add(listener);
      return () => outlineListeners.delete(listener);
    },

    /**
     * Scripted demo so the feature is verifiable without a live mic session.
     * Lays down a small San Francisco "tour" the way the voice agent would.
     */
    async demo() {
      return annotate([
        { type: 'highlight', target: 'Palace of Fine Arts, San Francisco', label: 'Palace of Fine Arts', color: 'amber' },
        { type: 'area', target: 'Presidio of San Francisco', label: 'The Presidio (former Army base)', color: 'green', footprint: true },
        { type: 'pin', target: 'Letterman Digital Arts Center, San Francisco', label: 'ILM / Lucasfilm', color: 'cyan' },
        { type: 'arrow', target: 'Palace of Fine Arts, San Francisco', toTarget: 'Marina District, San Francisco', label: 'next to the Marina' },
      ], { flyTo: true, clearPrevious: true, persist: true });
    },

    /**
     * Self-running narration "tour" — sequences camera moves and annotations
     * with pauses the way the voice agent would, so the whole experience can be
     * watched end-to-end without a mic. `window.__gevAnnotations.tour()`.
     */
    async tour() {
      clear();
      flyTo({ lon: -122.4486, lat: 37.7960, height: 520, heading: 0, pitch: -26, duration: 3 });
      await wait(3200);
      await annotate([{ type: 'highlight', target: 'Palace of Fine Arts, San Francisco', label: 'Palace of Fine Arts', color: 'amber' }], { persist: true });
      await wait(2600);
      await annotate([{ type: 'arrow', target: 'Palace of Fine Arts, San Francisco', toTarget: 'Marina Green, San Francisco', label: 'next to the Marina', color: 'cyan' }], { persist: true });
      await wait(2600);
      flyTo({ lon: -122.4545, lat: 37.7880, height: 1500, heading: 18, pitch: -32, duration: 3 });
      await wait(3200);
      await annotate([{ type: 'area', target: 'Presidio of San Francisco', label: 'The Presidio — a former Army base', color: 'green', footprint: true }], { persist: true });
      await wait(2800);
      await annotate([{ type: 'pin', target: 'Letterman Digital Arts Center, San Francisco', label: 'ILM / Lucasfilm', color: 'red' }], { persist: true });
      await wait(2600);
      await annotate([{ type: 'route', color: 'amber', label: 'Crissy Field shoreline', points: [
        { target: 'Palace of Fine Arts, San Francisco' },
        { target: 'Crissy Field, San Francisco' },
        { target: 'Fort Point, San Francisco' },
      ] }], { persist: true });
      return { ok: true, steps: 6 };
    },
  };

  function flyTo({ lon, lat, height, heading = 0, pitch = -30, duration = 2.5 }) {
    try {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(pitch),
          roll: 0,
        },
        duration,
      });
    } catch {
      /* camera flight best-effort */
    }
  }

  return engine;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exact per-vertex ring equality ([[lon,lat],…], ~1m epsilon) — the geometry-identity test. */
function ringsEqual(a, b) {
  const la = a ? a.length : 0;
  const lb = b ? b.length : 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (Math.abs(a[i][0] - b[i][0]) >= 1e-5 || Math.abs(a[i][1] - b[i][1]) >= 1e-5) return false;
  }
  return true;
}

// --- helpers ----------------------------------------------------------------

/** The place name(s) a spec attempted to resolve (route waypoints, arrow endpoints, or a single target). */
function specTargets(spec) {
  const type = normalizeType(spec?.type);
  if (type === 'route' && Array.isArray(spec?.points)) {
    return spec.points.map((p) => p?.target ?? p?.name).filter(Boolean);
  }
  if (type === 'arrow') {
    return [spec?.target, spec?.toTarget].filter(Boolean);
  }
  return spec?.target ? [spec.target] : [];
}

/**
 * One shared failed-result shape for EVERY annotation failure path (live-cap,
 * unresolved, thrown), so the tool layer can always name the unresolved PLACE
 * rather than the caption. Pass explicit failedTargets (e.g. only the missing
 * arrow endpoint) when known; otherwise it derives them from the spec.
 */
function failResult(spec, error, failedTargets) {
  const targets = (failedTargets && failedTargets.length) ? failedTargets : specTargets(spec);
  return {
    ok: false,
    label: spec?.label || spec?.target || targets[0] || null,
    target: spec?.target ?? null,
    failedTargets: targets.length ? targets : null,
    error,
  };
}

function normalizeType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'area' || t === 'polygon' || t === 'outline' || t === 'compound') return 'area';
  if (t === 'route' || t === 'path' || t === 'line') return 'route';
  if (t === 'arrow' || t === 'vector' || t === 'connector') return 'arrow';
  if (t === 'label' || t === 'callout' || t === 'text') return 'label';
  if (t === 'pin' || t === 'marker' || t === 'point') return 'pin';
  return 'highlight';
}

function computeAlpha(anno, now) {
  const inT = (now - anno.bornAt) / 260;
  const fadeIn = inT >= 1 ? 1 : Math.max(0, inT);

  if (anno.ttlMs == null && !anno.expiring) return fadeIn;

  const fadeStart = anno.fadeStart != null
    ? anno.fadeStart
    : anno.createdAt + (anno.ttlMs || 0);
  if (now < fadeStart) return fadeIn;
  const out = 1 - (now - fadeStart) / FADE_MS;
  if (out <= 0) anno.expiring = true;
  return Math.max(0, Math.min(fadeIn, out));
}

/** Whether a mark still has alpha animation ahead — fading in, fading out, or a TTL
 *  fade not yet finished. A persistent mark past its ~260ms fade-in is stable, so the
 *  tick loop can stop. */
function pendingAnimation(anno, now) {
  if (now - anno.bornAt < 260) return true; // fading in
  if (anno.expiring) return true; // fading out
  if (anno.ttlMs != null) {
    const fadeStart = anno.fadeStart != null ? anno.fadeStart : anno.createdAt + (anno.ttlMs || 0);
    return now < fadeStart + FADE_MS; // TTL fade still ahead or in progress
  }
  return false; // persistent + faded in → stable
}

// Region-scale viewports (a mountain range, sea, or desert can span thousands of km)
// must not launch the assist flight to space: frameAnnotation flies at range × 2.4,
// so this cap keeps the camera at ≈290 km — the same regional swath scale the
// fly_to_location natural-region heuristic uses (field test 2026-07-23).
const VIEWPORT_ASSIST_RANGE_CAP_M = 120000;

/** flyTo range from a Places viewport box (low/high lat-lng corners), or null. */
function viewportRange(vp) {
  if (!vp?.low || !vp?.high) return null;
  try {
    const span = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(vp.low.longitude, vp.low.latitude),
      Cesium.Cartesian3.fromDegrees(vp.high.longitude, vp.high.latitude),
    );
    return Number.isFinite(span) && span > 0
      ? Math.max(300, Math.min(span * 0.7, VIEWPORT_ASSIST_RANGE_CAP_M))
      : null;
  } catch {
    return null;
  }
}

function ringRange(ring) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lon, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const span = Cesium.Cartesian3.distance(
    Cesium.Cartesian3.fromDegrees(minLon, minLat),
    Cesium.Cartesian3.fromDegrees(maxLon, maxLat),
  );
  return Math.max(300, span * 0.7);
}

function cleanLabel(label) {
  const text = String(label || '').trim();
  return text ? text.slice(0, 80) : null;
}

function round5(n) {
  return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : null;
}

function normalizeMode(m) {
  const t = String(m || '').toLowerCase();
  if (t === 'car' || t === 'drive' || t === 'driving') return 'car';
  if (t === 'bike' || t === 'cycle' || t === 'cycling' || t === 'bicycle') return 'bike';
  return 'foot';
}

/** Fetch a real street-following route from the /api/route proxy (OSM/OSRM). */
async function fetchRoute(coordPairs, mode, externalSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 13000);
  try {
    const coords = coordPairs.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
    const res = await fetch(`/api/gev/route?profile=${mode}&coords=${encodeURIComponent(coords)}`, { signal: controller.signal });
    const data = await res.json();
    if (data?.ok && Array.isArray(data.geometry) && data.geometry.length >= 2) return data;
  } catch { /* routing unavailable / aborted → caller falls back to straight segments */ } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
  return null;
}

function greatCircleM(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(m) {
  if (!Number.isFinite(m)) return null;
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m / 10) * 10} m`;
}

function composeRouteLabel(baseLabel, distM, durS, mode, fallback) {
  const dist = formatDistance(distM);
  if (!dist) return baseLabel;
  const min = Number.isFinite(durS) ? Math.max(1, Math.round(durS / 60)) : null;
  const word = mode === 'car' ? 'drive' : mode === 'bike' ? 'ride' : 'walk';
  // Fallback = routing was unavailable, so we drew a straight line: label it as a
  // direct line with no travel time (never claim an "X min walk" we didn't compute).
  let metrics;
  if (fallback) metrics = `${dist} · direct line (no route)`;
  else metrics = min != null ? `${dist} · ${min} min ${word}` : dist;
  return baseLabel ? `${baseLabel} — ${metrics}` : metrics;
}

function appendDistance(baseLabel, distM) {
  const dist = formatDistance(distM);
  if (!dist) return baseLabel;
  return baseLabel ? `${baseLabel} — ${dist}` : dist;
}
