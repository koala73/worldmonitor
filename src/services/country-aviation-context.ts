import type { AirportDelayAlert } from '@/services/aviation';

/** Disruptions a country brief reports: closures, and severe or major delays or restrictions. */
export function isBriefAviationDisruption(alert: AirportDelayAlert): boolean {
  return alert.delayType === 'closure' || alert.severity === 'severe' || alert.severity === 'major';
}

const MAX_AIRPORTS = 5;
const MAX_REASON_CHARS = 120;

// Reasons carry upstream NOTAM and provider text: keep it to one short line.
function oneLine(value: string | undefined, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from upstream text
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One brief-context line naming the disrupted airports, closures first, so the
 * brief can say which airport is affected and why rather than only a count.
 * Returns '' when there is nothing to report.
 */
export function formatAirportDisruptionLine(alerts: readonly AirportDelayAlert[]): string {
  if (!alerts.length) return '';
  const rank = (a: AirportDelayAlert) => (a.delayType === 'closure' ? 0 : a.severity === 'severe' ? 1 : 2);
  const parts = [...alerts]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_AIRPORTS)
    .map((a) => {
      const status = a.delayType === 'closure' ? 'closed' : `${a.severity} disruption`;
      const reason = oneLine(a.reason, MAX_REASON_CHARS);
      return `${oneLine(a.iata, 8)} ${oneLine(a.name, 60)}: ${status}${reason ? ` (${reason})` : ''}`;
    });
  const more = alerts.length > MAX_AIRPORTS ? `; +${alerts.length - MAX_AIRPORTS} more` : '';
  return `Airport disruptions: ${parts.join('; ')}${more}`;
}
