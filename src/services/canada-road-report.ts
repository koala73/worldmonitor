import type { CanadaRoadRecord } from './canada-roads-core';

export function isReportableCanadaRoad(record: CanadaRoadRecord): boolean {
  if (record.isFullClosure) return true;

  const noReport = /^no[\s-]+(?:data|reports?)[.!]?$/i;
  const noValue = /^(?:no[\s-]+(?:data|reports?)|none|unknown|n\/a)?[.!]?$/i;
  const genericType = /^(?:event|alert|condition|road[\s_-]*conditions?)$/i;
  const text = (value?: string | null) => (value || '').trim();
  const headline = text(record.headline).toLowerCase() === text(record.roadwayName).toLowerCase()
    ? '' : record.headline;
  const details = [headline, record.description, record.lanesAffected, record.currImpact].map(text);
  const types = [record.eventType, record.type].map(text);
  const severity = text(record.severity);

  if (![...details, ...types, severity].some((value) => noReport.test(value))) return true;
  return !noValue.test(severity)
    || types.some((value) => !noValue.test(value) && !genericType.test(value))
    || details.some((value) => !noValue.test(value));
}
