// src/data/issPass.js
/**
 * Next-ISS-pass prediction from a satrec: coarse 30 s scan to find a window
 * where elevation ≥ minElevDeg, refined to ~5 s at the edges, tracking peak
 * elevation. ~2880 SGP4 propagations for a 24 h horizon — tens of ms, fine for
 * an on-demand voice call. Pattern from skylight (MIT) shared/src/celestial.ts
 * nextISSPass, extended with set-time + peak tracking.
 */
import { propagate, gstime, eciToEcf, ecfToLookAngles } from 'satellite.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/** Observer look angles at an instant, or null when propagation fails. */
export function lookAnglesAt(satrec, dateMs, latDeg, lonDeg) {
  const date = new Date(dateMs);
  const pv = propagate(satrec, date);
  const pos = pv && pv.position;
  if (!pos || typeof pos === 'boolean') return null;
  const ecf = eciToEcf(pos, gstime(date));
  const look = ecfToLookAngles(
    { latitude: latDeg * D2R, longitude: lonDeg * D2R, height: 0 },
    ecf,
  );
  return {
    elevDeg: look.elevation * R2D,
    azDeg: (((look.azimuth * R2D) % 360) + 360) % 360,
  };
}

export function findNextIssPass({
  satrec, latDeg, lonDeg, fromMs,
  minElevDeg = 10, horizonHours = 24, coarseStepSec = 30, fineStepSec = 5,
}) {
  const elev = (t) => lookAnglesAt(satrec, t, latDeg, lonDeg)?.elevDeg ?? -90;
  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarse = coarseStepSec * 1000;
  const fine = fineStepSec * 1000;

  // Coarse scan for the first sample above threshold. If we START inside a
  // pass, that's still "the next pass" for a voice answer — accept it.
  let hit = null;
  for (let t = fromMs; t <= horizonMs; t += coarse) {
    if (elev(t) >= minElevDeg) { hit = t; break; }
  }
  if (hit == null) return null;

  // Refine rise: walk back in fine steps to the first sample ≥ threshold.
  let riseMs = hit;
  while (riseMs - fine > fromMs && elev(riseMs - fine) >= minElevDeg) riseMs -= fine;

  // Walk forward through the pass tracking the peak until we drop below.
  let maxElevDeg = -90;
  let maxElevMs = riseMs;
  let t = riseMs;
  while (t <= horizonMs) {
    const e = elev(t);
    if (e < minElevDeg && t > riseMs) break;
    if (e > maxElevDeg) { maxElevDeg = e; maxElevMs = t; }
    t += fine;
  }
  const setMs = t;

  const rise = lookAnglesAt(satrec, riseMs, latDeg, lonDeg);
  return { riseMs, setMs, maxElevDeg, maxElevMs, riseAzDeg: rise ? rise.azDeg : 0 };
}
