// Readers of the per-country watched-site rollup the site seeder publishes. Pure; each
// surface (Country Brief, country signals, lookup) reads one rollup key and asks these
// functions what it may show. Only a confirmed change reaches a reader: a raised flag,
// a shadowed flag (published as no flag at all) and a stale rollup show nothing.
import { FLAG_WORDING } from './flag-record.js';

export const SITES_SCHEMA = 1;
// Three days: the seeder runs daily and a whole registry pass can span two runs.
export const ROLLUP_MAX_AGE_MS = 3 * 86_400_000;

const scene = (value) => value && typeof value.itemId === 'string' && value.itemId
  && typeof value.datetime === 'string' && Number.isFinite(Date.parse(value.datetime))
  ? { itemId: value.itemId, datetime: value.datetime, platform: typeof value.platform === 'string' ? value.platform : null }
  : null;

/** The rollup when it is this country's, of a known schema and fresh; otherwise why not. */
export function readCountryRollup(raw, countryCode, nowMs, maxAgeMs = ROLLUP_MAX_AGE_MS) {
  if (raw === null || raw === undefined) return { status: 'missing' };
  if (typeof raw !== 'object' || raw.schema !== SITES_SCHEMA || raw.countryCode !== countryCode
    || !Array.isArray(raw.sites) || !Number.isFinite(raw.asOf)) return { status: 'malformed' };
  if (nowMs - raw.asOf > maxAgeMs) return { status: 'stale' };
  return { status: 'current', rollup: raw };
}

/** Sites whose change scoring is published: a shadowed or unscored site carries no flag. */
export function scoredSiteCount(rollup) {
  return rollup.sites.filter((site) => site?.flag && typeof site.flag.state === 'string').length;
}

/** Each confirmed change, newest confirming scene first, with the scenes that raised and confirmed it. */
export function confirmedSiteFlags(rollup) {
  const flags = [];
  for (const site of rollup.sites) {
    const flag = site?.flag;
    if (flag?.state !== 'confirmed' || flag.wording !== FLAG_WORDING || !flag.confirmed) continue;
    const confirmed = scene(flag.confirmed);
    const raised = scene(flag.confirmed.raisedBy);
    if (!confirmed || !raised || typeof site.siteId !== 'string' || typeof site.name !== 'string' || !site.name.trim()) continue;
    flags.push({ siteId: site.siteId, name: site.name.trim(), geometryKey: String(flag.confirmed.geometryKey ?? ''), raised, confirmed });
  }
  return flags.sort((a, b) => b.confirmed.datetime.localeCompare(a.confirmed.datetime) || a.siteId.localeCompare(b.siteId));
}

/** A short stable tag of which confirmed scenes a reader saw, for cache keys. */
export function confirmedFlagsTag(flags) {
  if (flags.length === 0) return '';
  let hash = 0x811c9dc5;
  for (const char of flags.map((flag) => `${flag.siteId}@${flag.confirmed.itemId}`).join(',')) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
