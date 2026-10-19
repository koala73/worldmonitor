import { CII_RISK_SCORE_CACHE_KEYS } from '../_cii-risk-cache-keys.js';
import { redisPipeline } from '../_upstash-json.js';
import { CII_FORMULA_VERSION } from '../../server/worldmonitor/intelligence/v1/_risk-config';
import { CII_COUNTRY_CODES } from '../../shared/cii-weights';
import { buildCiiHistory, buildCiiMovers, CII_DAY_MS, CII_HISTORY_MAX_AGE_MS, parseCiiDailyPoints, type CiiDailyPoint } from '../../shared/cii-daily-history';
import { RpcValidationError } from './billing-denial';

export function ciiHistoryDays(value: unknown, name: 'history_days' | 'movers_days'): number | undefined {
  if (value === undefined) return undefined;
  const minimum = name === 'history_days' ? 1 : 7;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 90) {
    throw new RpcValidationError(name, [{ field: name, description: `Must be an integer from ${minimum} to 90.` }]);
  }
  return value;
}

export async function readCountryCiiHistory(code: string, days: number, version: string, now = Date.now()) {
  const today = Math.floor(now / CII_DAY_MS);
  const results = await redisPipeline([[
    'ZRANGE', `${CII_RISK_SCORE_CACHE_KEYS.dailyHistoryPrefix}${code}`, String(today - days + 1), String(today), 'BYSCORE',
  ]], 3_000);
  const parsed = parseCiiDailyPoints(results?.[0]?.error ? null : results?.[0]?.result, now);
  const history = buildCiiHistory(parsed.points, days, version, now);
  const stale = history.stale || parsed.invalid;
  const current = parsed.points.filter(point => point.v === version);
  const latest = current[current.length - 1];
  return { history: { ...history, stale }, reuseUntil: !stale && latest ? latest.t + CII_HISTORY_MAX_AGE_MS : null };
}

export async function readCiiMovers(days: number, now = Date.now()) {
  const today = Math.floor(now / CII_DAY_MS);
  const keys = CII_COUNTRY_CODES.map(code => `${CII_RISK_SCORE_CACHE_KEYS.dailyHistoryPrefix}${code}`);
  const results = await redisPipeline(keys.flatMap(key => [
    ['ZRANGE', key, String(today), '-inf', 'BYSCORE', 'REV', 'LIMIT', '0', '1'],
    ['ZRANGE', key, String(today - days), '-inf', 'BYSCORE', 'REV', 'LIMIT', '0', '1'],
  ]), 3_000);
  const endpoints = new Map<string, CiiDailyPoint[]>();
  const unavailableInputs: string[] = [], failedInputs: string[] = [];
  for (const [i, code] of CII_COUNTRY_CODES.entries()) {
    const pair = results?.slice(i * 2, i * 2 + 2);
    const parsed = pair?.map(row => parseCiiDailyPoints(row.error ? null : row.result, now));
    const failed = !pair || pair.some(row => row.error) || parsed?.some(row => row.invalid);
    const points = parsed?.flatMap(row => row.points).sort((a, b) => a.t - b.t) ?? [];
    const latestPoints = parsed?.[0]?.points;
    const latest = latestPoints?.[latestPoints.length - 1];
    if (failed || !latest || latest.v !== CII_FORMULA_VERSION || now - latest.t > CII_HISTORY_MAX_AGE_MS) unavailableInputs.push(keys[i]!);
    if (failed) failedInputs.push(keys[i]!);
    endpoints.set(code, failed ? [] : points);
  }
  return {
    movers: buildCiiMovers(endpoints, days, CII_FORMULA_VERSION, now),
    available: unavailableInputs.length < keys.length,
    unavailableInputs, failedInputs,
  };
}

const components = {
  type: 'object', required: ['ciiContribution', 'geoConvergence', 'militaryActivity', 'newsActivity'],
  properties: { ciiContribution: { type: 'number' }, geoConvergence: { type: 'number' }, militaryActivity: { type: 'number' }, newsActivity: { type: 'number' } },
};
export const CII_HISTORY_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['methodologyVersion', 'requestedDays', 'returnedDays', 'points', 'change', 'versionBreaks', 'stale'],
  properties: {
    methodologyVersion: { type: 'string' }, requestedDays: { type: 'integer' }, returnedDays: { type: 'integer' }, stale: { type: 'boolean' },
    points: { type: 'array', items: { type: 'object', required: ['date', 'combinedScore', 'components'], properties: { date: { type: 'string' }, combinedScore: { type: 'number' }, components } } },
    change: { type: ['object', 'null'], required: ['fromDate', 'fromScore', 'toDate', 'toScore', 'delta'], properties: { fromDate: { type: 'string' }, fromScore: { type: 'number' }, toDate: { type: 'string' }, toScore: { type: 'number' }, delta: { type: 'number' } } },
    versionBreaks: { type: 'array', items: { type: 'object', required: ['date', 'from', 'to'], properties: { date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
  },
};

const moverRow = { type: 'object', required: ['countryCode', 'fromDate', 'from', 'to', 'delta'], properties: { countryCode: { type: 'string' }, fromDate: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, delta: { type: 'number' } } };
export const CII_MOVERS_OUTPUT_SCHEMA = {
  type: 'object', required: ['window_days', 'as_of', 'methodology_version', 'risers', 'fallers', 'insufficient_history'],
  properties: {
    window_days: { type: 'integer' }, as_of: { type: ['string', 'null'] }, methodology_version: { type: 'string' },
    risers: { type: 'array', maxItems: 5, items: moverRow }, fallers: { type: 'array', maxItems: 5, items: moverRow },
    insufficient_history: { type: 'array', items: { type: 'string' } },
  },
};
