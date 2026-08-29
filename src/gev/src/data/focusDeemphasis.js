import * as Cesium from 'cesium';

/**
 * Focus-aware sprite treatment shared by the live contact layers.
 *
 * The selected target is protected by changing ambient sprite alpha, never by
 * collection ordering: Cesium's translucent distance sort is not stable for
 * collections with similar bounding volumes. This is a narrow amendment to
 * the normal always-visible contact rule. Ambient contacts remain present and
 * never fall below `dimFloor`; only sprites competing with the tracked target
 * are smoothly de-emphasized.
 *
 * The production consumers sample this service every 80 ms. The default
 * 300 ms attack and 600 ms release deliberately span several consumer
 * quanta, so a contact receives at least four distinct rendered emphasis
 * values during attack instead of crossing the range in one or two ticks.
 */

export const DEFAULT_FOCUS_DEEMPHASIS_PARAMS = Object.freeze({
  paddingPx: 18,
  dimFloor: 0.25,
  nearerBehavior: 'allow',
  hysteresisPx: 6,
  distanceHysteresisRatio: 0.08,
  attackMs: 300,
  releaseMs: 600,
  writeEpsilon: 0.005,
});

let _params = { ...DEFAULT_FOCUS_DEEMPHASIS_PARAMS };
let _focusTarget = null;
const _spriteStates = new WeakMap();
const _scratchScreen = new Cesium.Cartesian2();
const _advanceResult = {
  factor: 1,
  changed: false,
  transitioning: false,
  active: false,
  desired: 1,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvedParams(overrides) {
  if (!overrides || overrides === _params) return _params;
  return { ..._params, ...overrides };
}

function focusTargetEmphasisResolved(
  spriteScreenPosition,
  spriteCameraDistance,
  target,
  tuning,
  previouslyCompeting,
  spriteHalfWidthPx,
  spriteHalfHeightPx,
  previouslyFarther,
) {
  if (!target?.screenRect || !spriteScreenPosition) return 1;
  if (!Number.isFinite(spriteScreenPosition.x) || !Number.isFinite(spriteScreenPosition.y)) return 1;

  // Published rects already contain their publication-time padding. The
  // delta keeps direct pure-function calls and runtime A/B overrides honest.
  // The ambient extent makes overlap mean visual overlap, not center-point
  // containment: a class-sized icon whose edge intrudes into the focus rect
  // yields even when its center remains just outside it.
  const paddingDelta = tuning.paddingPx - (Number.isFinite(target.paddingPx) ? target.paddingPx : 0);
  const hysteresis = previouslyCompeting ? tuning.hysteresisPx : 0;
  const expansionX = paddingDelta + hysteresis
    + Math.max(0, Number.isFinite(spriteHalfWidthPx) ? spriteHalfWidthPx : 0);
  const expansionY = paddingDelta + hysteresis
    + Math.max(0, Number.isFinite(spriteHalfHeightPx) ? spriteHalfHeightPx : 0);
  const rect = target.screenRect;
  const inside = spriteScreenPosition.x >= rect.left - expansionX
    && spriteScreenPosition.x <= rect.right + expansionX
    && spriteScreenPosition.y >= rect.top - expansionY
    && spriteScreenPosition.y <= rect.bottom + expansionY;
  if (!inside) return 1;

  const floor = clamp(tuning.dimFloor, 0.01, 1);
  if (tuning.nearerBehavior === 'dim') return floor;

  const distanceBand = Number.isFinite(target.cameraDistance)
    ? Math.max(0, target.cameraDistance * tuning.distanceHysteresisRatio)
    : 0;
  const fartherThreshold = Number.isFinite(target.cameraDistance)
    ? target.cameraDistance + (previouslyFarther ? -distanceBand : distanceBand)
    : Number.NaN;
  const farther = !Number.isFinite(spriteCameraDistance)
    || !Number.isFinite(fartherThreshold)
    || spriteCameraDistance >= fartherThreshold;
  if (farther) return floor;
  if (tuning.nearerBehavior === 'partial') return floor + (1 - floor) * 0.5;
  return 1;
}

function smoothFocusEmphasisResolved(current, target, elapsedMs, tuning) {
  const from = clamp(Number.isFinite(current) ? current : 1, tuning.dimFloor, 1);
  const to = clamp(Number.isFinite(target) ? target : 1, tuning.dimFloor, 1);
  if (Math.abs(to - from) < Number.EPSILON) return to;
  const duration = to < from ? tuning.attackMs : tuning.releaseMs;
  if (duration <= 0) return to;
  const t = clamp((Number.isFinite(elapsedMs) ? elapsedMs : 0) / duration, 0, 1);
  // Cubic ease-out reaches the exact endpoint at the configured duration and
  // stays continuous when a moving contact reverses direction mid-transition.
  const eased = 1 - ((1 - t) ** 3);
  return clamp(from + (to - from) * eased, tuning.dimFloor, 1);
}

/**
 * Replace the runtime tuning values used by every focus consumer.
 * Unknown keys are ignored so evidence-harness overrides cannot accidentally
 * grow an undocumented rendering contract.
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [patch]
 * @returns {typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS} Current normalized values.
 */
export function setFocusDeemphasisParams(patch = {}) {
  const next = { ..._params };
  if (Number.isFinite(patch.paddingPx)) next.paddingPx = Math.max(0, patch.paddingPx);
  if (Number.isFinite(patch.dimFloor)) next.dimFloor = clamp(patch.dimFloor, 0.01, 1);
  if (['allow', 'dim', 'partial'].includes(patch.nearerBehavior)) {
    next.nearerBehavior = patch.nearerBehavior;
  }
  if (Number.isFinite(patch.hysteresisPx)) next.hysteresisPx = Math.max(0, patch.hysteresisPx);
  if (Number.isFinite(patch.distanceHysteresisRatio)) {
    next.distanceHysteresisRatio = clamp(patch.distanceHysteresisRatio, 0, 0.5);
  }
  if (Number.isFinite(patch.attackMs)) next.attackMs = Math.max(0, patch.attackMs);
  if (Number.isFinite(patch.releaseMs)) next.releaseMs = Math.max(0, patch.releaseMs);
  if (Number.isFinite(patch.writeEpsilon)) next.writeEpsilon = Math.max(0, patch.writeEpsilon);
  _params = next;
  return { ..._params };
}

/** @returns {typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS} Current runtime tuning. */
export function getFocusDeemphasisParams() {
  return _params;
}

/** Restore production defaults. Primarily useful for deterministic QA. */
export function resetFocusDeemphasisParams() {
  _params = { ...DEFAULT_FOCUS_DEEMPHASIS_PARAMS };
}

/**
 * Publish a focus target from the exact world position already cached by its
 * tracking/render path. Callers must never re-derive a position here: a second
 * propagation/dead-reckoning sample at a different frame phase recreates the
 * tracked-target jitter class this service is designed to avoid.
 *
 * @param {object} input
 * @param {string} input.ownerLayer
 * @param {string|number} input.id
 * @param {Cesium.Scene} input.scene
 * @param {Cesium.Camera} input.camera
 * @param {Cesium.Cartesian3} input.displayPosition Cached display position.
 * @param {number} [input.widthPx=24] Projected visual width before padding.
 * @param {number} [input.heightPx=24] Projected visual height before padding.
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [input.params]
 * @returns {object|null} Published target, or null when it cannot be projected.
 */
export function publishFocusTargetFromCachedPosition({
  ownerLayer,
  id,
  scene,
  camera,
  displayPosition,
  widthPx = 24,
  heightPx = 24,
  params,
}) {
  if (!ownerLayer || id === null || id === undefined || !scene || !camera || !displayPosition) {
    clearFocusTarget(ownerLayer, id);
    return null;
  }
  const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, displayPosition, _scratchScreen);
  if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
    clearFocusTarget(ownerLayer, id);
    return null;
  }
  const tuning = resolvedParams(params);
  const padding = tuning.paddingPx;
  const halfWidth = Math.max(1, widthPx) / 2;
  const halfHeight = Math.max(1, heightPx) / 2;
  const appeared = !_focusTarget;
  _focusTarget = {
    ownerLayer,
    id,
    screenRect: {
      left: screen.x - halfWidth - padding,
      top: screen.y - halfHeight - padding,
      right: screen.x + halfWidth + padding,
      bottom: screen.y + halfHeight + padding,
    },
    paddingPx: padding,
    cameraDistance: Cesium.Cartesian3.distance(camera.positionWC, displayPosition),
    frameNumber: scene.frameState?.frameNumber ?? -1,
  };
  if (appeared) {
    for (const listener of _focusAppearListeners) {
      try { listener(); } catch (e) { console.warn('[focus] appear listener error:', e); }
    }
  }
  return _focusTarget;
}

const _focusAppearListeners = new Set();

/**
 * Notify on the null→set edge of the shared focus target. Consumers that
 * self-suspend their per-frame focus work (e.g. CCTV's projection loop) use
 * this single edge to re-arm; the set→null edge needs no event because the
 * consumer's own loop is still running through the relax tail and
 * self-stops via focusPassIsNeeded. (perf wave 1)
 * @param {() => void} listener Called when a focus target is published after none existed.
 * @returns {() => void} Unsubscribe.
 */
export function onFocusTargetAppear(listener) {
  _focusAppearListeners.add(listener);
  return () => _focusAppearListeners.delete(listener);
}

/**
 * Clear the focus only when the caller still owns it. This prevents idle
 * tracked-layer ticks from erasing a target just published by another layer.
 * @param {string} [ownerLayer]
 * @param {string|number|null} [id]
 */
export function clearFocusTarget(ownerLayer, id = null) {
  if (!_focusTarget) return;
  if (ownerLayer && _focusTarget.ownerLayer !== ownerLayer) return;
  if (id !== null && id !== undefined && _focusTarget.id !== id) return;
  _focusTarget = null;
}

/** @returns {object|null} The current shared focus target. */
export function getFocusTarget() {
  return _focusTarget;
}

/**
 * Pure focus decision for one ambient sprite.
 *
 * `previouslyCompeting` is state, not tuning: it expands the exit edge by
 * `hysteresisPx` without moving the entry edge. Farther sprites dim fully;
 * nearer treatment deliberately remains a runtime tuning choice.
 *
 * @param {{x:number,y:number}|null} spriteScreenPosition
 * @param {number} spriteCameraDistance
 * @param {object|null} target
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [params]
 * @param {boolean} [previouslyCompeting=false]
 * @param {number} [spriteHalfWidthPx=0] Ambient visual half-width.
 * @param {number} [spriteHalfHeightPx=spriteHalfWidthPx] Ambient visual half-height.
 * @param {boolean} [previouslyFarther=previouslyCompeting] Prior distance-side state.
 * @returns {number} Target emphasis in [dimFloor, 1].
 */
export function focusTargetEmphasis(
  spriteScreenPosition,
  spriteCameraDistance,
  target,
  params,
  previouslyCompeting = false,
  spriteHalfWidthPx = 0,
  spriteHalfHeightPx = spriteHalfWidthPx,
  previouslyFarther = previouslyCompeting,
) {
  const tuning = resolvedParams(params);
  return focusTargetEmphasisResolved(
    spriteScreenPosition,
    spriteCameraDistance,
    target,
    tuning,
    previouslyCompeting,
    spriteHalfWidthPx,
    spriteHalfHeightPx,
    previouslyFarther,
  );
}

/**
 * Pure time-based easing step. Attack means motion toward de-emphasis;
 * release means restoration toward full emphasis.
 * @param {number} current
 * @param {number} target
 * @param {number} elapsedMs
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [params]
 * @returns {number}
 */
export function smoothFocusEmphasis(current, target, elapsedMs, params) {
  const tuning = resolvedParams(params);
  return smoothFocusEmphasisResolved(current, target, elapsedMs, tuning);
}

/**
 * Advance one sprite's persistent focus state. The caller owns the eventual
 * color write so focus can compose with freshness/horizon alpha at one site.
 * @param {object} sprite Stable billboard/point primitive identity.
 * @param {object} input
 * @param {{x:number,y:number}|null} input.screenPosition
 * @param {number} input.cameraDistance
 * @param {number} input.nowMs
 * @param {object|null} [input.target]
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [input.params]
 * @param {number} [input.spriteHalfWidthPx=0]
 * @param {number} [input.spriteHalfHeightPx=input.spriteHalfWidthPx]
 *
 * IMPORTANT: the returned object is a module-owned mutable singleton. Consume
 * every needed property before the next call; never retain it as a snapshot.
 * @returns {{factor:number, changed:boolean, transitioning:boolean,active:boolean,desired:number}}
 */
export function advanceSpriteFocus(sprite, {
  screenPosition,
  cameraDistance,
  nowMs,
  target = _focusTarget,
  params,
  spriteHalfWidthPx = 0,
  spriteHalfHeightPx = spriteHalfWidthPx,
}) {
  const tuning = resolvedParams(params);
  let state = _spriteStates.get(sprite);
  if (!state) {
    if (!target) {
      _advanceResult.factor = 1;
      _advanceResult.changed = false;
      _advanceResult.transitioning = false;
      _advanceResult.active = false;
      _advanceResult.desired = 1;
      return _advanceResult;
    }
    state = {
      factor: 1,
      desired: 1,
      transitionFrom: 1,
      transitionStartMs: nowMs,
      wasFarther: false,
    };
    _spriteStates.set(sprite, state);
  }

  // First sample the OLD transition at this timestamp. If the desired state
  // changes, the new transition must begin at the value already on screen,
  // not the prior tick's stale anchor. This preserves progress during a
  // retarget and, paired with range hysteresis, prevents boundary chatter
  // from continually restarting at 1.0.
  const oldElapsedMs = Math.max(0, nowMs - state.transitionStartMs);
  const current = smoothFocusEmphasisResolved(
    state.transitionFrom,
    state.desired,
    oldElapsedMs,
    tuning,
  );
  const desired = focusTargetEmphasisResolved(
    screenPosition,
    cameraDistance,
    target,
    tuning,
    state.desired < 1,
    spriteHalfWidthPx,
    spriteHalfHeightPx,
    state.wasFarther,
  );
  if (desired !== state.desired) {
    state.transitionFrom = current;
    state.transitionStartMs = nowMs;
    state.desired = desired;
  }
  const elapsedMs = Math.max(0, nowMs - state.transitionStartMs);
  const next = smoothFocusEmphasisResolved(state.transitionFrom, desired, elapsedMs, tuning);
  const changed = Math.abs(next - state.factor) > tuning.writeEpsilon;
  state.factor = next;
  state.desired = desired;
  state.wasFarther = tuning.nearerBehavior !== 'dim'
    && Math.abs(desired - tuning.dimFloor) <= tuning.writeEpsilon;
  const transitioning = Math.abs(next - desired) > tuning.writeEpsilon;
  const active = Math.abs(next - 1) > tuning.writeEpsilon;

  if (!target && !transitioning && next === 1) _spriteStates.delete(sprite);
  _advanceResult.factor = next;
  _advanceResult.changed = changed;
  _advanceResult.transitioning = transitioning;
  _advanceResult.active = active;
  _advanceResult.desired = desired;
  return _advanceResult;
}

/**
 * Project and advance one world-anchored sprite using an owning layer's
 * existing render pass.
 * @param {object} sprite Stable primitive identity.
 * @param {Cesium.Cartesian3} position Current cached/rendered world position.
 * @param {Cesium.Scene} scene
 * @param {Cesium.Camera} camera
 * @param {number} nowMs
 * @param {object|null} [target]
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [params]
 * @param {number} [spriteHalfWidthPx=0]
 * @param {number} [spriteHalfHeightPx=spriteHalfWidthPx]
 * @returns {{factor:number, changed:boolean, transitioning:boolean,active:boolean,desired:number}}
 */
export function advanceProjectedSpriteFocus(
  sprite,
  position,
  scene,
  camera,
  nowMs,
  target = _focusTarget,
  params,
  spriteHalfWidthPx = 0,
  spriteHalfHeightPx = spriteHalfWidthPx,
) {
  // Common case: nothing tracked and this sprite holds no dimming state —
  // advanceSpriteFocus would return identity without reading the projection,
  // so skip the worldToWindowCoordinates round trip entirely (it was N
  // wasted projections per fleet tick with nothing tracked). Sprites still
  // relaxing keep their state entry until fully settled (see the delete at
  // the transition tail), so they keep projecting until done. (perf item 8)
  if (!target && !_spriteStates.has(sprite)) {
    _advanceResult.factor = 1;
    _advanceResult.changed = false;
    _advanceResult.transitioning = false;
    _advanceResult.active = false;
    _advanceResult.desired = 1;
    return _advanceResult;
  }
  const screen = position && scene
    ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, _scratchScreen)
    : null;
  const cameraDistance = position && camera?.positionWC
    ? Cesium.Cartesian3.distance(camera.positionWC, position)
    : Number.NaN;
  return advanceSpriteFocus(sprite, {
    screenPosition: screen,
    cameraDistance,
    nowMs,
    target,
    params,
    spriteHalfWidthPx,
    spriteHalfHeightPx,
  });
}

/**
 * A gated consumer must keep ticking until every previously dimmed sprite has
 * returned to identity, even when no target remains.
 * @param {object|null} target
 * @param {number} activeCount Count of emphasis factors outside the 1.0 deadband.
 * @returns {boolean}
 */
export function focusPassIsNeeded(target, activeCount) {
  return target !== null && target !== undefined
    || (Number.isFinite(activeCount) && activeCount > 0);
}

/**
 * Match Cesium's shader-side NearFarScalar interpolation for rendered extents.
 * Cesium interpolates against squared camera distance with a 0.2 exponent.
 * @param {{near:number,nearValue:number,far:number,farValue:number}|null} scalar
 * @param {number} cameraDistanceM
 * @returns {number}
 */
export function nearFarScalarValueAtDistance(scalar, cameraDistanceM) {
  if (!scalar || !Number.isFinite(cameraDistanceM)) return 1;
  const nearSq = scalar.near * scalar.near;
  const farSq = scalar.far * scalar.far;
  if (!Number.isFinite(nearSq) || !Number.isFinite(farSq) || farSq <= nearSq) return 1;
  const rawT = ((cameraDistanceM * cameraDistanceM) - nearSq) / (farSq - nearSq);
  const t = Math.pow(clamp(rawT, 0, 1), 0.2);
  return scalar.nearValue + (scalar.farValue - scalar.nearValue) * t;
}

/** Shared virtual time used only by the DEV evidence seam. */
let _focusEvidenceNowMs = null;

/** Resolve production time unless deterministic evidence capture owns it. */
export function focusNowMs(productionNowMs) {
  return _focusEvidenceNowMs ?? productionNowMs;
}

/** Set deterministic evidence time; called only through development seams. */
export function setFocusEvidenceNowMs(nowMs) {
  _focusEvidenceNowMs = Number.isFinite(nowMs) ? nowMs : null;
  return _focusEvidenceNowMs;
}

/** Advance deterministic evidence time without consulting a wall clock. */
export function advanceFocusEvidenceNowMs(deltaMs) {
  if (_focusEvidenceNowMs === null) return null;
  _focusEvidenceNowMs += Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
  return _focusEvidenceNowMs;
}

/** Forget state when a primitive is removed from its owning collection. */
export function forgetSpriteFocus(sprite) {
  if (sprite) _spriteStates.delete(sprite);
}

/**
 * Deadband predicate shared by consumers' final alpha write sites.
 * @param {number} currentAlpha
 * @param {number} nextAlpha
 * @param {Partial<typeof DEFAULT_FOCUS_DEEMPHASIS_PARAMS>} [params]
 * @returns {boolean}
 */
export function focusAlphaNeedsWrite(currentAlpha, nextAlpha, params) {
  const tuning = resolvedParams(params);
  return !Number.isFinite(currentAlpha)
    || Math.abs(currentAlpha - nextAlpha) > tuning.writeEpsilon;
}
