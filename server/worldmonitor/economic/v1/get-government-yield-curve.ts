/**
 * RPC: getGovernmentYieldCurve — reads seeded sovereign yield curves from Redis.
 * All external publisher calls happen in the seed-yield-curve-* seeders on
 * Railway. Uncovered or unseeded markets return unavailable=true.
 */

import type {
  ServerContext,
  GetGovernmentYieldCurveRequest,
  GetGovernmentYieldCurveResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';
import {
  COVERED_MARKETS,
  OECD_LT_KEY,
  OECD_LT_LATEST_KEY,
  findCoveredMarket,
  govYieldCurveFromLatest,
  govYieldCurvesFromShards,
  govYieldLatestKey,
  govYieldYearKey,
  govYieldYears,
  oecdLtCurvesForCountry,
} from './government-yield-curves';

const UNAVAILABLE: GetGovernmentYieldCurveResponse = {
  country: '',
  source: '',
  measure: '',
  curves: [],
  unavailable: true,
};

async function readDailyHistory(country: string, startYear: number) {
  const keys = govYieldYears(startYear).map((year) => govYieldYearKey(country, year));
  const shards = await getCachedJsonBatch(keys, true);
  return govYieldCurvesFromShards([...shards.values()]);
}

export async function getGovernmentYieldCurve(
  _ctx: ServerContext,
  req: GetGovernmentYieldCurveRequest,
): Promise<GetGovernmentYieldCurveResponse> {
  const country = (req.country ?? '').trim();
  if (!/^[A-Za-z]{2}$/.test(country)) {
    throw new ValidationError([{ field: 'country', description: 'Expected an ISO 3166-1 alpha-2 country code' }]);
  }
  const normalized = country.toUpperCase();
  const market = findCoveredMarket(normalized);

  try {
    if (market) {
      if (req.history !== true) {
        const latest = govYieldCurveFromLatest(await getCachedJson(govYieldLatestKey(market.country), true));
        const latestCurve = latest.length > 0 ? latest[latest.length - 1] : undefined;
        if (latestCurve) {
          return {
            country: market.country,
            source: market.source,
            measure: market.measure,
            curves: [latestCurve],
            unavailable: false,
          };
        }
      }
      const curves = await readDailyHistory(market.country, market.startYear);
      if (curves.length === 0) return { ...UNAVAILABLE, country: market.country };
      return {
        country: market.country,
        source: market.source,
        measure: market.measure,
        curves: req.history === true ? curves : curves.slice(-1),
        unavailable: false,
      };
    }

    // No covered daily curve: fall back to the OECD monthly 10Y benchmark.
    // history=false reads the small :latest key (the 27-market canonical is
    // ~700 KB and can breach the 1.5s Redis read budget from edge regions).
    const monthly = req.history === true
      ? oecdLtCurvesForCountry(await getCachedJson(OECD_LT_KEY, true), normalized)
      : oecdLtCurvesForCountry(await getCachedJson(OECD_LT_LATEST_KEY, true), normalized);
    if (monthly.length === 0) return { ...UNAVAILABLE, country: normalized };
    return {
      country: normalized,
      source: 'oecd-mei-monthly',
      measure: 'monthly-10y',
      curves: req.history === true ? monthly : monthly.slice(-1),
      unavailable: false,
    };
  } catch {
    return { ...UNAVAILABLE, country: normalized };
  }
}

/** Registry of daily-covered market codes, exported for docs/tests. */
export function governmentYieldCountries(): string[] {
  return COVERED_MARKETS.map((market) => market.country);
}
