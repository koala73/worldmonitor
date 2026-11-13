import { easternWallTime, eiaReleaseFor } from '../shared/oil-release-calendar.ts';

const DAY = 86_400_000;
const ROW = /<th[^>]*scope="row"[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*<\/th>\s*<td>\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*<\/td>\s*<td>[^<]*<\/td>\s*<td>\s*(\d{1,2}):(\d{2}) ([ap])\.m\.\s*<\/td>/g;

const utcDay = (text: string) => Date.parse(`${text} UTC`);

export interface PublishedEiaShift { weekEnding: number; release: number }

export function parseEiaSchedule(html: string): PublishedEiaShift[] {
  return [...html.matchAll(ROW)].map(([, week, release, hour, minute, meridiem]) => ({
    weekEnding: utcDay(week),
    release: easternWallTime(utcDay(release), (Number(hour) % 12 + (meridiem === 'p' ? 12 : 0)) * 60 + Number(minute)),
  }));
}

// Every Friday from the first to the last published row must release at the
// published time, or at the regular Wednesday 10:30 ET when the page lists none.
export function diffEiaSchedule(rows: readonly PublishedEiaShift[]): string[] {
  if (rows.length === 0) return [];
  const published = new Map(rows.map(row => [row.weekEnding, row.release]));
  const weeks = rows.map(row => row.weekEnding);
  const problems: string[] = [];
  for (let week = Math.min(...weeks); week <= Math.max(...weeks); week += 7 * DAY) {
    const expected = published.get(week) ?? easternWallTime(week + 5 * DAY, 10 * 60 + 30);
    const actual = eiaReleaseFor(week);
    if (actual !== expected) {
      problems.push(`week ending ${new Date(week).toISOString().slice(0, 10)}: computed ${new Date(actual).toISOString()}, EIA publishes ${new Date(expected).toISOString()}`);
    }
  }
  return problems;
}
