/** Normalize a heading into the [0, 360) range. */
export function normalizeHeading(value) {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** Advance a displayed heading along the shortest arc without exceeding a slew rate. */
export function slewHeading(current, target, maxStepDeg) {
  const from = normalizeHeading(current);
  const to = normalizeHeading(target);
  if (!Number.isFinite(maxStepDeg) || maxStepDeg <= 0) return from;
  const delta = ((to - from + 540) % 360) - 180;
  const step = Math.max(-maxStepDeg, Math.min(maxStepDeg, delta));
  return normalizeHeading(from + step);
}

/**
 * Return a bounded cockpit-anchor correction for one render step.
 *
 * The cockpit advances inertially from the aircraft's reported course/speed,
 * then uses this amount to converge on the layer's delayed display position.
 * Capping correction below forward speed prevents a late feed fix from
 * becoming a first-person surge or reversal while still removing drift.
 */
export function cockpitAnchorCorrectionStep(distanceM, speedMps, dtSec) {
  if (!Number.isFinite(distanceM) || distanceM <= 0
    || !Number.isFinite(dtSec) || dtSec <= 0) return 0;
  const dt = Math.min(0.1, dtSec);
  const speed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const eased = distanceM * (1 - Math.exp(-1.25 * dt));
  const correctionRateMps = Math.max(0.75, speed * 0.22);
  return Math.min(distanceM, eased, correctionRateMps * dt);
}

/** Return whether a throttled cockpit presentation update is due. */
export function cockpitUiUpdateDue(nowMs, lastUpdateMs, intervalMs) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(intervalMs) || intervalMs < 0) return false;
  if (!Number.isFinite(lastUpdateMs) || lastUpdateMs <= 0 || nowMs < lastUpdateMs) return true;
  return nowMs - lastUpdateMs >= intervalMs;
}

/** Return whether the bounded rendered-surface acquisition window has elapsed. */
export function cockpitSurfaceWaitExpired(nowMs, startedMs, timeoutMs = 5000) {
  if (![nowMs, startedMs, timeoutMs].every(Number.isFinite) || timeoutMs < 0) return true;
  return nowMs - startedMs >= timeoutMs;
}

/**
 * Keep the cockpit camera above the shared rendered-surface floor.
 * Unknown floors preserve the proposed camera height.
 */
export function cockpitGroundSafeHeight(proposedHeightM, groundHeightM, clearanceM) {
  if (!Number.isFinite(proposedHeightM)) return proposedHeightM;
  if (!Number.isFinite(groundHeightM)) return proposedHeightM;
  const clearance = Number.isFinite(clearanceM) ? Math.max(0, clearanceM) : 0;
  return Math.max(proposedHeightM, groundHeightM + clearance);
}

/**
 * Resolve the cockpit altitude readout without rewriting source aviation data.
 * Confirmed grounded contacts read zero feet; airborne contacts retain MSL.
 */
export function cockpitAltitudeDisplayFt(altitudeM, onGround) {
  if (onGround === true) return 0;
  return Number.isFinite(altitudeM) ? altitudeM * 3.28084 : null;
}

/** Format the cockpit Context scope without overstating installation coverage. */
export function formatCockpitContextScope(subjectLabel, radiusM, installationCoverage = null) {
  const normalizedLabel = typeof subjectLabel === 'string'
    ? subjectLabel.trim() || '—'
    : Number.isFinite(subjectLabel) ? String(subjectLabel) : '—';
  const radiusKm = Number.isFinite(radiusM) && radiusM >= 0
    ? String(Math.round(radiusM / 1000))
    : '—';
  const coverage = typeof installationCoverage === 'string'
    ? installationCoverage.trim()
    : '';
  const base = `${normalizedLabel} · ${radiusKm} KM AIR/SEA WINDOW`;
  return coverage
    ? `${base} · INSTALLATIONS ${coverage}`
    : base;
}

/** Return seven 30-degree compass divisions centered on a heading. */
export function compassDivisions(heading) {
  const center = Math.round(normalizeHeading(heading) / 30) * 30;
  return [-90, -60, -30, 0, 30, 60, 90].map((offset) => normalizeHeading(center + offset));
}

/** Format a compass division as a cardinal/intercardinal label or degrees. */
export function formatCompassDivision(heading) {
  const normalized = normalizeHeading(heading);
  const labels = new Map([
    [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
    [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
  ]);
  return labels.get(normalized) || String(Math.round(normalized)).padStart(3, '0');
}

/** Choose a readable altitude-tape interval for the current flight level. */
export function altitudeRulerStep(altitudeFt) {
  if (!Number.isFinite(altitudeFt)) return 500;
  const altitude = Math.max(0, altitudeFt);
  if (altitude < 5000) return 100;
  if (altitude < 15000) return 250;
  return 500;
}

/**
 * Return an odd number of altitude ticks whose fractional slots move smoothly
 * behind a fixed center pointer as altitude changes.
 */
export function altitudeRulerTicks(altitudeFt, count = 9) {
  if (!Number.isFinite(altitudeFt)) return [];
  const tickCount = Math.max(3, Math.floor(count) | 1);
  const altitude = Math.max(0, altitudeFt);
  const stepFt = altitudeRulerStep(altitude);
  const altitudeUnits = altitude / stepFt;
  const anchorUnits = Math.floor(altitudeUnits);
  const half = Math.floor(tickCount / 2);
  return Array.from({ length: tickCount }, (_, index) => {
    const tickUnits = anchorUnits + index - half;
    const slot = tickUnits - altitudeUnits;
    return {
      valueFt: Math.max(0, tickUnits * stepFt),
      slot,
      depth: Math.abs(slot),
      major: tickUnits % 2 === 0,
      stepFt,
    };
  });
}

/**
 * Return the horizontal inset needed to keep an altitude tick on a circular
 * keyhole rim. The tape places each slot at 8% of its diameter vertically.
 */
export function altitudeRulerCurveInset(slot) {
  if (!Number.isFinite(slot)) return 0;
  const normalizedY = Math.min(0.92, Math.abs(slot) * 0.16);
  return 1 - Math.sqrt(1 - normalizedY ** 2);
}

/** Render altitude-tape values as stable five-character flight-deck labels. */
export function formatAltitudeRulerTick(valueFt) {
  if (!Number.isFinite(valueFt)) return '-----';
  return String(Math.max(0, Math.round(valueFt))).padStart(5, '0');
}

/** Choose a readable speed-tape interval for the current ground speed. */
export function speedRulerStep(speedKt) {
  if (!Number.isFinite(speedKt)) return 25;
  const speed = Math.max(0, speedKt);
  if (speed < 100) return 10;
  if (speed < 300) return 20;
  return 25;
}

/** Return moving speed ticks behind a fixed current-speed pointer. */
export function speedRulerTicks(speedKt, count = 9) {
  if (!Number.isFinite(speedKt)) return [];
  const tickCount = Math.max(3, Math.floor(count) | 1);
  const speed = Math.max(0, speedKt);
  const stepKt = speedRulerStep(speed);
  const speedUnits = speed / stepKt;
  const anchorUnits = Math.floor(speedUnits);
  const half = Math.floor(tickCount / 2);
  return Array.from({ length: tickCount }, (_, index) => {
    const tickUnits = anchorUnits + index - half;
    const slot = tickUnits - speedUnits;
    return {
      valueKt: Math.max(0, tickUnits * stepKt),
      slot,
      depth: Math.abs(slot),
      major: tickUnits % 2 === 0,
      stepKt,
    };
  });
}

/** Render speed-tape values as stable three-character flight-deck labels. */
export function formatSpeedRulerTick(valueKt) {
  if (!Number.isFinite(valueKt)) return '---';
  return String(Math.max(0, Math.round(valueKt))).padStart(3, '0');
}

/** Return the initial great-circle bearing between two latitude/longitude points. */
export function bearingBetweenCoordinates(fromLat, fromLon, toLat, toLon) {
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return null;
  const φ1 = fromLat * Math.PI / 180;
  const φ2 = toLat * Math.PI / 180;
  const Δλ = (toLon - fromLon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2)
    - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
  return normalizeHeading(Math.atan2(y, x) * 180 / Math.PI);
}

/** Return a target bearing relative to the current heading in the [-180, 180) range. */
export function relativeBearing(bearing, heading) {
  if (!Number.isFinite(bearing) || !Number.isFinite(heading)) return null;
  return ((normalizeHeading(bearing) - normalizeHeading(heading) + 540) % 360) - 180;
}

/**
 * Resolve which flight layer owns the cockpit's tracked aircraft.
 *
 * Both layers can briefly describe a tracked aircraft during a cross-layer
 * handoff, so the viewer's normalized tracked identity (`gevTrackedId`) is the
 * tie-breaker — the same rule `militaryAwareness.currentTrackedFlightSubject`
 * uses. Layer precedence remains the fallback when no normalized identity is
 * available, so tracking paths that never stamp one keep working.
 * @param {object} [options] Candidate descriptors and the tracked identity.
 * @param {object|null} [options.civilian] `flightsLayer.getTrackedInfo()` result.
 * @param {object|null} [options.military] `militaryFlightsLayer.getTrackedInfo()` result.
 * @param {string} [options.trackedId] Normalized `<layerId>:<icao24>` tracked identity.
 * @returns {object|null} The owning layer's info stamped with its `layerId`.
 */
export function resolveTrackedAircraftInfo({
  civilian = null,
  military = null,
  trackedId = '',
} = {}) {
  const candidates = [];
  if (civilian) candidates.push({ ...civilian, layerId: 'flights' });
  if (military) candidates.push({ ...military, layerId: 'military' });
  if (!candidates.length) return null;
  const trackedKey = String(trackedId || '').trim().toLowerCase();
  if (trackedKey) {
    const owner = candidates.find(
      (candidate) => `${candidate.layerId}:${candidate.icao24}`.toLowerCase() === trackedKey,
    );
    if (owner) return owner;
  }
  return candidates[0];
}

/**
 * Decide how the cockpit Contact panel renders the current context snapshot.
 *
 * The panel hosts its own PREVIOUS/NEXT controls, so its visibility can only
 * depend on whether a snapshot exists — never on which subject that snapshot
 * happens to describe. Anything else strands the operator the moment NEXT
 * lands on a contact that is not the tracked aircraft.
 * @param {object} [options] Resolver inputs.
 * @param {object|null} [options.snapshot] `militaryAwareness.getContextSnapshot()` result.
 * @param {object|null} [options.info] Tracked aircraft info from the owning flight layer.
 * @returns {{visible: boolean, mode: string, subjectMatchesTracked: boolean,
 *   aircraftRelative: boolean, contactLost: boolean}}
 *   Panel visibility plus the per-field rendering rules for this frame.
 */
export function resolveCockpitContextReadout({ snapshot = null, info = null } = {}) {
  if (!snapshot) {
    return {
      visible: false,
      mode: 'standby',
      subjectMatchesTracked: false,
      aircraftRelative: false,
      contactLost: false,
    };
  }
  const trackedId = info?.icao24 ?? info?.id;
  const subjectMatchesTracked = snapshot.subject?.layerId === info?.layerId
    && String(snapshot.subject?.id) === String(trackedId);
  // `subjectPresent` is absent on snapshots built before the presence signal
  // existed; only an explicit `false` means the subject left its source.
  const contactLost = snapshot.subjectPresent === false;
  return {
    visible: true,
    mode: contactLost ? 'lost' : (subjectMatchesTracked ? 'tracked' : 'foreign'),
    subjectMatchesTracked,
    // The nose-relative arrow and BRG readout are measured in the tracked
    // aircraft's own frame; every other value in that row is measured from the
    // subject. When they are not the same contact, rendering both live shows
    // one mixed-frame reading as a single measurement, so the aircraft-frame
    // half is dashed instead.
    aircraftRelative: subjectMatchesTracked,
    // A lost contact holds its last-known values: recomputing them against a
    // frozen position would present stale geometry as a live reading.
    contactLost,
  };
}

/**
 * Resolve a vertically centered panel slot inside a HUD rail while respecting
 * live rectangles that intersect that rail above or below the viewport center.
 */
export function resolveHudRailLayout({
  viewportHeight,
  panelHeight,
  laneLeft,
  laneRight,
  obstacles = [],
  baseTop,
  baseBottom,
  gap = 12,
  align = 'center',
}) {
  if (![viewportHeight, panelHeight, laneLeft, laneRight, baseTop, baseBottom]
    .every(Number.isFinite) || viewportHeight <= 0 || laneRight <= laneLeft) return null;
  const midpoint = viewportHeight * 0.5;
  let safeTop = Math.max(0, baseTop);
  let safeBottom = Math.min(viewportHeight, baseBottom);

  for (const rect of obstacles) {
    if (![rect?.left, rect?.right, rect?.top, rect?.bottom].every(Number.isFinite)) continue;
    if (rect.right <= laneLeft || rect.left >= laneRight || rect.bottom <= rect.top) continue;
    if (rect.bottom <= midpoint) safeTop = Math.max(safeTop, rect.bottom + gap);
    else if (rect.top >= midpoint) safeBottom = Math.min(safeBottom, rect.top - gap);
  }

  safeBottom = Math.max(safeTop, safeBottom);
  const availableHeight = Math.max(0, safeBottom - safeTop);
  const renderedHeight = Math.min(Math.max(0, panelHeight), availableHeight);
  return {
    top: align === 'start'
      ? safeTop
      : safeTop + Math.max(0, (availableHeight - renderedHeight) * 0.5),
    maxHeight: availableHeight,
    safeTop,
    safeBottom,
    constrained: panelHeight > availableHeight,
  };
}
