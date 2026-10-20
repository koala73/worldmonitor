/**
 * Shared NGA broadcast-warning classification for subsea-cable activity, used
 * by the server cable-health scorer and the client cable-activity layer.
 *
 * Two problems this guards against (validated against the live NGA active set):
 * - NGA keeps "UNTIL FURTHER NOTICE" warnings in the active feed for years
 *   (the newest active cable notice in Oct 2026 was issued in 2024), so an
 *   undated or old notice must not surface as current repair activity.
 * - "M/V" is the usual ship prefix in cable-operations warnings (e.g. the
 *   Persian Gulf / Bahrain "CABLE OPERATIONS ... BY M/V ..." notice), but the
 *   same prefix appears in seismic-survey notices for vessels "TOWING ...
 *   CABLES" (streamers), which are not subsea-cable work.
 */

/** Notices issued longer ago than this are treated as stale standing notices. */
export const NGA_CABLE_NOTICE_MAX_AGE_DAYS = 30;

const CABLE_KEYWORDS = [
  'CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING',
  'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE',
  'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE',
];

/** Explicit subsea-cable work wording. */
const CABLE_WORK_RE = /CABLE\s+(?:OPERATIONS?|LAYING|LAY|REPAIRS?|INSTALLATION|BURIAL|WORKS?)|(?:SUBMARINE|UNDERSEA|TELECOMMUNICATIONS?|FIBER\s+OPTIC)\s+CABLE|FIBER\s+OPTIC\s+REPAIRS?\b|CABLE\s*SHIP/i;

/** Seismic survey vessels towing streamer "cables" (not subsea-cable work). */
const SEISMIC_STREAMER_RE = /TOWING\b[^.]*?\bCABLES?\b/i;

const DEDICATED_SHIP_PATTERNS = [
  /CABLESHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CABLE\s+SHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /\bC\/?S\s+([A-Z][A-Z0-9\s\-']+)/,
];

/** Generic vessel prefixes; only count as cable ships when the notice describes cable work. */
const GENERIC_SHIP_PATTERNS = [
  /\bM\/V\s+([A-Z][A-Z0-9\-']+(?:\s+[A-Z0-9\-']+)*)/i,
  /\bVESSEL\s+([A-Z][A-Z0-9\s\-']+)/i,
];

/** True when the warning text concerns subsea cables (and is not a seismic streamer notice). */
export function isCableRelatedNotice(text: string): boolean {
  const upper = text.toUpperCase();
  const subject = upper.replace(/\bCABLE\s+AREAS?\b/g, '');
  if (!CABLE_KEYWORDS.some((kw) => subject.includes(kw))) return false;
  if (SEISMIC_STREAMER_RE.test(upper) && !CABLE_WORK_RE.test(upper)) return false;
  return true;
}

/** Name of the cable vessel named in the notice, or null. M/V and VESSEL only count alongside cable-work wording. */
export function extractCableShipName(text: string): string | null {
  const patterns = CABLE_WORK_RE.test(text)
    ? [...DEDICATED_SHIP_PATTERNS, ...GENERIC_SHIP_PATTERNS]
    : DEDICATED_SHIP_PATTERNS;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.split(/\n|,|\b(?:ON\s+STATION|REPAIRING|LAYING|WORKING|COMMENCED|IN\s+AREA|ALONG\s+TRACKLINE)\b/i)[0]?.trim().replace(/\s+/g, ' ');
    if (name && name.length > 2 && !/^(THE|AND|FOR|WITH)$/i.test(name)) return name;
  }
  return null;
}

/** True when a notice is recent enough for current activity, allowing five minutes of clock skew. Undated notices are stale. */
export function isFreshNotice(issuedAtMs: number, nowMs: number = Date.now(), maxAgeDays: number = NGA_CABLE_NOTICE_MAX_AGE_DAYS): boolean {
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) return false;
  const ageMs = nowMs - issuedAtMs;
  return ageMs >= -5 * 60_000 && ageMs <= maxAgeDays * 86_400_000;
}
