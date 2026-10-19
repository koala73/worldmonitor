import type { IntelligenceServiceHandler, CountryHistoryPoint } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
import { getCountryHistoryAccess } from '../../../_shared/country-history-access';
import { runRedisPipeline } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';

const DAY = 86400000;

function parsePoint(raw: unknown, country: string, start: number, now: number): CountryHistoryPoint {
  if (typeof raw !== 'string') throw new Error('invalid history member');
  const point = JSON.parse(raw);
  const date = Date.parse(`${point.date}T00:00:00Z`);
  if (point.countryCode !== country || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)
    || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== point.date
    || date < start * DAY || typeof point.capturedAt !== 'number' || !Number.isFinite(point.capturedAt) || point.capturedAt > now
    || point.capturedAt < date || point.capturedAt >= date + DAY
    || !Array.isArray(point.topEvents) || point.topEvents.length > 5
    || !Array.isArray(point.keySignals) || !point.keySignals.every((s: unknown) => typeof s === 'string')) throw new Error('invalid history point');
  for (const score of [point.cii, point.resilience]) {
    if (score !== undefined && (!score || typeof score.score !== 'number' || !Number.isFinite(score.score) || score.score < 0 || score.score > 100
      || typeof score.version !== 'string' || !score.version || typeof score.observedAt !== 'number'
      || !Number.isFinite(score.observedAt) || score.observedAt <= 0 || score.observedAt > point.capturedAt)) throw new Error('invalid history score');
  }
  for (const event of point.topEvents) {
    if (!event || !['title', 'source', 'category', 'link'].every(key => typeof event[key] === 'string')
      || event.title.length > 300 || event.link.length > 1024 || event.source.length > 100 || event.category.length > 100
      || !/^https?:\/\//i.test(event.link)) throw new Error('invalid history event');
  }
  return { date: point.date, capturedAt: point.capturedAt, cii: point.cii, resilience: point.resilience, topEvents: point.topEvents, keySignals: point.keySignals, ciiVersionBreak: false, resilienceVersionBreak: false };
}

export const getCountryHistory: IntelligenceServiceHandler['getCountryHistory'] = async (ctx, req) => {
  const country = req.country?.trim().toUpperCase() ?? '';
  if (!isAssignedCountryCode(country)) throw new ValidationError([{ field: 'country', description: 'Use an assigned ISO alpha-2 country code.' }]);
  if (!Number.isInteger(req.days) || req.days < 0) throw new ValidationError([{ field: 'days', description: 'days must be a non-negative integer.' }]);
  const requestedDays = req.days || 7;
  const allowedDays = getCountryHistoryAccess(ctx.request);
  const effectiveDays = Math.min(requestedDays, allowedDays);
  const now = Date.now();
  const start = Math.floor(now / DAY) - effectiveDays + 1;
  markNoCacheResponse(ctx.request);
  const base = { country, requestedDays, allowedDays, effectiveDays, returnedDays: 0, points: [], fetchedAt: 0, stale: true, upstreamUnavailable: true };
  try {
    const results = await runRedisPipeline([
      ['ZRANGEBYSCORE', `history:country:${country}`, start, Math.floor(now / DAY), 'LIMIT', 0, 365],
      ['GET', 'seed-meta:history:country'],
    ], true);
    if (results.length !== 2 || results.some(result => result.error) || !Array.isArray(results[0]?.result) || typeof results[1]?.result !== 'string') return base;
    const meta = JSON.parse(results[1].result);
    if (typeof meta.fetchedAt !== 'number' || !Number.isFinite(meta.fetchedAt) || meta.fetchedAt <= 0 || meta.fetchedAt > now || !(meta.recordCount > 0)) return base;
    const points = results[0].result.map(raw => parsePoint(raw, country, start, now)).sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(points.map(point => point.date)).size !== points.length) return base;
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]!, current = points[i]!;
      const gap = Date.parse(current.date) - Date.parse(previous.date) !== DAY;
      current.ciiVersionBreak = gap || !previous.cii || previous.cii.version !== current.cii?.version;
      current.resilienceVersionBreak = gap || !previous.resilience || previous.resilience.version !== current.resilience?.version;
    }
    return { ...base, points, returnedDays: points.length, fetchedAt: meta.fetchedAt, stale: now - meta.fetchedAt > 36 * 3600000, upstreamUnavailable: false };
  } catch {
    return base;
  }
};
