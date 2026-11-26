const DAY_MS = 86_400_000;

/** Minutes the zone is ahead of UTC at that instant. */
export function utcOffsetMinutes(timeZone: string, ms: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(ms).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
}

/** Clock and calendar labels in one zone, so every mark on a timeline reads in the place's local time. */
export interface ZonedClock {
  timeZone: string;
  /** e.g. UTC+4 */
  abbreviation: string;
  day: (ms: number) => string;
  dayParts: (ms: number) => { weekday: string; day: string; month: string };
  time: (ms: number) => string;
  /** Local midnights strictly inside the span. */
  midnights: (startMs: number, endMs: number) => number[];
}

export function zonedClock(timeZone: string | null, locale: string, nowMs: number): ZonedClock {
  const zone = timeZone ?? 'UTC';
  const dayParts = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
  const clock = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const partsOf = (ms: number) => {
    const parts = dayParts.formatToParts(ms);
    const get = (type: Intl.DateTimeFormatPartTypes) => (parts.find((part) => part.type === type)?.value ?? '').replace(/[.,]/g, '');
    return { weekday: get('weekday'), day: get('day'), month: get('month') };
  };
  const offset = utcOffsetMinutes(zone, nowMs);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const abbreviation = offset === 0 ? 'UTC' : `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  return {
    timeZone: zone,
    abbreviation,
    dayParts: (ms) => partsOf(ms),
    day: (ms) => {
      const { weekday, day, month } = partsOf(ms);
      return `${weekday} ${day} ${month}`;
    },
    time: (ms) => clock.format(ms),
    midnights: (startMs, endMs) => {
      const out: number[] = [];
      for (let day = Math.floor((startMs + offset * 60_000) / DAY_MS) + 1; ; day++) {
        const first = day * DAY_MS - utcOffsetMinutes(zone, day * DAY_MS) * 60_000;
        // The offset at UTC midnight can differ from the one at local midnight on a daylight-saving day.
        const guess = day * DAY_MS - utcOffsetMinutes(zone, first) * 60_000;
        if (guess >= endMs) break;
        if (guess > startMs) out.push(guess);
      }
      return out;
    },
  };
}
