/**
 * Convert a cardinal/intercardinal direction string to a compass heading.
 *
 * Two matching modes, because the same text is parsed from two very different
 * kinds of source field:
 *
 *   1. Dedicated direction fields (Caltrans `location.direction`, Austin
 *      `travel_direction`/`facing`, …) hold a real facing value. There, bare
 *      cardinal words ("West", "North") ARE the answer — pass `allowBare=true`.
 *
 *   2. Free-form name/description text ("5TH ST / WEST AVE", "N LAMAR BLVD") is
 *      full of STREET names that merely contain a cardinal word. Reading a bare
 *      "West" there as a facing direction mis-orients the camera with false
 *      confidence (59 of ~1000 Austin cameras hit this — field review
 *      2026-07-04). There, only explicit travel forms ("WESTBOUND"/"WB") count —
 *      leave `allowBare=false` (the default).
 *
 * Recognizes full travel words ("NORTHBOUND"), abbreviations ("NB"), and —
 * only when `allowBare` is set — bare cardinals ("NORTH").
 *
 * @param {string} value - Direction text (case-insensitive).
 * @param {boolean} [allowBare=false] - Match bare cardinal words. Use ONLY for
 *   dedicated direction fields, never for free-form name inference.
 * @returns {number} Heading in degrees [0..360), or NaN if unrecognized.
 */
export function directionToHeading(value, allowBare = false) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return NaN;
  // Explicit travel/intercardinal forms — safe on free-form text (a street
  // name almost never contains "NORTHBOUND" or a lone "NB" token).
  if (/\bNORTHBOUND\b|\bNB\b/.test(text)) return 0;
  if (/\bSOUTHBOUND\b|\bSB\b/.test(text)) return 180;
  if (/\bEASTBOUND\b|\bEB\b/.test(text)) return 90;
  if (/\bWESTBOUND\b|\bWB\b/.test(text)) return 270;
  if (/\bNORTHEAST\b|\bNE\b/.test(text)) return 45;
  if (/\bNORTHWEST\b|\bNW\b/.test(text)) return 315;
  if (/\bSOUTHEAST\b|\bSE\b/.test(text)) return 135;
  if (/\bSOUTHWEST\b|\bSW\b/.test(text)) return 225;
  // Bare cardinals — dedicated direction fields only.
  if (allowBare) {
    if (/\bNORTH\b/.test(text)) return 0;
    if (/\bSOUTH\b/.test(text)) return 180;
    if (/\bEAST\b/.test(text)) return 90;
    if (/\bWEST\b/.test(text)) return 270;
  }
  return NaN;
}
