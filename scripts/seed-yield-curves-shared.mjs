// Multi-country government yield curves — seeder option helpers.
// Each seed-yield-curve-<cc>.mjs seeder calls runSeed() directly and builds
// its extraKeys with these factories so the per-country file stays a thin
// fetch + parse + declare.
//
// Storage mirrors the US Treasury par-curve seeder (#8481): canonical payload
// is the full history; extra keys are `:latest` and per-year shards, because a
// single GET of a full daily history exceeds the 1.5s Redis read budget.

import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { countCurves, yearShard } from './lib/yield-curves/model.mjs';

export const YIELD_CURVE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const YIELD_CURVE_MAX_STALE_MIN = 4320; // 72h = 3x daily interval; covers Fri→Mon
export const YIELD_CURVE_MAX_CONTENT_AGE_MIN = 10 * DAY_MIN;

export function canonicalKey(country) {
  return `economic:yield-curve:${country.toLowerCase()}:v1`;
}

export function latestKey(country) {
  return `economic:yield-curve:${country.toLowerCase()}:v1:latest`;
}

export function yearKey(country, year) {
  return `economic:yield-curve:${country.toLowerCase()}:v1:${year}`;
}

export function activationKey(country) {
  return `seed-activated:economic:yield-curve-${country.toLowerCase()}`;
}

export function seedResource(country) {
  return `yield-curve-${country.toLowerCase()}`;
}

export function contentMeta(payload) {
  const curves = payload?.curves ?? [];
  return tokensToContentMeta([curves[0]?.date, curves.at(-1)?.date]);
}

/** The `:latest` extra key: the only curve the RPC reads when history=false. */
export function latestExtraKeyEntry(country) {
  return {
    key: latestKey(country),
    transform: (data) => ({ curves: data.curves.slice(-1) }),
    declareRecords: () => 1,
  };
}

/** One per-year shard extra key (skipWhenEmpty keeps empty years unpublished). */
export function yearExtraKeyEntry(country, year, isCurrentYear) {
  return {
    key: yearKey(country, year),
    transform: (data) => yearShard(data, year),
    declareRecords: countCurves,
    skipWhenEmpty: true,
    allowMissingOnSkip: isCurrentYear,
  };
}

export function makeValidate(minCurves, startsWith) {
  return function validate(data) {
    const curves = data?.curves;
    if (!Array.isArray(curves) || curves.length < minCurves) return false;
    if (startsWith && !curves[0]?.date?.startsWith(startsWith)) return false;
    const latest = curves.at(-1);
    return latest?.tenors && Object.keys(latest.tenors).length > 0;
  };
}

/** Writes the health activation marker; strict-after-first-publish cutover. */
export function markYieldCurveActivated(country) {
  return async () => {
    const { getOptionalUpstashCreds, upstashCommand } = await import('./_upstash-rest.mjs');
    try {
      const creds = getOptionalUpstashCreds();
      if (!creds) return;
      await upstashCommand(creds, ['SET', activationKey(country), '1']);
    } catch (err) {
      console.warn(`  WARN: ${country} activation marker write failed: ${err?.message || err}`);
    }
  };
}