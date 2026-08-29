import * as Cesium from 'cesium';
import { getOverlayPaintRect } from '../overlays/worldOverlay.js';
import {
  getActiveTrackedReadoutId,
  TRACKED_OVERLAY_SOURCE_ID,
} from '../data/trackedReadout.js';

/**
 * Screen-space annotation renderer (Direction B — the "whiteboard" aesthetic).
 *
 * Same world-anchored data model as the world-space renderer, but drawn as an
 * SVG overlay that is RE-PROJECTED every frame from the world coordinates via
 * `SceneTransforms.worldToWindowCoordinates`. That gives the best of both:
 *
 *   - World-anchored, so marks PERSIST and track as the camera moves/orbits
 *     (unlike a frame-bound pixel overlay that has to clear on camera motion).
 *   - SVG-rendered, so we get the hand-drawn explainer look — sketchy strokes,
 *     pulsing rings, draw-on outlines, arrows, and glassy callout cards with
 *     leader lines — that native Cesium primitives can't express as nicely.
 *
 * Marks behind the globe horizon are culled with an EllipsoidalOccluder, and
 * anything that projects off-screen / behind the camera is hidden.
 *
 * Screen-renderer contract (update is used by the hybrid outline-upgrade path):
 *   add(anno) / update(anno) / remove(anno) / sync(map) / destroy()
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

// Altitude-scaled marker geometry. Zoomed in (≤ NEAR_H) reticles are full-size; pulling
// back shrinks them toward small recon dots (MIN floor) so many world-anchored marks no
// longer collapse into an overlapping blob when their anchors project close together.
const MARK_SCALE_NEAR_H = 800;   // m: at/below this, full-size reticles
const MARK_SCALE_FAR_H = 6000;   // m: at/above this, minimum size
const MARK_SCALE_MIN = 0.32;     // floor so dots never vanish
const RING_OUTER_R = 34;
const RING_INNER_R = 18;
const DOT_R = 5;
const LABEL_DOT_R = 4;
function markScale(h) {
  if (!(h > MARK_SCALE_NEAR_H)) return 1;
  if (h >= MARK_SCALE_FAR_H) return MARK_SCALE_MIN;
  const t = (h - MARK_SCALE_NEAR_H) / (MARK_SCALE_FAR_H - MARK_SCALE_NEAR_H);
  return 1 - t * (1 - MARK_SCALE_MIN);
}

export function createScreenAnnotationRenderer(viewer, {
  overlayPaintRect = getOverlayPaintRect,
  activeTrackedReadoutId = getActiveTrackedReadoutId,
} = {}) {
  injectStyles();
  const { layer, svg, defs } = buildOverlay();
  document.body.appendChild(layer);

  const scene = viewer.scene;
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, scene.camera.positionWC);
  const records = new Map(); // anno.id -> { anno, group, parts }
  const scratch = new Cesium.Cartesian2();
  const scratchDir = new Cesium.Cartesian3();
  // Per-point ground height cache. Marks must sit on the real surface, not at
  // sea level — otherwise in elevated cities (Austin ~150 m) they project
  // underground and parallax sinks them at oblique angles. Sampled once the
  // tiles under the point load, then settled (stable, no per-frame jitter).
  const heightCache = new Map();
  const HEIGHT_CACHE_SOFT = 600; // target size; over this we evict keys not used this frame
  const HEIGHT_CACHE_HARD = 8000; // absolute ceiling (one big ring + others) — never exceeded
  let projGen = 0; // bumped each projection frame; entries used this frame are "hot"
  function trimHeightCache() {
    if (heightCache.size <= HEIGHT_CACHE_SOFT) return;
    // Evict COLD keys first (not touched this frame), so a single large area/route
    // — the screen renderer can project a ring up to ~4000 points — cannot churn its
    // OWN active heights out of cache and force a clampToHeight every frame.
    for (const [k, v] of heightCache) {
      if (heightCache.size <= HEIGHT_CACHE_SOFT) break;
      if (v.gen !== projGen) heightCache.delete(k);
    }
    // Backstop if a single frame legitimately needs more than the soft cap.
    while (heightCache.size > HEIGHT_CACHE_HARD) {
      const oldest = heightCache.keys().next().value;
      if (oldest === undefined) break;
      heightCache.delete(oldest);
    }
  }

  // Re-project every annotation each rendered frame so marks stay glued to the
  // world. postRender runs after the camera/tiles update, so positions are exact.
  const onPostRender = () => projectAll();
  scene.postRender.addEventListener(onPostRender);

  function color(anno) {
    return PALETTE[anno.color] || PALETTE.primary;
  }

  // Best-effort surface height under a coordinate (clamps onto the 3D tiles).
  // Returns 0 until the tile loads, then caches the validated height.
  function groundHeight(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    const cached = heightCache.get(key);
    if (cached && cached.settled) {
      // Mark hot for this frame + bump to most-recently-used so heights for live
      // marks survive eviction while places we've navigated away from age out.
      cached.gen = projGen;
      heightCache.delete(key);
      heightCache.set(key, cached);
      return cached.h;
    }
    try {
      if (scene.clampToHeightSupported && typeof scene.clampToHeight === 'function') {
        const c = scene.clampToHeight(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
        if (c) {
          const h = Cesium.Cartographic.fromCartesian(c).height;
          if (Number.isFinite(h) && h > -430 && h < 9000) {
            heightCache.set(key, { h, settled: true, gen: projGen });
            trimHeightCache();
            return h;
          }
        }
      }
    } catch { /* tiles not ready */ }
    const fallback = cached ? cached.h : 0;
    heightCache.set(key, { h: fallback, settled: false, gen: projGen });
    trimHeightCache();
    return fallback;
  }

  function add(anno) {
    const c = color(anno);
    const group = svgEl('g', { class: 'gev-anno', opacity: '0' });
    const parts = {};

    if (anno.type === 'area' && anno.ring && anno.ring.length >= 3) {
      // Synthesized (buffered/approximate) areas render DASHED + fainter, with no
      // "draw-on" gesture, so they never masquerade as an authoritative boundary.
      parts.poly = svgEl('polygon', {
        class: anno.synthesized ? 'gev-anno-area' : 'gev-anno-area gev-draw',
        fill: c, stroke: c,
        'fill-opacity': anno.synthesized ? '0.08' : '0.14',
        'stroke-width': '2.5',
        ...(anno.synthesized ? { 'stroke-dasharray': '9 7' } : {}),
        filter: 'url(#gev-sketch)',
      });
      group.appendChild(parts.poly);
      parts.label = makeCallout(anno.label, c);
      if (parts.label) group.appendChild(parts.label.node);
    } else if (anno.type === 'arrow' && anno.to) {
      parts.path = svgEl('path', {
        class: 'gev-anno-arrow gev-draw', fill: 'none', stroke: c,
        'stroke-width': '3', 'marker-end': `url(#gev-arrow-${anno.color || 'primary'})`,
        filter: 'url(#gev-sketch)',
      });
      ensureArrowMarker(defs, anno.color || 'primary', c);
      group.appendChild(parts.path);
      parts.label = makeCallout(anno.label, c);
      if (parts.label) group.appendChild(parts.label.node);
    } else if (anno.type === 'route' && Array.isArray(anno.path) && anno.path.length >= 2) {
      // Multi-waypoint path: a drawn-on polyline with a dot at each waypoint.
      parts.poly = svgEl('polyline', {
        class: 'gev-anno-arrow gev-draw', fill: 'none', stroke: c,
        'stroke-width': '3', 'marker-end': `url(#gev-arrow-${anno.color || 'primary'})`,
        filter: 'url(#gev-sketch)',
      });
      ensureArrowMarker(defs, anno.color || 'primary', c);
      group.appendChild(parts.poly);
      parts.dots = anno.path.map(() => {
        const dot = svgEl('circle', { class: 'gev-anno-dot', fill: c, stroke: '#06121c', 'stroke-width': '2', r: '4' });
        group.appendChild(dot);
        return dot;
      });
      parts.label = makeCallout(anno.label, c);
      if (parts.label) group.appendChild(parts.label.node);
    } else {
      // pin / highlight / label — pulsing target rings + a marker dot + callout
      if (anno.type !== 'label') {
        parts.ringOuter = svgEl('circle', { class: 'gev-anno-ring gev-pulse', fill: 'none', stroke: c, 'stroke-width': '2', r: '34' });
        parts.ringInner = svgEl('circle', { class: 'gev-anno-ring', fill: c, 'fill-opacity': '0.12', stroke: c, 'stroke-width': '2.5', r: '18', filter: 'url(#gev-sketch)' });
        group.appendChild(parts.ringOuter);
        group.appendChild(parts.ringInner);
      }
      parts.dot = svgEl('circle', { class: 'gev-anno-dot', fill: c, stroke: '#06121c', 'stroke-width': '2', r: anno.type === 'label' ? '4' : '5' });
      group.appendChild(parts.dot);
      parts.leader = svgEl('line', { class: 'gev-anno-leader', stroke: c, 'stroke-width': '1.5', 'stroke-opacity': '0.7' });
      group.appendChild(parts.leader);
      parts.label = makeCallout(anno.label, c);
      if (parts.label) group.appendChild(parts.label.node);
    }

    // Record the mark BEFORE it touches the live document, then unwind on any
    // throw from here down (projectAll reaches into Cesium and can fail on a
    // lost context). Previously a throw past the DOM insert left an ORPHANED
    // <g>: the engine's rollback only deletes its own map entry, so the next
    // annotate of the same geometry stacked a fresh mark on top of the corpse.
    records.set(anno.id, { anno, group, parts });
    try {
      svg.appendChild(group);
      // trigger draw-on / fade-in on the next frame
      requestAnimationFrame(() => group.classList.add('gev-in'));
      // The draw-on effect uses a fixed stroke-dasharray of 1400 (see CSS). Any
      // stroke longer than 1400px (a long arrow/route on a wide window) would keep
      // a permanent dash gap — the arrowhead detaches from the truncated line (H6).
      // Once the dashoffset transition finishes the stroke is meant to be fully
      // drawn, so drop the dasharray entirely then and the stroke reads solid at
      // any length. Guarded on the specific property so an unrelated transition
      // (none here, but defensive) doesn't clear it early.
      for (const drawEl of group.querySelectorAll('.gev-draw')) {
        drawEl.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'stroke-dashoffset') {
            drawEl.style.strokeDasharray = 'none';
          }
        }, { once: true });
      }
      projectAll();
    } catch (error) {
      // Hard, immediate unwind — a mark that never finished has nothing to
      // fade out, and the caller (engine rollback) must find a clean board.
      records.delete(anno.id);
      try { group.remove(); } catch { /* never inserted */ }
      if (records.size === 0) heightCache.clear();
      throw error;
    }
  }

  /**
   * Re-seat a progressive area upgrade without replacing its SVG group. The hybrid
   * renderer converts the pending reticle to a centroid label; keeping the group
   * preserves element identity and prevents the old/new 320 ms fades from overlapping.
   */
  function update(anno, { empty = false } = {}) {
    const rec = records.get(anno.id);
    if (!rec) {
      if (!empty) add(anno);
      return;
    }
    rec.anno = anno;

    if (empty) {
      for (const child of Array.from(rec.group.children)) child.remove();
      rec.parts = {};
      rec.hidden = true;
      projectAll();
      return;
    }
    rec.hidden = false;

    // Pending areas are initially rendered by this branch as point reticles. On
    // outline resolution the hybrid renderer changes only their screen proxy to a
    // label, whose dot/leader/callout already exist; remove the two reticle rings and
    // keep every remaining node (especially the group and callout) alive.
    if (anno.type === 'label' && rec.parts.dot) {
      rec.parts.ringOuter?.remove();
      rec.parts.ringInner?.remove();
      delete rec.parts.ringOuter;
      delete rec.parts.ringInner;
      rec.parts.dot.setAttribute('r', String(LABEL_DOT_R));
      projectAll();
      return;
    }

    // Area-type updates route through the hybrid proxy only.
  }

  function project(lon, lat) {
    // Anchor at the real surface height (cached + validated), so marks sit on
    // the ground/building instead of at sea level. The settle-once cache keeps
    // it stable (no per-frame jitter that earlier broke nearby projections).
    const world = Cesium.Cartesian3.fromDegrees(lon, lat, groundHeight(lon, lat));
    // Reject points behind the camera (they produce wrapped/extreme coords).
    Cesium.Cartesian3.subtract(world, scene.camera.positionWC, scratchDir);
    if (Cesium.Cartesian3.dot(scratchDir, scene.camera.directionWC) <= 0) return null;
    // Reject points beyond the globe horizon.
    if (!occluder.isPointVisible(world)) return null;
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world, scratch);
    if (!win || !Number.isFinite(win.x) || !Number.isFinite(win.y)) return null;
    // Reject absurd off-screen projections (anchor not in view).
    const w = scene.canvas.clientWidth || scene.canvas.width;
    const h = scene.canvas.clientHeight || scene.canvas.height;
    if (win.x < -w || win.x > 2 * w || win.y < -h || win.y > 2 * h) return null;
    return { x: win.x, y: win.y };
  }

  // Tracked-entity z-order: the tracked aircraft is a Cesium billboard in the
  // CANVAS, which sits BELOW this SVG overlay (z-90, HTML over canvas). So a screen mark
  // could hide it. After layout, any mark whose ACTUAL projected bounding box (rings,
  // leader, polygon, route line, callout card — not just the anchor) INTERSECTS the
  // tracked subject's screen FOOTPRINT is faded. The complete card footprint comes
  // from the host's ACTUAL painted rectangle after final layout; the billboard extent
  // is unioned for aircraft/satellites that also own a native tracked graphic.
  const TRACKED_BBOX_MARGIN = 8;     // px buffer added around the footprint
  const TRACKED_FADE_EASE = 0.22;    // per-frame ease toward hidden(0) / visible(1)
  const TRACKED_HYSTERESIS_PX = 18;  // dead-band so the overlap test can't flip-flop
  const _scratchTrackedWin = new Cesium.Cartesian2();

  // Evaluate a NearFarScalar (billboard scaleByDistance) at a camera distance.
  function nearFarValue(nfs, dist) {
    if (dist <= nfs.near) return nfs.nearValue;
    if (dist >= nfs.far) return nfs.farValue;
    const t = (dist - nfs.near) / (nfs.far - nfs.near);
    return nfs.nearValue + t * (nfs.farValue - nfs.nearValue);
  }
  // Tracked-subject screen footprint, or null when neither host card nor native
  // tracked graphic painted. The host rectangle is authoritative for the card.
  function trackedEntityRect() {
    const trackedId = activeTrackedReadoutId();
    const painted = trackedId
      ? overlayPaintRect(TRACKED_OVERLAY_SOURCE_ID, trackedId)
      : null;
    let left = painted?.x;
    let right = painted ? painted.x + painted.w : undefined;
    let top = painted?.y;
    let bottom = painted ? painted.y + painted.h : undefined;

    const ent = viewer.trackedEntity;
    const now = Cesium.JulianDate.now();
    const world = typeof ent?.gevDisplayPosition === 'function'
      ? ent.gevDisplayPosition()
      : null;
    const win = world
      ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, world, _scratchTrackedWin)
      : null;

    // Billboard box — centered on the anchor, magnified by scaleByDistance.
    const bb = ent?.billboard;
    if (bb && win && Number.isFinite(win.x) && Number.isFinite(win.y)) {
      const baseW = bb.width?.getValue?.(now) ?? 28;
      const baseH = bb.height?.getValue?.(now) ?? 28;
      let scale = 1;
      const sbd = bb.scaleByDistance?.getValue?.(now);
      if (sbd) scale = nearFarValue(sbd, Cesium.Cartesian3.distance(scene.camera.positionWC, world));
      const hw = (baseW * scale) / 2; const hh = (baseH * scale) / 2;
      const bbLeft = win.x - hw;
      const bbRight = win.x + hw;
      const bbTop = win.y - hh;
      const bbBottom = win.y + hh;
      left = Number.isFinite(left) ? Math.min(left, bbLeft) : bbLeft;
      right = Number.isFinite(right) ? Math.max(right, bbRight) : bbRight;
      top = Number.isFinite(top) ? Math.min(top, bbTop) : bbTop;
      bottom = Number.isFinite(bottom) ? Math.max(bottom, bbBottom) : bbBottom;
    }
    if (![left, right, top, bottom].every(Number.isFinite)) return null;

    const m = TRACKED_BBOX_MARGIN;
    return { left: left - m, right: right + m, top: top - m, bottom: bottom + m };
  }

  function projectAll() {
    if (!records.size) return;
    projGen += 1; // new frame: entries touched below are "hot" and survive trimming
    const trackedRect = trackedEntityRect();
    occluder.cameraPosition = scene.camera.positionWC;
    const h = scene.canvas.clientHeight || scene.canvas.height;
    const w = scene.canvas.clientWidth || scene.canvas.width;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // Shrink point-marker geometry as the camera pulls back (declutter the blob).
    const mScale = markScale(viewer.camera.positionCartographic?.height ?? 1000);

    for (const rec of records.values()) {
      const { anno, group, parts } = rec;
      if (rec.hidden) {
        group.style.display = 'none';
        continue;
      }
      group.setAttribute('opacity', String(anno.alpha ?? 1));

      if (anno.type === 'area' && parts.poly) {
        const pts = [];
        let cx = 0; let cy = 0; let n = 0;
        for (const [lon, lat] of anno.ring) {
          const p = project(lon, lat);
          if (!p) continue;
          pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
          cx += p.x; cy += p.y; n++;
        }
        if (pts.length >= 3) {
          parts.poly.setAttribute('points', pts.join(' '));
          group.style.display = '';
          if (parts.label) positionCallout(parts.label, cx / n, cy / n - 6, true);
        } else {
          group.style.display = 'none';
        }
      } else if (anno.type === 'arrow' && parts.path) {
        const a = project(anno.anchor.lon, anno.anchor.lat);
        const b = project(anno.to.lon, anno.to.lat);
        if (a && b) {
          // gentle arc so the connector reads as a drawn gesture, not a ruler line
          const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
          const dx = b.x - a.x; const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.min(60, len * 0.18);
          const ctrlX = mx - (dy / len) * bow;
          const ctrlY = my + (dx / len) * bow;
          parts.path.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
          group.style.display = '';
          // Anchor the label to the (stable) endpoint midpoint, lifted toward the bow.
          if (parts.label) positionCallout(parts.label, mx + (ctrlX - mx) * 0.5, my + (ctrlY - my) * 0.5 - 8, true);
        } else {
          group.style.display = 'none';
        }
      } else if (anno.type === 'route' && parts.poly) {
        const projected = anno.path.map((pt) => project(pt.lon, pt.lat));
        const pts = [];
        for (const p of projected) {
          if (p) pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
        }
        if (pts.length >= 2) {
          parts.poly.setAttribute('points', pts.join(' '));
          // dots at each resolvable waypoint; hide the rest
          parts.dots.forEach((dot, i) => {
            const p = projected[i];
            if (p) { dot.setAttribute('cx', p.x.toFixed(1)); dot.setAttribute('cy', p.y.toFixed(1)); dot.style.display = ''; }
            else { dot.style.display = 'none'; }
          });
          group.style.display = '';
          // label at the middle waypoint
          const mid = projected.filter(Boolean)[Math.floor(projected.filter(Boolean).length / 2)];
          if (parts.label && mid) positionCallout(parts.label, mid.x, mid.y - 12, true);
        } else {
          group.style.display = 'none';
        }
      } else {
        const p = project(anno.anchor.lon, anno.anchor.lat);
        if (p) {
          group.style.display = '';
          const baseDotR = anno.type === 'label' ? LABEL_DOT_R : DOT_R;
          if (parts.dot) { parts.dot.setAttribute('cx', p.x.toFixed(1)); parts.dot.setAttribute('cy', p.y.toFixed(1)); parts.dot.setAttribute('r', (baseDotR * mScale).toFixed(1)); }
          if (parts.ringOuter) { parts.ringOuter.setAttribute('cx', p.x.toFixed(1)); parts.ringOuter.setAttribute('cy', p.y.toFixed(1)); parts.ringOuter.setAttribute('r', (RING_OUTER_R * mScale).toFixed(1)); }
          if (parts.ringInner) { parts.ringInner.setAttribute('cx', p.x.toFixed(1)); parts.ringInner.setAttribute('cy', p.y.toFixed(1)); parts.ringInner.setAttribute('r', (RING_INNER_R * mScale).toFixed(1)); }
          if (parts.label) {
            // Keep the callout tucked near the (now smaller) reticle by scaling its offset.
            const lx = p.x + 18 * mScale; const ly = p.y - 34 * mScale;
            positionCallout(parts.label, lx, ly, false);
            if (parts.leader) {
              parts.leader.setAttribute('x1', p.x.toFixed(1)); parts.leader.setAttribute('y1', p.y.toFixed(1));
              parts.leader.setAttribute('x2', lx.toFixed(1)); parts.leader.setAttribute('y2', (ly + parts.label.height).toFixed(1));
              parts.label._leader = parts.leader; // so de-collision can re-point it
            }
          }
        } else {
          group.style.display = 'none';
        }
      }
    }

    // Keep clustered callouts readable.
    const placed = [];
    for (const rec of records.values()) {
      const cal = rec.parts.label;
      if (cal && cal.sized && rec.group.style.display !== 'none' && Number.isFinite(cal._x)) {
        placed.push(cal);
      }
    }
    if (placed.length > 1) decollideCallouts(placed);

    // Tracked-entity z-order — runs AFTER all geometry + callout de-collision so each
    // group's bbox reflects its final on-screen extent. Any mark whose bbox INTERSECTS
    // the tracked entity's screen footprint is faded toward FULLY HIDDEN (target 0, not a
    // partial dim) so the tracked plane/ship reads as genuinely ON TOP. The fade is EASED
    // per frame (no abrupt pop as the entity crosses a mark) and reverses smoothly when
    // it moves off. Every screen mark here is point-like (pins/labels/reticles/arrows) —
    // the big area/route footprints live in the world layer — so fully hiding an
    // overlapped one is safe and not jarring.
    for (const rec of records.values()) {
      const { anno, group } = rec;
      if (group.style.display === 'none') continue;
      const cur = rec._trackedFade ?? 1;
      let overlapping = false;
      if (trackedRect) {
        let bb = null;
        try { bb = group.getBBox(); } catch { bb = null; }
        if (bb && (bb.width !== 0 || bb.height !== 0)) {
          // HYSTERESIS: a mark that's already hidden must clear the rect by
          // TRACKED_HYSTERESIS_PX before it starts showing again; one that's visible fades
          // as soon as it touches. The dead-band stops the overlap test from flip-flopping
          // frame-to-frame (the pulsing reticle stroke + de-collided cards keep the bbox in
          // motion), which was the source of the flicker.
          const m = cur < 0.5 ? TRACKED_HYSTERESIS_PX : 0;
          overlapping = bb.x <= trackedRect.right + m && bb.x + bb.width >= trackedRect.left - m
            && bb.y <= trackedRect.bottom + m && bb.y + bb.height >= trackedRect.top - m;
        }
      }
      const target = overlapping ? 0 : 1;
      const next = cur + (target - cur) * TRACKED_FADE_EASE;
      rec._trackedFade = Math.abs(next - target) < 0.02 ? target : next;
      // Only override when faded — otherwise leave the base alpha (set above) intact.
      // (The CSS `transition: opacity` was removed from .gev-anno so this per-frame JS ease
      // is the ONLY easing — previously the two fought and produced an opacity oscillation.)
      if (rec._trackedFade !== 1) {
        group.setAttribute('opacity', String((anno.alpha ?? 1) * rec._trackedFade));
      }
    }
  }

  function remove(anno) {
    const rec = records.get(anno.id);
    if (!rec) return;
    rec.group.classList.remove('gev-in');
    rec.group.classList.add('gev-out');
    const node = rec.group;
    window.setTimeout(() => { try { node.remove(); } catch { /* gone */ } }, 360);
    records.delete(anno.id);
    // Board emptied → drop accumulated height samples (natural reset point).
    if (records.size === 0) heightCache.clear();
  }

  function sync() {
    // Positioning is driven by the postRender loop; nothing to batch here.
    projectAll();
  }

  function destroy() {
    try { scene.postRender.removeEventListener(onPostRender); } catch { /* torn down */ }
    try { layer.remove(); } catch { /* gone */ }
    records.clear();
    heightCache.clear();
  }

  return { add, update, remove, sync, destroy };
}

// --- SVG helpers ------------------------------------------------------------

function buildOverlay() {
  const layer = document.createElement('div');
  layer.className = 'gev-screen-whiteboard';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'gev-screen-whiteboard-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS(SVGNS, 'defs');
  // subtle hand-drawn wobble for strokes
  defs.innerHTML = `
    <filter id="gev-sketch" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`;
  svg.appendChild(defs);
  layer.appendChild(svg);
  return { layer, svg, defs };
}

function makeCallout(text, c) {
  if (!text) return null;
  const node = document.createElementNS(SVGNS, 'g');
  node.setAttribute('class', 'gev-anno-callout');
  const rect = document.createElementNS(SVGNS, 'rect');
  rect.setAttribute('rx', '5');
  rect.setAttribute('class', 'gev-anno-card');
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('class', 'gev-anno-text');
  t.setAttribute('x', '9');
  t.setAttribute('y', '16');
  t.textContent = text;
  const accent = document.createElementNS(SVGNS, 'rect');
  accent.setAttribute('class', 'gev-anno-accent');
  accent.setAttribute('width', '3');
  accent.setAttribute('rx', '1.5');
  accent.setAttribute('fill', c);
  node.appendChild(rect);
  node.appendChild(accent);
  node.appendChild(t);
  const callout = { node, rect, text: t, accent, width: 0, height: 26, sized: false };
  // size the card to the text once it is in the DOM
  requestAnimationFrame(() => sizeCallout(callout));
  return callout;
}

function sizeCallout(callout) {
  try {
    const bbox = callout.text.getBBox();
    const w = Math.max(24, bbox.width + 18);
    const h = Math.max(22, bbox.height + 10);
    callout.rect.setAttribute('width', String(w));
    callout.rect.setAttribute('height', String(h));
    callout.accent.setAttribute('height', String(h - 8));
    callout.accent.setAttribute('x', '0');
    callout.accent.setAttribute('y', '4');
    callout.width = w;
    callout.height = h;
    callout.sized = true;
  } catch { /* not laid out yet */ }
}

function positionCallout(callout, x, y, center) {
  if (!callout.sized) sizeCallout(callout);
  const tx = center ? x - callout.width / 2 : x;
  callout._x = tx;
  callout._y = y;
  callout.node.setAttribute('transform', `translate(${tx.toFixed(1)}, ${y.toFixed(1)})`);
}

/**
 * Nudge overlapping callout cards apart so labels stay readable when several
 * marks cluster on screen. Simple top-down sweep: each card that overlaps an
 * earlier one is pushed just below it. O(n²) but n is small.
 */
function decollideCallouts(callouts) {
  callouts.sort((a, b) => a._y - b._y);
  for (let i = 0; i < callouts.length; i++) {
    const a = callouts[i];
    for (let j = 0; j < i; j++) {
      const b = callouts[j];
      const overlapX = a._x < b._x + b.width + 6 && a._x + a.width + 6 > b._x;
      const overlapY = a._y < b._y + b.height && a._y + a.height > b._y;
      if (overlapX && overlapY) {
        a._y = b._y + b.height + 5;
        a.node.setAttribute('transform', `translate(${a._x.toFixed(1)}, ${a._y.toFixed(1)})`);
        if (a._leader) {
          a._leader.setAttribute('x2', a._x.toFixed(1));
          a._leader.setAttribute('y2', a._y.toFixed(1));
        }
      }
    }
  }
}

function ensureArrowMarker(defs, key, c) {
  if (defs.querySelector(`#gev-arrow-${key}`)) return;
  const marker = document.createElementNS(SVGNS, 'marker');
  marker.setAttribute('id', `gev-arrow-${key}`);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  path.setAttribute('fill', c);
  marker.appendChild(path);
  defs.appendChild(marker);
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function injectStyles() {
  if (document.getElementById('gev-screen-whiteboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'gev-screen-whiteboard-styles';
  style.textContent = `
  .gev-screen-whiteboard { position: fixed; inset: 0; pointer-events: none; z-index: 90; }
  .gev-screen-whiteboard-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  /* No CSS opacity transition here on purpose: group opacity is driven per-frame in JS
     (the 260ms fade-in via computeAlpha, and the tracked-entity z-order ease). A CSS
     transition fought those per-frame writes and made the tracked-fade opacity oscillate
     (flicker). Fade-OUT keeps its own transition via .gev-anno.gev-out below. */
  .gev-anno-ring { filter: drop-shadow(0 0 6px currentColor); }
  .gev-anno-dot { filter: drop-shadow(0 0 5px rgba(255,255,255,0.6)); }
  .gev-anno-area { filter: drop-shadow(0 0 5px currentColor); }
  .gev-anno-arrow { filter: drop-shadow(0 0 4px currentColor); stroke-linecap: round; }
  .gev-anno-leader { stroke-dasharray: 2 3; }
  .gev-anno-card { fill: rgba(8,18,28,0.78); stroke: rgba(255,255,255,0.14); stroke-width: 1; }
  .gev-anno-text { fill: #eaf6ff; font: 600 13px "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.02em; }
  /* draw-on: outlined shapes reveal their stroke */
  .gev-draw { stroke-dasharray: 1400; stroke-dashoffset: 1400; }
  .gev-anno.gev-in .gev-draw { transition: stroke-dashoffset 900ms ease-out; stroke-dashoffset: 0; }
  /* opacity-only fade-in: a CSS transform here would override the SVG transform
     attribute used to POSITION the callout and snap it to 0,0. */
  .gev-anno-callout { opacity: 0; }
  .gev-anno.gev-in .gev-anno-callout { animation: gev-pop 320ms ease-out both; }
  .gev-anno.gev-out { opacity: 0 !important; transition: opacity 320ms ease; }
  .gev-pulse { animation: gev-ring-pulse 1.8s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
  @keyframes gev-ring-pulse { 0%,100% { opacity: 0.9; stroke-width: 2; } 50% { opacity: 0.35; stroke-width: 3.5; } }
  @keyframes gev-pop { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);
}
