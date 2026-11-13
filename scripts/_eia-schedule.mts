import { easternWallTime, eiaReleaseFor } from '../shared/oil-release-calendar.ts';

const DAY = 86_400_000;
const DATE = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;
const TIME = /^(\d{1,2}):(\d{2}) ([ap])\.m\.$/;

// Undefined for text that is not a real calendar date. Date.parse rolls February 31
// over to March 3, so the day of month must survive the round trip.
function utcDay(text: string): number | undefined {
  const time = Date.parse(`${text} UTC`);
  return Number.isFinite(time) && new Date(time).getUTCDate() === Number(/ (\d+),/.exec(text)?.[1]) ? time : undefined;
}

export interface PublishedEiaShift { weekEnding: number; release: number }

const cellText = (cell: string) => cell.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Throws on any row it cannot read, so a markup change cannot shrink the checked range.
export function parseEiaSchedule(html: string): PublishedEiaShift[] {
  return (html.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []).filter(row => /<th[^>]*scope="row"/.test(row)).map(row => {
    const cells = [...row.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map(match => cellText(match[1]));
    const time = TIME.exec(cells[3] ?? '');
    const weekEnding = DATE.test(cells[0] ?? '') ? utcDay(cells[0]) : undefined;
    const releaseDay = DATE.test(cells[1] ?? '') ? utcDay(cells[1]) : undefined;
    if (weekEnding === undefined || releaseDay === undefined || !time) {
      throw new Error(`Unreadable EIA schedule row: ${cellText(row).slice(0, 120)}`);
    }
    return {
      weekEnding,
      release: easternWallTime(releaseDay, (Number(time[1]) % 12 + (time[3] === 'p' ? 12 : 0)) * 60 + Number(time[2])),
    };
  });
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
